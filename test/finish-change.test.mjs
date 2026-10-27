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
     * @returns {Promise<{ prepared: object, result?: object, touches: number }>} what happened
     */
    async function seedFinish(
        r,
        host,
        list,
        { projects = capture(r), candidate, touch = true, config = FIXTURE_CONFIG } = {},
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
        const approval = {
            statement,
            commit: prepared.commit,
            branch: prepared.branch,
            origin: ORIGIN,
            pendingKeys: [],
        };
        return { prepared, result: await finish({ ...input, approval }), touches: 1 };
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
        const host = fakeCodeHost({ listOpened: true });
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

    it("leaves the pull request failing as not reviewed after a cancelled touch, and the next Finish replaces X", async () => {
        const r = changeRepo();
        const host = fakeCodeHost({ listOpened: true });
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
        const host = fakeCodeHost({ listOpened: true });
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
        const host = fakeCodeHost({ listOpened: true });
        await seedFinish(r, host, [[BADGE]], { projects: capture(r, 501) });
        await seedFinish(r, host, [[BUTTON]], { projects: capture(r, 502) });
        expect(host.opened.map((o) => o.number)).toEqual([900, 901]);
        expect(new Set(host.opened.map((o) => o.branch)).size).toBe(2);
    });

    it("after a restart without its records, goes to a fresh branch and closes the old seed pull request", async () => {
        const r = changeRepo();
        const host = fakeCodeHost({ listOpened: true });
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
        expect(git(r.remote, "ls-tree", "--name-only", host.opened[0].branch, "--", badge)).toBe(badge);
        expect(seedStatements(r, fresh)[0].entries.find((e) => e.decision === "reject")).toMatchObject({
            path: `compact-mantine/${BADGE}`,
            reason: "caught mid-animation",
        });
        expect(gateOn(r, fresh, "pr:901")).toEqual([]);
    });

    it("closes the old seed pull request after a restart even when ignoreBranches hides seed branches", async () => {
        const r = changeRepo();
        const host = fakeCodeHost({ listOpened: true });
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
        const host = fakeCodeHost({ listOpened: true });
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
        // The next Finish starts a fresh seed branch with a pull request of its own.
        await seedFinish(r, host, [[BUTTON]], { projects });
        expect(host.opened.map((o) => o.state)).toEqual(["closed", "open"]);
    });

    it("refuses and closes a recorded seed whose pull request comes from another repository", async () => {
        const r = changeRepo();
        const host = fakeCodeHost({ listOpened: true });
        const projects = capture(r);
        await seedFinish(r, host, [[BADGE]], { projects });
        const real = host.change;
        host.change = async (n) => ({ ...(await real(n)), head: { ref: host.opened[0].branch, repo: { id: 2 } } });
        await expect(seedFinish(r, host, [[BUTTON]], { projects })).rejects.toThrow(
            "its pull request comes from another repository",
        );
        expect(host.opened[0].state).toBe("closed");
    });

    it("adds a candidate's second Finish as one commit on its branch's tip, chained after the first", async () => {
        const r = changeRepo();
        const host = fakeCodeHost({ listOpened: true });
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

    it("commits the seed statement unsigned while the default branch holds no key, replacing X in the same Finish", async () => {
        const r = repoWith({ approvalFormat: "change", repositoryId: REPO_ID });
        const host = fakeCodeHost({ listOpened: true });
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
        delete host.listChanges;
        const { prepared, result } = await seedFinish(r, host, [[BADGE]]);
        expect(prepared.opened).toBeUndefined();
        expect(prepared.statement.change).toBe(`branch:${prepared.branch}`);
        expect(result.pullRequest).toBeNull();
        expect(gateOn(r, prepared.branch, `branch:${prepared.branch}`)).toEqual([]);
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
