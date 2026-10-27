/*
 * Finish in change mode (docs/approval-format.md): one signed change statement per Finish, written
 * where its content says, and no review record; and Finish in tree mode where the default branch
 * still holds tree statements, so a repository whose CI runs the old gate never receives a
 * statement that gate cannot read.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as oldGate from "./fixtures/old-gate/trusted/gate.mjs";
import { approvalProblems } from "../trusted/gate.mjs";
import { finish, prepareApproval } from "../trusted/lib/accept.mjs";
import { plainGitCodeHost } from "../trusted/lib/adapters/plain-git.mjs";
import { PASSKEYS_FILE } from "../trusted/lib/approval.mjs";
import { statementId, statementPath } from "../trusted/lib/change-approval.mjs";
import { approvalFormatAt, CONFIG_FILE } from "../trusted/lib/config.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { copyFixture, FIXTURE_CONFIG, git, makeRepo, onePr, until } from "./helpers.mjs";
import { fakeCodeHost } from "./fakes/code-host.mjs";
import { approve, makeKey, passkeysJson } from "./passkey-vectors.mjs";

const TOKEN = "t".repeat(43);
const KEY = makeKey("127.0.0.1");
// An https origin: the gate never takes an approval made on a plain http page.
const ORIGIN = "https://127.0.0.1:9443";
const REPO_ID = "5d2c9a10-7f3e-4b61-a8d4-0c9e1b2f3a47";
const APPROVALS = "visual-review-approvals";
const BASELINES = "visual-baselines";
const CHANGE_DIR = `${APPROVALS}/pr-123`;
const BUTTON = "button--primary.dark.png";
const BADGE = "badge--default.light.png";

const servers = [];
afterEach(async () => {
    for (const { server, app } of servers.splice(0)) {
        await new Promise((resolve) => server.close(() => resolve()));
        await app.idle();
    }
});

/**
 * Commits files on the checked-out branch of a repository and pushes it.
 * @param {string} repo the repository
 * @param {Record<string, string | object>} files contents by path (objects as JSON)
 * @param {string} message the commit message
 */
function commitAndPush(repo, files, message) {
    for (const [path, data] of Object.entries(files)) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), typeof data === "string" ? data : `${JSON.stringify(data, null, 4)}\n`);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", message);
    git(repo, "push", "-q", "origin", "HEAD");
}

/**
 * The fixture repository with master's config changed (and, with `files`, more files on master),
 * merged into the pull request's branch `feature`, whose new head CI captured.
 * @param {object} config the config keys master sets or, as undefined, drops
 * @param {Record<string, string | object>} [files] more files for master
 * @returns {object} makeRepo's repository, `head` the captured head
 */
function repoWith(config, files = {}) {
    const r = makeRepo();
    const own = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
    commitAndPush(r.repo, { [CONFIG_FILE]: { ...own, ...config }, ...files }, "base");
    git(r.repo, "checkout", "-q", "feature");
    git(r.repo, "merge", "-q", "--no-edit", "master");
    git(r.repo, "push", "-q", "origin", "feature");
    const head = git(r.repo, "rev-parse", "HEAD");
    git(r.repo, "checkout", "-q", "master");
    return { ...r, head, master: git(r.repo, "rev-parse", "master") };
}

/**
 * A repository in change mode with KEY on its default branch.
 * @returns {object} it, as repoWith returns it
 */
const changeRepo = () =>
    repoWith({ approvalFormat: "change", repositoryId: REPO_ID }, { [PASSKEYS_FILE]: passkeysJson(KEY) });

/**
 * Another checkout of the same remote, as a second reviewer's machine has.
 * @param {object} r the repository
 * @param {string} name its folder
 * @returns {object} the same repository, `repo` the new checkout
 */
function secondCheckout(r, name) {
    const repo = join(r.dir, name);
    git(r.dir, "clone", "-q", "-b", "master", r.remote, repo);
    git(repo, "config", "user.name", "Second");
    git(repo, "config", "user.email", "second@example.com");
    git(repo, "config", "core.hooksPath", "/dev/null");
    git(repo, "lfs", "install", "--local", "--skip-repo");
    git(repo, "fetch", "-q", "origin", "feature:feature");
    return { ...r, repo };
}

/**
 * Starts a review server on the repository, served as ORIGIN, with #123 listed.
 * @param {object} r the repository
 * @returns {Promise<object>} `api(method, path, body)`, `touches` (passkey approvals given) and
 *     `sign(statement)`, which gives one
 */
async function start(r) {
    const box = {};
    const server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const local = `http://127.0.0.1:${server.address().port}`;
    const tmp = join(r.repo, "tmp/visual-review");
    box.app = createApp({ repo: r.repo, tmp, config: FIXTURE_CONFIG, token: TOKEN, origin: ORIGIN, gh: onePr()(r) });
    servers.push({ server, app: box.app });
    const api = async (method, path, body) => {
        const res = await fetch(`${local}${path}`, {
            method,
            headers: { "x-review-token": TOKEN, origin: ORIGIN, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    const s = { api, touches: 0 };
    s.sign = (statement) => {
        s.touches++;
        return approve(statement, KEY, { origin: ORIGIN });
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await api("GET", "/api/prs")).status).toBe(200);
    return s;
}

/**
 * Decides images of #123.
 * @param {object} s the server
 * @param {[string, string, string?, string?][]} list project, file, decision (accept) and reason
 */
async function decide(s, list) {
    for (const [project, file, decision = "accept", reason = null] of list) {
        const res = await s.api("POST", "/api/decide", { id: "123", project, file, decision, reason });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
}

/** Every decidable image of #123 whose baseline the default branch holds as the capture names. */
const ALL = [
    ["compact-mantine", BUTTON],
    ["compact-mantine", BADGE],
    ["compact-mantine", "card--legacy.png"],
    ["compact-mantine", "tooltip--hover.png", "exclude", "animation never settles"],
    ["graphty-element", "graph--basic.png"],
];

/**
 * Finish as the page runs it: prepare, one passkey touch when one is asked for, then Finish, and
 * the job's end.
 * @param {object} s the server
 * @returns {Promise<{ prepared: object, job: object }>} what finish-prepare answered and the job
 */
async function finishOnce(s) {
    const prepared = (await s.api("POST", "/api/finish-prepare", { id: "123" })).body;
    const body = prepared.required
        ? { id: "123", challenge: prepared.challenge, approval: s.sign(prepared.statement) }
        : { id: "123" };
    const begun = await s.api("POST", "/api/finish", body);
    expect(begun.status, JSON.stringify(begun.body)).toBe(202);
    let job;
    await until(async () => {
        ({ job } = (await s.api("GET", "/api/finish-status")).body);
        return !job?.running;
    });
    return { prepared, job };
}

/**
 * The files under a folder at a commit of the remote.
 * @param {object} r the repository
 * @param {string} ref the commit
 * @param {string} dir the folder
 * @returns {string[]} their paths
 */
const filesAt = (r, ref, dir) =>
    git(r.remote, "ls-tree", "-r", "--name-only", ref, "--", `${dir}/`).split("\n").filter(Boolean);

/**
 * The gate's approval check on the merge result of `feature` into master, as `gate --change pr:123`.
 * @param {object} r the repository
 * @param {object} [o] what to change
 * @param {object[] | null} [o.keys] the base's keys (default KEY's)
 * @param {"change" | "tree"} [o.mode] the mode
 * @returns {string[]} the problems
 */
function gateProblems(r, { keys = [KEY.entry], mode = "change" } = {}) {
    const merged = join(r.dir, `merge-${Math.random().toString(36).slice(2)}`);
    git(r.dir, "clone", "-q", "-b", "master", r.remote, merged);
    git(
        merged,
        "-c",
        "user.name=CI",
        "-c",
        "user.email=ci@example.com",
        "merge",
        "-q",
        "--no-ff",
        "--no-edit",
        "origin/feature",
    );
    const base = git(merged, "rev-parse", "HEAD^1");
    return approvalProblems({
        base,
        head: "HEAD",
        cwd: merged,
        baselines: BASELINES,
        approvals: APPROVALS,
        keys,
        mode,
        changes: ["pr:123"],
        repository: REPO_ID,
    }).problems;
}

const statementsOn = (r) =>
    filesAt(r, "feature", CHANGE_DIR).map((file) => JSON.parse(git(r.remote, "show", `feature:${file}`)));

describe("Finish in change mode", () => {
    it("writes one signed statement where its content says, which the gate passes, and no review record", async () => {
        const r = changeRepo();
        const s = await start(r);
        await decide(s, ALL);
        const { prepared, job } = await finishOnce(s);
        expect(prepared).toMatchObject({ required: true, signs: "change", tree: false });
        expect(job.error).toBeNull();
        expect(s.touches).toBe(1);
        expect(filesAt(r, "feature", `${BASELINES}/reviews`)).toEqual([]);
        const [file, ...more] = filesAt(r, "feature", APPROVALS);
        expect(more).toEqual([]);
        const st = JSON.parse(git(r.remote, "show", `feature:${file}`));
        expect(file).toBe(statementPath(APPROVALS, st));
        expect(st).toMatchObject({
            version: 2,
            repository: REPO_ID,
            change: "pr:123",
            capturedHead: r.head,
            previous: null,
        });
        expect(st.entries.map((e) => [e.path, e.decision])).toEqual([
            ["compact-mantine/badge--default.light.png", "accept"],
            ["compact-mantine/button--primary.dark.png", "accept"],
            ["compact-mantine/card--legacy.png", "accept"],
            ["compact-mantine/tooltip--hover.json", "exclude"],
            ["graphty-element/graph--basic.png", "accept"],
        ]);
        expect(st.entries.find((e) => e.decision === "exclude").reason).toBe("animation never settles");
        expect(git(r.remote, "log", "-1", "--format=%B", "feature")).toMatch(`Approval: ${file}`);
        expect(gateProblems(r)).toEqual([]);
        expect(gateProblems(r, { mode: "tree" })).toEqual([]);
    });

    it("signs a Finish that leaves images undecided: its statement holds only what it decided", async () => {
        const r = changeRepo();
        const s = await start(r);
        await decide(s, [["compact-mantine", BUTTON]]);
        const { prepared, job } = await finishOnce(s);
        expect(prepared).toMatchObject({ required: true, signs: "change" });
        expect(prepared.unsigned).toBeUndefined();
        expect(job.error).toBeNull();
        expect(statementsOn(r).map((st) => st.entries.map((e) => e.path))).toEqual([[`compact-mantine/${BUTTON}`]]);
        // The undecided images were not written, so the gate has only the one to check; the
        // capture check holds the rest back until they are decided.
        expect(gateProblems(r)).toEqual([]);
    });

    it("chains a second Finish to the first, and the two pass the gate together", async () => {
        const r = changeRepo();
        const s = await start(r);
        await decide(s, ALL.slice(0, 2));
        expect((await finishOnce(s)).job.error).toBeNull();
        await decide(s, ALL.slice(2));
        expect((await finishOnce(s)).job.error).toBeNull();
        const [first, second] = statementsOn(r).sort((a, b) =>
            a.previous === null ? -1 : b.previous === null ? 1 : 0,
        );
        expect(first.previous).toBeNull();
        expect(second.previous).toBe(statementId(first));
        expect(s.touches).toBe(2);
        expect(gateProblems(r)).toEqual([]);
    });

    it("rebuilds its commit on unrelated new commits pushed meanwhile, with one passkey touch in all", async () => {
        const r = changeRepo();
        const s = await start(r);
        await decide(s, ALL);
        const prepared = (await s.api("POST", "/api/finish-prepare", { id: "123" })).body;
        const approval = s.sign(prepared.statement);
        // The author pushes code while the reviewer touches the passkey.
        const author = secondCheckout(r, "author");
        git(author.repo, "checkout", "-q", "feature");
        commitAndPush(author.repo, { "src2.txt": "more\n" }, "more code");
        const pushedMeanwhile = git(author.repo, "rev-parse", "HEAD");
        await s.api("POST", "/api/finish", { id: "123", challenge: prepared.challenge, approval });
        let job;
        await until(async () => {
            ({ job } = (await s.api("GET", "/api/finish-status")).body);
            return !job?.running;
        });
        expect(job.error).toBeNull();
        expect(s.touches).toBe(1);
        expect(git(r.remote, "rev-parse", "feature^")).toBe(pushedMeanwhile);
        expect(statementsOn(r)).toHaveLength(1);
        expect(gateProblems(r)).toEqual([]);
    });

    it("chains two reviewers who decided different snapshots: the second Finishes after the first", async () => {
        const r = changeRepo();
        const other = secondCheckout(r, "other");
        const a = await start(r);
        const b = await start(other);
        await decide(a, ALL.slice(0, 2));
        await decide(b, ALL.slice(2));
        // B prepares and touches, then A's Finish lands first.
        const prepared = (await b.api("POST", "/api/finish-prepare", { id: "123" })).body;
        const approval = b.sign(prepared.statement);
        expect((await finishOnce(a)).job.error).toBeNull();
        await b.api("POST", "/api/finish", { id: "123", challenge: prepared.challenge, approval });
        let job;
        await until(async () => {
            ({ job } = (await b.api("GET", "/api/finish-status")).body);
            return !job?.running;
        });
        expect(job.error).toMatch(/decided no snapshot differently; nothing was pushed: press Finish again/);
        expect((await finishOnce(b)).job.error).toBeNull();
        expect(b.touches).toBe(2);
        const chain = statementsOn(r);
        const first = chain.find((st) => st.previous === null);
        expect(chain.find((st) => st !== first).previous).toBe(statementId(first));
        expect(gateProblems(r)).toEqual([]);
    });

    it("stops a second reviewer who decided one snapshot differently, naming it", async () => {
        const r = changeRepo();
        const other = secondCheckout(r, "other");
        const a = await start(r);
        const b = await start(other);
        await decide(a, [ALL[0], ["compact-mantine", BADGE, "reject", "the border is gone"]]);
        await decide(b, [ALL[1]]);
        const prepared = (await b.api("POST", "/api/finish-prepare", { id: "123" })).body;
        const approval = b.sign(prepared.statement);
        expect((await finishOnce(a)).job.error).toBeNull();
        await b.api("POST", "/api/finish", { id: "123", challenge: prepared.challenge, approval });
        let job;
        await until(async () => {
            ({ job } = (await b.api("GET", "/api/finish-status")).body);
            return !job?.running;
        });
        expect(job.error).toMatch(`decided compact-mantine/${BADGE} differently; nothing was pushed`);
        expect(statementsOn(r)).toHaveLength(1);
    });

    it("commits the statement unsigned while the default branch holds no key", async () => {
        const r = repoWith({ approvalFormat: "change", repositoryId: REPO_ID });
        const s = await start(r);
        await decide(s, ALL);
        const { prepared, job } = await finishOnce(s);
        expect(prepared.required).toBe(false);
        expect(job.error).toBeNull();
        const [st] = statementsOn(r);
        expect(st.approval).toBeUndefined();
        expect(filesAt(r, "feature", `${BASELINES}/reviews`)).toEqual([]);
        expect(gateProblems(r, { keys: null })).toEqual([]);
    });

    it("posts a Finish that only rejects, with no passkey asked and no statement written", async () => {
        const r = changeRepo();
        const s = await start(r);
        await decide(s, [["compact-mantine", BUTTON, "reject", "the border is gone"]]);
        const { prepared, job } = await finishOnce(s);
        expect(prepared.required).toBe(false);
        expect(job.error).toBeNull();
        expect(job.result).toMatchObject({ commit: null, rejects: 1, commentError: null });
        expect(s.touches).toBe(0);
        expect(git(r.remote, "rev-parse", "feature")).toBe(r.head);
        expect(filesAt(r, "feature", APPROVALS)).toEqual([]);
    });

    it("replaces a statement committed unsigned once a key lands, with one touch, and the gate passes", async () => {
        const r = repoWith({ approvalFormat: "change", repositoryId: REPO_ID });
        const before = await start(r);
        await decide(before, ALL);
        expect((await finishOnce(before)).job.error).toBeNull();
        expect(statementsOn(r)[0].approval).toBeUndefined();
        commitAndPush(r.repo, { [PASSKEYS_FILE]: passkeysJson(KEY) }, "key");
        expect(gateProblems(r)).not.toEqual([]);

        const s = await start(r);
        await decide(s, ALL);
        const { prepared, job } = await finishOnce(s);
        expect(prepared).toMatchObject({ required: true, signs: "change" });
        expect(job.error).toBeNull();
        expect(s.touches).toBe(1);
        const [st, ...more] = statementsOn(r);
        expect(more).toEqual([]);
        expect(st.previous).toBeNull();
        expect(st.approval).toBeDefined();
        expect(gateProblems(r)).toEqual([]);
    });
});

describe("Finish of a seed in change mode", () => {
    const SEED_BRANCH = /^visual\/seed-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}-[0-9a-f]{32}$/;

    /**
     * A capture of master by one CI run, as `serve --master-run` downloads it.
     * @param {object} r the repository
     * @param {number} [runId] the run
     * @returns {Record<string, { dir: string, results: object }>} the projects
     */
    const capture = (r, runId = 501) => ({
        "compact-mantine": copyFixture(
            "compact-mantine",
            join(r.dir, `run-${runId}-${Math.random()}/compact-mantine`),
            {
                commit: r.master,
                headSha: null,
                pr: null,
                runId,
                runAttempt: 1,
            },
        ),
    });

    /**
     * The code host of a seed test: its pull requests' heads follow their branches on the remote.
     * @param {object} r the repository
     * @returns {ReturnType<typeof fakeCodeHost>} the host
     */
    const seedHost = (r) =>
        fakeCodeHost({
            listOpened: true,
            headOf: (b) => git(r.remote, "rev-parse", "--verify", "-q", `refs/heads/${b}`),
        });

    /**
     * One seed Finish as the page runs it: prepare (which opens the pull request when the run has
     * none), one passkey touch, then Finish.
     * @param {object} r the repository
     * @param {object} host the code host
     * @param {[string, string?, string?][]} list file, decision (accept) and reason
     * @param {object} [o] what else
     * @param {Record<string, { dir: string, results: object }>} [o.projects] the run's capture
     * @param {string} [o.candidate] the candidate's commit
     * @param {boolean} [o.touch] false cancels the passkey touch
     * @param {object} [o.config] the configuration
     * @param {() => void} [o.meanwhile] what happens between the prepare and the Finish
     * @returns {Promise<{ prepared: object, result?: object, touches: number }>} what happened
     */
    async function seedFinish(
        r,
        host,
        list,
        { projects = capture(r), candidate, touch = true, config = FIXTURE_CONFIG, meanwhile = () => {} } = {},
    ) {
        const decisions = list.map(([file, decision = "accept", reason = null]) => ({
            project: "compact-mantine",
            file,
            decision,
            reason,
        }));
        const input = {
            repo: r.repo,
            codeHost: host,
            target: { pr: null, branch: null, ...(candidate && { candidate }) },
            projects,
            decisions,
            config,
            repository: REPO_ID,
            retryDelays: [],
        };
        const prepared = await prepareApproval({ ...input, now: new Date() });
        if (!touch) {
            return { prepared, touches: 0 };
        }
        const statement = { ...prepared.statement, approval: approve(prepared.statement, KEY, { origin: ORIGIN }) };
        // One more touch for each earlier seed of the capture this one retires.
        const retire = prepared.retire.map((r) => ({
            ...r,
            statement: { ...r.statement, approval: approve(r.statement, KEY, { origin: ORIGIN }) },
        }));
        const approval = {
            statement,
            commit: prepared.commit,
            branch: prepared.branch,
            origin: ORIGIN,
            pendingKeys: [],
            retire,
            close: prepared.close,
        };
        meanwhile();
        return { prepared, result: await finish({ ...input, approval }), touches: 1 + retire.length };
    }

    /**
     * The gate on the merge result of a seed branch into master, as `gate --pr N`.
     * @param {object} r the repository
     * @param {string} branch the seed branch
     * @param {string} change the change gated
     * @returns {string[]} the problems
     */
    function gateOn(r, branch, change) {
        const merged = join(r.dir, `merge-${Math.random().toString(36).slice(2)}`);
        git(r.dir, "clone", "-q", "-b", "master", r.remote, merged);
        git(
            merged,
            "-c",
            "user.name=CI",
            "-c",
            "user.email=ci@example.com",
            "merge",
            "-q",
            "--no-ff",
            "--no-edit",
            `origin/${branch}`,
        );
        return approvalProblems({
            base: git(merged, "rev-parse", "HEAD^1"),
            head: "HEAD",
            cwd: merged,
            baselines: BASELINES,
            approvals: APPROVALS,
            keys: [KEY.entry],
            mode: "change",
            changes: [change],
            repository: REPO_ID,
        }).problems;
    }

    const seedStatements = (r, branch) =>
        git(r.remote, "diff", "--name-only", "--diff-filter=A", `master...${branch}`, "--", `${APPROVALS}/`)
            .split("\n")
            .filter(Boolean)
            .map((file) => ({ file, ...JSON.parse(git(r.remote, "show", `${branch}:${file}`)) }));

    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("opens the pull request first, signs one seed statement with one touch, and the gate passes", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const { prepared, result, touches } = await seedFinish(r, host, [[BADGE]]);
        // The pull request was open before the touch: prepare opened it, and its number is signed.
        expect(prepared.opened).toBe("https://fake/changes/900");
        expect(prepared.statement).toMatchObject({ type: "seed-approval", change: "pr:900", capturedHead: r.master });
        expect(touches).toBe(1);
        expect(host.opened).toHaveLength(1);
        const [{ branch }] = host.opened;
        expect(branch).toMatch(SEED_BRANCH);
        expect(result).toMatchObject({ branch, pullRequest: "https://fake/changes/900" });
        // X' replaced X: one commit on the captured commit, holding the baselines and the statement.
        expect(git(r.remote, "rev-list", "--count", `${r.master}..${branch}`)).toBe("1");
        const [st] = seedStatements(r, branch);
        expect(st.previous).toBeNull();
        expect(host.posted.find((p) => p.kind === "update")?.body).toContain("Seeds visual baselines from master");
        expect(gateOn(r, branch, "pr:900")).toEqual([]);
        // The statement counts for its own pull request only.
        expect(gateOn(r, branch, "pr:901")[0]).toContain("not reviewed");
    });

    it("uses the pull request GitHub opened when the answer to opening it was lost", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const open = host.openChange;
        host.openChange = async (change) => {
            await open(change);
            throw new Error("connection reset");
        };
        const { prepared, result } = await seedFinish(r, host, [[BADGE]]);
        expect(prepared.statement.change).toBe("pr:900");
        expect(host.opened).toHaveLength(1);
        expect(result.pullRequest).toBe("https://fake/changes/900");
        expect(gateOn(r, host.opened[0].branch, "pr:900")).toEqual([]);
    });

    it("refuses to push a signed seed whose pull request was closed while the touch waited", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await expect(
            seedFinish(r, host, [[BADGE]], {
                projects,
                meanwhile: () => {
                    host.opened[0].state = "closed";
                },
            }),
        ).rejects.toThrow("https://fake/changes/900, the pull request of this seed, was closed");
        expect(seedStatements(r, host.opened[0].branch)).toEqual([]);
        // The next Finish starts a fresh seed branch.
        await seedFinish(r, host, [[BADGE]], { projects });
        expect(host.opened.map((o) => o.state)).toEqual(["closed", "open"]);
    });

    it("leaves the pull request failing as not reviewed after a cancelled touch, and the next Finish replaces X", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, touch: false });
        const [{ branch }] = host.opened;
        expect(seedStatements(r, branch)).toEqual([]);
        expect(gateOn(r, branch, "pr:900").join("\n")).toContain("not reviewed");
        const { result } = await seedFinish(r, host, [[BADGE]], { projects });
        expect(result.branch).toBe(branch);
        expect(host.opened).toHaveLength(1);
        expect(git(r.remote, "rev-list", "--count", `${r.master}..${branch}`)).toBe("1");
        expect(gateOn(r, branch, "pr:900")).toEqual([]);
    });

    it("chains a second Finish of the run onto its seed branch, and a later reject there fails the gate", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        await seedFinish(r, host, [[BUTTON]], { projects });
        const [{ branch }] = host.opened;
        expect(host.opened).toHaveLength(1);
        const chain = seedStatements(r, branch);
        const first = chain.find((st) => st.previous === null);
        const { file, ...doc } = first;
        expect(chain.find((st) => st !== first).previous).toBe(statementId(doc));
        expect(gateOn(r, branch, "pr:900")).toEqual([]);
        await seedFinish(r, host, [[BADGE, "reject", "caught mid-animation"], [BUTTON]], { projects });
        expect(gateOn(r, branch, "pr:900")).toEqual([
            `${BASELINES}/compact-mantine/${BADGE}: rejected (caught mid-animation); a rejected item needs a code change, not another review`,
        ]);
        expect(file).toBeDefined();
    });

    it("gives two runs of master seeded on one day two branches and two pull requests", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        await seedFinish(r, host, [[BADGE]], { projects: capture(r, 501) });
        await seedFinish(r, host, [[BUTTON]], { projects: capture(r, 502) });
        expect(host.opened.map((o) => o.number)).toEqual([900, 901]);
        expect(new Set(host.opened.map((o) => o.branch)).size).toBe(2);
    });

    it("after a restart without its records, goes to a fresh branch and closes the old seed pull request", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await seedFinish(r, host, [[BADGE, "reject", "caught mid-animation"], [BUTTON]], { projects });
        expect(host.opened.map((o) => [o.number, o.state])).toEqual([
            [900, "closed"],
            [901, "open"],
        ]);
        // No open pull request holds the earlier accept: the new one leaves the rejected image out.
        const fresh = host.opened[1].branch;
        const badge = `${BASELINES}/compact-mantine/${BADGE}`;
        expect(git(r.remote, "ls-tree", "--name-only", fresh, "--", badge)).toBe("");
        // The old seed's branch is deleted, so nobody can reopen its pull request with the accept.
        expect(git(r.remote, "branch", "--list", host.opened[0].branch)).toBe("");
        expect(seedStatements(r, fresh)[0].entries.find((e) => e.decision === "reject")).toMatchObject({
            path: `compact-mantine/${BADGE}`,
            reason: "caught mid-animation",
        });
        expect(gateOn(r, fresh, "pr:901")).toEqual([]);
    });

    it("closes the old seed pull request after a restart even when ignoreBranches hides seed branches", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        const config = { ...FIXTURE_CONFIG, ignoreBranches: ["visual/"] };
        await seedFinish(r, host, [[BADGE]], { projects, config });
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await seedFinish(r, host, [[BADGE, "reject", "caught mid-animation"], [BUTTON]], { projects, config });
        expect(host.opened.map((o) => [o.number, o.state])).toEqual([
            [900, "closed"],
            [901, "open"],
        ]);
    });

    it("refuses and closes a recorded seed branch someone pushed a code commit to, naming the commit", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [{ branch }] = host.opened;
        const other = join(r.dir, "intruder");
        git(r.dir, "clone", "-q", "-b", branch, r.remote, other);
        writeFileSync(join(other, "src.txt"), "code\n");
        git(other, "add", "-A");
        git(other, "-c", "user.name=I", "-c", "user.email=i@example.com", "commit", "-q", "-m", "code");
        git(other, "push", "-q", "origin", branch);
        const code = git(other, "rev-parse", "HEAD");
        await expect(seedFinish(r, host, [[BUTTON]], { projects })).rejects.toThrow(
            `commit ${code.slice(0, 12)} is not a Finish commit of this seed (it changes src.txt)`,
        );
        expect(host.opened[0].state).toBe("closed");
        expect(git(r.remote, "branch", "--list", branch)).not.toBe("");
        // The next Finish starts a fresh seed branch with a pull request of its own and leaves the
        // closed one as it is.
        const { prepared } = await seedFinish(r, host, [[BUTTON]], { projects });
        expect(prepared.retire).toEqual([]);
        expect(host.opened.map((o) => o.state)).toEqual(["closed", "open"]);
        expect(git(r.remote, "rev-parse", branch)).toBe(code);
    });

    it("refuses and closes a recorded seed whose pull request comes from another repository", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const real = host.change;
        host.change = async (n) => ({ ...(await real(n)), head: { ref: host.opened[0].branch, repo: { id: 2 } } });
        await expect(seedFinish(r, host, [[BUTTON]], { projects })).rejects.toThrow(
            "its pull request comes from another repository",
        );
        expect(host.opened[0].state).toBe("closed");
    });

    /**
     * Whether anything touched pull request 900 or its branch after `before` posts: no reopen,
     * close or push.
     * @param {object} r the repository
     * @param {object} host the fake code host
     * @param {number} before the posts before
     * @param {string | null} tip the branch's tip before (null: deleted)
     */
    function untouched(r, host, before, tip) {
        expect(host.posted.slice(before).filter((p) => p.number === 900)).toEqual([]);
        const branch = host.opened.find((o) => o.number === 900).branch;
        expect(git(r.remote, "branch", "--list", branch) === "" ? null : git(r.remote, "rev-parse", branch)).toBe(tip);
    }

    /**
     * The head GitHub keeps for each pull request (refs/pull/N/head): its branch's tip when it is
     * closed, which "Restore branch" brings back after the branch is deleted.
     * @param {object} r the repository
     * @param {object} host the fake code host
     * @returns {Map<number, string>} the heads, by number
     */
    function keptHeads(r, host) {
        const heads = new Map();
        const close = host.closeChange;
        host.closeChange = async (number) => {
            heads.set(number, git(r.remote, "rev-parse", host.opened.find((o) => o.number === number).branch));
            return close(number);
        };
        return heads;
    }

    it("never lets a seed pull request closed by hand with its branch kept block a later Finish", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [old] = host.opened;
        old.state = "closed";
        const tip = git(r.remote, "rev-parse", old.branch);
        const before = host.posted.length;
        // With its record, then twice more after restarts lost it.
        await seedFinish(r, host, [[BADGE, "reject", "caught mid-animation"], [BUTTON]], { projects });
        for (let i = 0; i < 2; i++) {
            rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
            const { prepared } = await seedFinish(r, host, [[BUTTON]], { projects });
            expect(prepared.retire.map((x) => x.number)).not.toContain(900);
        }
        expect(old.state).toBe("closed");
        untouched(r, host, before, tip);
    });

    it("retires an earlier seed with a signed reject on its branch, so restoring and reopening it fails the gate", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const heads = keptHeads(r, host);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [old] = host.opened;
        const [accepted] = seedStatements(r, old.branch);
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        const { prepared, touches } = await seedFinish(r, host, [[BUTTON]], { projects });
        expect(prepared.retire.map((x) => x.number)).toEqual([900]);
        expect(touches).toBe(2);
        expect(host.opened.map((o) => [o.number, o.state])).toEqual([
            [900, "closed"],
            [901, "open"],
        ]);
        expect(git(r.remote, "branch", "--list", old.branch)).toBe("");
        // "Restore branch", then reopen: the head GitHub kept holds the retiring statement.
        git(r.remote, "branch", old.branch, heads.get(900));
        const chain = seedStatements(r, old.branch);
        const { file, ...doc } = accepted;
        expect(chain.find((st) => st.file !== file)).toMatchObject({
            change: "pr:900",
            previous: statementId(doc),
            entries: [{ path: `compact-mantine/${BADGE}`, decision: "reject" }],
        });
        expect(gateOn(r, old.branch, "pr:900")).toEqual([
            `${BASELINES}/compact-mantine/${BADGE}: rejected (retired: a later Finish of this capture replaced this seed); a rejected item needs a code change, not another review`,
        ]);
        expect(gateOn(r, host.opened[1].branch, "pr:901")).toEqual([]);
    });

    it("never lets a seed pull request closed with its branch deleted block a later Finish", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [old] = host.opened;
        await host.closeChange(old.number);
        git(r.remote, "branch", "-D", old.branch);
        const before = host.posted.length;
        for (let i = 0; i < 2; i++) {
            rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
            const { prepared } = await seedFinish(r, host, [[BUTTON]], { projects });
            expect(prepared.retire.map((x) => x.number)).not.toContain(900);
        }
        expect(old.state).toBe("closed");
        untouched(r, host, before, null);
    });

    it("never lets a candidate's accept pull request closed with its branch deleted block a reject", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, candidate: r.master });
        const [old] = host.opened;
        await host.closeChange(old.number);
        git(r.remote, "branch", "-D", old.branch);
        const before = host.posted.length;
        const input = {
            repo: r.repo,
            codeHost: host,
            target: { pr: null, branch: null, candidate: r.master },
            projects,
            decisions: [{ project: "compact-mantine", file: BADGE, decision: "reject", reason: "clipped" }],
            config: FIXTURE_CONFIG,
            repository: REPO_ID,
            retryDelays: [],
        };
        expect(await prepareApproval({ ...input, now: new Date() })).toBeNull();
        expect(await finish(input)).toMatchObject({ rejects: 1 });
        expect(old.state).toBe("closed");
        untouched(r, host, before, null);
    });

    it("leaves alone another pull request whose branch only carries a seed's commits", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [old] = host.opened;
        git(r.remote, "branch", "dev/x", old.branch);
        const list = host.listChanges;
        host.listChanges = async (c) => [
            ...(await list(c)),
            { number: 77, url: "https://fake/changes/77", branch: "dev/x", fork: false },
        ];
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await seedFinish(r, host, [[BUTTON]], { projects, touch: false });
        await seedFinish(r, host, [[BUTTON]], { projects });
        expect(host.posted.filter((p) => p.number === 77)).toEqual([]);
        expect(git(r.remote, "branch", "--list", "dev/x")).not.toBe("");
        expect(old.state).toBe("closed");
    });

    it("closes a run's seed pull request holding only its images after a restart, but only after the touch", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, touch: false });
        const [old] = host.opened;
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await seedFinish(r, host, [[BUTTON]], { projects, touch: false });
        expect(old.state).toBe("open");
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await seedFinish(r, host, [[BUTTON]], { projects });
        expect(old.state).toBe("closed");
        expect(git(r.remote, "branch", "--list", old.branch)).toBe("");
    });

    it("refuses a seed Finish on a code host that cannot list its changes", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        delete host.listChanges;
        await expect(seedFinish(r, host, [[BADGE]])).rejects.toThrow("the code host cannot list its changes");
    });

    it("skips an earlier seed someone closed after the prepare, never reopening it or recreating its branch", async () => {
        for (const deleted of [false, true]) {
            const r = changeRepo();
            const host = seedHost(r);
            const projects = capture(r);
            await seedFinish(r, host, [[BADGE]], { projects });
            const [old] = host.opened;
            const tip = git(r.remote, "rev-parse", old.branch);
            rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
            let before = 0;
            const { prepared } = await seedFinish(r, host, [[BUTTON]], {
                projects,
                meanwhile: () => {
                    old.head = tip;
                    old.state = "closed";
                    if (deleted) {
                        git(r.remote, "branch", "-D", old.branch);
                    }
                    before = host.posted.length;
                },
            });
            expect(prepared.retire.map((x) => x.number)).toEqual([900]);
            expect(old.state).toBe("closed");
            untouched(r, host, before, deleted ? null : tip);
            expect(host.opened[1].state).toBe("open");
        }
    });

    it("keeps an earlier seed's branch and refuses when its pull request's head never reaches the retiring commit", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [old] = host.opened;
        const accepted = git(r.remote, "rev-parse", old.branch);
        const real = host.change;
        host.change = async (n) => {
            const c = await real(n);
            return n === 900 ? { ...c, head: { ...c.head, sha: accepted } } : c;
        };
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await expect(seedFinish(r, host, [[BUTTON]], { projects })).rejects.toThrow(
            `its branch ${old.branch} is kept with the retiring statement: press Finish again`,
        );
        expect(old.state).toBe("open");
        expect(git(r.remote, "branch", "--list", old.branch)).not.toBe("");
    });

    it("skips the closed pull request a seed statement names, closing only a later one opened from its branch", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [old] = host.opened;
        old.head = git(r.remote, "rev-parse", old.branch);
        old.state = "closed";
        const later = {
            number: 950,
            html_url: "https://fake/changes/950",
            branch: old.branch,
            state: "open",
            body: "",
        };
        host.opened.push(later);
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        const before = host.posted.length;
        const { prepared } = await seedFinish(r, host, [[BUTTON]], { projects });
        expect(prepared.retire).toEqual([]);
        expect(later.state).toBe("closed");
        expect(host.posted.slice(before).filter((p) => p.number === 900)).toEqual([]);
    });

    it("does not retire again a seed an earlier Finish already retired", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await seedFinish(r, host, [[BUTTON]], { projects });
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        const before = host.posted.length;
        const { prepared, touches } = await seedFinish(r, host, [[BADGE]], { projects });
        expect(prepared.retire.map((x) => x.number)).toEqual([901]);
        expect(touches).toBe(2);
        expect(host.posted.slice(before).filter((p) => p.number === 900)).toEqual([]);
    });

    it("refuses a seed Finish when another seed of the capture was opened after the prepare", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [first] = host.opened;
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        const other = `${first.branch}-other`;
        await expect(
            seedFinish(r, host, [[BUTTON]], {
                projects,
                meanwhile: () => {
                    git(r.remote, "branch", other, "master");
                    host.opened.push({
                        number: 970,
                        html_url: "https://fake/changes/970",
                        branch: other,
                        state: "open",
                        body: "",
                    });
                },
            }),
        ).rejects.toThrow(
            "https://fake/changes/970 holds a seed of this capture that changed since this Finish was prepared",
        );
        expect(host.opened.find((o) => o.number === 900)?.state).toBe("open");
    });

    it("refuses a seed Finish when an earlier seed it only closes moved after the prepare, keeping it", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, touch: false });
        const [old] = host.opened;
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await expect(
            seedFinish(r, host, [[BUTTON]], {
                projects,
                // The other Finish's touch lands on its branch meanwhile.
                meanwhile: () => git(r.remote, "update-ref", `refs/heads/${old.branch}`, r.master),
            }),
        ).rejects.toThrow(
            "https://fake/changes/900 holds a seed of this capture that changed since this Finish was prepared",
        );
        expect(old.state).toBe("open");
        expect(git(r.remote, "branch", "--list", old.branch)).not.toBe("");
    });

    it("rejects that image in an earlier seed of the run when a later Finish of it only rejects it", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE], [BUTTON]], { projects });
        const [old] = host.opened;
        const { prepared, result, touches } = await seedFinish(r, host, [[BADGE, "reject", "clipped"]], { projects });
        expect(prepared.statement).toMatchObject({
            change: "pr:900",
            entries: [{ path: `compact-mantine/${BADGE}`, decision: "reject" }],
        });
        expect(touches).toBe(1);
        expect(result).toMatchObject({ rejects: 1 });
        expect(result.closedPullRequest).toBeUndefined();
        // The seed stays open with BUTTON accepted and BADGE rejected.
        expect(old.state).toBe("open");
        expect(gateOn(r, old.branch, "pr:900")).toEqual([
            `${BASELINES}/compact-mantine/${BADGE}: rejected (rejected by a later Finish of this capture); a rejected item needs a code change, not another review`,
        ]);
    });

    it("leaves an earlier seed of the run alone when a later Finish of it only rejects another image", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE], [BUTTON]], { projects });
        const [old] = host.opened;
        const tip = git(r.remote, "rev-parse", old.branch);
        const before = host.posted.length;
        const input = {
            repo: r.repo,
            codeHost: host,
            target: { pr: null, branch: null },
            projects,
            decisions: [{ project: "compact-mantine", file: "slider--sizes.png", decision: "reject", reason: "cut" }],
            config: FIXTURE_CONFIG,
            repository: REPO_ID,
            retryDelays: [],
            now: new Date(),
        };
        // Nothing of the seed is signed: the image rejected now is not in it.
        expect(await prepareApproval(input)).toBeNull();
        expect(await finish(input)).toMatchObject({ rejects: 1 });
        expect(old.state).toBe("open");
        expect(git(r.remote, "rev-parse", old.branch)).toBe(tip);
        expect(host.posted.slice(before).filter((p) => p.number === 900)).toEqual([]);
        expect(gateOn(r, old.branch, "pr:900")).toEqual([]);
    });

    it("ignores a forged unsigned statement on a visual/ branch, asking for no extra touch", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const [{ branch }] = host.opened;
        const [accepted] = seedStatements(r, branch);
        const forged = { ...accepted, change: "pr:960", previous: null };
        delete forged.file;
        delete forged.approval;
        const other = join(r.dir, "forger");
        git(r.dir, "clone", "-q", "-b", "master", r.remote, other);
        git(other, "checkout", "-q", "-b", "visual/x-1");
        writeFileSync(join(other, "x.txt"), "x\n");
        mkdirSync(join(other, statementPath(APPROVALS, forged), ".."), { recursive: true });
        writeFileSync(join(other, statementPath(APPROVALS, forged)), `${JSON.stringify(forged, null, 2)}\n`);
        git(other, "add", "-A");
        git(other, "-c", "user.name=F", "-c", "user.email=f@example.com", "commit", "-q", "-m", "forged");
        git(other, "push", "-q", "origin", "visual/x-1");
        host.opened.push({ number: 960, html_url: "https://fake/changes/960", branch: "visual/x-1", state: "closed" });
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        const { prepared, touches } = await seedFinish(r, host, [[BUTTON]], { projects });
        expect(prepared.retire.map((x) => x.number)).toEqual([900]);
        expect(touches).toBe(2);
        expect(host.posted.some((p) => p.number === 960)).toBe(false);
    });

    it("adds a candidate's second Finish as one commit on its branch's tip, chained after the first", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, candidate: r.master });
        const [{ branch }] = host.opened;
        expect(branch).toMatch(/^visual\/approve-[0-9a-f]{12}-[0-9a-f]{32}$/);
        const tip = git(r.remote, "rev-parse", branch);
        await seedFinish(r, host, [[BADGE], [BUTTON]], { projects, candidate: r.master });
        expect(git(r.remote, "rev-parse", `${branch}^`)).toBe(tip);
        expect(seedStatements(r, branch)).toHaveLength(2);
        expect(gateOn(r, branch, "pr:900")).toEqual([]);
    });

    it("retires a candidate's accept pull request with a signed reject when a later Finish rejects an image", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const heads = keptHeads(r, host);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, candidate: r.master });
        const [old] = host.opened;
        const { prepared, result, touches } = await seedFinish(r, host, [[BADGE, "reject", "clipped"]], {
            projects,
            candidate: r.master,
        });
        expect(prepared.statement).toMatchObject({ change: "pr:900", entries: [{ decision: "reject" }] });
        expect(touches).toBe(1);
        expect(result).toMatchObject({ rejects: 1, closedPullRequest: "https://fake/changes/900" });
        expect(old.state).toBe("closed");
        expect(git(r.remote, "branch", "--list", old.branch)).toBe("");
        // "Restore branch", then reopen: the head GitHub kept holds the retiring statement.
        git(r.remote, "branch", old.branch, heads.get(900));
        expect(gateOn(r, old.branch, "pr:900").join("\n")).toContain("rejected (retired:");
    });

    it("retires a candidate's accept pull request from a second server that holds no record of it", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const heads = keptHeads(r, host);
        await seedFinish(r, host, [[BADGE]], { projects: capture(r), candidate: r.master });
        const [old] = host.opened;
        const second = secondCheckout(r, "second");
        const { prepared, result, touches } = await seedFinish(second, host, [[BADGE, "reject", "clipped"]], {
            projects: capture(second),
            candidate: r.master,
        });
        expect(prepared.statement).toMatchObject({ change: "pr:900", entries: [{ decision: "reject" }] });
        expect(touches).toBe(1);
        expect(result).toMatchObject({ rejects: 1, closedPullRequest: "https://fake/changes/900" });
        expect(old.state).toBe("closed");
        expect(git(r.remote, "branch", "--list", old.branch)).toBe("");
        git(r.remote, "branch", old.branch, heads.get(900));
        expect(gateOn(r, old.branch, "pr:900").join("\n")).toContain("rejected (retired:");
    });

    it("refuses a candidate reject when the code host cannot be read, posting nothing", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, candidate: r.master });
        const [old] = host.opened;
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        const before = host.posted.length;
        host.listChanges = async () => {
            throw new Error("HTTP 502");
        };
        const input = {
            repo: r.repo,
            codeHost: host,
            target: { pr: null, branch: null, candidate: r.master },
            projects,
            decisions: [{ project: "compact-mantine", file: BADGE, decision: "reject", reason: "clipped" }],
            config: FIXTURE_CONFIG,
            repository: REPO_ID,
            retryDelays: [],
        };
        const refused = "the seeds of this capture could not be looked up: listing the open changes failed (HTTP 502)";
        await expect(prepareApproval({ ...input, now: new Date() })).rejects.toThrow(refused);
        await expect(finish(input)).rejects.toThrow(refused);
        expect(old.state).toBe("open");
        expect(host.posted.slice(before)).toEqual([]);
        expect(git(r.remote, "branch", "--list", old.branch)).not.toBe("");
    });

    it("refuses a candidate reject when its accept branch cannot be fetched, keeping the pull request and its record", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, candidate: r.master });
        const [old] = host.opened;
        // The branch moves and a held lock makes fetching it fail while the remote still lists it.
        const lock = join(
            git(r.repo, "rev-parse", "--absolute-git-dir"),
            `refs/visual-review/origin/${old.branch}.lock`,
        );
        const reject = (meanwhile) =>
            seedFinish(r, host, [[BADGE, "reject", "clipped"]], { projects, candidate: r.master, meanwhile });
        await expect(
            reject(() => {
                const other = join(r.dir, "mover");
                git(r.dir, "clone", "-q", "-b", old.branch, r.remote, other);
                git(
                    other,
                    "-c",
                    "user.name=M",
                    "-c",
                    "user.email=m@example.com",
                    "commit",
                    "-q",
                    "--allow-empty",
                    "-m",
                    "move",
                );
                git(other, "push", "-q", "origin", old.branch);
                mkdirSync(join(lock, ".."), { recursive: true });
                writeFileSync(lock, "");
            }),
        ).rejects.toThrow("could not be read");
        expect(old.state).toBe("open");
        expect(git(r.remote, "branch", "--list", old.branch)).not.toBe("");
        rmSync(lock);
        const { result } = await reject();
        expect(result).toMatchObject({ closedPullRequest: "https://fake/changes/900" });
        expect(old.state).toBe("closed");
        expect(git(r.remote, "branch", "--list", old.branch)).toBe("");
    });

    it("forgets a candidate's merged accept pull request instead of retiring it", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects, candidate: r.master });
        const [old] = host.opened;
        old.merged = true;
        const input = {
            repo: r.repo,
            codeHost: host,
            target: { pr: null, branch: null, candidate: r.master },
            projects,
            decisions: [{ project: "compact-mantine", file: BADGE, decision: "reject", reason: "clipped" }],
            config: FIXTURE_CONFIG,
            repository: REPO_ID,
            retryDelays: [],
        };
        expect(await prepareApproval({ ...input, now: new Date() })).toBeNull();
        await finish(input);
        expect(host.posted.filter((p) => p.number === 900 && p.kind === "close")).toEqual([]);
        expect(git(r.remote, "branch", "--list", old.branch)).not.toBe("");
    });

    it("signs nothing for a Finish rejecting an image of a candidate with no accept pull request", async () => {
        const r = changeRepo();
        const host = seedHost(r);
        const prepared = await prepareApproval({
            repo: r.repo,
            codeHost: host,
            target: { pr: null, branch: null, candidate: r.master },
            projects: capture(r),
            decisions: [{ project: "compact-mantine", file: BADGE, decision: "reject", reason: "clipped" }],
            config: FIXTURE_CONFIG,
            repository: REPO_ID,
            retryDelays: [],
            now: new Date(),
        });
        expect(prepared).toBeNull();
    });

    it("retires a candidate's unsigned accept pull request unsigned while the default branch holds no key", async () => {
        const r = repoWith({ approvalFormat: "change", repositoryId: REPO_ID });
        const host = seedHost(r);
        const heads = keptHeads(r, host);
        const projects = capture(r);
        const run = (decision, reason) =>
            finish({
                repo: r.repo,
                codeHost: host,
                target: { pr: null, branch: null, candidate: r.master },
                projects,
                decisions: [{ project: "compact-mantine", file: BADGE, decision, reason }],
                config: FIXTURE_CONFIG,
                repository: REPO_ID,
                retryDelays: [],
            });
        await run("accept", null);
        const [old] = host.opened;
        const result = await run("reject", "clipped");
        expect(result).toMatchObject({ closedPullRequest: "https://fake/changes/900" });
        expect(git(r.remote, "branch", "--list", old.branch)).toBe("");
        git(r.remote, "branch", old.branch, heads.get(900));
        expect(seedStatements(r, old.branch).map((st) => st.entries[0].decision)).toEqual(
            expect.arrayContaining(["accept", "reject"]),
        );
    });

    it("commits the seed statement unsigned while the default branch holds no key, replacing X in the same Finish", async () => {
        const r = repoWith({ approvalFormat: "change", repositoryId: REPO_ID });
        const host = seedHost(r);
        const result = await finish({
            repo: r.repo,
            codeHost: host,
            target: { pr: null, branch: null },
            projects: capture(r),
            decisions: [{ project: "compact-mantine", file: BADGE, decision: "accept", reason: null }],
            config: FIXTURE_CONFIG,
            repository: REPO_ID,
            retryDelays: [],
        });
        const [{ branch }] = host.opened;
        expect(result).toMatchObject({ branch, pullRequest: "https://fake/changes/900" });
        expect(git(r.remote, "rev-list", "--count", `${r.master}..${branch}`)).toBe("1");
        const [st] = seedStatements(r, branch);
        expect(st).toMatchObject({ type: "seed-approval", change: "pr:900" });
        expect(st.approval).toBeUndefined();
    });

    it("seeds with branch: on a code host that opens no pull requests, pushing nothing before the touch", async () => {
        const r = changeRepo();
        const host = fakeCodeHost();
        delete host.openChange;
        const { prepared, result } = await seedFinish(r, host, [[BADGE]]);
        expect(prepared.opened).toBeUndefined();
        expect(prepared.statement.change).toBe(`branch:${prepared.branch}`);
        expect(result.pullRequest).toBeNull();
        expect(gateOn(r, prepared.branch, `branch:${prepared.branch}`)).toEqual([]);
    });

    it("on plain git, reads a local-only branch where it is and refuses only for an old seed branch", async () => {
        const r = changeRepo();
        git(r.repo, "branch", "my-local-work", "master");
        const host = plainGitCodeHost(r.repo, FIXTURE_CONFIG);
        const projects = capture(r);
        const { prepared } = await seedFinish(r, host, [[BADGE]], { projects });
        git(r.repo, "fetch", "-q", "origin");
        rmSync(join(r.repo, FIXTURE_CONFIG.workDir, "seed-branches.json"));
        await expect(seedFinish(r, host, [[BUTTON]], { projects })).rejects.toThrow(
            `${prepared.branch} holds an earlier seed of this capture: close or delete it, then press Finish again`,
        );
    });
});

describe("Finish in tree mode", () => {
    // graphty-monorepo's shape: tree statements in the approvals directory, no approvalFormat.
    const treeShaped = (feature = {}) => {
        const r = makeRepo();
        const own = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
        delete own.approvalFormat;
        const tree = git(r.repo, "rev-parse", `master:${BASELINES}`);
        const earlier = {
            version: 1,
            commit: r.master,
            tree,
            baselines: BASELINES,
            pr: 1,
            approvedAt: "2026-10-01T00:00:00.000Z",
        };
        const signed = { ...earlier, approval: approve(earlier, KEY, { origin: ORIGIN }) };
        commitAndPush(
            r.repo,
            { [CONFIG_FILE]: own, [PASSKEYS_FILE]: passkeysJson(KEY), [`${APPROVALS}/${tree}.json`]: signed },
            "base",
        );
        git(r.repo, "checkout", "-q", "feature");
        git(r.repo, "merge", "-q", "--no-edit", "master");
        if (Object.keys(feature).length > 0) {
            commitAndPush(r.repo, feature, "feature config");
        }
        git(r.repo, "push", "-q", "origin", "feature");
        const head = git(r.repo, "rev-parse", "HEAD");
        git(r.repo, "checkout", "-q", "master");
        return { ...r, head };
    };

    /**
     * Finishes every image of #123 and returns what the branch gained.
     * @param {object} r the repository
     * @returns {Promise<{ prepared: object, reviews: string[], approvals: string[] }>} it
     */
    async function finishAll(r) {
        const s = await start(r);
        await decide(s, ALL);
        await decide(s, [
            ["compact-mantine", "slider--sizes.png"],
            ["compact-mantine", "menu--open.png", "exclude", "noisy"],
        ]);
        const { prepared, job } = await finishOnce(s);
        expect(job.error).toBeNull();
        return {
            prepared,
            reviews: filesAt(r, "feature", `${BASELINES}/reviews`),
            approvals: filesAt(r, "feature", APPROVALS),
        };
    }

    it("writes a tree statement and a review record on a repository shaped like graphty-monorepo, which the old gate passes", async () => {
        const r = treeShaped();
        const { prepared, reviews, approvals } = await finishAll(r);
        expect(prepared).toMatchObject({ signs: "tree", tree: true });
        expect(reviews).toHaveLength(1);
        expect(approvals).toHaveLength(2);
        expect(approvals.every((f) => !f.slice(APPROVALS.length + 1).includes("/"))).toBe(true);
        const merged = join(r.dir, "merged");
        git(r.dir, "clone", "-q", "-b", "master", r.remote, merged);
        git(
            merged,
            "-c",
            "user.name=CI",
            "-c",
            "user.email=ci@example.com",
            "merge",
            "-q",
            "--no-ff",
            "--no-edit",
            "origin/feature",
        );
        const base = git(merged, "rev-parse", "HEAD^1");
        const { keys, problems } = oldGate.approvalKeys(base, "HEAD", merged);
        expect(problems).toEqual([]);
        expect(
            oldGate.treeApprovalProblems({
                base,
                head: "HEAD",
                cwd: merged,
                baselines: BASELINES,
                approvals: APPROVALS,
                keys,
            }),
        ).toEqual([]);
    });

    it("keeps tree statements when only the unmerged branch's config asks for change statements", async () => {
        const own = JSON.parse(readFileSync(join(makeRepo().repo, CONFIG_FILE), "utf8"));
        delete own.approvalFormat;
        const r = treeShaped({ [CONFIG_FILE]: { ...own, approvalFormat: "change", repositoryId: REPO_ID } });
        const { prepared, reviews, approvals } = await finishAll(r);
        expect(prepared.signs).toBe("tree");
        expect(reviews).toHaveLength(1);
        expect(approvals.every((f) => !f.slice(APPROVALS.length + 1).includes("/"))).toBe(true);
    });
});

describe("approvalFormatAt", () => {
    it("takes approvalFormat from the ref's config, and otherwise tree only where tree statements alone are", () => {
        const r = makeRepo();
        const at = (files) => {
            const own = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
            delete own.approvalFormat;
            commitAndPush(r.repo, { [CONFIG_FILE]: { ...own, ...files.config }, ...files.more }, "settings");
            return approvalFormatAt("HEAD", r.repo);
        };
        expect(approvalFormatAt("HEAD", r.repo)).toEqual({ format: "tree", repositoryId: null });
        expect(at({ more: {} })).toEqual({ format: "change", repositoryId: null });
        expect(at({ more: { [`${APPROVALS}/${"a".repeat(40)}.json`]: "{}\n" } }).format).toBe("tree");
        expect(at({ more: { [`${CHANGE_DIR}/x.json`]: "{}\n" } }).format).toBe("change");
        expect(at({ config: { approvalFormat: "tree", repositoryId: "id-1" }, more: {} })).toEqual({
            format: "tree",
            repositoryId: "id-1",
        });
    });
});
