/**
 * Approved before reads change statements beside review records: an image the owner accepted for
 * the same story in a signed statement is preselected as a record's is, an unverified one never
 * is, and the default branch's writer of each image (for a baselines history) says which
 * statement or record accepted it and whether its signature verified.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import { PASSKEYS_FILE } from "../trusted/lib/approval.mjs";
import { statementId, statementPath } from "../trusted/lib/change-approval.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { capturedItems, FIXTURE_CONFIG, git, isolateGit, makeRepo, onePr } from "./helpers.mjs";
import { approve, makeKey, passkeysJson } from "./passkey-vectors.mjs";

// Every git command the server runs, by its arguments.
const calls = vi.hoisted(() => ({ git: [] }));
vi.mock("../trusted/lib/github.mjs", async (importOriginal) => {
    const real = /** @type {typeof import("../trusted/lib/github.mjs")} */ (await importOriginal());
    const exec = (cmd, args, options) => {
        if (cmd === "git") {
            calls.git.push(args);
        }
        return real.exec(cmd, args, options);
    };
    return { ...real, exec };
});

const TOKEN = "t".repeat(43);
const KEY = makeKey();
const OTHER = makeKey();
const APPROVALS = FIXTURE_CONFIG.approvals;
const PROJECT = "compact-mantine";
const item = (file) => capturedItems().find((i) => i.file === file);
const BUTTON = item("button--primary.dark.png");
const SLIDER = item("slider--sizes.png");
const BADGE = item("badge--default.light.png");

let server;
let app;
beforeAll(() => isolateGit());
afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.idle();
    app = null;
    server = null;
});

// The id the statements below name: the config's, since the fake GitHub gives no id of its own.
const REPO_ID = "test-repository";
const CONFIG = { ...FIXTURE_CONFIG, repositoryId: REPO_ID };

/**
 * Starts the app on a random port for pull request #123 of a repository.
 * @param {object} r the repository (makeRepo)
 * @param {object} [o] options
 * @param {object} [o.config] the settings (default CONFIG)
 * @param {number} [o.githubId] the repository id GitHub answers with; none by default
 * @returns {Promise<{ api: (method: string, path: string) => Promise<any> }>} the app's API
 */
async function start(r, { config = CONFIG, githubId } = {}) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => vi.restoreAllMocks());
    const tmp = join(r.repo, "tmp/visual-review");
    server = createServer((req, res) => app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const fake = onePr()(r);
    const gh = (args, input) =>
        githubId !== undefined && args[0] === "api" && args[1] === "repos/{owner}/{repo}"
            ? Promise.resolve(JSON.stringify({ id: githubId }))
            : fake(args, input);
    app = createApp({ repo: r.repo, tmp, config, token: TOKEN, origin, gh });
    const api = async (method, path) => {
        const res = await fetch(`${origin}${path}`, { method, headers: { "x-review-token": TOKEN, origin } });
        return { status: res.status, body: await res.json() };
    };
    return { api };
}

/**
 * Commits files on master and pushes them, so the default branch holds them.
 * @param {object} r the repository
 * @param {Record<string, object | string>} files contents by path (objects as JSON)
 */
function onMaster(r, files) {
    for (const [path, data] of Object.entries(files)) {
        mkdirSync(join(r.repo, path, ".."), { recursive: true });
        writeFileSync(join(r.repo, path), typeof data === "string" ? data : JSON.stringify(data));
    }
    git(r.repo, "add", "-A");
    git(r.repo, "commit", "-q", "-m", "earlier approvals");
    git(r.repo, "push", "-q", "origin", "master");
}

/**
 * A repository whose default branch holds KEY in passkeys.json and these approvals.
 * @param {...{ path: string, doc: object }} approvals the statements and records, at their paths
 * @returns {object} the repository
 */
function repoWith(...approvals) {
    const r = makeRepo();
    onMaster(r, {
        [PASSKEYS_FILE]: passkeysJson(KEY),
        ...Object.fromEntries(approvals.map((a) => [a.path, a.doc])),
    });
    return r;
}

const accept = (i, more = {}) => ({
    path: `${PROJECT}/${i.file}`,
    from: i.baseline,
    to: i.capture,
    decision: "accept",
    ...more,
});

/**
 * A change statement of pr:77, signed with a key, at the place its content gives.
 * @param {object[]} entries its entries
 * @param {object} [more] other fields of the statement
 * @param {object} [more.key] the key that signs it (default KEY)
 * @param {object} [more.tamper] fields changed after signing, so the signature no longer holds
 * @returns {{ path: string, doc: object, id: string }} it
 */
function statement(entries, { key = KEY, tamper = {}, ...more } = {}) {
    const unsigned = {
        version: 2,
        type: "change-approval",
        repository: REPO_ID,
        baselines: FIXTURE_CONFIG.baselines,
        change: "pr:77",
        capturedHead: "a".repeat(40),
        previous: null,
        approvedAt: "2026-10-20T10:00:00Z",
        entries,
        ...more,
    };
    const doc = { ...unsigned, approval: approve(unsigned, key), ...tamper };
    return { path: statementPath(APPROVALS, doc), doc, id: statementId(doc) };
}

/**
 * A version 2 review record of pull request #66, signed with KEY.
 * @param {object[]} items its items, each with the baselines directory in its path
 * @param {object} [o] options
 * @param {object} [o.tamper] fields changed after signing
 * @returns {{ path: string, doc: object }} it
 */
function record(items, { tamper = {} } = {}) {
    const unsigned = { version: 2, pr: 66, items, rejects: [], reviewedAt: "2026-10-10T09:00:00.000Z" };
    const path = `${FIXTURE_CONFIG.baselines}/reviews/20261010T090000Z-pr66.json`;
    return { path, doc: { ...unsigned, approval: approve(unsigned, KEY), ...tamper } };
}
const baseline = (i) => `${FIXTURE_CONFIG.baselines}/${PROJECT}/${i.file}`;
const recordItem = (i) => ({
    path: baseline(i),
    from: i.baseline,
    to: i.capture,
    reason: null,
});

// The decisions the server shows for #123's compact-mantine after one refresh.
async function decisions(s) {
    await s.api("GET", "/api/prs");
    return (await s.api("GET", `/api/pr/123/${PROJECT}`)).body.decisions;
}

describe("approved before, from change statements", () => {
    it("preselects an image a signed change statement accepted for the same story", async () => {
        const st = statement([accept(BUTTON), accept(BADGE)]);
        const shown = await decisions(await start(repoWith(st)));
        const expected = { pr: 77, record: st.path, reviewedAt: "2026-10-20T10:00:00Z" };
        expect(shown[BUTTON.file]).toMatchObject({ decision: "accept", approvedBefore: expected });
        expect(shown[BADGE.file]).toMatchObject({ decision: "accept", approvedBefore: expected });
        expect(shown[SLIDER.file]).toBeUndefined();
    });

    it("preselects from a legacy review record, and from a record and a statement together", async () => {
        const rec = record([recordItem(SLIDER)]);
        const alone = await decisions(await start(repoWith(rec)));
        expect(alone[SLIDER.file]).toMatchObject({ approvedBefore: { pr: 66, record: rec.path } });

        const st = statement([accept(BUTTON)]);
        const both = await decisions(await start(repoWith(rec, st)));
        expect(both[SLIDER.file]).toMatchObject({ approvedBefore: { pr: 66, record: rec.path } });
        expect(both[BUTTON.file]).toMatchObject({ approvedBefore: { pr: 77, record: st.path } });
    });

    it("does not offer an image a later statement of the change rejects", async () => {
        const first = statement([accept(BUTTON), accept(SLIDER)]);
        const later = statement([accept(BUTTON, { decision: "reject", reason: "the shadow is cut off" })], {
            previous: first.id,
            // Earlier by the clock: within a change, the chain orders the statements.
            approvedAt: "2026-10-19T10:00:00Z",
        });
        const shown = await decisions(await start(repoWith(first, later)));
        expect(shown[BUTTON.file]).toBeUndefined();
        expect(shown[SLIDER.file]).toMatchObject({ approvedBefore: { record: first.path } });
    });

    it("a statement newer than a record replaces its decision on the path", async () => {
        const rec = record([recordItem(BUTTON)]);
        const st = statement([accept(BUTTON, { decision: "exclude", reason: "flaky" })]);
        expect((await decisions(await start(repoWith(rec, st))))[BUTTON.file]).toBeUndefined();
    });

    it("never preselects from a statement or record whose signature does not verify", async () => {
        const forged = statement([accept(BUTTON)], { tamper: { change: "pr:78" } });
        const foreign = statement([accept(BADGE)], { key: OTHER });
        const rec = record([recordItem(SLIDER)], { tamper: { pr: 67 } });
        const s = await start(repoWith(forged, foreign, rec));
        expect(await decisions(s)).toEqual({});
        expect(app.baselineWriter(baseline(BUTTON), BUTTON.capture)).toMatchObject({ file: forged.path, verified: false });
        expect(app.baselineWriter(baseline(BADGE), BADGE.capture)).toMatchObject({ file: foreign.path, verified: false });
        expect(app.baselineWriter(baseline(SLIDER), SLIDER.capture)).toMatchObject({ file: rec.path, verified: false });
    });

    it("never preselects from a statement of another repository, or when this one's id is unknown", async () => {
        const elsewhere = statement([accept(BUTTON)], { repository: "another-repository" });
        const ours = statement([accept(BADGE)], { change: "pr:79" });
        const r = repoWith(elsewhere, ours);
        const s = await start(r);
        expect(Object.keys(await decisions(s))).toEqual([BADGE.file]);
        expect(app.baselineWriter(baseline(BUTTON), BUTTON.capture)).toMatchObject({ verified: false });
        await new Promise((resolve) => server.close(() => resolve()));
        await app.idle();
        expect(await decisions(await start(r, { config: FIXTURE_CONFIG }))).toEqual({});
    });

    it("on GitHub, counts only statements that name the repository's GitHub id", async () => {
        const github = statement([accept(BUTTON)], { repository: "github:42" });
        const config = statement([accept(BADGE)], { change: "pr:79" });
        const shown = await decisions(await start(repoWith(github, config), { githubId: 42 }));
        expect(Object.keys(shown)).toEqual([BUTTON.file]);
    });

    it("names a change that is not a pull request as the statement names it", async () => {
        const st = statement([accept(BUTTON)], { change: "branch:feat/x" });
        const shown = await decisions(await start(repoWith(st)));
        expect(shown[BUTTON.file]).toMatchObject({ approvedBefore: { pr: null, change: "branch:feat/x" } });
    });

    it("reads a statement blob by where it sits, whichever place is read first", async () => {
        const st = statement([accept(BUTTON)]);
        // The same bytes at the top of the approvals directory, where only tree statements live.
        const copy = { path: `${APPROVALS}/copied.json`, doc: st.doc };
        const shown = await decisions(await start(repoWith(copy, st)));
        expect(shown[BUTTON.file]).toMatchObject({ approvedBefore: { record: st.path } });
    });

    it("never preselects from a statement at another place than its content gives", async () => {
        const st = statement([accept(BUTTON)]);
        const moved = { ...st, path: `${APPROVALS}/pr-78/${st.path.split("/").at(-1)}` };
        const s = await start(repoWith(moved));
        expect(await decisions(s)).toEqual({});
        expect(app.baselineWriter(baseline(BUTTON), BUTTON.capture)).toMatchObject({ verified: false });
    });
});

describe("the default branch's writer of each image", () => {
    it("finds the newest statement that accepted a hash, verified", async () => {
        const rec = record([recordItem(BUTTON)]);
        const older = statement([accept(BUTTON)], { change: "pr:70", approvedAt: "2026-10-12T08:00:00Z" });
        const newer = statement([accept(BUTTON)], { change: "pr:71", approvedAt: "2026-10-15T08:00:00Z" });
        const s = await start(repoWith(rec, newer, older));
        await s.api("GET", "/api/prs");
        expect(app.baselineWriter(baseline(BUTTON), BUTTON.capture)).toEqual({
            path: `${FIXTURE_CONFIG.baselines}/${PROJECT}/${BUTTON.file}`,
            file: newer.path,
            change: "pr:71",
            at: "2026-10-15T08:00:00Z",
            verified: true,
        });
        expect(app.baselineWriter(baseline(SLIDER), SLIDER.capture)).toBeNull();
    });
    it("names each path's own writer of an image, and an exclude that wrote it", async () => {
        const button = statement([accept(BUTTON)], { change: "pr:70", approvedAt: "2026-10-12T08:00:00Z" });
        // The same image, later, as the slider's baseline.
        const slider = statement([accept({ ...SLIDER, capture: BUTTON.capture })], {
            change: "pr:71",
            approvedAt: "2026-10-15T08:00:00Z",
        });
        const excluded = statement([accept(BADGE, { decision: "exclude", reason: "flaky" })], { change: "pr:72" });
        const s = await start(repoWith(button, slider, excluded));
        await s.api("GET", "/api/prs");
        expect(app.baselineWriter(baseline(BUTTON), BUTTON.capture)).toMatchObject({ file: button.path });
        expect(app.baselineWriter(baseline(SLIDER), BUTTON.capture)).toMatchObject({ file: slider.path });
        expect(app.baselineWriter(baseline(BADGE), BADGE.capture)).toMatchObject({ file: excluded.path, verified: true });
    });
});

describe("reading the approvals", () => {
    it("lists statements and records with one git ls-tree per branch, and reads each blob once", async () => {
        const st = statement([accept(BUTTON)]);
        const rec = record([recordItem(SLIDER)]);
        const r = repoWith(st, rec);
        const blob = git(r.repo, "rev-parse", `master:${st.path}`);
        const s = await start(r);
        const lists = () => calls.git.filter((a) => a.includes("ls-tree") && a.includes(`${APPROVALS}/`));
        const reads = () => calls.git.filter((a) => a.includes("cat-file") && a.includes(blob));
        calls.git.length = 0;
        expect(await decisions(s)).toMatchObject({ [BUTTON.file]: { approvedBefore: { record: st.path } } });
        // One listing of the approvals and the review records together at each of the default
        // branch's tip and #123's head, and the statement read once.
        expect(lists()).toHaveLength(2);
        expect(lists().every((a) => a.includes(`${FIXTURE_CONFIG.baselines}/reviews/`))).toBe(true);
        expect(reads()).toHaveLength(1);
        // Another refresh lists them again and reads no blob it read before.
        await s.api("GET", "/api/prs");
        expect(lists()).toHaveLength(4);
        expect(reads()).toHaveLength(1);
    });
});
