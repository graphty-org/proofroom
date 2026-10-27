/**
 * The Baselines screen's routes: every baseline at the default branch or a change from one
 * `git ls-tree`, one baseline's versions from one `git log` with each version's approval (the
 * change statement that wrote its image, or for a version approved the old way, the tree statement
 * of its baselines tree), the images by hash, and Git LFS objects of a ref not fetched shown as not
 * downloaded until the page asks for exactly those paths.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import { PASSKEYS_FILE } from "../trusted/lib/approval.mjs";
import { statementPath } from "../trusted/lib/change-approval.mjs";
import { sha256 } from "../trusted/lib/compare.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { FIXTURE, FIXTURE_CONFIG, git, isolateGit, makeRepo, onePr } from "./helpers.mjs";
import { approve, makeKey, passkeysJson } from "./passkey-vectors.mjs";

// Every git process the server starts, by its arguments.
const calls = vi.hoisted(() => ({ git: [] }));
vi.mock("node:child_process", async (importOriginal) => {
    const real = /** @type {typeof import("node:child_process")} */ (await importOriginal());
    const execFile = (cmd, args, ...rest) => {
        if (cmd === "git") {
            calls.git.push(args);
        }
        return real.execFile(cmd, args, ...rest);
    };
    return { ...real, execFile };
});

const TOKEN = "b".repeat(43);
const KEY = makeKey();
const REPO_ID = "test-repository";
const CONFIG = { ...FIXTURE_CONFIG, repositoryId: REPO_ID };
const B = FIXTURE_CONFIG.baselines;
const PATH = `${B}/compact-mantine/button--primary.dark.png`;
const NEW_PATH = `${B}/compact-mantine/badge--fresh.light.png`;
const image = (name) => readFileSync(join(FIXTURE, "compact-mantine", name));
const V1 = image("baselines/button--primary.dark.png");
const V2 = image("baselines/card--legacy.png");
const V3 = image("baselines/tooltip--hover.png");
const FRESH = image("slider--sizes.png");

let server;
let app;
beforeAll(() => isolateGit());
afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.idle();
    app = null;
    server = null;
});

// Writes files in the repository and commits them; answers the commit.
function commit(r, files, message) {
    for (const [path, data] of Object.entries(files)) {
        mkdirSync(join(r.repo, path, ".."), { recursive: true });
        writeFileSync(join(r.repo, path), data);
    }
    git(r.repo, "add", "-A");
    git(r.repo, "commit", "-q", "-m", message);
    return git(r.repo, "rev-parse", "HEAD");
}

/**
 * The fixture repository with three versions of one baseline on master: the first as it was made,
 * the second approved the old way (a tree statement of the baselines tree at its commit), the third
 * by a change statement of pr:71. The pull request's branch adds a baseline whose Git LFS object is
 * on the remote but not on this disk.
 * @returns {object} the repository, with the versions' commits
 */
function threeVersions() {
    const r = makeRepo();
    const first = git(r.repo, "rev-parse", "HEAD");
    const second = commit(r, { [PATH]: V2 }, "second version");
    const tree = git(r.repo, "rev-parse", `${second}:${B}`);
    const treeDoc = { version: 1, commit: second, tree, baselines: B, pr: 60, approvedAt: "2026-09-01T10:00:00.000Z" };
    const unsigned = {
        version: 2,
        type: "change-approval",
        repository: REPO_ID,
        baselines: B,
        change: "pr:71",
        capturedHead: "a".repeat(40),
        previous: null,
        approvedAt: "2026-10-15T08:00:00Z",
        entries: [
            { path: "compact-mantine/button--primary.dark.png", from: sha256(V2), to: sha256(V3), decision: "accept" },
        ],
    };
    const statement = { ...unsigned, approval: approve(unsigned, KEY) };
    const approvals = {
        [PASSKEYS_FILE]: passkeysJson(KEY),
        [`${FIXTURE_CONFIG.approvals}/${tree}.json`]: JSON.stringify({ ...treeDoc, approval: approve(treeDoc, KEY) }),
    };
    commit(r, approvals, "the old approval");
    const st = statementPath(FIXTURE_CONFIG.approvals, statement);
    const third = commit(r, { [PATH]: V3, [st]: JSON.stringify(statement) }, "third version");
    git(r.repo, "push", "-q", "origin", "master");
    // The pull request's branch: one new baseline, its object uploaded and then gone from here.
    git(r.repo, "checkout", "-q", "feature");
    git(r.repo, "merge", "-q", "--no-edit", "master");
    const head = commit(r, { [NEW_PATH]: FRESH }, "a new story");
    git(r.repo, "push", "-q", "origin", "feature");
    const oid = sha256(FRESH);
    git(r.repo, "lfs", "push", "--object-id", "origin", oid);
    git(r.repo, "checkout", "-q", "master");
    rmSync(join(r.repo, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid));
    return { ...r, head, first, second, third, statement: st, tree };
}

async function start(r) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => vi.restoreAllMocks());
    const tmp = join(r.repo, "tmp/visual-review");
    server = createServer((req, res) => app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    app = createApp({ repo: r.repo, tmp, config: CONFIG, token: TOKEN, origin, gh: onePr()(r) });
    const call = async (method, path, body) => {
        const res = await fetch(`${origin}${path}`, {
            method,
            headers: { "x-review-token": TOKEN, origin, "content-type": "application/json" },
            body: body && JSON.stringify(body),
        });
        const type = res.headers.get("content-type") ?? "";
        return {
            status: res.status,
            body: type.startsWith("image/") ? Buffer.from(await res.arrayBuffer()) : await res.json(),
        };
    };
    // One refresh: the default branch's tip and its approvals read.
    await call("GET", "/api/prs");
    return call;
}

const gitRuns = (what) => calls.git.filter((a) => a.includes(what));

describe("the baselines at a ref", () => {
    it("lists every baseline of the default branch from one git ls-tree, with its last change", async () => {
        const r = threeVersions();
        const api = await start(r);
        calls.git.length = 0;
        const { status, body } = await api("GET", "/api/baselines");
        expect(status).toBe(200);
        expect(body.sha).toBe(git(r.repo, "rev-parse", "origin/master"));
        expect(gitRuns("ls-tree")).toHaveLength(1);
        const button = body.items.find((i) => i.file === "button--primary.dark.png");
        expect(button).toMatchObject({
            project: "compact-mantine",
            hash: sha256(V3),
            bytes: V3.length,
            local: true,
            change: "pr:71",
            at: "2026-10-15T08:00:00Z",
        });
        expect(body.items.map((i) => i.file)).not.toContain("badge--fresh.light.png");
        // Asked again, the blobs are known: one ls-tree, and nothing read.
        calls.git.length = 0;
        await api("GET", "/api/baselines");
        expect(gitRuns("ls-tree")).toHaveLength(1);
        expect(gitRuns("cat-file")).toHaveLength(0);
    });

    it("shows a change's baselines, a Git LFS object not on this disk as not downloaded until asked for", async () => {
        const r = threeVersions();
        const api = await start(r);
        const listed = await api("GET", "/api/baselines?ref=123");
        expect(listed.status).toBe(200);
        expect(listed.body).toMatchObject({ ref: "123", sha: r.head });
        const fresh = listed.body.items.find((i) => i.file === "badge--fresh.light.png");
        expect(fresh).toMatchObject({ hash: sha256(FRESH), local: false });
        expect(await api("GET", `/api/baselines/image/${fresh.hash}`)).toMatchObject({
            status: 404,
            body: { code: "not-downloaded" },
        });
        // Nothing was fetched on its own.
        expect(gitRuns("lfs").filter((a) => a.includes("fetch"))).toHaveLength(0);
        calls.git.length = 0;
        const fetched = await api("POST", "/api/baselines-download", { ref: "123", paths: [NEW_PATH] });
        expect(fetched).toMatchObject({ status: 200, body: { fetched: 1 } });
        expect(gitRuns("fetch")).toEqual([["lfs", "fetch", "origin", r.head, "--include", NEW_PATH]]);
        const again = await api("GET", "/api/baselines?ref=123");
        expect(again.body.items.find((i) => i.file === "badge--fresh.light.png").local).toBe(true);
        const img = await api("GET", `/api/baselines/image/${fresh.hash}`);
        expect(img.status).toBe(200);
        expect(sha256(img.body)).toBe(fresh.hash);
        const pic = await api("GET", `/api/baselines/pic/${fresh.hash}`);
        expect(pic.status).toBe(200);
        expect(pic.body.subarray(1, 4).toString()).toBe("PNG");
    });

    it("refuses a download of a path outside the baselines, or of a commit outside the ref's history", async () => {
        const r = threeVersions();
        const api = await start(r);
        expect((await api("POST", "/api/baselines-download", { paths: ["README.md"] })).status).toBe(400);
        expect((await api("POST", "/api/baselines-download", { paths: [`${B}/a/../../x.png`] })).status).toBe(400);
        expect((await api("POST", "/api/baselines-download", { paths: [`${B}/a/*.png`] })).status).toBe(400);
        const outside = await api("POST", "/api/baselines-download", { paths: [PATH], commit: r.head });
        expect(outside.status).toBe(400);
        expect((await api("GET", "/api/baselines?ref=999")).status).toBe(404);
    });
});

describe("one baseline's history", () => {
    it("lists its versions newest first from one git log, each with the approval that holds it", async () => {
        const r = threeVersions();
        const api = await start(r);
        await api("GET", "/api/baselines");
        calls.git.length = 0;
        const { status, body } = await api("GET", `/api/baselines/history?path=${encodeURIComponent(PATH)}`);
        expect(status).toBe(200);
        expect(gitRuns("log")).toHaveLength(1);
        expect(body.versions.map((v) => v.commit)).toEqual([r.third, r.second, r.first]);
        expect(body.versions.map((v) => v.hash)).toEqual([sha256(V3), sha256(V2), sha256(V1)]);
        const [third, second, first] = body.versions;
        expect(third).toMatchObject({ author: "Owner", local: true });
        // The change statement whose entry wrote that image.
        expect(third.approval).toEqual({
            kind: "statement",
            file: r.statement,
            change: "pr:71",
            verified: true,
            signed: true,
            signer: "test",
        });
        // Approved the old way: the tree statement of the baselines tree at its commit.
        expect(second.approval).toEqual({
            kind: "tree",
            file: `${FIXTURE_CONFIG.approvals}/${r.tree}.json`,
            change: "pr:60",
            verified: true,
            signed: true,
            signer: "test",
        });
        expect(first.approval).toBeNull();
        // Every version's image is served by its hash.
        for (const v of body.versions) {
            const img = await api("GET", `/api/baselines/image/${v.hash}`);
            expect(sha256(img.body)).toBe(v.hash);
        }
    });

    it("refuses a path outside the baselines", async () => {
        const api = await start(threeVersions());
        expect((await api("GET", "/api/baselines/history?path=README.md")).status).toBe(400);
        expect((await api("GET", "/api/baselines/image/nothing")).status).toBe(404);
        expect((await api("GET", "/api/baselines/pic/nothing")).status).toBe(404);
    });
});
