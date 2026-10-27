/**
 * Captures started from the review page, on this machine: a queue that runs one capture at a time.
 *
 * A capture is of the working tree, a local branch, or a change from the code host. Each of its
 * projects is one child process of `proofroom run` (after the project's `build` command), run
 * through the config's `captureCommand` when it names one, with its own process group, so Cancel
 * stops it and every browser it started. The working tree is captured in place; a branch or a
 * change is checked out, detached, into a worktree of its own under the work directory, removed
 * afterwards.
 *
 * Where a capture is written decides what the page can do with it:
 * - a change from the code host, every project and story: as that change's local preview,
 *   `<previews>/<number>/<project>/`, decided and finished like CI's capture of it;
 * - a local branch (or a clean working tree, which is its branch's head), every project and story:
 *   `<previews>/branch/<name>/<project>/`, a target of its own, decided and finished onto the branch;
 * - anything else (uncommitted changes, a story prefix, other baselines than the change's target):
 *   `<work dir>/captures/<id>/<project>/`, to look at only.
 * Each of those folders holds a `status.json`: the state, the commit and the projects. A capture
 * whose commit moved while it ran is refused at the end, so a capture that can be decided always
 * matches a commit.
 *
 * `run` writes `progress.json` beside each project's result lines; the queue reads it when asked,
 * and keeps the newest log lines of each capture in memory. The jobs (without their logs) are kept
 * in `<work dir>/captures/jobs.json`, so a restarted server still lists them.
 *
 * A capture can also be asked of CI, when the capture store can `request` one and the capturing
 * workflow on the default branch takes requests: then it is always a whole open change at the head
 * the page showed, against its own baselines, because the run it starts becomes that change's
 * capture, reviewed and finished as any CI capture of it. Nothing of it runs here: the queue asks
 * the store for its run's and jobs' states (`status`) while it waits or runs, at most once per
 * `ciEvery`, and only when the page asks for the captures.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROGRESS_FILE } from "./compare-run.mjs";
import { exec } from "./github.mjs";
import { writeJson } from "./inbox.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
/** The folder of a work directory that holds the page's captures. */
export const CAPTURES_DIR = "captures";
/** The folder of the previews directory that holds local branches' captures. */
export const BRANCH_DIR = "branch";
// The log lines kept per capture, and the most a request is answered with.
const LOG_KEPT = 500;
const LOG_SENT = 200;
// The finished captures kept in the list, and the look-only ones kept on disk.
const FINISHED_KEPT = 50;
const LOOK_KEPT = 10;
const STORY_PREFIX = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[0-9a-f]{7,40}$/;
// How often the capturing workflow on the default branch is read again, to say whether CI takes requests.
const WORKFLOW_EVERY = 60_000;
/** The git config key, under `branch.<name>`, marking a local branch made from a remote one: its remote ref. */
const FROM_REMOTE = "proofroomRemote";

/** A capture request the server refuses, with the HTTP status it answers. */
export class CaptureRefused extends Error {
    /**
     * A refusal.
     * @param {number} status the HTTP status
     * @param {string} message why
     * @param {object} [more] more fields of the answer
     */
    constructor(status, message, more = {}) {
        super(message);
        this.status = status;
        this.more = more;
    }
}

/**
 * Where a local branch's capture is kept.
 * @param {string} previews the previews directory
 * @param {string} branch the branch
 * @returns {string} its folder
 */
export const branchFolder = (previews, branch) => join(previews, BRANCH_DIR, encodeURIComponent(branch));

/**
 * The review target a local branch's capture is listed as.
 * @param {string} branch the branch
 * @returns {string} its id
 */
export const branchTargetId = (branch) => `branch-${encodeURIComponent(branch)}`;

const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
};

/**
 * The local branches' captures in a previews directory that finished, each with its status.json.
 * @param {string | null} previews the previews directory
 * @returns {{ branch: string, dir: string, status: any }[]} them
 */
export function branchCaptures(previews) {
    const root = previews && join(previews, BRANCH_DIR);
    let names = [];
    try {
        names = root ? readdirSync(root) : [];
    } catch {
        return [];
    }
    return names
        .map((n) => ({
            branch: decodeURIComponent(n),
            dir: join(root, n),
            status: readJson(join(root, n, "status.json")),
        }))
        .filter((c) => c.status?.state === "done" && c.status.branch === c.branch);
}

/**
 * The look-only captures in a work directory that finished, each with its status.json.
 * @param {string} tmp the work directory
 * @returns {{ id: number, dir: string, status: any }[]} them, newest first
 */
export function lookCaptures(tmp) {
    const root = join(tmp, CAPTURES_DIR);
    let names = [];
    try {
        names = readdirSync(root).filter((n) => /^\d+$/.test(n));
    } catch {
        return [];
    }
    return names
        .map((n) => ({ id: Number(n), dir: join(root, n), status: readJson(join(root, n, "status.json")) }))
        .filter((c) => c.status?.state === "done")
        .sort((a, b) => b.id - a.id);
}

/**
 * The capture queue.
 * @param {object} options its settings
 * @param {string} options.repo the repository the server runs in: its working tree is "the working tree"
 * @param {ReturnType<typeof import("./config.mjs").normalizeConfig>} options.config the settings
 * @param {string} options.tmp the work directory
 * @param {string | null} options.previews where local previews are; null when this server has none
 * @param {() => { pr: number | null, head: string, branch: string, title: string, author: string | null, remote?: string }[]} [options.changes]
 *     the code host's changes as last listed: pull requests, or under plain git the branches only on
 *     a remote (`remote` names one, such as origin/feat-x, and `pr` is null)
 * @param {() => Promise<string | null>} [options.whoAmI] the code host login of the person running the server
 * @param {(job: object) => void} [options.onEnd] told when a capture ends, however it ends
 * @param {string} [options.cli] the proofroom command line to run (this package's)
 * @param {import("./adapters/index.mjs").CaptureStore | null} [options.store] the capture store, which
 *     CI captures are asked of when it can `request` them
 * @param {number} [options.ciEvery] the least time, in milliseconds, between two asks of one CI
 *     capture's state
 * @returns the queue
 */
export function captureQueue({
    repo,
    config,
    tmp,
    previews,
    changes = () => [],
    whoAmI = async () => null,
    onEnd = () => {},
    cli = CLI,
    store = null,
    ciEvery = 20_000,
}) {
    const root = join(tmp, CAPTURES_DIR);
    const jobsFile = join(root, "jobs.json");
    const git = (args, cwd = repo, env) => exec("git", args, { cwd, env: env && { ...process.env, ...env } });
    /** @type {any[]} every capture, oldest first */
    let jobs = [];
    const logs = new Map();
    const children = new Map();
    let running = null;
    let idle = Promise.resolve();
    /** The CI captures whose state is being asked, by id. */
    const asking = new Map();
    let workflowWhy = "the capturing workflow has not been read yet";
    let workflowAt = -Infinity;
    const saved = readJson(jobsFile);
    if (Array.isArray(saved?.jobs)) {
        // A capture the last server left running may still be: nothing of it is kept running. One on
        // CI goes on there, and is followed again.
        for (const j of saved.jobs.filter((x) => x.state === "running" && !x.ci)) {
            stragglersGone(tmp, j.id);
        }
        jobs = saved.jobs.map((j) =>
            (j.state === "running" || j.state === "queued") && !j.ci
                ? {
                      ...j,
                      state: "failed",
                      error: "the review server stopped while this capture was waiting or running",
                  }
                : j,
        );
    }
    let next = jobs.reduce((n, j) => Math.max(n, j.id), 0) + 1;
    const save = () => {
        try {
            writeJson(jobsFile, { jobs: jobs.slice(-FINISHED_KEPT) });
        } catch (err) {
            console.error(`proofroom: could not keep the list of captures: ${err.message}`);
        }
    };
    const log = (j, line) => {
        const l = logs.get(j.id) ?? { first: 0, lines: [] };
        l.lines.push(line);
        if (l.lines.length > LOG_KEPT) {
            l.lines.splice(0, l.lines.length - LOG_KEPT);
            l.first = (j.logged ?? 0) + 1 - LOG_KEPT;
        }
        logs.set(j.id, l);
        j.logged = (j.logged ?? 0) + 1;
    };

    /**
     * Turns the page's request into a capture, or refuses it: what, which baselines, which
     * projects and stories, and where.
     * @param {any} body the request: `{ what, baselines, projects, stories, where, confirmed }`
     * @returns {Promise<object>} the planned capture
     */
    async function plan(body) {
        const what = body?.what ?? {};
        const confirmed = body?.confirmed === true;
        if (body?.where !== undefined && body.where !== "here") {
            throw new CaptureRefused(400, 'where must be "here" or "ci"');
        }
        if (!previews) {
            throw new CaptureRefused(409, "this server shows a local results folder: it starts no captures");
        }
        const names = Object.keys(config.projects);
        const projects = body.projects === undefined ? names : body.projects;
        if (!Array.isArray(projects) || projects.length === 0 || projects.some((p) => !names.includes(p))) {
            throw new CaptureRefused(400, `projects must be some of ${names.join(", ")}`);
        }
        const stories = String(body.stories ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (stories.some((s) => !STORY_PREFIX.test(s))) {
            throw new CaptureRefused(400, "a story prefix is the start of a story id, such as button--");
        }
        const p = { projects: names.filter((n) => projects.includes(n)), stories: stories.length ? stories : null };
        if (what.kind === "tree") {
            Object.assign(p, await treePlan(confirmed));
        } else if (what.kind === "branch") {
            Object.assign(p, await branchPlan(String(what.branch ?? ""), confirmed));
        } else if (what.kind === "change") {
            Object.assign(p, await changePlan(what, confirmed));
        } else {
            throw new CaptureRefused(400, 'what.kind must be "tree", "branch" or "change"');
        }
        p.baselines = await baselinesPlan(body.baselines ?? "target");
        // Only a whole capture against the change's own target is decided: a story prefix reports
        // every story it skipped as removed, some projects would replace the change's whole capture,
        // and other baselines are not what the gate compares.
        if (p.stories) {
            p.look ??= "a partial capture";
        } else if (p.projects.length < names.length) {
            p.look ??= "some projects only";
        } else if (p.baselines.kind === "commit") {
            p.look ??= "a capture against another commit's baselines";
        }
        if (p.look) {
            p.decidable = null;
        }
        // Only now, with the whole request accepted, does a decided capture of a remote branch make
        // its local branch (a look-only one captures the remote commit and leaves no branch behind).
        if (p.fromRemote && p.decidable) {
            await trackRemote(p.branch, p.fromRemote);
        }
        return p;
    }

    async function treePlan(confirmed) {
        const branch = await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
        const head = await git(["rev-parse", "HEAD"]);
        const dirty = (await changedFiles()) > 0;
        if (!dirty && branch) {
            return {
                ...(await asBranch(branch, head, confirmed)),
                kind: "tree",
                label: "working tree",
                inPlace: true,
            };
        }
        return {
            kind: "tree",
            label: "working tree",
            branch: branch || null,
            head,
            inPlace: true,
            decidable: null,
            look: dirty ? "uncommitted changes" : "a detached checkout",
        };
    }

    async function branchPlan(branch, confirmed) {
        const head = await localHead(branch);
        return {
            kind: "branch",
            label: `branch ${branch}`,
            inPlace: false,
            ...(await asBranch(branch, head, confirmed)),
        };
    }

    // A local branch's head, or a refusal.
    async function localHead(branch) {
        const ok =
            branch !== "" &&
            (await git(["check-ref-format", "--branch", branch]).then(
                () => true,
                () => false,
            ));
        const head = ok
            ? await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]).catch(() => "")
            : "";
        if (!head) {
            throw new CaptureRefused(404, `no local branch ${branch}`);
        }
        return head;
    }

    /**
     * Turns the page's request for a CI capture into the open change it captures, or refuses it:
     * CI captures a whole change at the head the page showed (a change's, or a local branch's or a
     * clean working tree's that is the head of an open change), every project and story, against
     * its own baselines.
     * @param {any} body the request
     * @returns {Promise<object>} the planned capture
     */
    async function ciPlan(body) {
        const why = ciFacts().available ? null : ciFacts().why;
        if (why) {
            throw new CaptureRefused(409, `CI cannot capture here: ${why}`);
        }
        const names = Object.keys(config.projects);
        const projects = body.projects ?? names;
        if (
            String(body.stories ?? "").trim() !== "" ||
            !Array.isArray(projects) ||
            names.some((n) => !projects.includes(n)) ||
            (body.baselines ?? "target") !== "target"
        ) {
            throw new CaptureRefused(
                400,
                "CI captures a whole change against its own baselines, because its run becomes the change's capture: capture some projects or stories, or against other baselines, on this machine",
            );
        }
        const what = body.what ?? {};
        let change;
        if (what.kind === "change") {
            change = changes().find((c) => c.pr !== null && c.pr === Number(what.number));
            if (!change) {
                throw new CaptureRefused(404, `no open change ${what.number}`);
            }
            if (what.head !== change.head) {
                throw new CaptureRefused(409, `#${change.pr} has a newer head than the page showed: look at it again`);
            }
        } else if (what.kind === "tree" || what.kind === "branch") {
            let branch = what.branch;
            if (what.kind === "tree") {
                if ((await changedFiles()) > 0) {
                    throw new CaptureRefused(
                        409,
                        "uncommitted changes are not on CI: commit and push them, or capture the working tree on this machine",
                    );
                }
                branch = await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
                if (!branch) {
                    throw new CaptureRefused(409, "a detached checkout is no change CI can capture");
                }
            }
            const head = await localHead(String(branch ?? ""));
            change = changes().find((c) => c.pr !== null && c.branch === branch && c.head === head);
            if (!change) {
                throw new CaptureRefused(
                    409,
                    `CI captures the head of an open change: ${branch} at ${head.slice(0, 10)} is not one; push it and open one, or capture it on this machine`,
                );
            }
        } else {
            throw new CaptureRefused(400, 'what.kind must be "tree", "branch" or "change"');
        }
        return {
            kind: "change",
            label: `#${change.pr} ${change.title}`,
            title: change.title,
            number: change.pr,
            branch: change.branch,
            head: change.head,
            author: change.author,
            projects: names,
            stories: null,
            baselines: { kind: "target", label: config.defaultBranch },
            decidable: "change",
        };
    }

    // A local branch's capture: the open change of that branch when the code host lists one at
    // this head (its preview, under the change's rules unless its author runs this server), else
    // the branch as a target of its own. The default branch is never finished onto: look only.
    async function asBranch(branch, head, confirmed) {
        if (branch === config.defaultBranch) {
            return { branch, head, decidable: null, look: "the default branch" };
        }
        // A local branch proofroom made from a remote one is still someone else's code.
        const remote = await git(["config", "--get", `branch.${branch}.${FROM_REMOTE}`]).catch(() => "");
        if (remote) {
            const author = (await git(["log", "-1", "--format=%cn", head]).catch(() => "")) || null;
            mayRun({ pr: null, remote, author }, confirmed);
        }
        const change = changes().find((c) => c.pr !== null && c.branch === branch && c.head === head);
        if (!change) {
            return { branch, head, decidable: "branch" };
        }
        if (change.author === null || change.author !== (await whoAmI().catch(() => null))) {
            mayRun(change, confirmed);
        }
        return { branch, head, number: change.pr, decidable: "change", author: change.author };
    }

    // Another person's change builds and runs their code here: only through captureCommand, and
    // only once the reader confirmed it, naming its author.
    function mayRun(change, confirmed) {
        const name = change.pr === null ? change.remote : `#${change.pr}`;
        if (!config.captureCommand) {
            throw new CaptureRefused(
                403,
                `capturing ${name} here builds and runs its code: set captureCommand in ${"visual-review.config.json"} to isolate it${change.pr === null ? "" : ", or capture it on CI"}`,
            );
        }
        if (!confirmed) {
            throw new CaptureRefused(428, `capturing ${name} here builds and runs its code: confirm it first`, {
                change: { pr: change.pr, author: change.author, ...(change.pr === null && { remote: change.remote }) },
            });
        }
    }

    async function changePlan(what, confirmed) {
        if (what.number === undefined && typeof what.branch === "string") {
            return remotePlan(what, confirmed);
        }
        const number = Number(what.number);
        const change = changes().find((c) => c.pr === number);
        if (!change) {
            throw new CaptureRefused(404, `no open change ${what.number}`);
        }
        // Never a head the page did not show: the reader confirmed this commit's author and code.
        if (what.head !== change.head) {
            throw new CaptureRefused(409, `#${number} has a newer head than the page showed: look at it again`);
        }
        mayRun(change, confirmed);
        if (!(await haveCommit(change.head))) {
            await git(["fetch", "-q", "--no-write-fetch-head", "origin", `refs/pull/${number}/head`]).catch(() => {});
            if (!(await haveCommit(change.head))) {
                throw new CaptureRefused(
                    409,
                    `the head of #${number} (${change.head.slice(0, 10)}) is not fetched here`,
                );
            }
        }
        return {
            kind: "change",
            label: `#${number} ${change.title}`,
            title: change.title,
            number,
            branch: change.branch,
            head: change.head,
            author: change.author,
            inPlace: false,
            decidable: "change",
        };
    }

    // Plain git: a branch only on a remote is someone's code from elsewhere, so it is captured here
    // only as a change from the code host is. A decided capture makes it a local branch tracking the
    // remote one (plan, trackRemote), then captured, decided and finished as any local branch: Finish
    // pushes it back there.
    async function remotePlan(what, confirmed) {
        const change = changes().find((c) => c.pr === null && c.remote === what.branch);
        if (!change) {
            throw new CaptureRefused(404, `no branch ${what.branch} on a remote`);
        }
        if (what.head !== change.head) {
            throw new CaptureRefused(409, `${what.branch} has a newer head than the page showed: look at it again`);
        }
        mayRun(change, confirmed);
        return {
            kind: "branch",
            label: `branch ${change.branch}`,
            inPlace: false,
            branch: change.branch,
            head: change.head,
            decidable: "branch",
            fromRemote: change.remote,
        };
    }

    // The local branch of a remote one, marked as made from it so that capturing it again as a
    // local branch still asks first and runs through captureCommand (asBranch).
    async function trackRemote(branch, remote) {
        await git(["branch", "--track", branch, `refs/remotes/${remote}`]).catch((err) => {
            throw new CaptureRefused(409, `${branch} could not be made a local branch: ${err.message}`);
        });
        await git(["config", `branch.${branch}.${FROM_REMOTE}`, remote]);
    }

    async function baselinesPlan(given) {
        const target = await defaultRef();
        if (given === "target" || given === "default") {
            return { kind: given, ref: target, label: config.defaultBranch };
        }
        const sha = typeof given === "object" && given !== null ? String(given.commit ?? "") : "";
        const commit = SHA.test(sha)
            ? await git(["rev-parse", "--verify", "-q", `${sha}^{commit}`]).catch(() => "")
            : "";
        if (!commit) {
            throw new CaptureRefused(400, "baselines must be target, default or { commit: <sha> } of a commit here");
        }
        return { kind: "commit", ref: commit, label: commit.slice(0, 10) };
    }

    // The default branch as this repository has it: origin's, else the local branch.
    async function defaultRef() {
        for (const ref of [`refs/remotes/origin/${config.defaultBranch}`, `refs/heads/${config.defaultBranch}`]) {
            if (
                await git(["rev-parse", "--verify", "-q", ref]).then(
                    () => true,
                    () => false,
                )
            ) {
                return ref;
            }
        }
        throw new CaptureRefused(409, `no ${config.defaultBranch} here to take the baselines from`);
    }

    const haveCommit = (sha) =>
        git(["cat-file", "-e", `${sha}^{commit}`]).then(
            () => true,
            () => false,
        );

    // The working tree's changed files, leaving out the work directory.
    async function changedFiles() {
        const out = await git(["status", "--porcelain", "--", ".", `:(exclude)${config.workDir}`]);
        const inside = relative(repo, tmp);
        return out
            .split("\n")
            .filter(Boolean)
            .filter((l) => inside.startsWith("..") || !l.slice(3).startsWith(inside)).length;
    }

    /**
     * What the New capture sheet offers: the working tree's branch and its changed files, the
     * local branches (the current one first), and under plain git the branches only on a remote.
     * @returns {Promise<{ branch: string | null, changed: number, branches: string[],
     *     remote: { name: string, head: string, title: string, author: string | null }[] }>} them
     */
    async function sources() {
        const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")) || null;
        const all = (await git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"]))
            .split("\n")
            .filter(Boolean);
        const branches = branch ? [branch, ...all.filter((b) => b !== branch)] : all;
        const remote = changes()
            .filter((c) => c.pr === null && c.remote)
            .map((c) => ({ name: c.remote, head: c.head, title: c.title, author: c.author }));
        return { branch, changed: await changedFiles(), branches, remote };
    }

    /**
     * Queues a capture the page asked for.
     * @param {any} body the request
     * @returns {Promise<object>} the capture
     */
    async function start(body) {
        if (body?.where === "ci") {
            return startCi(body);
        }
        const p = await plan(body);
        const id = next++;
        const out = p.look
            ? join(root, String(id))
            : p.decidable === "change"
              ? join(previews, String(p.number))
              : branchFolder(previews, p.branch);
        const j = {
            id,
            what: {
                kind: p.kind,
                label: p.label,
                title: p.title ?? null,
                branch: p.branch ?? null,
                number: p.number ?? null,
                author: p.author ?? null,
            },
            head: p.head,
            inPlace: p.inPlace,
            decidable: p.decidable,
            look: p.look ?? null,
            baselines: p.baselines,
            projects: p.projects,
            stories: p.stories,
            out,
            target: p.look ? `capture-${id}` : p.decidable === "change" ? String(p.number) : branchTargetId(p.branch),
            state: "queued",
            step: null,
            error: null,
            createdAt: Date.now(),
            startedAt: null,
            endedAt: null,
        };
        jobs.push(j);
        log(j, running ? "Waiting: local captures run one at a time" : `Starting the capture of ${p.label}`);
        save();
        pump();
        return j;
    }

    // Asks CI for a capture: the store's request is made before the capture is listed, so a request
    // CI refused is never listed.
    async function startCi(body) {
        const p = await ciPlan(body);
        let ci;
        try {
            ci = await store.request({ branch: p.branch, head: p.head }, { projects: p.projects, stories: [] }, config);
        } catch (err) {
            throw new CaptureRefused(502, `CI did not take the request: ${err.message}`);
        }
        const j = {
            id: next++,
            what: {
                kind: p.kind,
                label: p.label,
                title: p.title,
                branch: p.branch,
                number: p.number,
                author: p.author,
            },
            head: p.head,
            inPlace: false,
            decidable: p.decidable,
            look: null,
            baselines: p.baselines,
            projects: p.projects,
            stories: null,
            out: null,
            target: String(p.number),
            ci: { ...ci, url: null, jobs: [] },
            state: "queued",
            step: null,
            error: null,
            createdAt: Date.now(),
            startedAt: null,
            endedAt: null,
        };
        jobs.push(j);
        log(j, `Asked CI for a capture of ${p.label} at ${p.head.slice(0, 10)} (request ${ci.request})`);
        save();
        return j;
    }

    // Asks the store how each CI capture that waits or runs is getting on, at most once per
    // `ciEvery` each, without waiting for the answers: the page's next poll has them.
    function askCi() {
        const now = Date.now();
        for (const j of jobs.filter(
            (x) => x.ci && busy(x) && !asking.has(x.id) && now - (x.ci.askedAt ?? 0) >= ciEvery,
        )) {
            const asked = store
                .status(j.ci, j.projects)
                .then((st) => ciAnswer(j, st))
                .catch((err) => log(j, `CI did not say how the capture is getting on: ${err.message}`))
                .finally(() => {
                    j.ci.askedAt = Date.now();
                    asking.delete(j.id);
                });
            asking.set(j.id, asked);
        }
    }

    function ciAnswer(j, st) {
        if (!busy(j)) {
            return; // cancelled while it was asked
        }
        const was = j.state;
        j.ci.run = st.run?.id ?? j.ci.run;
        j.ci.url = st.run?.url ?? j.ci.url;
        j.ci.jobs = st.jobs;
        if (st.state === "running") {
            j.state = "running";
            j.startedAt ??= Date.now();
        } else if (["done", "failed", "cancelled"].includes(st.state)) {
            j.state = st.state;
            j.startedAt ??= Date.now();
            j.endedAt = Date.now();
            j.error = { failed: "the CI run failed", cancelled: "Cancelled on CI" }[st.state] ?? null;
        }
        if (j.state !== was) {
            log(j, `CI: ${j.state}${j.ci.url ? ` (${j.ci.url})` : ""}`);
            save();
            if (!busy(j)) {
                onEnd(j);
            }
        }
    }

    // Whether CI captures can be asked for here, and what the store can say and do about them.
    function ciFacts() {
        const can = typeof store?.request === "function";
        return {
            available: can && workflowWhy === null,
            why: can ? (workflowWhy ?? "") : "your capture store cannot start CI jobs",
            status: typeof store?.status === "function",
            cancel: typeof store?.cancel === "function",
        };
    }

    // Why the capturing workflow on the default branch takes no capture requests, or null when it does.
    async function readWorkflow() {
        const file = `.github/workflows/${config.workflow}`;
        let ref;
        try {
            ref = await defaultRef();
        } catch (err) {
            return err.message;
        }
        const text = await git(["show", `${ref}:${file}`]).catch(() => null);
        if (text === null) {
            return `${file} is not on ${config.defaultBranch}`;
        }
        // ponytail: read as text, not parsed: the dispatch trigger and its request input are named.
        return /^\s*workflow_dispatch:/m.test(text) && /^\s+request:/m.test(text)
            ? null
            : `${file} on ${config.defaultBranch} takes no capture requests: update it with proofroom init --force`;
    }

    function pump() {
        if (running) {
            return;
        }
        const j = jobs.find((x) => x.state === "queued" && !x.ci);
        if (!j) {
            return;
        }
        running = j;
        idle = work(j)
            .catch((err) => {
                if (!j.cancelling) {
                    j.state = "failed";
                    j.error = err.message;
                    log(j, `Failed: ${j.error}`);
                }
            })
            .then(() => {
                if (j.cancelling) {
                    j.state = "cancelled";
                    j.error = "Cancelled by you";
                    log(j, "Cancelled");
                }
            })
            .finally(() => {
                j.endedAt = Date.now();
                j.step = null;
                running = null;
                writeStatus(j);
                save();
                pruneLook();
                onEnd(j);
                pump();
            });
    }

    // The folder's status.json: what the server reads to list it, and a change's preview state.
    function writeStatus(j) {
        const state = j.state === "running" ? "running" : j.state === "done" ? "done" : "failed";
        try {
            writeJson(join(j.out, "status.json"), {
                state,
                step: j.step,
                pr: j.what.number,
                branch: j.decidable === "branch" ? j.what.branch : null,
                head: j.head,
                merge: j.head,
                startedAt: new Date(j.startedAt ?? j.createdAt).toISOString(),
                updatedAt: new Date().toISOString(),
                projects: j.projects,
                capture: j.id,
                label: j.what.label,
                look: j.look,
                error: j.error,
            });
        } catch (err) {
            console.error(`proofroom: could not write ${join(j.out, "status.json")}: ${err.message}`);
        }
    }

    async function work(j) {
        j.state = "running";
        j.startedAt = Date.now();
        rmSync(j.out, { recursive: true, force: true });
        mkdirSync(j.out, { recursive: true });
        writeStatus(j);
        save();
        const scratch = join(root, "work", String(j.id));
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(scratch, { recursive: true });
        let checkout = repo;
        try {
            if (!j.inPlace) {
                checkout = join(scratch, "checkout");
                j.step = "checking out";
                log(j, `Checking out ${j.head.slice(0, 10)}`);
                await git(["worktree", "add", "-q", "--detach", checkout, j.head]);
            }
            const baselines = join(scratch, "baselines");
            j.step = `reading ${j.baselines.label}'s baselines`;
            await extractBaselines(j.baselines.ref, baselines);
            for (const name of j.projects) {
                if (j.cancelling) {
                    break;
                }
                j.current = name;
                const build = config.projects[name].build;
                if (build) {
                    j.step = `building ${name}`;
                    log(j, `[${name}] building: ${build}`);
                    await runChild(j, name, ["sh", "-c", build], checkout, false);
                }
                if (j.cancelling) {
                    break;
                }
                j.step = `capturing ${name}`;
                const args = [process.execPath, cli, "run", "--project", name, "--out", join(j.out, name), "--no-fail"];
                args.push("--baselines", join(baselines, config.baselines, name));
                if (j.stories) {
                    args.push("--stories", j.stories.join(","));
                }
                const wrapped = config.captureCommand
                    ? ["sh", "-c", `${config.captureCommand} "$@"`, "proofroom", ...args]
                    : args;
                await runChild(j, name, wrapped, checkout, true);
            }
            if (j.cancelling) {
                rmSync(j.out, { recursive: true, force: true });
                mkdirSync(j.out, { recursive: true });
                return;
            }
            j.step = "checking the commit";
            await checkHead(j, checkout);
            j.state = "done";
            log(j, "Done");
        } catch (err) {
            if (!j.cancelling) {
                // Nothing half made is offered: a decided capture always matches a commit.
                for (const name of j.projects) {
                    rmSync(join(j.out, name, "results.json"), { force: true });
                }
            }
            throw err;
        } finally {
            if (!j.inPlace) {
                await git(["worktree", "remove", "--force", checkout]).catch(() => {});
            }
            rmSync(scratch, { recursive: true, force: true });
        }
    }

    // A capture whose commit moved while it ran is refused: its folder would say it is of a commit
    // that is no longer the branch's or the change's head.
    async function checkHead(j, checkout) {
        const now = await git(["rev-parse", "HEAD"], checkout);
        let moved = now !== j.head ? `the checkout is at ${now.slice(0, 10)} now` : null;
        if (!moved && j.decidable === "branch") {
            const tip = await git(["rev-parse", "--verify", "-q", `refs/heads/${j.what.branch}`]).catch(() => "");
            moved = tip === j.head ? null : `${j.what.branch} is at ${tip.slice(0, 10) || "nothing"} now`;
        }
        if (!moved && j.decidable === "change") {
            const tip = changes().find((c) => c.pr === j.what.number)?.head;
            moved = tip === undefined || tip === j.head ? null : `#${j.what.number} is at ${tip.slice(0, 10)} now`;
        }
        if (!moved && j.inPlace && j.decidable && (await changedFiles()) > 0) {
            moved = "the working tree was changed while it was captured";
        }
        if (moved) {
            throw new Error(`the commit moved while it was captured (${moved}): capture it again`);
        }
    }

    // The baselines a capture is compared with: the ref's baselines folder, smudged (a Git LFS
    // pointer becomes its image), checked out of a scratch index so nothing of the repository's own
    // index or working tree is touched.
    async function extractBaselines(ref, dir) {
        mkdirSync(dir, { recursive: true });
        const index = join(dir, ".index");
        const env = { GIT_INDEX_FILE: index };
        await git(["read-tree", ref], repo, env);
        const files = (await git(["ls-files", "--", `${config.baselines}/`], repo, env)).split("\n").filter(Boolean);
        if (files.length > 0) {
            await exec("git", ["checkout-index", "-f", `--prefix=${dir}/`, "--stdin"], {
                cwd: repo,
                input: `${files.join("\n")}\n`,
                env: { ...process.env, ...env },
            });
        }
        rmSync(index, { force: true });
        for (const name of Object.keys(config.projects)) {
            mkdirSync(join(dir, config.baselines, name), { recursive: true });
        }
    }

    // One child process, in a process group of its own, logged line by line; a capture's result
    // lines are logged as "[project] <status> <file>". Resolves when it ends; a failure rejects.
    function runChild(j, name, argv, cwd, results) {
        return new Promise((resolve, reject) => {
            const child = spawn(argv[0], argv.slice(1), {
                cwd,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, PROOFROOM_CAPTURE_JOB: jobMarker(tmp, j.id), ...previewEnv(j) },
            });
            children.set(j.id, child);
            const lines = (stream, each) => {
                let rest = "";
                stream.setEncoding("utf8");
                stream.on("data", (chunk) => {
                    const parts = (rest + chunk).split("\n");
                    rest = parts.pop();
                    parts.forEach(each);
                });
                stream.on("end", () => rest && each(rest));
            };
            lines(child.stdout, (l) => log(j, results ? resultText(name, l) : `[${name}] ${l}`));
            lines(child.stderr, (l) => log(j, `[${name}] ${l}`));
            child.on("error", reject);
            child.on("close", (code, signal) => {
                children.delete(j.id);
                if (j.cancelling) {
                    // The capture ends once nothing of it is left (cancel).
                    stragglersGone(tmp, j.id).then(() => resolve(null));
                } else if (code === 0) {
                    resolve(null);
                } else {
                    reject(
                        new Error(
                            `${results ? "the capture" : "the build"} of ${name} ${signal ? `was stopped (${signal})` : `exited with ${code}`}`,
                        ),
                    );
                }
            });
        });
    }

    // A change's capture names the change and its head, as a preview of it.
    const previewEnv = (j) =>
        j.decidable === "change"
            ? { VISUAL_REVIEW_PREVIEW_PR: String(j.what.number), VISUAL_REVIEW_PREVIEW_HEAD: j.head }
            : {};

    const resultText = (name, line) => {
        try {
            const r = JSON.parse(line);
            if (typeof r?.file === "string") {
                return `[${name}] ${r.status} ${r.file}${r.reason ? `: ${r.reason}` : ""}`;
            }
        } catch {
            // Not a result line.
        }
        return `[${name}] ${line}`;
    };

    function pruneLook() {
        for (const c of lookCaptures(tmp).slice(LOOK_KEPT)) {
            rmSync(c.dir, { recursive: true, force: true });
        }
    }

    /**
     * Cancels a capture: one waiting is dropped; one running is stopped with every process it
     * started; one on CI has its run cancelled.
     * @param {number} id the capture
     * @returns {Promise<object | null>} the capture, or null when there is none
     */
    async function cancel(id) {
        const j = jobs.find((x) => x.id === id);
        if (!j) {
            return null;
        }
        if (j.ci) {
            if (busy(j)) {
                if (typeof store?.cancel !== "function") {
                    throw new CaptureRefused(409, "your capture store cannot cancel CI jobs");
                }
                await store.cancel(j.ci);
                j.state = "cancelled";
                j.error = "Cancelled by you";
                j.endedAt = Date.now();
                log(j, "Cancelled on CI");
                save();
                onEnd(j);
            }
            return j;
        }
        if (j.state === "queued") {
            j.state = "cancelled";
            j.endedAt = Date.now();
            log(j, "Cancelled");
            save();
            onEnd(j);
        } else if (j.state === "running" && !j.cancelling) {
            j.cancelling = true;
            log(j, "Cancelling: stopping its processes");
            // ponytail: killed at once, not asked to close: Playwright's own SIGTERM handler waited on
            // a page stuck loading, and a killed browser leaves its temporary profile folder behind.
            const child = children.get(j.id);
            if (child) {
                kill(-child.pid, "SIGKILL");
            }
            // A browser runs in a process group of its own: every process naming the capture goes.
            stragglersGone(tmp, j.id);
        }
        return j;
    }

    /** Stops the running capture and every process it started, as the server stops. */
    function stop() {
        const child = running && children.get(running.id);
        if (child) {
            kill(-child.pid, "SIGKILL");
        }
        for (const pid of running ? captureProcesses(tmp, running.id) : []) {
            kill(pid, "SIGKILL");
        }
    }

    const progressOf = (j) =>
        j.ci
            ? []
            : j.projects.map((name) => {
                  const p = readJson(join(j.out, name, PROGRESS_FILE));
                  return {
                      project: name,
                      done: p?.done ?? 0,
                      total: p?.total ?? 0,
                      current: p?.current ?? null,
                      failures: p?.failures ?? 0,
                      failed: p?.failed ?? [],
                  };
              });

    // A capture as the list shows it: no log, its stories counted over its projects; on CI, its
    // project jobs counted instead.
    const row = (j) => {
        if (j.ci) {
            const ended = j.ci.jobs.filter((x) => !["queued", "running"].includes(x.state));
            return {
                ...localRow(j, []),
                where: "ci",
                done: ended.length,
                total: j.projects.length,
                failures: ended.filter((x) => x.state === "failed").length,
                jobs: j.ci.jobs,
                runUrl: j.ci.url,
            };
        }
        return localRow(j, j.state === "queued" ? [] : progressOf(j));
    };
    const localRow = (j, progress) => {
        return {
            id: j.id,
            what: j.what,
            head: j.head,
            where: "this machine",
            state: j.state,
            cancelling: j.cancelling === true,
            step: j.step,
            error: j.error,
            look: j.look,
            target: j.target,
            projects: j.projects,
            stories: j.stories,
            baselines: { kind: j.baselines.kind, label: j.baselines.label },
            done: progress.reduce((n, p) => n + p.done, 0),
            total: progress.reduce((n, p) => n + p.total, 0),
            failures: progress.reduce((n, p) => n + p.failures, 0),
            createdAt: j.createdAt,
            startedAt: j.startedAt,
            endedAt: j.endedAt,
        };
    };

    return {
        sources,
        start,
        cancel,
        stop,
        /**
         * What the page asks for the captures with: reads the capturing workflow again when it is
         * due, and asks CI how its captures are getting on (askCi).
         * @returns {Promise<void>} once the workflow is read
         */
        async poll() {
            if (typeof store?.request === "function" && Date.now() - workflowAt >= WORKFLOW_EVERY) {
                workflowAt = Date.now();
                workflowWhy = await readWorkflow();
            }
            if (typeof store?.status === "function") {
                askCi();
            }
        },
        /**
         * Whether CI captures can be asked for, why not, and whether their state and Cancel are there.
         * @returns {{ available: boolean, why: string, status: boolean, cancel: boolean }} it
         */
        ci: () => ciFacts(),
        /**
         * Every capture: the one running, the ones waiting in order, the finished ones newest first.
         * @param {Set<number> | null} [watch] only these finished ones (those a page saw waiting or
         *     running), so a page following a capture asks for little
         * @returns {{ running: object[], queued: object[], finished: object[] }} them
         */
        list(watch = null) {
            const all = [...jobs].reverse();
            return {
                running: all.filter((j) => j.state === "running").map(row),
                queued: all
                    .filter((j) => j.state === "queued")
                    .reverse()
                    .map(row),
                finished: all
                    .filter((j) => !["running", "queued"].includes(j.state) && (!watch || watch.has(j.id)))
                    .map(row),
            };
        },
        /**
         * One capture with each project's progress and its log since a line.
         * @param {number} id the capture
         * @param {number} [since] the number of the first log line wanted
         * @returns {object | null} it
         */
        get(id, since = 0) {
            const j = jobs.find((x) => x.id === id);
            if (!j) {
                return null;
            }
            const l = logs.get(j.id) ?? { first: 0, lines: [] };
            const end = l.first + l.lines.length;
            const from = Math.max(l.first, Math.min(end, Number.isInteger(since) ? since : 0), end - LOG_SENT);
            return {
                ...row(j),
                progress: progressOf(j),
                log: { from, lines: l.lines.slice(from - l.first) },
            };
        },
        /**
         * Settles once no capture runs.
         * @returns {Promise<void>} once idle
         */
        idle: async () => {
            while (running || asking.size > 0) {
                await Promise.all([idle, ...asking.values()]);
            }
        },
    };
}

// Whether a capture still waits or runs.
const busy = (j) => j.state === "queued" || j.state === "running";

// What a capture's processes carry in PROOFROOM_CAPTURE_JOB: its id and the work directory, since
// ids are counted per work directory and several review servers can run on one machine.
const jobMarker = (tmp, id) => `${id}@${resolve(tmp)}`;

/**
 * Kills every process left of a capture, and settles once none is: a killed process takes a moment
 * to go.
 * @param {string} tmp the work directory
 * @param {number} id the capture
 * @returns {Promise<void>} once none is left
 */
async function stragglersGone(tmp, id) {
    for (let left = captureProcesses(tmp, id); left.length > 0; left = captureProcesses(tmp, id)) {
        for (const pid of left) {
            kill(pid, "SIGKILL");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const kill = (target, signal) => {
    try {
        process.kill(target, signal);
    } catch {
        // Already gone.
    }
};

/**
 * The processes whose environment names a capture (Linux's /proc; none elsewhere).
 * @param {string} tmp the work directory of the server that runs it
 * @param {number} id the capture
 * @returns {number[]} their pids
 */
export function captureProcesses(tmp, id) {
    const marker = `\0PROOFROOM_CAPTURE_JOB=${jobMarker(tmp, id)}\0`;
    let pids = [];
    try {
        pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
    } catch {
        return [];
    }
    return pids
        .filter((pid) => {
            try {
                return `\0${readFileSync(join("/proc", pid, "environ"), "latin1")}\0`.includes(marker);
            } catch {
                return false;
            }
        })
        .map(Number)
        .filter((pid) => pid !== process.pid);
}
