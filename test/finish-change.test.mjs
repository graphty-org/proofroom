/*
 * Finish in change mode (docs/approval-format.md): one signed change statement per Finish, written
 * where its content says, and no review record; and Finish in tree mode where the default branch
 * still holds tree statements, so a repository whose CI runs the old gate never receives a
 * statement that gate cannot read.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as oldGate from "./fixtures/old-gate/trusted/gate.mjs";
import { approvalProblems } from "../trusted/gate.mjs";
import { finish } from "../trusted/lib/accept.mjs";
import { PASSKEYS_FILE } from "../trusted/lib/approval.mjs";
import { statementId, statementPath } from "../trusted/lib/change-approval.mjs";
import { approvalFormatAt, CONFIG_FILE } from "../trusted/lib/config.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { copyFixture, FIXTURE_CONFIG, git, makeRepo, onePr, until } from "./helpers.mjs";
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
    git(r.remote, "ls-tree", "-r", "--name-only", ref, "--", `${dir}/`)
        .split("\n")
        .filter(Boolean);

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
    git(merged, "-c", "user.name=CI", "-c", "user.email=ci@example.com", "merge", "-q", "--no-ff", "--no-edit", "origin/feature");
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
        const [first, second] = statementsOn(r).sort((a, b) => (a.previous === null ? -1 : b.previous === null ? 1 : 0));
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

    it("refuses a seed, whose statement no gate could count, and pushes nothing", async () => {
        const r = changeRepo();
        const at = { commit: r.master, headSha: null, pr: null };
        const projects = { "compact-mantine": copyFixture("compact-mantine", join(r.dir, "m/compact-mantine"), at) };
        const before = git(r.remote, "for-each-ref", "--format=%(refname)");
        await expect(
            finish({
                repo: r.repo,
                gh: async () => "{}",
                target: { pr: null, branch: null },
                projects,
                decisions: [{ project: "compact-mantine", file: BADGE, decision: "accept", reason: null }],
                config: FIXTURE_CONFIG,
                repository: REPO_ID,
            }),
        ).rejects.toThrow("a capture of the default branch cannot be approved with change statements");
        expect(git(r.remote, "for-each-ref", "--format=%(refname)")).toBe(before);
    });
});

describe("Finish in tree mode", () => {
    // graphty-monorepo's shape: tree statements in the approvals directory, no approvalFormat.
    const treeShaped = (feature = {}) => {
        const r = makeRepo();
        const own = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
        delete own.approvalFormat;
        const tree = git(r.repo, "rev-parse", `master:${BASELINES}`);
        const earlier = { version: 1, commit: r.master, tree, baselines: BASELINES, pr: 1, approvedAt: "2026-10-01T00:00:00.000Z" };
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
        git(merged, "-c", "user.name=CI", "-c", "user.email=ci@example.com", "merge", "-q", "--no-ff", "--no-edit", "origin/feature");
        const base = git(merged, "rev-parse", "HEAD^1");
        const { keys, problems } = oldGate.approvalKeys(base, "HEAD", merged);
        expect(problems).toEqual([]);
        expect(
            oldGate.treeApprovalProblems({ base, head: "HEAD", cwd: merged, baselines: BASELINES, approvals: APPROVALS, keys }),
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
