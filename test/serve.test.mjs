import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { delimiter, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { contentHash } from "../trusted/gate.mjs";
import { parsePasskeys, recordHash, verifyApproval, verifyRecord } from "../trusted/lib/approval.mjs";
import { sha256 } from "../trusted/lib/compare.mjs";
import { approvalIndex } from "../trusted/lib/filters.mjs";
import {
    downloadCaptures,
    hurry,
    newestMasterCapture,
    onceOnDisk,
    openPullRequests,
    withRetries,
} from "../trusted/lib/github.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { thumbnail } from "../trusted/lib/thumbs.mjs";
import { PNG } from "pngjs";
import { notifyOnce } from "../trusted/lib/inbox.mjs";
import {
    capturedItems,
    copyFixture,
    fakeGh,
    FIXTURE,
    FIXTURE_CONFIG,
    git,
    isolateGit,
    job,
    keepTiles,
    makeRepo,
    onePr,
    pushCommit,
    seedTiles,
    tempDir,
    until,
    withMoved,
} from "./helpers.mjs";
import { approve, makeKey, passkeysJson, register } from "./passkey-vectors.mjs";

const TOKEN = "t".repeat(43);

let server;
let app;
// The app's tiles made in advance run on after the server closes: wait for them, or their reads of
// a later-deleted download log into the next test's console.error spy.
afterEach(async () => {
    // Until every request has been answered: a list refresh still running would write its state
    // into the repository after the test file removed it (tempDir).
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.idle();
    app = null;
});

// The fixture's grid tiles, made once and put in every server's tmp directory (keepTiles).
let tiles = null;
beforeAll(async () => {
    isolateGit();
    const s = await start({ gh: onePr(), tiles: false });
    tiles = await keepTiles({ ...s, token: TOKEN }, 123);
    server.close();
    await app.idle();
    app = null;
});

/**
 * Starts the app on a random port.
 * @param {object} [options] passed to createApp; `repo` defaults to a fresh repository
 * @param {boolean} [options.tiles] false: without the fixture's grid tiles made already
 * @returns {Promise<object>} `api(method, path, body, headers)` plus the repository
 */
async function start({ tiles: seed = true, ...options } = {}) {
    const r = options.repo ? options : makeRepo();
    const repo = options.repo ?? r.repo;
    const tmp = join(repo, "tmp/visual-review");
    if (seed && tiles) {
        seedTiles(tiles, tmp);
    }
    const box = {};
    server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    box.app = createApp({ repo, tmp, config: FIXTURE_CONFIG, token: TOKEN, origin, ...options, gh: options.gh(r) });
    app = box.app;
    const api = async (method, path, body, headers = {}) => {
        const res = await fetch(`${origin}${path}`, {
            method,
            headers: { "x-review-token": TOKEN, origin, "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const type = res.headers.get("content-type") ?? "";
        return {
            status: res.status,
            type,
            body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
        };
    };
    return { ...r, repo, origin, api, tmp };
}

/**
 * Waits for the running Finish to end, as the page does.
 * @param {object} s the started app
 * @returns {Promise<object | null>} the ended job
 */
async function endedJob(s) {
    let ended;
    await until(async () => {
        ({ job: ended } = (await s.api("GET", "/api/finish-status")).body);
        return !ended?.running;
    });
    return ended;
}

/**
 * Starts a Finish and waits for it to end.
 * @param {object} s the started app
 * @param {string} id the target
 * @returns {Promise<{ begun: object, job: object | null }>} the start's response and the ended job
 */
async function finishJob(s, id) {
    const begun = await s.api("POST", "/api/finish", { id });
    return { begun, job: await endedJob(s) };
}

describe("serve: pull requests", () => {
    it("lists every open pull request, with counts per project, and one without a CI run as waiting", async () => {
        const s = await start({
            gh: (r) =>
                fakeGh({
                    prs: [
                        { number: 123, head: r.head, branch: "feature" },
                        { number: 124, head: "4".repeat(40), branch: "no-run" },
                    ],
                    runs: { [r.head]: { id: 1000, head: r.head } },
                    jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
                    artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                }),
        });
        const { status, body } = await s.api("GET", "/api/prs");
        expect(status).toBe(200);
        expect(body.targets.map((t) => t.id)).toEqual(["123", "124"]);
        expect(body.targets[1].projects[0].problem).toBe("waiting for CI on 4444444444");
        const [pr] = body.targets;
        expect(pr).toMatchObject({ pr: 123, runId: 1000, branch: "feature", mergeMasterFirst: false });
        const cm = pr.projects.find((p) => p.project === "compact-mantine");
        expect(cm).toMatchObject({
            problem: null,
            counts: { changed: 2, new: 1, removed: 1, unstable: 1, failed: 1, unchanged: 1 },
            reviewable: 6,
            decided: 0,
        });
    });

    it("answers the inbox, and keeps it on disk for the notifier", async () => {
        const s = await start({
            gh: (r) =>
                fakeGh({
                    prs: [
                        { number: 123, head: r.head, branch: "feature" },
                        { number: 124, head: "4".repeat(40), branch: "no-run" },
                    ],
                    runs: { [r.head]: { id: 1000, head: r.head } },
                    jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
                    artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head, items: capturedItems() },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                }),
        });
        const { body: list } = await s.api("GET", "/api/prs");
        const undecided = list.targets[0].projects.reduce((n, p) => n + p.undecided, 0);
        expect(list.inbox).toMatchObject({ capturing: 1, done: 0, notReady: [] });
        expect(list.inbox.ready).toEqual([
            expect.objectContaining({ pr: 123, undecided, complete: true, source: "CI", headSha: s.head }),
        ]);
        const { body } = await s.api("GET", "/api/inbox");
        expect(body.ready[0].since).toBe(list.inbox.ready[0].since);
        const kept = JSON.parse(readFileSync(join(s.tmp, "state/inbox.json"), "utf8"));
        expect(kept).toMatchObject({ origin: s.origin, capturing: 1 });
        expect(kept.ready.map((r) => r.pr)).toEqual([123]);
    });

    it("never offers a draft pull request for review: its author is still working on it (issue 2727)", async () => {
        const s = await start({
            gh: (r) =>
                fakeGh({
                    prs: [{ number: 123, head: r.head, branch: "feature", draft: true }],
                    runs: { [r.head]: { id: 1000, head: r.head } },
                    jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
                    artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head, items: capturedItems() },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                }),
        });
        const { body: list } = await s.api("GET", "/api/prs");
        expect(list.targets[0]).toMatchObject({ pr: 123, draft: true });
        expect(list.inbox).toMatchObject({ ready: [], notReady: [], drafts: 1 });
    });

    it("holds back a pull request with a failed story, with its reason, and the notifier never announces it", async () => {
        // The fixture's menu--open failed; give it a baseline, as a story that rendered before.
        const items = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items.map((i) =>
            i.status === "failed" ? { ...i, baseline: "a".repeat(64) } : i,
        );
        const s = await start({
            gh: (r) =>
                onePr({
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head, items },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                })(r),
        });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/inbox");
        expect(body.ready).toEqual([]);
        expect(body.notReady).toEqual([
            expect.objectContaining({
                pr: 123,
                project: "compact-mantine",
                story: "menu--open",
                reason: "capture failed: menu--open: story render errored",
                retry: false,
            }),
        ]);
        const out = join(s.tmp, "sent.json");
        const command = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(out)}, "sent")`];
        expect(await notifyOnce({ stateDir: join(s.tmp, "state"), command, gap: 0 })).toEqual([]);
        expect(existsSync(out)).toBe(false);
        // A failed item has no image in the artifact: asking for one is "no such image", never a
        // damaged download that throws the capture away.
        const img = await s.api("GET", "/api/img/123/compact-mantine/baseline/menu--open.png");
        expect(img.status).toBe(404);
        expect(JSON.stringify(img.body)).not.toContain("damaged");
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).status).toBe(200);
    });

    it("shows capture failed with the job's log when the visual job failed or uploaded nothing", async () => {
        const s = await start({
            gh: onePr({
                jobs: { 1000: [job("compact-mantine", "failure"), job("graphty-element")] },
                artifacts: { 1000: ["visual-compact-mantine-1"] },
            }),
        });
        const { body } = await s.api("GET", "/api/prs");
        const [cm, ge] = ["compact-mantine", "graphty-element"].map((p) =>
            body.targets[0].projects.find((x) => x.project === p),
        );
        expect(cm).toMatchObject({ problem: "capture failed", logUrl: "https://gh/job/compact-mantine" });
        expect(ge).toMatchObject({ problem: "capture failed", logUrl: "https://gh/job/graphty-element" });
    });

    it("shows a project the run left out as not affected, not as a failed capture, across a restart", async () => {
        const gh = (r) => {
            const inner = onePr()(r);
            return async (args, input) => {
                if (args[0] === "run" && args[1] === "download" && args[4] === "visual-graphty-element-1") {
                    mkdirSync(args[6], { recursive: true });
                    const marker = { skipped: "not affected", project: "graphty-element" };
                    writeFileSync(join(args[6], "skipped.json"), JSON.stringify(marker));
                    return "";
                }
                return inner(args, input);
            };
        };
        const first = await start({ warm: true, gh });
        const { body } = await first.api("GET", "/api/prs");
        const ge = body.targets[0].projects.find((x) => x.project === "graphty-element");
        expect(ge).toMatchObject({ problem: "not affected" });
        // Not a failed capture, so it never holds the pull request out of the inbox.
        const inbox = (await first.api("GET", "/api/inbox")).body;
        expect(inbox.notReady.map((n) => n.project)).not.toContain("graphty-element");
        // Nor does it leave Finish's status pending as an unreviewed project.
        expect((await first.api("GET", "/api/target/123?finish=1")).body.finish.unloaded).toEqual([]);
        server.close();
        const s = await start({ repo: first.repo, head: first.head, master: first.master, warm: true, gh });
        const kept = (await s.api("GET", "/api/prs?cached=1")).body.targets[0].projects;
        expect(kept.find((x) => x.project === "graphty-element")).toMatchObject({
            problem: "not affected",
            downloading: false,
        });
    });

    it("shows an incomplete capture as N of M stories", async () => {
        const s = await start({
            gh: (r) =>
                onePr({
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head, complete: false, expected: 20 },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                })(r),
        });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets[0].projects.find((p) => p.project === "compact-mantine").problem).toBe(
            "incomplete: 7 of 20 stories",
        );
    });

    it("answers other requests while a git call of the list's refresh is held", async () => {
        // A git that holds the read of the default branch's baselines (againstBase's cat-file) until
        // the test releases it. A git call of the refresh run on the server's own thread, as one once
        // was, blocked every request, and a git that stalled for seconds timed out the list (#1496).
        // On such a server the test cannot release it, so the hold ends by itself once the suite's
        // 60 s test limit has passed (6000 sleeps of at least 10 ms): git then fails, leaving a mark
        // the test checks, instead of carrying on as if released.
        const bin = tempDir("vr-git-");
        const real = process.env.PATH.split(delimiter)
            .map((d) => join(d, "git"))
            .find((f) => existsSync(f));
        const gate = { held: join(bin, "held"), release: join(bin, "release"), expired: join(bin, "expired") };
        writeFileSync(
            join(bin, "git"),
            [
                "#!/bin/sh",
                'case "$*" in "cat-file --batch")',
                `  : > '${gate.held}'; i=0`,
                `  while [ ! -e '${gate.release}' ]; do`,
                `    [ $i -ge 6000 ] && { : > '${gate.expired}'; echo 'fake git: the held read was never released' >&2; exit 1; }`,
                "    sleep 0.01; i=$((i + 1))",
                "  done ;;",
                "esac",
                `exec '${real}' "$@"`,
                "",
            ].join("\n"),
        );
        chmodSync(join(bin, "git"), 0o755);
        const path = process.env.PATH;
        process.env.PATH = `${bin}${delimiter}${path}`;
        onTestFinished(() => {
            process.env.PATH = path;
            rmSync(bin, { recursive: true, force: true });
        });
        const s = await start({ gh: onePr() });
        const list = s.api("GET", "/api/prs");
        await until(() => existsSync(gate.held));
        expect((await s.api("GET", "/api/inbox")).status).toBe(200);
        writeFileSync(gate.release, "");
        expect((await list).status).toBe(200);
        expect(existsSync(gate.expired), "the held git read was never released").toBe(false);
    });

    it("shows the newest attempt's artifact", async () => {
        const s = await start({
            gh: (r) =>
                onePr({
                    runs: { [r.head]: { id: 1000, head: r.head, attempt: 2 } },
                    artifacts: {
                        1000: ["visual-compact-mantine-1", "visual-compact-mantine-2", "visual-graphty-element-1"],
                    },
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head },
                        "visual-compact-mantine-2": { headSha: r.head, runAttempt: 2 },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                })(r),
        });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.results.runAttempt).toBe(2);
    });

    it("badges a pull request that lacks master's newest baseline commit", async () => {
        const r = makeRepo();
        pushCommit(r.remote, "master", "visual-baselines/compact-mantine/other.png");
        const s = await start({ ...r, gh: onePr() });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets[0].mergeMasterFirst).toBe(true);
    });

    it("lists, when a project opens, the baselines master changed since its capture", async () => {
        const r = makeRepo();
        pushCommit(r.remote, "master", "visual-baselines/compact-mantine/other.png");
        pushCommit(r.remote, "master", "visual-baselines/compact-mantine/button--primary.dark.png");
        const s = await start({ ...r, gh: onePr() });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        const newer = Object.fromEntries(body.target.projects.map((p) => [p.project, p.newer]));
        expect(newer).toEqual({
            "compact-mantine": ["button--primary.dark.png", "other.png"],
            "graphty-element": [],
        });
    });

    it("lists nothing as newer when the branch has master's baselines", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.target.projects.map((p) => p.newer)).toEqual([[], []]);
    });

    it("returns a project's items and its decisions", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const { status, body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(status).toBe(200);
        expect(body.items).toHaveLength(7);
        expect(body.acceptable).toBe(true);
        expect(body.decisions).toEqual({});
    });
});

describe("serve: coupled pull requests", () => {
    // #123 and #124 change the same baselines; #124's capture of slider--sizes differs.
    const OTHER = "5".repeat(40);
    const coupled = (r) => {
        const items = capturedItems();
        const theirs = items.map((i) => (i.file === "slider--sizes.png" ? { ...i, capture: "e".repeat(64) } : i));
        return fakeGh({
            prs: [
                { number: 124, head: OTHER, branch: "feature" },
                { number: 123, head: r.head, branch: "feature" },
            ],
            runs: { [r.head]: { id: 1000, head: r.head }, [OTHER]: { id: 1001, head: OTHER } },
            jobs: {
                1000: [job("compact-mantine"), job("graphty-element")],
                1001: [job("compact-mantine"), job("graphty-element")],
            },
            artifacts: {
                1000: ["visual-compact-mantine-1", "visual-graphty-element-1"],
                1001: ["visual-compact-mantine-2", "visual-graphty-element-2"],
            },
            results: {
                "visual-compact-mantine-1": { headSha: r.head, items },
                "visual-graphty-element-1": { headSha: r.head },
                "visual-compact-mantine-2": { headSha: OTHER, items: theirs },
                "visual-graphty-element-2": { headSha: OTHER },
            },
        });
    };
    const decisions = async (s, id) => (await s.api("GET", `/api/pr/${id}/compact-mantine`)).body.decisions;

    it("lists them as one group oldest first, counting a shared image once", async () => {
        const s = await start({ gh: coupled });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/inbox");
        expect(body.groups).toEqual([
            expect.objectContaining({
                ids: ["123", "124"],
                prs: [123, 124],
                shared: expect.arrayContaining([
                    "compact-mantine/button--primary.dark.png",
                    "graphty-element/graph--basic.png",
                ]),
                // #124's head was never fetched: its other files are unknown, so no fold is suggested.
                fold: null,
            }),
        ]);
        const [g] = body.groups;
        // Every undecided image of both, less the ones both show identically.
        expect(g.images - g.distinct).toBe(g.images / 2 - 1);
    });

    it("applies a decision and an Undo to the members showing the same image, and only them", async () => {
        const s = await start({ gh: coupled });
        await s.api("GET", "/api/prs");
        const decide = (file, decision, extra = {}) =>
            s.api("POST", "/api/decide-group", {
                id: "123",
                project: "compact-mantine",
                file,
                decision,
                reason: null,
                ...extra,
            });
        const one = await decide("button--primary.dark.png", "accept");
        expect(one.body).toMatchObject({ ok: true, also: [124], failed: [] });
        // Decided while reviewing #123: #124's Finish counts it as not opened there.
        expect((await decisions(s, "124"))["button--primary.dark.png"]).toMatchObject({
            decision: "accept",
            bulk: true,
        });
        // A different capture on #124: decided on #123 only.
        expect((await decide("slider--sizes.png", "accept")).body.also).toEqual([]);
        expect((await decisions(s, "124"))["slider--sizes.png"]).toBeUndefined();
        // #124 decided otherwise: never reversed, and said so.
        await s.api("POST", "/api/decide", {
            id: "124",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "reject",
            reason: "no",
        });
        const clash = await decide("badge--default.light.png", "accept");
        expect(clash.body.failed).toEqual([{ pr: 124, error: expect.stringContaining("already rejected") }]);
        // Undo goes to #124 only where it holds the same decision.
        expect((await decide("button--primary.dark.png", null)).body.also).toEqual([124]);
        expect((await decide("badge--default.light.png", null)).body.also).toEqual([]);
        expect(await decisions(s, "124")).toEqual({
            "badge--default.light.png": expect.objectContaining({ decision: "reject" }),
        });
        // Plain /api/decide never touches the group.
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "button--primary.dark.png",
            decision: "accept",
            reason: null,
        });
        expect((await decisions(s, "124"))["button--primary.dark.png"]).toBeUndefined();
        const log = readFileSync(join(s.tmp, "state/groups.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
        expect(log[0]).toMatchObject({ group: [123, 124], pr: 123, action: "decide", decision: "accept", also: [124] });
    });

    it("accepts all on the members showing the same images", async () => {
        const s = await start({ gh: coupled });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("POST", "/api/accept-all-group", { id: "123", project: "compact-mantine" });
        expect(body.also).toEqual([124]);
        const theirs = await decisions(s, "124");
        expect(Object.keys(theirs).sort()).toEqual(body.files.filter((f) => f !== "slider--sizes.png").sort());
        expect(body.files).toContain("slider--sizes.png");
    });
});

describe("serve: update from master", () => {
    it("merges master into the branch as a background job, then lists the new head", async () => {
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => out.mockRestore());
        const r = makeRepo();
        pushCommit(r.remote, "master", "visual-baselines/compact-mantine/other.png");
        const s = await start({ ...r, gh: onePr() });
        expect((await s.api("GET", "/api/prs")).body.targets[0].mergeMasterFirst).toBe(true);
        const begun = await s.api("POST", "/api/update", { id: "123" });
        expect(begun.status).toBe(202);
        expect(begun.body.job).toMatchObject({ kind: "update", target: "123", pr: 123, running: true });
        const job = await endedJob(s);
        expect(job.error).toBeNull();
        expect(job.result).toMatchObject({
            commit: git(r.remote, "rev-parse", "feature"),
            branch: "feature",
            taken: [],
            recapture: ["visual-baselines/compact-mantine/other.png"],
        });
        expect(git(r.remote, "rev-parse", "feature^1")).toBe(r.head);
    });

    it("refuses a second job, and fails on a branch that already has master", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => {
            err.mockRestore();
            out.mockRestore();
        });
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        expect((await s.api("POST", "/api/update", { id: "123" })).status).toBe(202);
        expect(await s.api("POST", "/api/update", { id: "123" })).toMatchObject({
            status: 409,
            body: { error: "a Finish or an update is already running" },
        });
        // The branch already has master: the job fails and says so.
        expect((await endedJob(s)).error).toBe("feature already has everything on master: nothing to update");
    });

    it("keeps a decision whose capture and baseline are unchanged in the new run, and drops one whose baseline moved", async () => {
        let second = false;
        const s = await start({
            gh: (r) => {
                const first = onePr()(r);
                const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
                // The new run: master's newer baseline of slider--sizes, the same captures.
                const items = fixture.items.map((i) =>
                    i.file === "slider--sizes.png" ? { ...i, baseline: "f".repeat(64) } : i,
                );
                const at = { commit: r.head, headSha: r.head, runId: 1001 };
                const next = onePr({
                    runs: { [r.head]: { id: 1001, head: r.head, attempt: 1 } },
                    jobs: { 1001: [job("compact-mantine"), job("graphty-element")] },
                    artifacts: { 1001: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                    results: { "visual-compact-mantine-1": { ...at, items }, "visual-graphty-element-1": at },
                })(r);
                return (args, input) => (second ? next : first)(args, input);
            },
        });
        await s.api("GET", "/api/prs");
        const decide = (file, decision, reason) =>
            s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision, reason });
        expect((await decide("button--primary.dark.png", "accept")).status).toBe(200);
        expect((await decide("slider--sizes.png", "accept")).status).toBe(200);
        expect((await decide("badge--default.light.png", "reject", "too wide")).status).toBe(200);
        second = true;
        expect((await s.api("GET", "/api/prs")).body.targets[0].runId).toBe(1001);
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({
            "button--primary.dark.png": { decision: "accept", reason: null },
            "badge--default.light.png": { decision: "reject", reason: "too wide" },
        });
    });
});

describe("serve: master", () => {
    const master = (r) =>
        fakeGh({
            runsById: { 2000: { id: 2000, head: r.master, attempt: 1 } },
            runs: { [r.master]: { id: 2999, head: r.master } },
            jobs: { 2000: [job("compact-mantine"), job("graphty-element")] },
            artifacts: {
                2000: ["visual-compact-mantine-1", "visual-graphty-element-1"],
                2999: ["visual-compact-mantine-1"],
            },
            results: {
                "visual-compact-mantine-1": { commit: r.master, headSha: null, pr: null, runId: 2000 },
                "visual-graphty-element-1": { commit: r.master, headSha: null, pr: null, runId: 2000 },
            },
        });

    it("shows the run given with --master-run and no other", async () => {
        const s = await start({ gh: master, masterRun: 2000 });
        const { body } = await s.api("GET", "/api/prs");
        const target = body.targets.find((t) => t.id === "master");
        expect(target).toMatchObject({ pr: null, runId: 2000, commit: s.master });
        expect(target.projects.map((p) => p.project)).toEqual(["compact-mantine", "graphty-element"]);
    });

    it("refuses Accept for a project that is not seeded from master", async () => {
        const p = FIXTURE_CONFIG.projects;
        const config = {
            ...FIXTURE_CONFIG,
            projects: { ...p, "graphty-element": { ...p["graphty-element"], seedFromDefaultBranch: false } },
        };
        const s = await start({ gh: master, masterRun: 2000, config });
        await s.api("GET", "/api/prs");
        const decide = (project, file) =>
            s.api("POST", "/api/decide", { id: "master", project, file, decision: "accept" });
        expect((await decide("graphty-element", "graph--basic.png")).status).toBe(403);
        expect((await decide("compact-mantine", "badge--default.light.png")).status).toBe(200);
        const { body } = await s.api("GET", "/api/pr/master/graphty-element");
        expect(body.acceptable).toBe(false);
    });
});

describe("serve: candidates", () => {
    // Two full runs of master: 2000 captured C (master), 2001 captured C2 (the feature commit), both
    // of the same fixture, so their images hash the same.
    const fullRuns = (r) => {
        const gh = fakeGh({
            runsById: { 2000: { id: 2000, head: r.master, attempt: 1 }, 2001: { id: 2001, head: r.head, attempt: 2 } },
            // A full run calls ci.yml from its job "CI", so its jobs are "CI / visual (<project>)".
            jobs: {
                2000: [{ ...job("compact-mantine"), name: "CI / visual (compact-mantine)" }],
                2001: [{ ...job("compact-mantine"), name: "CI / visual (compact-mantine)" }],
            },
            artifacts: { 2000: ["visual-compact-mantine-1"], 2001: ["visual-compact-mantine-2"] },
            results: {
                "visual-compact-mantine-1": { commit: r.master, headSha: null, pr: null, runId: 2000 },
                "visual-compact-mantine-2": { commit: r.head, headSha: null, pr: null, runId: 2001, runAttempt: 2 },
            },
        });
        // Master's rejects open an issue.
        return async (args, input) => {
            if (args[1]?.startsWith("repos/{owner}/{repo}/pulls?state=open")) {
                if (r.box.open === null) {
                    throw new Error("HTTP 403: rate limit");
                }
                return JSON.stringify(r.box.open);
            }
            if (args[2] === "PATCH") {
                r.box.closed.push(args[3]);
                return "{}";
            }
            if (args[1] !== "repos/{owner}/{repo}/issues") {
                return gh(args, input);
            }
            if (r.failIssues) {
                throw new Error("HTTP 502");
            }
            return JSON.stringify({ html_url: "https://gh/issues/7" });
        };
    };
    const record = (commit, runId, waiting, at) => ({ commit, runId, waiting, at });
    const offered = async (s) => (await s.api("GET", "/api/prs")).body.targets.find((t) => t.id === "master");
    const decisions = async (s) => (await s.api("GET", "/api/pr/master/compact-mantine")).body.decisions;
    const decide = (s, file, decision, reason = null) =>
        s.api("POST", "/api/decide", { id: "master", project: "compact-mantine", file, decision, reason });

    /**
     * A server whose candidate list is `box.list`, read again at every refresh.
     * @param {(r: object) => object[]} make the first list, from the repository
     * @param {object} [extra] more createApp options
     * @returns {Promise<object>} the started app, with `list` to change
     */
    async function startWith(make, extra = {}) {
        const box = { list: [], open: [], closed: [] };
        const r = makeRepo();
        r.box = box;
        box.list = make(r);
        const s = await start({
            ...r,
            gh: fullRuns,
            candidates: async () => box.list ?? Promise.reject(new Error("store down")),
            ...extra,
        });
        return Object.assign(s, { box });
    }

    it("offers the oldest waiting run and queues the newer ones behind it", async () => {
        const s = await startWith((r) => [
            record(r.head, 2001, true, 3000),
            record("9".repeat(40), 1999, false, 2500),
            record(r.master, 2000, true, 2000),
            record("8".repeat(40), 1998, false, 1000),
            record("7".repeat(40), 1997, false, 500),
        ]);
        const t = await offered(s);
        expect(t).toMatchObject({ runId: 2000, commit: s.master });
        expect(t.candidate).toEqual({ commit: s.master, runId: 2000, queued: [{ commit: s.head, runId: 2001 }] });
        expect(t.title).toBe(`master candidate ${s.master.slice(0, 10)} (1 queued)`);
        expect(t.projects.find((p) => p.project === "compact-mantine").logUrl).toBe("https://gh/job/compact-mantine");
    });

    it("keeps a candidate with a changed image waiting, through a newer run and an accept-only Finish", async () => {
        const s = await startWith((r) => [record(r.master, 2000, true, 2000)]);
        await offered(s);
        s.box.list = [...s.box.list, record(s.head, 2001, true, 3000)];
        expect((await offered(s)).candidate.commit).toBe(s.master);
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        const { job: ended } = await finishJob(s, "master");
        expect(ended.error).toBeNull();
        expect(ended.result.branch).toBe(`visual/approve-${s.master.slice(0, 12)}`);
        const changed = git(s.remote, "diff", "--name-only", s.master, ended.result.branch).split("\n");
        expect(changed.every((f) => /^(visual-baselines|visual-review-approvals)\//.test(f))).toBe(true);
        expect(ended.result.pullRequest).toBe("https://gh/pull/650");
        // Still offered while its pull request is open, and the list still says it waits.
        expect((await offered(s)).candidate.commit).toBe(s.master);
        // The accept pull request merges: A reaches master, so the next candidate is offered.
        git(s.remote, "update-ref", "refs/heads/master", ended.result.commit);
        expect((await offered(s)).candidate).toEqual({ commit: s.head, runId: 2001, queued: [] });
        // Its pull request reverted: the record leaves master, and the candidate waits again.
        const path = /^Record: (.+)$/m.exec(
            git(s.remote, "log", "--format=%B", `${s.master}..${ended.result.commit}`),
        )[1];
        git(s.repo, "fetch", "-q", "origin", "master");
        git(s.repo, "checkout", "-q", "--detach", "FETCH_HEAD");
        git(s.repo, "rm", "-q", path);
        git(
            s.repo,
            "commit",
            "-q",
            "-m",
            `Revert "test(workspace): approve visual baselines at ${s.master.slice(0, 12)}"`,
        );
        git(s.repo, "push", "-q", "origin", "HEAD:refs/heads/master");
        expect((await offered(s)).candidate.commit).toBe(s.master);
    });

    it("carries a decision over to the next candidate by image hash", async () => {
        const s = await startWith((r) => [record(r.master, 2000, true, 2000), record(r.head, 2001, true, 3000)]);
        await offered(s);
        expect((await decide(s, "button--primary.dark.png", "accept")).status).toBe(200);
        s.box.list = [record(s.master, 2000, false, 2000), record(s.head, 2001, true, 3000)];
        expect((await offered(s)).runId).toBe(2001);
        expect(await decisions(s)).toMatchObject({ "button--primary.dark.png": { decision: "accept" } });
    });

    it("drops a candidate a Finish rejected something in and offers the next, the reject still standing", async () => {
        const s = await startWith((r) => [record(r.master, 2000, true, 2000), record(r.head, 2001, true, 3000)]);
        await offered(s);
        expect((await decide(s, "slider--sizes.png", "reject", "clipped")).status).toBe(200);
        expect((await decide(s, "button--primary.dark.png", "accept")).status).toBe(200);
        const { job: ended } = await finishJob(s, "master");
        expect(ended.error).toBeNull();
        // Only the rejects: no accept commit, no accept pull request for a candidate that cannot promote.
        expect(ended.result).toMatchObject({
            rejects: 1,
            commit: null,
            pullRequest: null,
            issue: "https://gh/issues/7",
        });
        expect(git(s.remote, "branch", "--list", "visual/approve-*")).toBe("");
        const t = await offered(s);
        expect(t.candidate.commit).toBe(s.head);
        expect(await decisions(s)).toMatchObject({
            "slider--sizes.png": { decision: "reject", reason: "clipped" },
            "button--primary.dark.png": { decision: "accept" },
        });
    });

    it("sends a reject again on the next candidate, so it is dropped too and opens no accept pull request", async () => {
        const s = await startWith((r) => [record(r.master, 2000, true, 2000), record(r.head, 2001, true, 3000)]);
        await offered(s);
        expect((await decide(s, "slider--sizes.png", "reject", "clipped")).status).toBe(200);
        await finishJob(s, "master");
        expect((await offered(s)).candidate.commit).toBe(s.head);
        expect((await decide(s, "button--primary.dark.png", "accept")).status).toBe(200);
        const { job: ended } = await finishJob(s, "master");
        expect(ended.result).toMatchObject({ rejects: 1, commit: null, pullRequest: null });
        expect(git(s.remote, "branch", "--list", "visual/approve-*")).toBe("");
        expect(await offered(s)).toBeUndefined();
    });

    it("commits every decision on a second Finish of the same candidate", async () => {
        const s = await startWith((r) => [record(r.master, 2000, true, 2000)]);
        await offered(s);
        await decide(s, "badge--default.light.png", "accept");
        await finishJob(s, "master");
        await decide(s, "button--primary.dark.png", "accept");
        const { job: ended } = await finishJob(s, "master");
        expect(ended.error).toBeNull();
        const changed = git(s.remote, "diff", "--name-only", s.master, ended.result.branch);
        expect(changed).toContain("visual-baselines/compact-mantine/badge--default.light.png");
        expect(changed).toContain("visual-baselines/compact-mantine/button--primary.dark.png");
        // Built again on the candidate: one accept commit (and its statement), not the first Finish's plus another.
        const parents = git(s.remote, "log", "--reverse", "--format=%P %s", `${s.master}..${ended.result.branch}`);
        expect(parents.split("\n")[0]).toBe(
            `${s.master} test(workspace): approve visual baselines at ${s.master.slice(0, 12)}`,
        );
        expect(parents.split("\n").filter((l) => l.includes("approve visual baselines at"))).toHaveLength(1);
    });

    it("closes the accept pull request of an earlier Finish when a later Finish rejects an image", async () => {
        const s = await startWith((r) => [record(r.master, 2000, true, 2000)]);
        await offered(s);
        await decide(s, "badge--default.light.png", "accept");
        const first = (await finishJob(s, "master")).job;
        expect(first.result.pullRequest).toBe("https://gh/pull/650");
        s.box.open = [{ number: 650, html_url: "https://gh/pull/650", head: { ref: first.result.branch } }];
        await decide(s, "slider--sizes.png", "reject", "clipped");
        const { job: ended } = await finishJob(s, "master");
        expect(ended.result).toMatchObject({ rejects: 1, closedPullRequest: "https://gh/pull/650" });
        expect(s.box.closed).toEqual(["repos/{owner}/{repo}/pulls/650"]);
        expect(await offered(s)).toBeUndefined();
    });

    it("closes a rejected candidate's accept pull request on a later refresh when the Finish could not", async () => {
        const s = await startWith((r) => [record(r.master, 2000, true, 2000), record(r.head, 2001, true, 3000)]);
        await offered(s);
        s.box.open = null; // the listing fails
        await decide(s, "slider--sizes.png", "reject", "clipped");
        const { job: ended } = await finishJob(s, "master");
        expect(ended.result.closeError).toMatch(/could not close the pull request of visual\/approve-/);
        expect(ended.warnings.join("\n")).toMatch(/still open/);
        // Dropped all the same, with its rejects filed once.
        expect((await offered(s)).candidate.commit).toBe(s.head);
        const branch = `visual/approve-${s.master.slice(0, 12)}`;
        s.box.open = [{ number: 651, html_url: "https://gh/pull/651", head: { ref: branch } }];
        await offered(s);
        expect(s.box.closed).toEqual(["repos/{owner}/{repo}/pulls/651"]);
        await offered(s);
        expect(s.box.closed).toHaveLength(1);
    });

    it("accepts on a candidate a project that is not seeded from the default branch", async () => {
        const p = FIXTURE_CONFIG.projects;
        const config = {
            ...FIXTURE_CONFIG,
            projects: { ...p, "compact-mantine": { ...p["compact-mantine"], seedFromDefaultBranch: false } },
        };
        const s = await startWith((r) => [record(r.master, 2000, true, 2000)], { config });
        await offered(s);
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
    });

    it("keeps a candidate whose rejects could not be filed, so Finish can send them again", async () => {
        const s = await startWith((r) => {
            r.failIssues = true;
            return [record(r.master, 2000, true, 2000), record(r.head, 2001, true, 3000)];
        });
        await offered(s);
        await decide(s, "slider--sizes.png", "reject", "clipped");
        await finishJob(s, "master");
        expect((await offered(s)).candidate.commit).toBe(s.master);
    });

    it("leaves out a malformed row and offers the rest", async () => {
        const s = await startWith((r) => [
            { commit: "ABC", runId: 1, waiting: true, at: 1 },
            record(r.master, 2000, true, 2000),
        ]);
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets.find((t) => t.id === "master").candidate.commit).toBe(s.master);
        expect(body.warning).toMatch(/1 malformed row, left out/);
    });

    it("keeps the last good list when the command prints something else", async () => {
        const s = await startWith((r) => [record(r.master, 2000, true, 2000)]);
        await offered(s);
        s.box.list = { not: "a list" };
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets.find((t) => t.id === "master").candidate.commit).toBe(s.master);
        expect(body.warning).toMatch(/could not list the candidates: the candidates command must print/);
    });

    it("never shows a dropped candidate again when the next one's run cannot be read", async () => {
        const s = await startWith((r) => [
            record(r.master, 2000, true, 2000),
            record("6".repeat(40), 2098, true, 3000),
        ]);
        await offered(s);
        expect((await decide(s, "slider--sizes.png", "reject", "clipped")).status).toBe(200);
        await finishJob(s, "master");
        const t = await offered(s);
        expect(t.candidate.commit).toBe("6".repeat(40));
        expect(t.runId ?? null).toBeNull();
        s.box.list = null; // the list fails too: the last one read is used, still without the dropped one
        expect((await offered(s)).candidate.commit).toBe("6".repeat(40));
    });

    it("offers nothing while no candidate waits, and --master-run still wins", async () => {
        const s = await startWith(() => [record("8".repeat(40), 1998, false, 1000)]);
        expect(await offered(s)).toBeUndefined();
        server.close();
        await app.idle();
        const pinned = await startWith((r) => [record(r.master, 2000, true, 2000)], { masterRun: 2001 });
        expect(await offered(pinned)).toMatchObject({ runId: 2001, candidate: null });
    });
});

describe("serve: rolling renders", () => {
    // Two slice runs rendered master's commit: 3000 and 3001, each with one artifact of the fixture.
    const slices = (r, extra = {}) =>
        fakeGh({
            artifacts: { 3000: ["visual-compact-mantine-1"], 3001: ["visual-compact-mantine-2"] },
            results: {
                "visual-compact-mantine-1": { commit: r.master, headSha: null, pr: null, runId: 3000 },
                "visual-compact-mantine-2": { commit: r.master, headSha: null, pr: null, runId: 3001 },
            },
            ...extra,
        });
    const item = (id, mode, runId) => ({
        project: "compact-mantine",
        id,
        mode,
        runId,
        attempt: 1,
        artifact: `visual-compact-mantine-${runId - 2999}`,
    });
    const target = async (s) => (await s.api("GET", "/api/prs")).body.targets.find((t) => t.id === "rolling");
    const capture = async (s) => (await s.api("GET", "/api/pr/rolling/compact-mantine")).body;
    const decide = (s, file, decision, reason = null) =>
        s.api("POST", "/api/decide", { id: "rolling", project: "compact-mantine", file, decision, reason });

    async function startWith(make, { gh = slices, ...extra } = {}) {
        const box = { list: [], candidates: [] };
        const r = makeRepo();
        box.list = make(r);
        const s = await start({
            ...r,
            gh,
            rolling: async () => box.list,
            candidates: async () => box.candidates,
            ...extra,
        });
        return Object.assign(s, { box });
    }

    it("offers exactly the listed renders of the newest render commit, each with its render", async () => {
        const s = await startWith((r) => [
            {
                commit: r.master,
                at: 5000,
                items: [item("badge--default", "light", 3000), item("button--primary", "dark", 3001)],
                pending: [{ project: "compact-mantine", id: "slider--sizes", mode: null, why: "re-render pending" }],
            },
            { commit: "9".repeat(40), at: 4000, items: [], pending: [] },
        ]);
        const t = await target(s);
        expect(t.rolling).toMatchObject({ commit: s.master, waiting: 1, older: 0 });
        expect(t.title).toMatch(new RegExp(`^master rolling: rendered from ${s.master.slice(0, 10)} at `));
        expect(t.runId).toBe(3001);
        expect(t.warnings[0]).toMatch(/1 changed renders wait for a re-render/);
        const body = await capture(s);
        expect(body.items.map((i) => [i.file, i.render])).toEqual([
            ["badge--default.light.png", "3000-1"],
            ["button--primary.dark.png", "3001-1"],
        ]);
        expect(body.target.commit).toBe(s.master);
    });

    it("binds a decision to its render: a newer render of the story drops it, whatever its hash", async () => {
        const s = await startWith((r) => [
            { commit: r.master, at: 5000, items: [item("badge--default", "light", 3000)], pending: [] },
        ]);
        await target(s);
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        expect((await capture(s)).decisions).toMatchObject({ "badge--default.light.png": { decision: "accept" } });
        // the same picture, rendered again by run 3001
        s.box.list = [{ commit: s.master, at: 6000, items: [item("badge--default", "light", 3001)], pending: [] }];
        await s.api("GET", "/api/prs?refresh=1");
        await until(async () => (await target(s))?.runId === 3001);
        expect((await capture(s)).decisions).toEqual({});
    });

    it("refuses its Finish while a candidate is offered", async () => {
        const held = await startWith((r) => {
            return [{ commit: r.master, at: 5000, items: [item("badge--default", "light", 3000)], pending: [] }];
        });
        held.box.candidates = [{ commit: held.master, runId: 2000, waiting: true, at: 1 }];
        await target(held);
        expect((await decide(held, "badge--default.light.png", "accept")).status).toBe(200);
        const refused = await held.api("POST", "/api/finish", { id: "rolling" });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/a candidate is held/);
    });

    it("refuses its Finish while another approval pull request is open", async () => {
        const s = await startWith(
            (r) => [{ commit: r.master, at: 5000, items: [item("badge--default", "light", 3000)], pending: [] }],
            { gh: (r) => slices(r, { prs: [{ number: 77, head: r.head, branch: "visual/approve-0123456789ab" }] }) },
        );
        await target(s);
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        const refused = await s.api("POST", "/api/finish", { id: "rolling" });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/approval pull request #77 is open/);
    });

    it("finishes on visual/approve-rolling-<sha>, parented on the render commit", async () => {
        const s = await startWith((r) => [
            { commit: r.master, at: 5000, items: [item("badge--default", "light", 3000)], pending: [] },
        ]);
        await target(s);
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        const { job: ended } = await finishJob(s, "rolling");
        expect(ended.error).toBeNull();
        const branch = `visual/approve-rolling-${s.master.slice(0, 12)}`;
        expect(ended.result.branch).toBe(branch);
        // the accept commit, under the signed statement commit
        expect(git(s.remote, "log", "--format=%s", `${s.master}..${branch}`).split("\n")).toContain(
            `test(workspace): rolling approval of visual baselines rendered at ${s.master.slice(0, 12)}`,
        );
        const changed = git(s.remote, "diff", "--name-only", s.master, branch).split("\n");
        expect(changed.every((f) => /^(visual-baselines|visual-review-approvals)\//.test(f))).toBe(true);
    });
});

describe("serve: images", () => {
    it("serves a capture and a baseline whose hashes match results.json", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const cap = await s.api("GET", "/api/img/123/compact-mantine/capture/button--primary.dark.png");
        expect(cap.status).toBe(200);
        expect(cap.type).toBe("image/png");
        expect(cap.body.equals(readFileSync(join(FIXTURE, "compact-mantine/button--primary.dark.png")))).toBe(true);
        const base = await s.api("GET", "/api/img/123/compact-mantine/baseline/card--legacy.png");
        expect(base.status).toBe(200);
    });

    it("refuses any path outside the downloaded artifact", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        for (const path of ["..%2Fresults.json", "..%2F..%2F..%2Fpackage.json", "results.json", "%2Fetc%2Fpasswd"]) {
            expect((await s.api("GET", `/api/img/123/compact-mantine/capture/${path}`)).status).toBe(404);
        }
        const raw = await new Promise((resolve) => {
            const port = new URL(s.origin).port;
            request(
                {
                    port,
                    path: "/api/img/123/compact-mantine/capture/../../../etc/passwd",
                    headers: { "x-review-token": TOKEN },
                },
                resolve,
            ).end();
        });
        expect(raw.statusCode).toBe(404);
    });

    it("names a target that is not listed any more by its number, or by the default branch", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const pr = await s.api("GET", "/api/img/999/compact-mantine/capture/button--primary.dark.png");
        expect(pr.status).toBe(404);
        expect(pr.body.error).toBe("#999 is not listed any more (closed, or it could not be loaded): reload the list");
        const master = await s.api("GET", "/api/img/master/compact-mantine/capture/button--primary.dark.png");
        expect(master.status).toBe(404);
        expect(master.body.error).toBe(
            "master is not listed any more (closed, or it could not be loaded): reload the list",
        );
    });

    it("refuses an image whose bytes differ from results.json's hash", async () => {
        const s = await start({ gh: onePr() });
        const { body } = await s.api("GET", "/api/prs");
        const dir = join(s.tmp, `1000-1/compact-mantine`);
        expect(body.targets[0].runAttempt).toBe(1);
        writeFileSync(join(dir, "badge--default.light.png"), "tampered");
        writeFileSync(join(dir, "baselines/card--legacy.png"), "tampered");
        expect((await s.api("GET", "/api/img/123/compact-mantine/capture/badge--default.light.png")).status).toBe(409);
        expect((await s.api("GET", "/api/img/123/compact-mantine/baseline/card--legacy.png")).status).toBe(409);
    });
});

describe("serve: access", () => {
    it("refuses an /api request without the session token", async () => {
        const s = await start({ gh: onePr() });
        expect((await s.api("GET", "/api/prs", undefined, { "x-review-token": "wrong" })).status).toBe(401);
        const bare = await fetch(`${s.origin}/api/prs`);
        expect(bare.status).toBe(401);
    });

    it("serves the page without the token", async () => {
        const s = await start({ gh: onePr() });
        const page = await fetch(`${s.origin}/`);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
        expect(await page.text()).toContain("review.js");
    });

    it("refuses a state-changing request from a foreign origin", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const decision = {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        };
        expect((await s.api("POST", "/api/decide", decision, { origin: "https://evil.example" })).status).toBe(403);
        expect((await s.api("POST", "/api/finish", { id: "123" }, { origin: "https://evil.example" })).status).toBe(
            403,
        );
    });

    it("answers Finish only to POST", async () => {
        const s = await start({ gh: onePr() });
        expect((await s.api("GET", "/api/finish")).status).toBe(405);
        expect((await s.api("PUT", "/api/finish", { id: "123" })).status).toBe(405);
    });
});

describe("serve: renamed stories", () => {
    it("counts a moved item as needing a decision, serves its capture as its baseline, and accepts it", async () => {
        const s = await start({ gh: withMoved });
        const prs = await s.api("GET", "/api/prs");
        const cm = prs.body.targets[0].projects.find((p) => p.project === "compact-mantine");
        expect(cm.counts.moved).toBe(1);
        expect(cm.reviewable).toBe(6);
        const capture = readFileSync(join(FIXTURE, "compact-mantine/slider--sizes.png"));
        const base = await s.api("GET", "/api/img/123/compact-mantine/baseline/slider--sizes.png");
        expect(base.status).toBe(200);
        expect(base.body.equals(capture)).toBe(true);
        const decide = { id: "123", project: "compact-mantine", file: "slider--sizes.png", decision: "accept" };
        expect((await s.api("POST", "/api/decide", decide)).status).toBe(200);
        const item = (await s.api("GET", "/api/pr/123/compact-mantine")).body.items.find(
            (i) => i.file === "slider--sizes.png",
        );
        expect(item).toMatchObject({ status: "moved", from: "old-slider--sizes" });
    });
});

describe("serve: decisions and Finish", () => {
    it("keeps decisions in memory and refuses Accept on an unstable item", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const decide = (file, decision, reason) =>
            s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision, reason });
        expect((await decide("tooltip--hover.png", "accept")).status).toBe(409);
        expect((await decide("tooltip--hover.png", "exclude", "races")).status).toBe(200);
        expect((await decide("badge--default.light.png", "reject")).status).toBe(400);
        expect((await decide("badge--default.light.png", "accept")).status).toBe(200);
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({
            "tooltip--hover.png": { decision: "exclude", reason: "races" },
            "badge--default.light.png": { decision: "accept", reason: null },
        });
        const prs = await s.api("GET", "/api/prs");
        expect(prs.body.targets[0].projects[0].decided).toBe(2);
        expect((await decide("badge--default.light.png", null)).status).toBe(200);
        expect(Object.keys((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions)).toEqual([
            "tooltip--hover.png",
        ]);
    });

    it("finishes across every project in one commit, and marks what it published", async () => {
        // Finish says in the server's log when it starts, ends and fails.
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        onTestFinished(() => {
            out.mockRestore();
            err.mockRestore();
        });
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        });
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "graphty-element",
            file: "graph--basic.png",
            decision: "accept",
        });
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "slider--sizes.png",
            decision: "reject",
            reason: "thumb moved",
        });
        const { begun, job } = await finishJob(s, "123");
        expect(begun.status).toBe(202);
        expect(job.error).toBeNull();
        const body = job.result;
        expect(body.rejects).toBe(1);
        expect(git(s.remote, "rev-parse", "feature")).toBe(body.commit);
        expect(git(s.remote, "rev-parse", "feature~1")).toBe(s.head);
        // What Finish published stays shown, marked posted: the accept until a new CI run replaces
        // this capture, the reject for good.
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toEqual({
            "badge--default.light.png": { decision: "accept", reason: null, posted: true },
            "slider--sizes.png": { decision: "reject", reason: "thumb moved", posted: true },
        });
        // A second Finish has nothing new to post.
        expect((await finishJob(s, "123")).job.error).toBe("nothing decided");
        expect(out.mock.calls.map(([line]) => line)).toEqual([
            "visual-review: Finish of #123 started: 3 decisions, 4 undecided",
            `visual-review: Finish of #123 done: commit ${body.commit}, 1 rejects`,
            "visual-review: Finish of #123 started: 0 decisions, 4 undecided",
        ]);
        expect(err.mock.calls.map(([line]) => line)).toEqual(["visual-review: Finish of #123 failed: nothing decided"]);
    });

    it("treats a finished accept as published only while the branch holds it", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => vi.restoreAllMocks());
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const decide = (file, decision, reason) =>
            s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision, reason });
        await decide("badge--default.light.png", "accept");
        await decide("slider--sizes.png", "reject", "thumb moved");
        const { job } = await finishJob(s, "123");
        expect(job.error).toBeNull();
        const decisions = async () => (await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions;
        const unpublished = async () => (await s.api("GET", "/api/target/123")).body.unpublished;
        await s.api("GET", "/api/prs");
        expect((await decisions())["badge--default.light.png"]).toEqual({
            decision: "accept",
            reason: null,
            posted: true,
        });
        expect(await unpublished()).toBe(0);
        // The accept commit is reverted on the branch, and CI captures the same images again.
        const clone = join(s.dir, "reverter");
        git(s.dir, "clone", "-q", "-b", "feature", s.remote, clone);
        git(clone, "config", "user.name", "Other");
        git(clone, "config", "user.email", "other@example.com");
        git(clone, "revert", "--no-edit", job.result.commit);
        git(clone, "push", "-q", "origin", "feature");
        await s.api("GET", "/api/prs");
        // Decided, but no longer published: the next Finish publishes it again. The reject's
        // comment is not on the branch, so the revert leaves it posted.
        expect(await decisions()).toEqual({
            "badge--default.light.png": { decision: "accept", reason: null },
            "slider--sizes.png": { decision: "reject", reason: "thumb moved", posted: true },
        });
        expect(await unpublished()).toBe(1);
    });

    it("lets a reject an earlier Finish posted be changed to an accept, which the next Finish commits", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => vi.restoreAllMocks());
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const decide = (file, decision, reason) =>
            s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision, reason });
        await decide("badge--default.light.png", "accept");
        await decide("slider--sizes.png", "reject", "thumb moved");
        const first = (await finishJob(s, "123")).job;
        expect(first.error).toBeNull();
        // Counted as rejected, waiting for a fix, never as nothing to decide.
        const listed = (await s.api("GET", "/api/prs")).body;
        expect(listed.targets[0].projects[0]).toMatchObject({ rejected: 1 });
        expect(listed.inbox).toMatchObject({ done: 0 });
        expect((await decide("slider--sizes.png", "accept")).status).toBe(200);
        expect((await s.api("GET", "/api/target/123")).body.unpublished).toBe(1);
        // The capture is of the head; the branch holds only the first Finish's commit on top of it.
        const { job } = await finishJob(s, "123");
        expect(job.error).toBeNull();
        expect(git(s.remote, "rev-parse", "feature~1")).toBe(first.result.commit);
        const record = (commit) => {
            const path = /Record: (\S+)/.exec(git(s.remote, "log", "-1", "--format=%B", commit))[1];
            return JSON.parse(git(s.remote, "show", `${commit}:${path}`));
        };
        const slider = "visual-baselines/compact-mantine/slider--sizes.png";
        // The earlier record keeps the reject; the new one accepts the image.
        expect(record(first.result.commit).rejects).toEqual([
            expect.objectContaining({ path: slider, reason: "thumb moved" }),
        ]);
        expect(record(job.result.commit).items).toEqual([expect.objectContaining({ path: slider })]);
        expect(record(job.result.commit).rejects).toEqual([]);
    });

    it("treats a finished accept as unpublished when the branch's baseline no longer holds its image", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => vi.restoreAllMocks());
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        });
        const { job } = await finishJob(s, "123");
        expect(job.error).toBeNull();
        await s.api("GET", "/api/prs");
        expect((await s.api("GET", "/api/target/123")).body.unpublished).toBe(0);
        // An update from the default branch takes its side of the baseline: the review record stays
        // on the branch, but the file holds the old image again, so the gate sees the change unaccepted.
        const clone = join(s.dir, "updater");
        git(s.dir, "clone", "-q", "-b", "feature", s.remote, clone);
        git(clone, "config", "user.name", "Other");
        git(clone, "config", "user.email", "other@example.com");
        git(clone, "rm", "-q", "visual-baselines/compact-mantine/badge--default.light.png");
        git(clone, "commit", "-q", "-m", "take the default branch's baseline");
        git(clone, "push", "-q", "origin", "feature");
        await s.api("GET", "/api/prs");
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toEqual({
            "badge--default.light.png": { decision: "accept", reason: null },
        });
        expect((await s.api("GET", "/api/target/123")).body.unpublished).toBe(1);
    });

    it("runs Finish in the background, reports its step, and refuses a second one and new decisions", async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        let reached;
        const atStatus = new Promise((resolve) => (reached = resolve));
        const s = await start({
            gh: (r) => {
                const gh = onePr()(r);
                return async (args, input) => {
                    if (args[1]?.includes("/statuses/")) {
                        reached();
                        await gate;
                    }
                    return gh(args, input);
                };
            },
        });
        await s.api("GET", "/api/prs");
        const decide = (file) =>
            s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision: "accept" });
        await decide("badge--default.light.png");
        expect((await s.api("GET", "/api/finish-status")).body.job).toBeNull();
        const begun = await s.api("POST", "/api/finish", { id: "123" });
        expect(begun.status).toBe(202);
        expect(begun.body.job).toMatchObject({ id: 1, target: "123", pr: 123, running: true });
        await atStatus;
        expect((await s.api("GET", "/api/finish-status")).body.job).toMatchObject({
            running: true,
            step: "posting the status",
        });
        const again = await s.api("POST", "/api/finish", { id: "123" });
        expect(again).toMatchObject({ status: 409, body: { error: "a Finish is already running" } });
        expect((await decide("button--primary.dark.png")).status).toBe(409);
        release();
        const job = await endedJob(s);
        expect(job).toMatchObject({ id: 1, running: false, step: null, error: null });
        expect(job.result.commit).toBe(git(s.remote, "rev-parse", "feature"));
        expect((await decide("button--primary.dark.png")).status).toBe(200);
    });

    it("keeps what a Finish published when a refresh read the branch from before its push", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        onTestFinished(() => vi.restoreAllMocks());
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        let reached;
        const atStatus = new Promise((resolve) => (reached = resolve));
        const s = await start({
            gh: (r) => {
                const gh = onePr()(r);
                return async (args, input) => {
                    if (args[1]?.includes("/statuses/")) {
                        reached();
                        await gate;
                    }
                    return gh(args, input);
                };
            },
        });
        await s.api("GET", "/api/prs");
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        });
        await s.api("POST", "/api/finish", { id: "123" });
        await atStatus;
        // A refresh while the Finish runs fetches nothing, and reads the branch as it was before
        // the push.
        const before = () => git(s.repo, "update-ref", "refs/remotes/origin/feature", s.head);
        before();
        await s.api("GET", "/api/prs");
        release();
        expect((await endedJob(s)).error).toBeNull();
        const unpublished = async () => (await s.api("GET", "/api/target/123")).body.unpublished;
        expect(await unpublished()).toBe(0);
        // A later refresh whose fetch fails still knows the push.
        before();
        git(s.repo, "remote", "set-url", "origin", join(s.dir, "gone"));
        await s.api("GET", "/api/prs");
        expect(await unpublished()).toBe(0);
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toEqual({
            "badge--default.light.png": { decision: "accept", reason: null, posted: true },
        });
    });

    it("reports the signing key the server's environment gives git", async () => {
        const s = await start({ gh: onePr() });
        const saved = { ...process.env };
        Object.assign(process.env, {
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "user.signingkey",
            GIT_CONFIG_VALUE_0: "/keys/agent.pub",
            GIT_CONFIG_KEY_1: "commit.gpgsign",
            GIT_CONFIG_VALUE_1: "yes",
        });
        try {
            const { body } = await s.api("GET", "/api/prs");
            expect(body.targets[0].signer).toMatchObject({
                signs: true,
                key: "/keys/agent.pub",
                keyFrom: "command line:",
                fromEnv: true,
            });
        } finally {
            for (const k of Object.keys(process.env).filter((k) => k.startsWith("GIT_CONFIG_"))) {
                delete process.env[k];
            }
            Object.assign(process.env, saved);
        }
    });

    it("keeps the decisions and returns git's stderr when the commit fails", async () => {
        const s = await start({ gh: onePr() });
        git(s.repo, "config", "gpg.ssh.program", "false");
        git(
            s.repo,
            "config",
            "user.signingkey",
            "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderKeyNeverUsedBecauseTheProgramFails",
        );
        git(s.repo, "config", "gpg.format", "ssh");
        git(s.repo, "config", "commit.gpgsign", "true");
        await s.api("GET", "/api/prs");
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        });
        const { job } = await finishJob(s, "123");
        expect(job.error).toContain("failed to write commit object");
        expect(git(s.remote, "rev-parse", "feature")).toBe(s.head);
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toHaveProperty(
            "badge--default.light.png",
        );
    });
});

describe("serve: local results", () => {
    it("serves a results directory given with --results as one local preview, never master or a seed", async () => {
        const r = makeRepo();
        const dir = join(r.dir, "local");
        copyFixture("compact-mantine", join(dir, "compact-mantine"), { pr: null, runId: null, runAttempt: null });
        const s = await start({ ...r, gh: () => async () => "", results: dir });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets).toHaveLength(1);
        expect(body.targets[0]).toMatchObject({ id: "local", local: true, pr: null, branch: null });
        expect(body.targets[0].title).toMatch(/^local preview of /);
        expect((await s.api("GET", "/api/img/local/compact-mantine/capture/button--primary.dark.png")).status).toBe(
            200,
        );
    });

    it("takes no decision and no Finish on a local preview", async () => {
        const r = makeRepo();
        const s = await start({ ...r, gh: () => async () => "", results: FIXTURE });
        await s.api("GET", "/api/prs");
        const decide = (file, decision, reason) =>
            s.api("POST", "/api/decide", { id: "local", project: "compact-mantine", file, decision, reason });
        const refused = await decide("badge--default.light.png", "accept");
        expect(refused.status).toBe(403);
        expect(refused.body.error).toMatch(/local preview/);
        expect((await decide("card--legacy.png", "exclude", "noisy")).status).toBe(403);
        expect((await decide("card--legacy.png", "reject", "keep it")).status).toBe(403);
        expect((await s.api("GET", "/api/pr/local/compact-mantine")).body.acceptable).toBe(false);
        expect((await s.api("POST", "/api/finish", { id: "local" })).status).toBe(403);
    });
});

describe("serve: local previews of a pull request", () => {
    /**
     * Writes a local preview of one project as tools/visual-preview.sh leaves it.
     * @param {string} previews the previews directory
     * @param {string} project the fixture project
     * @param {string} head the pull request head it captured
     * @param {object} [extra] more results.json fields
     * @returns {{ dir: string, results: object }} the copy
     */
    const preview = (previews, project, head, extra = {}) =>
        copyFixture(project, join(previews, "123", project), {
            commit: "3".repeat(40),
            headSha: head,
            pr: 123,
            runId: null,
            runAttempt: null,
            local: {
                describe: "abc1234-dirty",
                diff: "0".repeat(64),
                preview: { merge: "3".repeat(40), host: "devbox", tool: "test" },
            },
            ...extra,
        });
    // #123 with no CI run yet.
    const noRun = (r) => fakeGh({ prs: [{ number: 123, head: r.head, branch: "feature" }] });
    const decide = (s, file, decision, reason, project = "compact-mantine") =>
        s.api("POST", "/api/decide", { id: "123", project, file, decision, reason });

    it("lists a complete preview of the head while CI is pending, and never one of an older head or an ad hoc capture", async () => {
        const r = makeRepo();
        const previews = join(r.dir, "previews");
        preview(previews, "compact-mantine", r.head);
        preview(previews, "graphty-element", "4".repeat(40));
        const s = await start({ ...r, gh: noRun, previews });
        const [t] = (await s.api("GET", "/api/prs")).body.targets;
        const [cm, ge] = t.projects;
        expect(cm).toMatchObject({ preview: true, acceptable: true, reviewable: 6, problem: null });
        expect(ge).toMatchObject({ preview: false, problem: `waiting for CI on ${r.head.slice(0, 10)}` });
        expect(t.headSha).toBe(r.head);

        // A capture without the preview's provenance (an ad hoc `capture --stories`) stays look only.
        const adhoc = join(r.dir, "adhoc");
        preview(adhoc, "compact-mantine", r.head, {
            pr: null,
            headSha: null,
            local: { describe: "x", diff: "0".repeat(64) },
        });
        const other = await start({ ...r, gh: noRun, previews: adhoc });
        expect((await other.api("GET", "/api/prs")).body.targets[0].projects[0].preview).toBe(false);
    });

    it("shows a preview for a project CI has not captured while another project of the run still downloads", async () => {
        const r = makeRepo();
        const previews = join(r.dir, "previews");
        preview(previews, "compact-mantine", r.head);
        // CI's run holds only graphty-element, and its download lasts until the test has looked: a
        // download that merely sleeps longer than the page waits can land while a slow response is
        // still being built, and its row is filled in place before the page sees it.
        let land;
        const landing = new Promise((resolve) => (land = resolve));
        onTestFinished(() => land());
        const s = await start({
            ...r,
            previews,
            gh: (repo) => {
                const ci = onePr({ artifacts: { 1000: ["visual-graphty-element-1"] } })(repo);
                return async (args, input) => {
                    if (args[0] === "run" && args[1] === "download") {
                        await landing;
                    }
                    return ci(args, input);
                };
            },
        });
        const [t] = (await s.api("GET", "/api/prs")).body.targets;
        expect(t.downloading).toBe(true);
        expect(t.projects[0]).toMatchObject({ project: "compact-mantine", preview: true, reviewable: 6 });
        expect(t.projects[1]).toMatchObject({ project: "graphty-element", downloading: true });
    });

    it("decides and finishes on a preview, and the record and commit say it was captured locally", async () => {
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => out.mockRestore());
        const r = makeRepo();
        const previews = join(r.dir, "previews");
        preview(previews, "compact-mantine", r.head);
        const s = await start({ ...r, gh: noRun, previews });
        await s.api("GET", "/api/prs");
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        const sheet = (await s.api("GET", "/api/target/123?finish=1")).body.finish;
        expect(sheet.previews).toEqual(["compact-mantine"]);
        const { job } = await finishJob(s, "123");
        expect(job.error).toBeNull();
        expect(git(s.remote, "rev-parse", "feature~1")).toBe(s.head);
        const message = git(s.remote, "log", "-1", "--format=%B", "feature");
        expect(message).toMatch(/Captured locally at 3{40} \(compact-mantine\)/);
        const path = /Record: (\S+)/.exec(message)[1];
        const record = JSON.parse(git(s.remote, "show", `feature:${path}`));
        expect(record.subject).toMatchObject({
            head: r.head,
            runId: null,
            runAttempt: null,
            local: [{ project: "compact-mantine", merge: "3".repeat(40), host: "devbox", tool: "test" }],
        });
        expect(record.items).toEqual([
            expect.objectContaining({ path: "visual-baselines/compact-mantine/badge--default.light.png", from: null }),
        ]);
    });

    it("offers the gate's capture of a commit not yet pushed as pending push: decided, Finish refused until it is the head", async () => {
        const r = makeRepo();
        const previews = join(r.dir, "previews");
        // The landing the gate checks: the pull request's head merged with a branch, not on GitHub yet.
        const candidate = (n) => git(r.repo, "commit-tree", `${r.head}^{tree}`, "-p", r.head, "-m", `land ${n}`);
        const items = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items;
        // As tools/visual-preview.sh --head stages it for #123 (VISUAL_PREVIEW_BRANCH).
        const stage = (sha, at, captured = items) => {
            const dir = join(previews, `.pending-${sha}`);
            preview(previews, "compact-mantine", sha, { items: captured });
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { recursive: true });
            renameSync(join(previews, "123/compact-mantine"), join(dir, "compact-mantine"));
            if (captured !== items) {
                // Another picture of the badge: the slider's image, under the badge's file.
                cpSync(
                    join(dir, "compact-mantine/slider--sizes.png"),
                    join(dir, "compact-mantine/badge--default.light.png"),
                );
            }
            writeFileSync(
                join(dir, "status.json"),
                JSON.stringify({ state: "done", pr: 123, head: sha, updatedAt: at, projects: ["compact-mantine"] }),
            );
            return dir;
        };
        let head = r.head;
        const gh = () => (args, input) => fakeGh({ prs: [{ number: 123, head, branch: "feature" }] })(args, input);
        const first = candidate(1);
        const staged = stage(first, "2026-10-24T10:00:00Z");
        // A capture of a commit that does not hold the head (an older golden) is never offered.
        stage(git(r.repo, "commit-tree", `${r.head}^{tree}`, "-m", "unrelated"), "2026-10-24T11:00:00Z");
        const s = await start({ ...r, gh, previews });
        let [t] = (await s.api("GET", "/api/prs")).body.targets;
        expect(t.pendingPush).toBe(first);
        expect(t.projects[0]).toMatchObject({ preview: true, pending: true, acceptable: true, reviewable: 6 });
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        const refused = await s.api("POST", "/api/finish-prepare", { id: "123" });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(new RegExp(`^pending push: .*${first.slice(0, 10)}.*head of #123`));
        expect((await s.api("POST", "/api/finish", { id: "123" })).status).toBe(409);

        // The gate failed (its capture discarded); the next candidate draws the same image: the decision
        // holds. One whose image for that story differs never takes it.
        rmSync(staged, { recursive: true });
        const second = candidate(2);
        const again = stage(second, "2026-10-24T12:00:00Z");
        [t] = (await s.api("GET", "/api/prs")).body.targets;
        expect(t.pendingPush).toBe(second);
        expect(t.projects[0]).toMatchObject({ pending: true, decided: 1 });
        rmSync(again, { recursive: true });
        const slider = items.find((i) => i.file === "slider--sizes.png");
        const redrawn = items.map((i) =>
            i.file === "badge--default.light.png" ? { ...i, capture: slider.capture, size: slider.size } : i,
        );
        const third = candidate(3);
        stage(third, "2026-10-24T13:00:00Z", redrawn);
        [t] = (await s.api("GET", "/api/prs")).body.targets;
        expect(t.projects[0]).toMatchObject({ pending: true, decided: 0 });

        // Pushed: GitHub lists it as the head and land.mjs made it the pull request's preview. Finish opens.
        renameSync(join(previews, `.pending-${third}`), join(previews, "123"));
        head = third;
        [t] = (await s.api("GET", "/api/prs")).body.targets;
        expect(t.pendingPush).toBeNull();
        expect(t.projects[0]).toMatchObject({ preview: true, pending: false });
        const opened = await s.api("POST", "/api/finish-prepare", { id: "123" });
        expect(opened.body.error ?? "").not.toMatch(/pending push/);
    });

    it("keeps a preview current after a Finish's own commits, finishes on it again, and asks for a new one after any other commit (issue 3235)", async () => {
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => out.mockRestore());
        const r = makeRepo();
        const previews = join(r.dir, "previews");
        // Without the fixture's failed story, which would hold the pull request out of the inbox.
        preview(previews, "compact-mantine", r.head, { items: capturedItems() });
        // GitHub lists the branch's tip as the draft's head.
        const s = await start({
            ...r,
            gh: (x) => (args, input) =>
                fakeGh({
                    prs: [{ number: 123, head: git(x.remote, "rev-parse", "feature"), branch: "feature", draft: true }],
                })(args, input),
            previews,
        });
        await s.api("GET", "/api/prs");
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        expect((await finishJob(s, "123")).job.error).toBeNull();
        const accepted = git(s.remote, "rev-parse", "feature");
        // A Finish's approval commit, which changes only the approvals directory.
        const approved = pushCommit(s.remote, "feature", `${FIXTURE_CONFIG.approvals}/t.json`);

        // The head is the approval commit: the preview of the old head is still current, the accept
        // finished and the rest undecided, and the draft still waits in the inbox with its count.
        const after = (await s.api("GET", "/api/prs")).body;
        const [t] = after.targets;
        expect(t).toMatchObject({ headSha: r.head });
        expect(t.projects[0]).toMatchObject({ preview: true, problem: null, decided: 1, finished: 1, undecided: 4 });
        expect(after.inbox.ready).toEqual([expect.objectContaining({ pr: 123, undecided: 4, decided: 1 })]);
        // A second Finish on the same preview commits on top of the earlier Finish's commits.
        expect((await decide(s, "button--primary.dark.png", "accept")).status).toBe(200);
        expect((await finishJob(s, "123")).job.error).toBeNull();
        expect(git(s.remote, "rev-parse", "feature~1")).toBe(approved);
        expect(git(s.remote, "rev-parse", "feature~2")).toBe(accepted);

        // Anything else on the branch: no preview, and it says a new one is needed.
        const other = pushCommit(s.remote, "feature", "src/other.txt");
        const [moved] = (await s.api("GET", "/api/prs")).body.targets;
        expect(moved.projects[0]).toMatchObject({
            preview: false,
            problem: `a new preview is needed for this head (${other.slice(0, 10)}): run tools/visual-preview.sh 123`,
        });
    });

    it("shows a project a preview of the head is still capturing as not loaded, and reads it again once status.json changes", async () => {
        const r = makeRepo();
        const previews = join(r.dir, "previews");
        preview(previews, "compact-mantine", r.head, { items: capturedItems() });
        const status = (state) =>
            writeFileSync(
                join(previews, "123/status.json"),
                JSON.stringify({ state, head: r.head, pr: 123, projects: ["compact-mantine", "graphty-element"] }),
            );
        status("running");
        // A CI run with no visual job (a draft's): every project of it is "no capture".
        const s = await start({
            ...r,
            previews,
            gh: () =>
                fakeGh({
                    prs: [{ number: 123, head: r.head, branch: "feature" }],
                    runs: { [r.head]: { id: 1000, head: r.head } },
                    jobs: { 1000: [] },
                    artifacts: { 1000: [] },
                }),
        });
        const [t] = (await s.api("GET", "/api/prs")).body.targets;
        expect(t.projects[0]).toMatchObject({ project: "compact-mantine", preview: true });
        expect(t.projects[1]).toMatchObject({ project: "graphty-element", problem: "local preview still capturing" });

        // The preview writes graphty-element and finishes: the page's next look at the list reads it.
        preview(previews, "graphty-element", r.head);
        status("done");
        await until(async () => (await s.api("GET", "/api/prs?cached=1")).body.targets[0].projects[1].preview === true);
    });

    it("carries decisions over to CI's capture where its bytes are identical, and shows a differing image undecided", async () => {
        // The made-up hash of CI's slider--sizes has no such bytes on disk: its thumbnail says so.
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        onTestFinished(() => err.mockRestore());
        let ci = false;
        const r = makeRepo();
        const previews = join(r.dir, "previews");
        preview(previews, "compact-mantine", r.head);
        const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        // CI draws slider--sizes differently from the preview; everything else byte for byte.
        const items = fixture.items.map((i) =>
            i.file === "slider--sizes.png" ? { ...i, capture: "e".repeat(64) } : i,
        );
        const at = { commit: r.head, headSha: r.head };
        const s = await start({
            ...r,
            previews,
            gh: (repo) => {
                const before = noRun(repo);
                const after = onePr({
                    results: { "visual-compact-mantine-1": { ...at, items }, "visual-graphty-element-1": at },
                })(repo);
                return (args, input) => (ci ? after : before)(args, input);
            },
        });
        await s.api("GET", "/api/prs");
        expect((await decide(s, "button--primary.dark.png", "accept")).status).toBe(200);
        expect((await decide(s, "slider--sizes.png", "accept")).status).toBe(200);
        expect((await decide(s, "card--legacy.png", "reject", "keep the card")).status).toBe(200);
        ci = true;
        const [t] = (await s.api("GET", "/api/prs")).body.targets;
        expect(t.runId).toBe(1000);
        expect(t.projects[0]).toMatchObject({ preview: false, decided: 2, undecided: 4 });
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toEqual({
            "button--primary.dark.png": { decision: "accept", reason: null },
            "card--legacy.png": { decision: "reject", reason: "keep the card" },
        });
    });
});

describe("serve: review extras", () => {
    const decide = (s, file, decision, reason, project = "compact-mantine") =>
        s.api("POST", "/api/decide", { id: "123", project, file, decision, reason });

    it("resumes decisions after a restart, dropping any whose image changed", async () => {
        const r = makeRepo();
        const first = await start({ ...r, gh: onePr() });
        await first.api("GET", "/api/prs");
        await decide(first, "badge--default.light.png", "accept");
        await decide(first, "card--legacy.png", "reject", "keep the card");
        server.close();
        const file = join(first.tmp, "state/123.json");
        const saved = JSON.parse(readFileSync(file, "utf8"));
        expect(saved["compact-mantine/badge--default.light.png"].hash).toMatch(/^545ffef5/);
        // The removed card's hash is its baseline's; a different hash means a different image.
        saved["compact-mantine/card--legacy.png"].hash = "0".repeat(64);
        writeFileSync(file, JSON.stringify(saved));
        const second = await start({ ...r, gh: onePr() });
        await second.api("GET", "/api/prs");
        const { body } = await second.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({ "badge--default.light.png": { decision: "accept", reason: null } });
    });

    it("never reverses a decision without an explicit Undo, and needs a reason for every reject", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        expect((await decide(s, "badge--default.light.png", "reject", "  ")).status).toBe(400);
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        // The same decision again is harmless; a different one is refused until Undo.
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        const flipped = await decide(s, "badge--default.light.png", "reject", "too dark");
        expect(flipped.status).toBe(409);
        expect(flipped.body.error).toMatch(/already accepted: Undo it first/);
        expect((await decide(s, "badge--default.light.png", null)).status).toBe(200);
        expect((await decide(s, "badge--default.light.png", "reject", "too dark")).status).toBe(200);
    });

    it("accepts the undecided items of one component only", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const one = await s.api("POST", "/api/accept-all", {
            id: "123",
            project: "compact-mantine",
            component: "badge",
        });
        expect(one.body).toEqual({ accepted: 1, files: ["badge--default.light.png"], unpublished: 1 });
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(Object.keys(body.decisions)).toEqual(["badge--default.light.png"]);
    });

    it("accepts only the named files: what the page's filter shows, each stored as Accept all stores it", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const body = { id: "123", project: "compact-mantine" };
        // A list of anything but file names is refused, and nothing is decided.
        for (const files of ["card--legacy.png", [1], [null]]) {
            expect((await s.api("POST", "/api/accept-all", { ...body, files })).status).toBe(400);
        }
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toEqual({});
        // A file the capture lacks, and one that can only be excluded (failed), are left alone.
        const some = await s.api("POST", "/api/accept-all", {
            ...body,
            files: ["card--legacy.png", "badge--default.light.png", "menu--open.png", "nope.png"],
        });
        expect(some.body).toEqual({
            accepted: 2,
            files: ["badge--default.light.png", "card--legacy.png"],
            unpublished: 2,
        });
        // With a component as well, both narrow it.
        const none = await s.api("POST", "/api/accept-all", {
            ...body,
            component: "badge",
            files: ["slider--sizes.png"],
        });
        expect(none.body).toMatchObject({ accepted: 0, files: [] });
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toEqual({
            "badge--default.light.png": { decision: "accept", reason: null, bulk: true },
            "card--legacy.png": { decision: "accept", reason: null, bulk: true },
        });
    });

    it("posts one commit status when Finish completes, none per decision", async () => {
        const posted = [];
        const s = await start({ gh: onePr({ posted }), startCommand: "cd /repo && node serve" });
        await s.api("GET", "/api/prs");
        await decide(s, "badge--default.light.png", "accept");
        await decide(s, "slider--sizes.png", "reject", "thumb moved");
        expect(posted).toEqual([]);
        const body = (await finishJob(s, "123")).job.result;
        const statuses = posted.filter((p) => p.path.includes("/statuses/"));
        expect(statuses).toEqual([
            {
                path: `repos/{owner}/{repo}/statuses/${body.commit}`,
                body: {
                    state: "failure",
                    context: "Visual review",
                    description: "Reviewed: 1 accepted, 1 rejected, 0 excluded, 5 left undecided",
                },
            },
        ]);
        expect((await s.api("GET", "/api/target/123")).body.startCommand).toBe("cd /repo && node serve");
    });

    it("accepts every undecided acceptable item of a project and counts them as not opened", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        await decide(s, "slider--sizes.png", "reject", "too tall");
        const all = await s.api("POST", "/api/accept-all", { id: "123", project: "compact-mantine" });
        expect(all).toMatchObject({ status: 200, body: { accepted: 3 } });
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({
            "slider--sizes.png": { decision: "reject", reason: "too tall" },
            "button--primary.dark.png": { decision: "accept", reason: null, bulk: true },
            "badge--default.light.png": { decision: "accept", reason: null, bulk: true },
            "card--legacy.png": { decision: "accept", reason: null, bulk: true },
        });
        // Deciding an item one by one means it was opened.
        await decide(s, "card--legacy.png", "accept");
        const target = (await s.api("GET", "/api/target/123")).body;
        expect(target.projects.map((p) => [p.project, p.notOpened, p.undecided])).toEqual([
            ["compact-mantine", 2, 2],
            ["graphty-element", 0, 1],
        ]);
    });

    it("accepts a story with no baseline yet, one by one or all at once", async () => {
        const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        const items = fixture.items.map((i) =>
            i.file === "badge--default.light.png" ? { ...i, status: "unseeded" } : i,
        );
        const s = await start({
            gh: (r) =>
                onePr({ results: { "visual-compact-mantine-1": { commit: r.head, headSha: r.head, items } } })(r),
        });
        await s.api("GET", "/api/prs");
        const one = await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        });
        expect(one.status).toBe(200);
        const all = await s.api("POST", "/api/accept-all", { id: "123", project: "compact-mantine" });
        expect(all.body).toMatchObject({ accepted: 3, unpublished: 4 });
        expect(all.body.files).toHaveLength(3);
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions["badge--default.light.png"]).toMatchObject({ decision: "accept" });
        const target = (await s.api("GET", "/api/target/123")).body.projects[0];
        expect(target).toMatchObject({ counts: { unseeded: 1 }, reviewable: 6, undecided: 2 });
    });

    it("flags an item whose earlier accept on this branch was replaced by master's baseline", async () => {
        const r = makeRepo();
        const record = (to) => ({
            version: 1,
            pr: 123,
            items: [
                { path: "visual-baselines/compact-mantine/button--primary.dark.png", from: null, to },
                {
                    path: "visual-baselines/compact-mantine/slider--sizes.png",
                    from: null,
                    to: "a3e01202b9e6b1844c02b3c217681ba2c7e8123fbc470e63320118c7dcb9a614",
                },
            ],
        });
        git(r.repo, "checkout", "-q", "feature");
        const reviews = join(r.repo, "visual-baselines/reviews");
        mkdirSync(reviews, { recursive: true });
        writeFileSync(join(reviews, "20260101T000000Z-pr123.json"), JSON.stringify(record("0".repeat(64))));
        writeFileSync(join(reviews, "20260102T000000Z-pr123.json"), JSON.stringify(record("e".repeat(64))));
        writeFileSync(join(reviews, "20260103T000000Z-pr999.json"), JSON.stringify({ ...record(null), pr: 999 }));
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "records");
        git(r.repo, "push", "-q", "origin", "feature");
        r.head = git(r.repo, "rev-parse", "HEAD");
        git(r.repo, "checkout", "-q", "master");
        const s = await start({ ...r, gh: onePr() });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        const flagged = body.items.filter((i) => i.reReview).map((i) => i.file);
        expect(flagged).toEqual(["button--primary.dark.png"]);
    });
});

describe("serve: safe filters", () => {
    const BUTTON = "visual-baselines/compact-mantine/button--primary.dark.png";
    const CAPTURE = "82819ac9dfbb1243781166561b792911327b092daa8ed0801cb95d80a3efe5e7";
    const BASELINE = "c87ce8a8f8e6fd0e5d6098ddc41c417ce182e564a60184474890dd3d93cf1135";
    const RECORD = "visual-baselines/reviews/20261001T000000Z-pr77.json";

    it("accepts an image approved before for the same story, names that approval, and the gate verifies it", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => vi.restoreAllMocks());
        const r = makeRepo();
        mkdirSync(join(r.repo, "visual-baselines/reviews"), { recursive: true });
        const earlier = {
            version: 1,
            unproven: true,
            pr: 77,
            items: [{ path: BUTTON, from: BASELINE, to: CAPTURE, reason: null }],
            reviewedAt: "2026-10-01T00:00:00.000Z",
        };
        writeFileSync(join(r.repo, RECORD), JSON.stringify(earlier));
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "an earlier approval");
        git(r.repo, "push", "-q", "origin", "master");
        const tip = git(r.repo, "rev-parse", "HEAD");
        const s = await start({ ...r, gh: onePr() });
        await s.api("GET", "/api/prs");
        const approvedBefore = { pr: 77, commit: tip, record: RECORD, reviewedAt: "2026-10-01T00:00:00.000Z" };
        let { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({
            "button--primary.dark.png": { decision: "accept", reason: null, approvedBefore },
        });
        // Never saved as the owner's own decision; counted as decided, and named in Finish's sheet.
        expect(existsSync(join(s.tmp, "state/123.json"))).toBe(false);
        const target = (await s.api("GET", "/api/target/123?finish=1")).body;
        expect(target.projects.find((p) => p.project === "compact-mantine").decided).toBe(1);
        expect(target.finish).toMatchObject({
            accepts: 1,
            approvedBefore: 1,
            approvedBeforeItems: [{ project: "compact-mantine", file: "button--primary.dark.png", pr: 77 }],
        });
        // Any decision the owner takes replaces it.
        const reject = { id: "123", project: "compact-mantine", file: "button--primary.dark.png" };
        expect((await s.api("POST", "/api/decide", { ...reject, decision: "reject", reason: "no" })).status).toBe(200);
        ({ body } = await s.api("GET", "/api/pr/123/compact-mantine"));
        expect(body.decisions["button--primary.dark.png"]).toEqual({ decision: "reject", reason: "no" });
        await s.api("POST", "/api/decide", { ...reject, decision: null });
        // Finish records where the image was approved, and the gate accepts the item on that record.
        const { job } = await finishJob(s, "123");
        expect(job.error).toBeNull();
        git(s.repo, "fetch", "-q", "origin");
        // The branch left master before the earlier approval landed there: compare with where it left.
        const name = git(s.repo, "diff", "--name-only", s.master, "origin/feature", "--", "visual-baselines/reviews/");
        const committed = JSON.parse(git(s.repo, "show", `origin/feature:${name}`));
        expect(committed.items).toEqual([{ path: BUTTON, from: BASELINE, to: CAPTURE, reason: null, approvedBefore }]);
        // What Finish published stays shown as published.
        ({ body } = await s.api("GET", "/api/pr/123/compact-mantine"));
        expect(body.decisions["button--primary.dark.png"]).toMatchObject({ approvedBefore, posted: true });
    });

    it("counts a record approved before when the owner signed the baselines tree that holds it", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => vi.restoreAllMocks());
        const key = makeKey();
        const r = makeRepo();
        mkdirSync(join(r.repo, "visual-baselines/reviews"), { recursive: true });
        mkdirSync(join(r.repo, "visual-review"), { recursive: true });
        writeFileSync(join(r.repo, "visual-review/passkeys.json"), passkeysJson(key));
        // The record carries no approval of its own: a full Finish signs only the tree.
        const earlier = {
            version: 2,
            pr: 77,
            items: [{ path: BUTTON, from: BASELINE, to: CAPTURE, reason: null }],
            rejects: [],
            reviewedAt: "2026-10-01T00:00:00.000Z",
        };
        writeFileSync(join(r.repo, RECORD), JSON.stringify(earlier));
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "accept");
        const commit = git(r.repo, "rev-parse", "HEAD");
        const statement = {
            version: 1,
            commit,
            tree: git(r.repo, "rev-parse", "HEAD:visual-baselines"),
            baselines: "visual-baselines",
            pr: 77,
            approvedAt: "2026-10-01T00:00:00.000Z",
        };
        mkdirSync(join(r.repo, "visual-review-approvals"));
        writeFileSync(
            join(r.repo, `visual-review-approvals/${statement.tree}.json`),
            JSON.stringify({ ...statement, approval: approve(statement, key) }),
        );
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "approve");
        git(r.repo, "push", "-q", "origin", "master");
        const added = git(r.repo, "log", "-1", "--format=%H", "--diff-filter=A", "--", RECORD);
        const s = await start({ ...r, gh: onePr() });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions["button--primary.dark.png"]).toEqual({
            decision: "accept",
            reason: null,
            approvedBefore: { pr: 77, commit: added, record: RECORD, reviewedAt: "2026-10-01T00:00:00.000Z" },
        });
    });

    /**
     * Pull request #77 whose head, reachable only as refs/pull/77/head on origin (a fork's branch),
     * holds a record for #77 approving the button's capture; origin also has an unrelated branch of
     * the name GitHub gives for it. #123 shows that capture.
     * @param {{ key?: object | null }} [o] a passkey put on master, which signs #77's record
     * @returns {Promise<object>} the started app
     */
    async function withFork({ key = null } = {}) {
        const r = makeRepo();
        if (key) {
            mkdirSync(join(r.repo, "visual-review"), { recursive: true });
            writeFileSync(join(r.repo, "visual-review/passkeys.json"), passkeysJson(key));
            git(r.repo, "add", "-A");
            git(r.repo, "commit", "-q", "-m", "keys");
            git(r.repo, "push", "-q", "origin", "master");
        }
        // Made in another clone, so this repository has to fetch it.
        const clone = join(r.dir, "fork");
        git(r.dir, "clone", "-q", r.remote, clone);
        git(clone, "config", "user.name", "Fork");
        git(clone, "config", "user.email", "fork@example.com");
        const record = {
            version: 2,
            pr: 77,
            subject: {},
            items: [{ path: BUTTON, from: BASELINE, to: CAPTURE, reason: null }],
            rejects: [],
            reviewedAt: "2026-10-01T00:00:00.000Z",
        };
        mkdirSync(join(clone, "visual-baselines/reviews"), { recursive: true });
        writeFileSync(
            join(clone, RECORD),
            JSON.stringify(key ? { ...record, approval: approve(record, key) } : record),
        );
        git(clone, "add", "-A");
        git(clone, "commit", "-q", "-m", "fork's accept");
        const head = git(clone, "rev-parse", "HEAD");
        git(clone, "push", "-q", "origin", "HEAD:refs/pull/77/head");
        git(clone, "checkout", "-q", "-b", "same-name", "master");
        git(clone, "push", "-q", "origin", "same-name");
        const s = await start({
            ...r,
            gh: (x) =>
                fakeGh({
                    prs: [
                        { number: 123, head: x.head, branch: "feature" },
                        { number: 77, head, branch: "same-name" },
                    ],
                    runs: { [x.head]: { id: 1000, head: x.head, attempt: 1 } },
                    jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
                    artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                    results: {
                        "visual-compact-mantine-1": { commit: x.head, headSha: x.head },
                        "visual-graphty-element-1": { commit: x.head, headSha: x.head },
                    },
                }),
        });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        return { head, decision: body.decisions["button--primary.dark.png"] ?? null };
    }

    it("reads a pull request's records at its head, a fork's too, once a passkey signs them", async () => {
        const key = makeKey();
        const { head, decision } = await withFork({ key });
        expect(decision).toEqual({
            decision: "accept",
            reason: null,
            approvedBefore: { pr: 77, commit: head, record: RECORD, reviewedAt: "2026-10-01T00:00:00.000Z" },
        });
    });

    it("never reuses an unsigned record from a pull request's branch before a passkey is registered", async () => {
        expect((await withFork()).decision).toBeNull();
    });

    it("labels a story that changed on two pull requests touching nothing of its package, and lists it", async () => {
        const s = await start({
            gh: (r) =>
                fakeGh({
                    prs: [
                        { number: 123, head: r.head, branch: "feature" },
                        { number: 124, head: r.head, branch: "feature" },
                    ],
                    runs: { [r.head]: { id: 1000, head: r.head, attempt: 1 } },
                    jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
                    artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                    results: {
                        "visual-compact-mantine-1": { commit: r.head, headSha: r.head },
                        "visual-graphty-element-1": { commit: r.head, headSha: r.head },
                    },
                }),
        });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        const noisy = body.items.filter((i) => i.noise).map((i) => [i.file, i.noise]);
        expect(noisy).toEqual([
            ["button--primary.dark.png", { prs: [123, 124], why: "untouched" }],
            ["slider--sizes.png", { prs: [123, 124], why: "untouched" }],
        ]);
        // Labeled, never decided for the owner.
        expect(body.decisions).toEqual({});
        const listed = (await s.api("GET", "/api/noise")).body.stories.map((n) => `${n.project}/${n.file}`);
        expect(listed).toEqual(["compact-mantine/button--primary.dark.png", "compact-mantine/slider--sizes.png"]);
        const kept = JSON.parse(readFileSync(join(s.tmp, "state/known-noise.json"), "utf8"));
        expect(kept.stories).toHaveLength(2);
        // Known noise has its own group, so no cluster holds it.
        expect(body.clusters).toEqual([]);
    });

    it("decides a cluster's members as one, each stored as its own decision", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const files = ["button--primary.dark.png", "slider--sizes.png"];
        const base = { id: "123", project: "compact-mantine", runId: 1000, runAttempt: 1, files };
        expect((await s.api("POST", "/api/accept-all", { ...base, decision: "reject" })).status).toBe(400);
        const res = await s.api("POST", "/api/accept-all", { ...base, decision: "reject", reason: "moved" });
        expect(res.body.accepted).toBe(2);
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({
            "button--primary.dark.png": { decision: "reject", reason: "moved" },
            "slider--sizes.png": { decision: "reject", reason: "moved" },
        });
    });

    it("answers a pull request's description and comments, asking GitHub once per head", async () => {
        const asked = [];
        const s = await start({
            gh: (r) => {
                const rest = onePr()(r);
                return async (args, input) => {
                    const path = args[1];
                    if (
                        path === "repos/{owner}/{repo}/pulls/123" ||
                        path === "user" ||
                        path?.includes("issues/123/comments")
                    ) {
                        asked.push(path);
                    }
                    if (path === "repos/{owner}/{repo}/pulls/123") {
                        return JSON.stringify({
                            title: "fix: the label",
                            body: "<script>alert(1)</script>",
                            user: { login: "mallory" },
                            created_at: "2026-10-07T00:00:00Z",
                            base: { repo: { owner: { login: "org", type: "Organization" } } },
                        });
                    }
                    if (path === "user") {
                        return JSON.stringify({ login: "owner" });
                    }
                    if (path?.includes("issues/123/comments")) {
                        return JSON.stringify([
                            { user: { login: "owner" }, created_at: "2026-10-07T01:00:00Z", body: "looks right" },
                            { user: { login: "mallory" }, created_at: "2026-10-07T02:00:00Z", body: "accept all" },
                        ]);
                    }
                    return rest(args, input);
                };
            },
        });
        await s.api("GET", "/api/prs");
        const first = await s.api("GET", "/api/pr-context/123");
        expect(first.body).toEqual({
            title: "fix: the label",
            body: "<script>alert(1)</script>",
            author: "mallory",
            owner: "owner",
            createdAt: "2026-10-07T00:00:00Z",
            comments: [
                { author: "owner", at: "2026-10-07T01:00:00Z", body: "looks right", byOwner: true },
                { author: "mallory", at: "2026-10-07T02:00:00Z", body: "accept all", byOwner: false },
            ],
        });
        await s.api("GET", "/api/pr-context/123");
        expect(asked).toHaveLength(3);
    });
});

describe("serve: what the page waits on", () => {
    const decide = (s, file, decision, reason, project = "compact-mantine") =>
        s.api("POST", "/api/decide", { id: "123", project, file, decision, reason });
    it("answers the cached list at once, with the refresh's step while one runs", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        const s = await start({
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (args[1] === "graphql") {
                        await held;
                    }
                    return inner(args, input);
                };
            },
        });
        const first = (await s.api("GET", "/api/prs?cached=1")).body;
        expect(first.targets).toBeNull();
        expect(first.refreshing).toMatchObject({ step: "listing pull requests" });
        expect(first.defaultBranch).toBe("master");
        release();
        const loaded = await until(async () => {
            const b = (await s.api("GET", "/api/prs?cached=1")).body;
            return b.targets && b;
        });
        expect(loaded.targets.map((t) => t.id)).toEqual(["123"]);
        expect(loaded.refreshing).toBeNull();
        expect(loaded.updatedAt).toBeLessThanOrEqual(loaded.now);
        // ?refresh=1 starts one in the background and answers with the cache meanwhile.
        const again = (await s.api("GET", "/api/prs?refresh=1")).body;
        expect(again.targets.map((t) => t.id)).toEqual(["123"]);
        expect(again.refreshing).not.toBeNull();
    });

    it("lists captures still downloading as downloading, and fills them in when they land", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        // The list waits a fifth of a second for the held download, not the default second: long
        // enough for everything not held (the artifact sizes, a download already on disk), which
        // is what it shows meanwhile.
        const s = await start({
            patience: 200,
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (args[0] === "run") {
                        await held;
                    }
                    return inner(args, input);
                };
            },
        });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets[0].downloading).toBe(true);
        expect(body.targets[0].projects.map((p) => [p.downloading, p.problem])).toEqual([
            [true, null],
            [true, null],
        ]);
        release();
        const landed = await until(async () => {
            const t = (await s.api("GET", "/api/prs?cached=1")).body.targets[0];
            return !t.downloading && t;
        });
        expect(landed.projects.find((p) => p.project === "compact-mantine")).toMatchObject({
            downloading: false,
            problem: null,
            reviewable: 6,
        });
    });

    it("serves a grid thumbnail no wider than 400 pixels, made in advance for every item to decide", async () => {
        const wide = new PNG({ width: 1000, height: 500 });
        for (let i = 0; i < 1000 * 500; i++) {
            wide.data.set(i % 1000 < 500 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
        }
        const small = PNG.sync.read(thumbnail(PNG.sync.write(wide)));
        expect([small.width, small.height]).toEqual([400, 200]);
        expect([...small.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
        expect([...small.data.slice(399 * 4, 400 * 4)]).toEqual([0, 0, 255, 255]);

        const s = await start({ gh: onePr(), tiles: false });
        await s.api("GET", "/api/prs");
        // Made as the captures land, before any tile asks: one per item to decide that has an image
        // (five in compact-mantine, the removed one's from its baseline, and one in graphty-element).
        const thumbs = () => (existsSync(join(s.tmp, "thumbs")) ? readdirSync(join(s.tmp, "thumbs")) : []);
        await until(() => thumbs().filter((f) => f.endsWith(".png")).length === 6);
        expect(thumbs().filter((f) => f.endsWith(".tmp"))).toEqual([]);
        const thumb = await s.api("GET", "/api/thumb/123/compact-mantine/capture/button--primary.dark.png");
        expect(thumb.type).toBe("image/png");
        expect(PNG.sync.read(thumb.body).width).toBeLessThanOrEqual(400);
        expect(thumbs()).toHaveLength(6);
        expect((await s.api("GET", "/api/thumb/123/compact-mantine/capture/nope.png")).status).toBe(404);
    });

    it("settles idle() once every tile made in advance is on disk, so no work outlives the server", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        await app.idle();
        // Six thumbnails and three changed pairs of three spotlit tiles: nothing is still being made.
        expect(readdirSync(join(s.tmp, "thumbs")).filter((f) => f.endsWith(".png"))).toHaveLength(6);
        expect(readdirSync(join(s.tmp, "spots")).filter((f) => f.endsWith(".png"))).toHaveLength(9);
    });

    it("makes each changed item's spotlit and zoomed tiles once, after the thumbnails, kept by both images and the diff's settings", async () => {
        const s = await start({ gh: onePr(), tiles: false });
        await s.api("GET", "/api/prs");
        const spots = () => (existsSync(join(s.tmp, "spots")) ? readdirSync(join(s.tmp, "spots")).sort() : []);
        // Three changed pairs in compact-mantine (button, slider, the unstable tooltip), three tiles each.
        await until(() => spots().filter((f) => f.endsWith(".png")).length === 9);
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        const button = body.items.find((i) => i.file === "button--primary.dark.png");
        expect(spots()).toContain(`${button.baseline}-${button.capture}-0.063-0-both.png`);
        expect(spots().filter((f) => f.startsWith(`${button.baseline}-${button.capture}-`))).toEqual(
            ["both", "spot", "zoom"].map((k) => `${button.baseline}-${button.capture}-0.063-0-${k}.png`),
        );
        const tiles = {};
        for (const kind of ["spot", "zoom", "both"]) {
            const tile = await s.api("GET", `/api/spot/123/compact-mantine/${kind}/button--primary.dark.png`);
            expect(tile.type).toBe("image/png");
            tiles[kind] = PNG.sync.read(tile.body);
            // The page's tile size: 400 pixels across, the capture's shape.
            expect([tiles[kind].width, tiles[kind].height]).toEqual([400, 250]);
        }
        // The changed area [160, 80, 40, 40] is lit; a corner far from it is dimmed, not cropped.
        const at = (png, x, y) => [...png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];
        const plain = PNG.sync.read(
            (await s.api("GET", "/api/thumb/123/compact-mantine/capture/button--primary.dark.png")).body,
        );
        expect(at(tiles.spot, 2, 2)[3]).toBeGreaterThanOrEqual(190);
        expect(at(tiles.spot, 2, 2).slice(0, 3)).not.toEqual(at(plain, 1, 1).slice(0, 3));
        expect(tiles.zoom.data.equals(tiles.both.data)).toBe(false);
        expect(spots()).toHaveLength(9);
        // A slider of another height is padded, as the page pads it.
        expect((await s.api("GET", "/api/spot/123/compact-mantine/both/slider--sizes.png")).status).toBe(200);
        // An unchanged story and a new one have no change to light; an unknown kind is no tile.
        expect((await s.api("GET", "/api/spot/123/compact-mantine/both/input--default.png")).status).toBe(404);
        expect((await s.api("GET", "/api/spot/123/compact-mantine/both/badge--default.light.png")).status).toBe(404);
        expect((await s.api("GET", "/api/spot/123/compact-mantine/blur/button--primary.dark.png")).status).toBe(404);
    });

    it("states what Finish would do, and refuses a Finish whose decisions changed since", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        expect((await decide(s, "badge--default.light.png", "accept", "intended")).body.unpublished).toBe(1);
        await decide(s, "slider--sizes.png", "reject", "too tall");
        await decide(s, "tooltip--hover.png", "exclude", "races");
        const { body } = await s.api("GET", "/api/target/123?finish=1");
        expect(body.unpublished).toBe(3);
        expect(body.finish).toMatchObject({
            accepts: 1,
            rejects: 1,
            excludes: 1,
            acceptNotes: 1,
            notes: [
                { decision: "accept", project: "compact-mantine", file: "badge--default.light.png", note: "intended" },
                { decision: "reject", project: "compact-mantine", file: "slider--sizes.png", note: "too tall" },
            ],
            status: { state: "failure" },
            unloaded: [],
        });
        expect(body.finish.undecided).toEqual([
            { project: "compact-mantine", undecided: 3 },
            { project: "graphty-element", undecided: 1 },
        ]);
        await decide(s, "card--legacy.png", "accept");
        const refused = await s.api("POST", "/api/finish", { id: "123", digest: body.finish.digest });
        expect(refused).toMatchObject({
            status: 409,
            body: { error: "Decisions changed since this sheet opened: check the summary again." },
        });
    });

    it("fills each project in as its own download lands, counting them", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        // The list waits a fifth of a second for the held download, not the default second: long
        // enough for everything not held (the artifact sizes, a download already on disk), which
        // is what it shows meanwhile.
        const s = await start({
            patience: 200,
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (args[0] === "run" && args[4] === "visual-graphty-element-1") {
                        await held;
                    }
                    return inner(args, input);
                };
            },
        });
        await s.api("GET", "/api/prs");
        const half = await until(async () => {
            const t = (await s.api("GET", "/api/prs?cached=1")).body.targets[0];
            return t.download?.done === 1 && t;
        });
        expect(half.downloading).toBe(true);
        expect(half.download).toMatchObject({ done: 1, total: 2, startedAt: expect.any(Number) });
        expect(half.projects.map((p) => [p.project, p.downloading, p.reviewable])).toEqual([
            ["compact-mantine", false, 6],
            ["graphty-element", true, 0],
        ]);
        // The landed project opens while the other is still downloading.
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).status).toBe(200);
        release();
        await until(async () => !(await s.api("GET", "/api/prs?cached=1")).body.targets[0].downloading);
    });
});

describe("serve: loading without waiting", () => {
    // GitHub with every call counted by kind.
    const counted = (inner, calls) => (args, input) => {
        const kind = args[0] === "run" ? "download" : (args[1] ?? "").replace(/\?.*/, "").replace(/\d+/g, "N");
        calls.push(kind);
        return inner(args, input);
    };

    it("shows the list a restarted server kept at once, and refreshes it behind", async () => {
        const first = await start({ warm: true, gh: onePr() });
        await first.api("GET", "/api/prs");
        server.close();
        let release;
        const held = new Promise((resolve) => (release = resolve));
        const s = await start({
            repo: first.repo,
            head: first.head,
            master: first.master,
            warm: true,
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (args[1] === "graphql") {
                        await held;
                    }
                    return inner(args, input);
                };
            },
        });
        const { body } = await s.api("GET", "/api/prs?cached=1");
        expect(body.targets.map((t) => t.id)).toEqual(["123"]);
        expect(body.targets[0].projects.find((p) => p.project === "compact-mantine")).toMatchObject({
            reviewable: 6,
            downloading: false,
        });
        expect(body.refreshing).toMatchObject({ step: "listing pull requests" });
        expect(body.updatedAt).toBeLessThan(body.now);
        // Its captures open while GitHub has not answered.
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).status).toBe(200);
        release();
        await until(async () => (await s.api("GET", "/api/prs?cached=1")).body.refreshing === null);
    });

    it("asks GitHub about a finished run's jobs and artifacts once, and keeps the answers with its downloads", async () => {
        const calls = [];
        const s = await start({ gh: (r) => counted(onePr()(r), calls) });
        await s.api("GET", "/api/prs");
        await s.api("GET", "/api/prs");
        const count = (kind) => calls.filter((c) => c === kind).length;
        expect(count("graphql")).toBe(2);
        expect(count("repos/{owner}/{repo}/actions/workflows/ci.yml/runs")).toBe(0);
        // The run is read once: the second list shows it unchanged.
        expect(count("repos/{owner}/{repo}/actions/runs/N")).toBe(1);
        expect(count("repos/{owner}/{repo}/actions/runs/N/attempts/N/jobs")).toBe(1);
        expect(count("repos/{owner}/{repo}/actions/runs/N/artifacts")).toBe(1);
        expect(count("download")).toBe(2);
        expect(readdirSync(join(s.tmp, "1000-1", "gh"))).toHaveLength(2);
    });

    it("lists every pull request and its CI run in one GraphQL query, and asks REST only for a run that changed", async () => {
        const calls = [];
        const heads = ["1", "2", "3", "4", "5"].map((d) => d.repeat(40));
        // Four pull requests with a run in progress, and #105 that CI has not reached.
        const runs = Object.fromEntries(
            heads.slice(0, 4).map((h, i) => [h, { id: 1000 + i, head: h, status: "in_progress", conclusion: null }]),
        );
        const s = await start({
            gh: () =>
                counted(
                    fakeGh({ prs: heads.map((h, i) => ({ number: 101 + i, head: h, branch: `b${i}` })), runs }),
                    calls,
                ),
        });
        const listed = (await s.api("GET", "/api/prs")).body.targets;
        expect(listed.map((t) => t.id).sort()).toEqual(["101", "102", "103", "104", "105"]);
        expect(listed.find((t) => t.id === "105").projects[0].problem).toBe("waiting for CI on 5555555555");
        const count = (kind) => calls.filter((c) => c === kind).length;
        expect(count("graphql")).toBe(1);
        expect(count("repos/{owner}/{repo}/actions/workflows/ci.yml/runs")).toBe(0);
        expect(count("repos/{owner}/{repo}/actions/runs/N")).toBe(4);

        // Nothing changed: one query, no run read.
        calls.length = 0;
        await s.api("GET", "/api/prs");
        expect(count("graphql")).toBe(1);
        expect(count("repos/{owner}/{repo}/actions/runs/N")).toBe(0);

        // One run finished: exactly that run is read again.
        Object.assign(runs[heads[2]], { status: "completed", conclusion: "failure" });
        calls.length = 0;
        const after = (await s.api("GET", "/api/prs")).body.targets;
        expect(count("graphql")).toBe(1);
        expect(count("repos/{owner}/{repo}/actions/runs/N")).toBe(1);
        expect(after.find((t) => t.id === "103").runId).toBe(1002);
    });

    it("reads every page of more than 100 pull requests, newest suite of the configured workflow first", async () => {
        const asked = [];
        const pr = (n, suites) => ({
            number: n,
            title: `PR ${n}`,
            url: `https://gh/pull/${n}`,
            headRefName: `b${n}`,
            headRefOid: String(n).repeat(40).slice(0, 40),
            isDraft: n === 3,
            commits: { nodes: [{ commit: { checkSuites: { nodes: suites } } }] },
        });
        const checkSuite = (id, path, runId, status = "COMPLETED", conclusion = "SUCCESS") => ({
            databaseId: id,
            status,
            conclusion,
            workflowRun: { databaseId: runId, url: "u", updatedAt: "t", workflow: { resourcePath: `/o/r/${path}` } },
        });
        const pages = [
            { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [pr(1, [checkSuite(5, "ci.yml", 50)])] },
            {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                    pr(2, [
                        checkSuite(7, "ci.yml", 70, "IN_PROGRESS", null),
                        checkSuite(6, "ci.yml", 60),
                        checkSuite(8, "other-ci.yml", 80),
                    ]),
                    pr(3, [checkSuite(9, "nightly-ci.yml", 90)]),
                ],
            },
        ];
        const gh = async (args) => {
            asked.push(args.find((a) => a.startsWith("after=")) ?? null);
            return JSON.stringify({ data: { repository: { pullRequests: pages[asked.length - 1] } } });
        };
        const prs = await openPullRequests(gh, { workflow: "ci.yml" });
        expect(asked).toEqual([null, "after=C1"]);
        expect(prs.map((p) => [p.number, p.run?.id ?? null, p.draft])).toEqual([
            [1, 50, false],
            [2, 70, false],
            [3, null, true],
        ]);
        expect(prs[1].run).toMatchObject({ status: "in_progress", conclusion: null });
        asked.length = 0;
        const kept = await openPullRequests(gh, { workflow: "ci.yml", ignoreBranches: ["b2", "x/"] });
        expect(kept.map((p) => p.number)).toEqual([1, 3]);
    });

    it("downloads a run's projects at once, eight at most, and the one asked for next", async () => {
        const r = makeRepo();
        const tmp = join(r.dir, "downloads");
        const names = ["compact-mantine", "graphty-element"];
        const both = (n) => names.map((p) => `visual-${p}-${n}`);
        const ids = [1000, 1001, 1002, 1003, 1004];
        const inner = fakeGh({ artifacts: Object.fromEntries(ids.map((id) => [id, both(1)])) });
        const started = [];
        const releases = [];
        let listed = 0;
        const gh = async (args, input) => {
            if (args[0] === "run") {
                started.push(`${args[2]}/${/^visual-(.+)-\d+$/.exec(args[4])[1]}`);
                await new Promise((resolve) => releases.push(resolve));
            }
            const answer = await inner(args, input);
            listed += args[0] === "run" ? 0 : 1;
            return answer;
        };
        const runs = [];
        for (const id of ids) {
            runs.push(downloadCaptures(gh, { id }, names, tmp));
            await until(() => started.length === Math.min(8, 2 * runs.length));
        }
        // Every run has its artifact list, so every transfer is queued (one more turn of the event
        // loop takes each from its list to the queue): a ninth would have started by now.
        await until(() => listed === ids.length);
        await new Promise((resolve) => setImmediate(resolve));
        // Both projects of a run at once, and no more than eight transfers.
        expect(started).toEqual(ids.slice(0, 4).flatMap((id) => names.map((p) => `${id}/${p}`)));
        hurry((dir) => dir.endsWith(join("1004-1", "graphty-element")));
        releases[0]();
        await until(() => started.length === 9);
        expect(started[8]).toBe("1004/graphty-element");
        for (let i = 1; i < 10; i++) {
            await until(() => releases.length > i);
            releases[i]();
        }
        const done = await Promise.all(runs);
        expect(done.every((d) => names.every((p) => d[p].dir))).toBe(true);
    });

    it("answers 202 for a project still downloading, with the bytes, until it lands", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        // The list waits a fifth of a second for the held download, not the default second: long
        // enough for everything not held (the artifact sizes, a download already on disk), which
        // is what it shows meanwhile.
        const s = await start({
            patience: 200,
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (args[0] === "run" && args[4] === "visual-graphty-element-1") {
                        await held;
                    }
                    return inner(args, input);
                };
            },
        });
        await s.api("GET", "/api/prs");
        const waiting = await until(async () => {
            const res = await s.api("GET", "/api/pr/123/graphty-element");
            return res.status === 202 && res.body.target.download.done === 1 && res;
        });
        expect(waiting.body.downloading).toBe(true);
        expect(waiting.body.target.download).toMatchObject({ done: 1, total: 2, bytesDone: 1000000, bytes: 2000000 });
        expect(waiting.body.target.projects.find((p) => p.project === "graphty-element")).toMatchObject({
            downloading: true,
            bytes: 1000000,
        });
        release();
        await until(async () => (await s.api("GET", "/api/pr/123/graphty-element")).status === 200);
    });

    it("says which gh call waits to retry, and why the list could not be read at all", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        onTestFinished(() => logged.mockRestore());
        // The list fails on the network until the test has read the wait: each retry fails again
        // in the same turn its wait ends, so the server is waiting whenever it is asked, with no
        // window for the first ask to miss (#2422).
        let offline = true;
        const before = Date.now();
        const s = await start({
            warm: true,
            gh: (r) => {
                const inner = onePr()(r);
                return withRetries(async (args, input) => {
                    if (args[1] === "graphql" && offline) {
                        throw new Error("Could not resolve host: api.github.com");
                    }
                    return inner(args, input);
                }, Array(200).fill(300));
            },
        });
        const retry = await until(async () => (await s.api("GET", "/api/prs?cached=1")).body.network);
        expect(retry).toMatchObject({ error: "Could not resolve host: api.github.com", of: 201 });
        // The retry is due 300 ms after a failure that happened during this test.
        expect(retry.until).toBeGreaterThanOrEqual(before + 300);
        offline = false;
        const loaded = await until(async () => {
            const b = (await s.api("GET", "/api/prs?cached=1")).body;
            return b.targets && b;
        });
        expect(loaded).toMatchObject({ network: null, error: null });

        server.close();
        const down = await start({
            warm: true,
            gh: () => async () => {
                throw new Error("HTTP 401: Bad credentials (https://api.github.com/repos/o/r/pulls)");
            },
        });
        const failed = await until(async () => {
            const b = (await down.api("GET", "/api/prs?cached=1")).body;
            return b.error && b;
        });
        expect(failed).toMatchObject({
            targets: null,
            refreshing: null,
            error: "HTTP 401: Bad credentials (https://api.github.com/repos/o/r/pulls)",
        });
    });
});

describe("newestMasterCapture", () => {
    it("downloads the newest master run's complete capture, skipping runs without one", async () => {
        const r = makeRepo();
        const gh = fakeGh({
            masterRuns: [
                { id: 3000, head: "3".repeat(40) },
                { id: 2000, head: "2".repeat(40) },
                { id: 1000, head: r.master },
            ],
            artifacts: { 3000: [], 2000: ["visual-compact-mantine-1"], 1000: ["visual-compact-mantine-1"] },
            results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null, runId: 2000 } },
        });
        const tmp = join(r.dir, "reference");
        const dir = await newestMasterCapture(gh, "compact-mantine", tmp, FIXTURE_CONFIG);
        expect(dir).toBe(join(tmp, "2000-1", "compact-mantine"));
        expect(JSON.parse(readFileSync(join(dir, "results.json"), "utf8")).runId).toBe(2000);
    });

    it("skips a master commit with no run", async () => {
        const r = makeRepo();
        const gh = fakeGh({
            masterRuns: [
                { id: null, head: "4".repeat(40) },
                { id: 2000, head: r.master },
            ],
            artifacts: { 2000: ["visual-compact-mantine-1"] },
            results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null, runId: 2000 } },
        });
        const tmp = join(r.dir, "reference");
        expect(await newestMasterCapture(gh, "compact-mantine", tmp, FIXTURE_CONFIG)).toBe(
            join(tmp, "2000-1", "compact-mantine"),
        );
    });

    it("uses a merged head's run, never an earlier commit of the merged branch", async () => {
        const r = makeRepo();
        const [m2, b2, b1] = ["4", "3", "2"].map((c) => c.repeat(40));
        const reference = (headArtifacts) =>
            newestMasterCapture(
                fakeGh({
                    masterRuns: [
                        { id: null, head: m2, parents: [r.master, b2] },
                        { id: 3000, head: b2, parents: [b1] },
                        { id: 2000, head: b1, parents: [r.master] },
                        { id: 1000, head: r.master },
                    ],
                    artifacts: {
                        3000: headArtifacts,
                        2000: ["visual-compact-mantine-1"],
                        1000: ["visual-compact-mantine-1"],
                    },
                    results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null } },
                }),
                "compact-mantine",
                join(r.dir, "reference"),
                FIXTURE_CONFIG,
            );
        expect(await reference(["visual-compact-mantine-1"])).toBe(
            join(r.dir, "reference", "3000-1", "compact-mantine"),
        );
        expect(await reference([])).toBe(join(r.dir, "reference", "1000-1", "compact-mantine"));
    });

    it("reads each run's artifact list once, though the range read and the download both look at it", async () => {
        const r = makeRepo();
        const inner = fakeGh({
            masterRuns: [
                { id: 3000, head: "3".repeat(40) },
                { id: 2000, head: r.master },
            ],
            artifacts: { 3000: ["build-x"], 2000: ["visual-compact-mantine-1"] },
            results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null, runId: 2000 } },
        });
        const lists = [];
        const gh = (args, input) => {
            if (/\/artifacts\?/.test(args[1] ?? "")) {
                lists.push(args[1]);
            }
            return inner(args, input);
        };
        // a reader that cannot range-read, so every run falls through to the whole download
        const dir = await newestMasterCapture(gh, "compact-mantine", join(r.dir, "reference"), FIXTURE_CONFIG, {
            reader: async () => null,
        });
        expect(dir).toBe(join(r.dir, "reference", "2000-1", "compact-mantine"));
        expect(lists).toEqual([
            "repos/{owner}/{repo}/actions/runs/3000/artifacts?per_page=100",
            "repos/{owner}/{repo}/actions/runs/2000/artifacts?per_page=100",
        ]);
    });

    it("walks the default branch once for several projects given the same API cache (#4318)", async () => {
        const r = makeRepo();
        const calls = [];
        const inner = fakeGh({
            masterRuns: [
                { id: 3000, head: "3".repeat(40) },
                { id: 2000, head: r.master },
            ],
            artifacts: { 3000: [], 2000: ["visual-compact-mantine-1"] },
            results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null, runId: 2000 } },
        });
        const gh = (args, input) => {
            calls.push(args.join(" "));
            return inner(args, input);
        };
        const cache = join(r.dir, "api-cache");
        const find = (project) =>
            newestMasterCapture(onceOnDisk(gh, cache), project, join(r.dir, "reference"), FIXTURE_CONFIG, {
                reader: null,
            });
        expect(await find("compact-mantine")).toBe(join(r.dir, "reference", "2000-1", "compact-mantine"));
        const first = calls.length;
        expect(await find("graphty-element")).toBeNull();
        expect(calls.slice(first)).toEqual([]);
    });

    it("finds nothing when no master run has a complete capture", async () => {
        const r = makeRepo();
        const gh = fakeGh({
            masterRuns: [{ id: 2000, head: r.master }],
            artifacts: { 2000: ["visual-compact-mantine-1"] },
            results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null, complete: false } },
        });
        expect(await newestMasterCapture(gh, "compact-mantine", join(r.dir, "reference"), FIXTURE_CONFIG)).toBeNull();
    });
});

describe("downloadCaptures", () => {
    const setup = () => {
        const r = makeRepo();
        const inner = fakeGh({ artifacts: { 1000: ["visual-compact-mantine-1"] } });
        const calls = [];
        return { r, inner, calls, tmp: join(r.dir, "downloads"), run: { id: 1000 } };
    };

    it("downloads a run once when two refreshes ask for it at the same time", async () => {
        const { inner, calls, tmp, run } = setup();
        // The first caller's extraction lasts until the second caller has its artifact list and
        // (one turn of the event loop later) has asked for the same download, mid-way through it.
        let listed = 0;
        let bothAsked;
        const asked = new Promise((resolve) => (bothAsked = resolve));
        const gh = async (args, input) => {
            if (args[0] === "run") {
                calls.push(args);
                await asked;
                return inner(args, input);
            }
            const answer = await inner(args, input);
            if (++listed === 2) {
                setImmediate(bothAsked);
            }
            return answer;
        };
        const [a, b] = await Promise.all([
            downloadCaptures(gh, run, ["compact-mantine"], tmp),
            downloadCaptures(gh, run, ["compact-mantine"], tmp),
        ]);
        expect(calls).toHaveLength(1);
        expect(a).toEqual(b);
        expect(existsSync(join(a["compact-mantine"].dir, "results.json"))).toBe(true);
        expect(readdirSync(join(tmp, "1000-1"))).toEqual(["compact-mantine"]);
    });

    it("leaves no directory behind when a download is interrupted, and retries next time", async () => {
        const { inner, tmp, run } = setup();
        const failing = async (args, input) => {
            if (args[0] === "run") {
                // Half-extracted, then gh dies: results.json (written last) never arrives.
                writeFileSync(join(args[6], "button--primary.png"), "partial");
                throw new Error("error extracting zip archive");
            }
            return inner(args, input);
        };
        const failed = await downloadCaptures(failing, run, ["compact-mantine"], tmp);
        expect(failed["compact-mantine"]).toEqual({
            dir: null,
            attempt: 1,
            bytes: 1000000,
            error: "error extracting zip archive",
        });
        expect(readdirSync(join(tmp, "1000-1"))).toEqual([]);

        const out = await downloadCaptures(inner, run, ["compact-mantine"], tmp);
        expect(existsSync(join(out["compact-mantine"].dir, "results.json"))).toBe(true);
    });

    it("replaces a leftover directory that has no results.json", async () => {
        const { inner, tmp, run } = setup();
        const dir = join(tmp, "1000-1", "compact-mantine");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "button--primary.png"), "partial");
        await downloadCaptures(inner, run, ["compact-mantine"], tmp);
        expect(existsSync(join(dir, "results.json"))).toBe(true);
    });
});

describe("network failures", () => {
    const NET = "error connecting to productionresultssa0.blob.core.windows.net\ncheck your internet connection";
    let logged;
    beforeEach(() => {
        logged = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => logged.mockRestore());
    const lines = () => logged.mock.calls.map(([line]) => line.split("\n")[0]);

    it("retries a gh call that failed on the network, then returns its answer", async () => {
        let calls = 0;
        const gh = withRetries(async () => {
            if (++calls <= 2) {
                throw new Error(NET);
            }
            return "ok";
        }, [0, 0, 0]);
        expect(await gh(["run", "download", "1"])).toBe("ok");
        expect(calls).toBe(3);
        expect(lines()).toEqual([
            "visual-review: gh run download 1 failed; retrying in 0 s: error connecting to productionresultssa0.blob.core.windows.net",
            "visual-review: gh run download 1 failed; retrying in 0 s: error connecting to productionresultssa0.blob.core.windows.net",
        ]);
    });

    it("gives up after the last delay", async () => {
        let calls = 0;
        const gh = withRetries(async () => {
            calls++;
            throw new Error("HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/pulls)");
        }, [0, 0]);
        await expect(gh(["api", "x"])).rejects.toThrow("HTTP 502");
        expect(calls).toBe(3);
    });

    it.each([
        ["a 4xx", ["api", "x"], "HTTP 404: Not Found (https://api.github.com/x)"],
        ["a missing artifact", ["run", "download", "1"], "no artifact matches any of the names or patterns provided"],
        ["a write", ["api", "x", "--input", "-"], NET],
    ])("does not retry %s", async (_, args, message) => {
        let calls = 0;
        const gh = withRetries(async () => {
            calls++;
            throw new Error(message);
        }, [0, 0, 0]);
        await expect(gh(args)).rejects.toThrow(message.split("\n")[0]);
        expect(calls).toBe(1);
        expect(lines()).toEqual([`visual-review: gh ${args.join(" ")} failed: ${message.split("\n")[0]}`]);
    });

    it("shows a project whose download failed, loads the others, and retries it on the next request", async () => {
        let down = true;
        const s = await start({
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (down && args[0] === "run" && args[4] === "visual-compact-mantine-1") {
                        throw new Error(NET);
                    }
                    return inner(args, input);
                };
            },
        });
        const first = (await s.api("GET", "/api/prs")).body.targets[0].projects;
        expect(first.find((p) => p.project === "compact-mantine").problem).toBe(
            "download failed: error connecting to productionresultssa0.blob.core.windows.net; reload the page to retry",
        );
        expect(first.find((p) => p.project === "graphty-element")).toMatchObject({ problem: null, reviewable: 1 });

        down = false;
        const second = (await s.api("GET", "/api/prs")).body.targets[0].projects;
        expect(second.find((p) => p.project === "compact-mantine")).toMatchObject({ problem: null, reviewable: 6 });
    });

    it("starts downloading at startup, and a request during it shares that refresh", async () => {
        const calls = [];
        let arrived;
        const requested = new Promise((resolve) => (arrived = resolve));
        const s = await start({
            warm: true,
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    calls.push(args.slice(0, 2).join(" "));
                    if (args[0] === "run") {
                        // The startup refresh downloads until the request below has arrived.
                        await requested;
                    }
                    return inner(args, input);
                };
            },
        });
        // The request's handler runs as it arrives; one turn of the event loop later it waits on
        // the refresh, and the downloads go on.
        server.once("request", () => setImmediate(arrived));
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets.map((t) => t.id)).toEqual(["123"]);
        expect(calls.filter((c) => c === "run download")).toHaveLength(2);
        expect(calls.filter((c) => c === "api graphql")).toHaveLength(1);
    });

    // Pull request #123 loads; #124's CI run cannot be read; master run 2000 loads.
    const twoPrsAndMaster = (fail) => (r) => {
        const inner = fakeGh({
            prs: [
                { number: 123, head: r.head, branch: "feature" },
                { number: 124, head: "4".repeat(40), branch: "other" },
            ],
            runs: { [r.head]: { id: 1000, head: r.head }, ["4".repeat(40)]: { id: 1001, head: "4".repeat(40) } },
            runsById: { 2000: { id: 2000, head: r.master } },
            jobs: { 1000: [job("compact-mantine"), job("graphty-element")], 2000: [job("compact-mantine")] },
            artifacts: { 1000: ["visual-compact-mantine-1"], 2000: ["visual-compact-mantine-1"] },
        });
        return async (args, input) => {
            if (fail(args[1] ?? "")) {
                throw new Error("error connecting to api.github.com");
            }
            return inner(args, input);
        };
    };

    it("shows one pull request that cannot be loaded as failed, and loads the rest and master", async () => {
        const s = await start({ masterRun: 2000, gh: twoPrsAndMaster((path) => path.endsWith("actions/runs/1001")) });
        const { status, body } = await s.api("GET", "/api/prs");
        expect(status).toBe(200);
        const byId = Object.fromEntries(body.targets.map((t) => [t.id, t]));
        expect(Object.keys(byId).sort()).toEqual(["123", "124", "master"]);
        expect(byId["124"]).toMatchObject({ pr: 124, runId: null, branch: "other" });
        expect(byId["124"].projects.map((p) => p.problem)).toEqual([
            "failed to load: error connecting to api.github.com; reload the page to retry",
            "failed to load: error connecting to api.github.com; reload the page to retry",
        ]);
        expect(byId["123"].projects.find((p) => p.project === "compact-mantine").problem).toBeNull();
        expect(byId.master.projects.find((p) => p.project === "compact-mantine").problem).toBeNull();
    });

    it("still loads master when the list of pull requests cannot be read", async () => {
        const s = await start({ masterRun: 2000, gh: twoPrsAndMaster((path) => path === "graphql") });
        const { status, body } = await s.api("GET", "/api/prs");
        expect(status).toBe(200);
        expect(body.targets.map((t) => t.id)).toEqual(["master"]);
        expect(lines()).toContain("visual-review: pull requests not listed: error connecting to api.github.com");
    });
});

describe("serve: passkeys", () => {
    const KEY = makeKey("127.0.0.1");
    const quiet = () => {
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => out.mockRestore());
    };

    /**
     * Pull request #123, with a gh that also opens pull requests and records them.
     * @param {string} [served] the origin the page says it is served from: an https one makes
     *     approvals the gate (and approvalIndex) accepts, which never take a plain http origin
     * @returns {Promise<object>} the started app, plus `opened`, the pull requests opened
     */
    async function startWithPulls(served) {
        const opened = [];
        const s = await start({
            ...(served && { origin: served }),
            gh: (r) => {
                const gh = onePr()(r);
                return async (args, input) => {
                    if (args[1] === "repos/{owner}/{repo}/pulls") {
                        opened.push(JSON.parse(input));
                        return JSON.stringify({ html_url: "https://gh/pull/500" });
                    }
                    return gh(args, input);
                };
            },
        });
        if (served) {
            const api = s.api;
            s.api = (method, path, body, headers = {}) => api(method, path, body, { origin: served, ...headers });
            s.origin = served;
        }
        await s.api("GET", "/api/prs");
        return { ...s, opened };
    }
    const HTTPS = "https://127.0.0.1:9443";

    // finish-prepare's second call: the prepared record, signed by the key.
    const signStep = (s, prepared, key = KEY) =>
        s.api("POST", "/api/finish-prepare", {
            id: "123",
            challenge: prepared.challenge,
            approval: approve(prepared.record, key, { origin: s.origin }),
        });

    // The images approvalIndex counts as approved before from the review records at the branch's tip.
    const approvedBefore = (s) => {
        const names = git(s.remote, "ls-tree", "--name-only", "feature", "visual-baselines/reviews/").split("\n");
        const records = names.map((path) => ({
            ref: "feature",
            commit: "feature",
            path,
            record: JSON.parse(git(s.remote, "show", `feature:${path}`)),
            main: false,
        }));
        return [...approvalIndex(records, [KEY.entry]).keys()];
    };
    const approvalsOn = (s) => git(s.remote, "log", "--format=%H", "feature", "--", "visual-review-approvals/");

    async function registerKey(s, key = KEY) {
        const { challenge } = (await s.api("POST", "/api/passkey-challenge", {})).body;
        return s.api("POST", "/api/register", {
            ...register(key, { challenge, origin: s.origin }),
            label: "iPad\nKeychain",
        });
    }

    const decide = (s, file, decision = "accept", reason = null) =>
        s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision, reason });

    // Decides every image of #123: accepts what can be accepted, excludes the rest.
    async function decideAll(s) {
        for (const project of ["compact-mantine", "graphty-element"]) {
            const { body } = await s.api("GET", `/api/pr/123/${project}`);
            for (const { file, status } of body.items) {
                const exclude = ["unstable", "failed"].includes(status);
                if (exclude || ["changed", "moved", "new", "unseeded", "removed"].includes(status)) {
                    const decision = exclude ? "exclude" : "accept";
                    const reason = exclude ? "noisy" : null;
                    expect(
                        (await s.api("POST", "/api/decide", { id: "123", project, file, decision, reason })).status,
                    ).toBe(200);
                }
            }
        }
    }
    const filesOf = (s, ref = "feature") => git(s.remote, "show", "--name-only", "--format=", ref).split("\n");

    it("takes the session token and the served origin on every passkey route", async () => {
        const s = await startWithPulls();
        for (const route of ["passkey-challenge", "register", "finish-prepare"]) {
            expect((await s.api("POST", `/api/${route}`, {}, { "x-review-token": "x" })).status).toBe(401);
            expect((await s.api("POST", `/api/${route}`, {}, { origin: "https://evil.example" })).status).toBe(403);
        }
        expect((await s.api("GET", "/api/passkeys", undefined, { "x-review-token": "x" })).status).toBe(401);
    });

    it("needs nothing while no key is known, and signs nothing while images are undecided", async () => {
        const s = await startWithPulls();
        expect((await s.api("GET", "/api/passkeys")).body).toEqual({ rpId: "127.0.0.1", keys: [], required: false });
        await decide(s, "badge--default.light.png");
        expect((await s.api("POST", "/api/finish-prepare", { id: "123" })).body).toEqual({ required: false });
        expect((await finishJob(s, "123")).job.error).toBeNull();
        const record = filesOf(s).find((f) => f.includes("reviews/"));
        expect(JSON.parse(git(s.remote, "show", `feature:${record}`)).version).toBe(3);
        expect(filesOf(s).some((f) => f.startsWith("visual-review-approvals/"))).toBe(false);
    });

    it("commits the statement unsigned while no key is known, once every image is decided", async () => {
        const s = await startWithPulls();
        await decideAll(s);
        expect((await finishJob(s, "123")).job.error).toBeNull();
        const [file] = filesOf(s);
        expect(file).toMatch(/^visual-review-approvals\/[0-9a-f]{40}\.json$/);
        const statement = JSON.parse(git(s.remote, "show", `feature:${file}`));
        expect(statement).toMatchObject({ version: 1, commit: git(s.remote, "rev-parse", "feature^"), pr: 123 });
        expect(statement.tree).toBe(git(s.remote, "rev-parse", "feature:visual-baselines"));
        expect(statement.approval).toBeUndefined();
    });

    it("registers a passkey: a pull request adding it, and approval required from then on", async () => {
        quiet();
        const s = await startWithPulls();
        const { status, body } = await registerKey(s);
        expect(status).toBe(200);
        expect(body.entry).toMatchObject({
            id: KEY.entry.id,
            publicKey: KEY.entry.publicKey,
            rpId: "127.0.0.1",
            label: "iPad Keychain",
        });
        expect(body.pullRequest).toBe("https://gh/pull/500");
        expect(body.branch).toMatch(/^visual\/passkey-\d{8}T\d{6}Z$/);
        expect(parsePasskeys(git(s.remote, "show", `${body.branch}:visual-review/passkeys.json`))[0].id).toBe(
            KEY.entry.id,
        );
        expect(s.opened[0]).toMatchObject({ head: body.branch, base: "master" });
        expect((await s.api("GET", "/api/passkeys")).body).toEqual({
            rpId: "127.0.0.1",
            keys: [{ id: KEY.entry.id, rpId: "127.0.0.1", label: "iPad Keychain", pending: true }],
            required: true,
        });
        expect((await registerKey(s)).body.error).toBe("this passkey is already registered");

        // Merged: master holds it, so it is no longer pending.
        const clone = join(s.dir, "merge");
        git(s.dir, "clone", "-q", "-b", "master", s.remote, clone);
        mkdirSync(join(clone, "visual-review"));
        writeFileSync(join(clone, "visual-review/passkeys.json"), passkeysJson(KEY));
        git(clone, "add", "-A");
        git(clone, "-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-q", "-m", "keys");
        git(clone, "push", "-q", "origin", "master");
        await s.api("GET", "/api/prs");
        expect((await s.api("GET", "/api/passkeys")).body.keys).toEqual([
            { id: KEY.entry.id, rpId: "127.0.0.1", label: "test", pending: false },
        ]);
    });

    it("trusts only the default branch's keys once it holds one, never a key registered since", async () => {
        quiet();
        const s = await startWithPulls();
        const clone = join(s.dir, "merge");
        git(s.dir, "clone", "-q", "-b", "master", s.remote, clone);
        mkdirSync(join(clone, "visual-review"));
        writeFileSync(join(clone, "visual-review/passkeys.json"), passkeysJson(KEY));
        git(clone, "add", "-A");
        git(clone, "-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-q", "-m", "keys");
        git(clone, "push", "-q", "origin", "master");
        await s.api("GET", "/api/prs");
        // Anyone who can reach the page could register a key; it is pending, and approves nothing.
        const later = makeKey("127.0.0.1");
        const added = await registerKey(s, later);
        expect(added.status).toBe(200);
        expect(added.body.gated).toBe(true);
        await decideAll(s);
        const prepared = (await s.api("POST", "/api/finish-prepare", { id: "123" })).body;
        expect(prepared.allowCredentials).toEqual([KEY.entry.id]);
        const refused = await s.api("POST", "/api/finish", {
            id: "123",
            challenge: prepared.challenge,
            approval: approve(prepared.statement, later, { origin: s.origin }),
        });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toMatch(/key not in passkeys.json/);
    });

    it("uses a registration challenge once and only for five minutes, and refuses a bad registration", async () => {
        const s = await startWithPulls();
        const { challenge } = (await s.api("POST", "/api/passkey-challenge", {})).body;
        const bad = await s.api("POST", "/api/register", register(KEY, { challenge, origin: "https://evil.example" }));
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/^the passkey was not accepted: .*origin/);
        // Used, even though it failed.
        expect((await s.api("POST", "/api/register", register(KEY, { challenge, origin: s.origin }))).status).toBe(409);
        const other = (await s.api("POST", "/api/passkey-challenge", {})).body.challenge;
        expect(
            (
                await s.api(
                    "POST",
                    "/api/register",
                    register(KEY, { challenge: other, origin: s.origin, algorithm: -257 }),
                )
            ).status,
        ).toBe(400);
        const late = (await s.api("POST", "/api/passkey-challenge", {})).body.challenge;
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60000 + 1000);
        onTestFinished(() => vi.restoreAllMocks());
        expect(
            (await s.api("POST", "/api/register", register(KEY, { challenge: late, origin: s.origin }))).status,
        ).toBe(409);
        expect(s.opened).toEqual([]);
    });

    it("finishes with one fresh, valid approval of the statement about the accept commit's tree, and pushes it signed", async () => {
        quiet();
        const s = await startWithPulls();
        await registerKey(s);
        await decideAll(s);

        expect((await s.api("POST", "/api/finish", { id: "123" })).status).toBe(400);
        const prepared = (await s.api("POST", "/api/finish-prepare", { id: "123" })).body;
        expect(prepared).toMatchObject({
            required: true,
            signs: "tree",
            tree: true,
            rpId: "127.0.0.1",
            allowCredentials: [KEY.entry.id],
            record: { version: 2, pr: 123 },
            statement: { version: 1, baselines: "visual-baselines", pr: 123 },
        });
        const { statement } = prepared;
        // The accept commit is made, not pushed, and the statement signs its baselines tree, which
        // holds the record: the one challenge.
        expect(git(s.repo, "rev-parse", `${statement.commit}:visual-baselines`)).toBe(statement.tree);
        expect(git(s.remote, "rev-parse", "feature")).toBe(git(s.repo, "rev-parse", `${statement.commit}^`));
        expect(prepared.challenge).toBe(recordHash(statement).toString("base64url"));
        // The record is not signed on its own: that route refuses the tree's challenge.
        expect((await signStep(s, prepared)).status).toBe(409);
        const approval = approve(statement, KEY, { origin: s.origin });
        const forged = approve(statement, makeKey("127.0.0.1"), { origin: s.origin });
        forged.credentialId = KEY.entry.id;
        const refused = await s.api("POST", "/api/finish", {
            id: "123",
            challenge: prepared.challenge,
            approval: forged,
        });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toMatch(/signature does not verify/);
        const elsewhere = approve(statement, KEY, { origin: "https://127.0.0.1:1" });
        expect(
            (await s.api("POST", "/api/finish", { id: "123", challenge: prepared.challenge, approval: elsewhere }))
                .status,
        ).toBe(403);
        expect((await s.api("POST", "/api/finish", { id: "123", challenge: "x", approval })).status).toBe(409);

        // A decision changed after the prepare: the approval is stale.
        await decide(s, "button--primary.dark.png", null);
        expect(
            (await s.api("POST", "/api/finish", { id: "123", challenge: prepared.challenge, approval })).status,
        ).toBe(409);
        await decide(s, "button--primary.dark.png", "accept");

        const fresh = (await s.api("POST", "/api/finish-prepare", { id: "123" })).body;
        const begun = await s.api("POST", "/api/finish", {
            id: "123",
            challenge: fresh.challenge,
            approval: approve(fresh.statement, KEY, { origin: s.origin }),
        });
        expect(begun.status).toBe(202);
        const job = await endedJob(s);
        expect(job.error).toBeNull();
        const file = `visual-review-approvals/${fresh.statement.tree}.json`;
        expect(filesOf(s)).toEqual([file]);
        expect(git(s.remote, "rev-parse", "feature^")).toBe(fresh.statement.commit);
        const signed = JSON.parse(git(s.remote, "show", `feature:${file}`));
        expect(signed).toMatchObject(fresh.statement);
        expect(verifyApproval(signed, [KEY.entry], { origin: s.origin })).toBeNull();
        // The gate takes only an https origin; this test server is plain http.
        expect(verifyApproval(signed, [KEY.entry])).toMatch(/not on the review page's origin/);
        // The record in the signed tree is the one prepared, signed by the tree's approval alone.
        const path = filesOf(s, "feature^").find((f) => f.includes("reviews/"));
        expect(JSON.parse(git(s.remote, "show", `feature:${path}`))).toEqual(fresh.record);
        // Used once.
        expect(
            (
                await s.api("POST", "/api/finish", {
                    id: "123",
                    challenge: fresh.challenge,
                    approval: signed.approval,
                })
            ).status,
        ).toBe(409);
    });

    it("signs the decisions of a Finish that rejects or leaves anything undecided, never its tree, and they count as approved before", async () => {
        quiet();
        const s = await startWithPulls(HTTPS);
        await registerKey(s);
        await decide(s, "badge--default.light.png");
        expect((await s.api("POST", "/api/finish-prepare", { id: "123" })).body).toMatchObject({
            required: true,
            signs: "record",
            tree: false,
            unsigned: "undecided",
        });
        await decideAll(s);
        await decide(s, "slider--sizes.png", null);
        await decide(s, "slider--sizes.png", "reject", "tall");
        const prepared = (await s.api("POST", "/api/finish-prepare", { id: "123" })).body;
        expect(prepared).toMatchObject({ required: true, signs: "record", tree: false, unsigned: "rejects" });
        // Without the record's approval, nothing is pushed.
        expect((await s.api("POST", "/api/finish", { id: "123" })).status).toBe(400);
        expect(git(s.remote, "rev-parse", "feature")).toBe(s.head);

        expect((await signStep(s, prepared)).body).toEqual({ required: false, signed: true });
        const { job } = await finishJob(s, "123");
        expect(job.error).toBeNull();
        expect(job.result.rejects).toBe(1);
        // One commit: the accepts and the signed record. No statement: the merge stays blocked.
        expect(git(s.remote, "rev-parse", "feature^")).toBe(s.head);
        expect(approvalsOn(s)).toBe("");
        const path = filesOf(s).find((f) => f.includes("reviews/"));
        const record = JSON.parse(git(s.remote, "show", `feature:${path}`));
        expect(record).toMatchObject({ version: 2, pr: 123 });
        expect(record.rejects).toHaveLength(1);
        expect(verifyRecord(record, [KEY.entry], { pr: 123 })).toBeNull();
        expect(approvedBefore(s).length).toBe(record.items.filter((i) => i.to !== null).length);
        expect(approvedBefore(s).length).toBeGreaterThan(0);
    });

    it("signs an earlier Finish's record that was pushed unsigned when Finish is pressed with nothing new", async () => {
        quiet();
        const s = await startWithPulls(HTTPS);
        // Before any key: the Finish with a reject pushes its record unsigned.
        await decide(s, "badge--default.light.png");
        await decide(s, "slider--sizes.png", "reject", "tall");
        expect((await finishJob(s, "123")).job.error).toBeNull();
        const first = git(s.remote, "rev-parse", "feature");
        const path = filesOf(s).find((f) => f.includes("reviews/"));
        const unsigned = JSON.parse(git(s.remote, "show", `feature:${path}`));
        expect(unsigned.approval).toBeUndefined();
        expect(approvedBefore(s)).toEqual([]);

        await registerKey(s);
        expect((await s.api("GET", "/api/target/123")).body).toMatchObject({ unpublished: 0, resign: true });
        const prepared = (await s.api("POST", "/api/finish-prepare", { id: "123" })).body;
        expect(prepared).toMatchObject({ required: true, signs: "record", resign: true, tree: false });
        expect(prepared.record).toEqual({ ...unsigned, version: 2 });
        expect((await signStep(s, prepared)).body).toEqual({ required: false, signed: true });
        const { job } = await finishJob(s, "123");
        expect(job.error).toBeNull();
        expect(job.result).toMatchObject({ resigned: true, rejects: 0 });

        // One commit on top, changing only that record: no decision is added or posted again.
        expect(git(s.remote, "rev-parse", "feature^")).toBe(first);
        expect(filesOf(s)).toEqual([path]);
        expect(git(s.remote, "ls-tree", "--name-only", "feature", "visual-baselines/reviews/")).toBe(path);
        const signed = JSON.parse(git(s.remote, "show", `feature:${path}`));
        expect({ ...signed, approval: undefined, version: 3 }).toEqual({ ...unsigned, approval: undefined });
        expect(verifyRecord(signed, [KEY.entry], { pr: 123 })).toBeNull();
        expect(approvedBefore(s)).toEqual([
            "visual-baselines/compact-mantine/badge--default.light.png " + unsigned.items[0].to,
        ]);
        expect(approvalsOn(s)).toBe("");
        // Signed once: nothing is left to sign.
        expect((await s.api("GET", "/api/target/123")).body.resign).toBe(false);
        expect((await s.api("POST", "/api/finish-prepare", { id: "123" })).body).toMatchObject({ required: false });
    });

    it("says so when no key is registered for the page's host", async () => {
        quiet();
        const s = await startWithPulls();
        mkdirSync(join(s.tmp, "state"), { recursive: true });
        writeFileSync(join(s.tmp, "state/passkeys-pending.json"), passkeysJson(makeKey("dev.ato.ms")));
        await decideAll(s);
        const r = await s.api("POST", "/api/finish-prepare", { id: "123" });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/^no passkey is registered for 127\.0\.0\.1: .*\(dev\.ato\.ms\)/);
    });
});

describe("serve: against the default branch", () => {
    it("shows what the branch already changed against master's baselines, and serves master's image", async () => {
        const r = makeRepo();
        const DIR = "visual-baselines/compact-mantine";
        const badge = readFileSync(join(FIXTURE, "compact-mantine/badge--default.light.png"));
        const master = (file) => contentHash(Buffer.from(git(r.repo, "show", `master:${DIR}/${file}`)));
        // The branch already holds its own baseline of input--default (an earlier Finish), and has
        // deleted card--legacy's; the capture matches the branch, so against it both look unchanged.
        git(r.repo, "checkout", "-q", "feature");
        writeFileSync(join(r.repo, DIR, "input--default.png"), badge);
        git(r.repo, "rm", "-q", `${DIR}/card--legacy.png`);
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "earlier accepts");
        git(r.repo, "push", "-q", "origin", "feature");
        const head = git(r.repo, "rev-parse", "HEAD");
        git(r.repo, "checkout", "-q", "master");
        const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        const items = fixture.items
            .filter((i) => i.file !== "card--legacy.png")
            .map((i) =>
                i.file === "input--default.png" ? { ...i, baseline: sha256(badge), capture: sha256(badge) } : i,
            );
        const s = await start({
            ...r,
            head,
            gh: onePr({
                results: {
                    "visual-compact-mantine-1": { commit: head, headSha: head, items, expected: items.length },
                    "visual-graphty-element-1": { commit: head, headSha: head },
                },
            }),
        });
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        const byFile = Object.fromEntries(body.items.map((i) => [i.file, i]));
        expect(byFile["input--default.png"]).toMatchObject({
            status: "changed",
            baseline: master("input--default.png"),
            capture: sha256(badge),
            vsBase: true,
        });
        expect(byFile["card--legacy.png"]).toMatchObject({
            status: "removed",
            baseline: master("card--legacy.png"),
            capture: null,
            vsBase: true,
        });
        // What the branch changes against its own baselines is shown as before.
        expect(byFile["button--primary.dark.png"]).toMatchObject({ status: "changed" });
        expect(byFile["button--primary.dark.png"].vsBase).toBeUndefined();
        for (const file of ["input--default.png", "card--legacy.png"]) {
            const img = await s.api("GET", `/api/img/123/compact-mantine/baseline/${file}`);
            expect(img.status).toBe(200);
            expect(sha256(img.body)).toBe(master(file));
        }
        // The capture of an unchanged item is not in the artifact: it is the branch's baseline.
        const capture = await s.api("GET", "/api/img/123/compact-mantine/capture/input--default.png");
        expect(sha256(capture.body)).toBe(sha256(badge));
        // Both are decided like any other change, and count as undecided until they are.
        const summary = (await s.api("GET", "/api/target/123")).body;
        const undecided = summary.projects.find((p) => p.project === "compact-mantine").undecided;
        const decide = (file) =>
            s.api("POST", "/api/decide", {
                id: "123",
                project: "compact-mantine",
                file,
                decision: "accept",
                reason: null,
            });
        expect((await decide("input--default.png")).status).toBe(200);
        expect((await decide("card--legacy.png")).status).toBe(200);
        const after = (await s.api("GET", "/api/target/123")).body;
        expect(after.projects.find((p) => p.project === "compact-mantine").undecided).toBe(undecided - 2);
    });

    it("keeps an item unchanged within tolerance whose baseline is master's, though its bytes differ", async () => {
        const r = makeRepo();
        const DIR = "visual-baselines/compact-mantine";
        const head = git(r.repo, "rev-parse", "feature");
        const master = contentHash(Buffer.from(git(r.repo, "show", `master:${DIR}/input--default.png`)));
        const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        // The capture matched the baseline within its threshold, and the artifact does not hold it.
        const items = fixture.items.map((i) =>
            i.file === "input--default.png" ? { ...i, baseline: master, capture: "f".repeat(64) } : i,
        );
        const s = await start({
            ...r,
            head,
            gh: onePr({
                results: {
                    "visual-compact-mantine-1": { commit: head, headSha: head, items, expected: items.length },
                    "visual-graphty-element-1": { commit: head, headSha: head },
                },
            }),
        });
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.problem ?? null).toBeNull();
        const item = body.items.find((i) => i.file === "input--default.png");
        expect(item).toMatchObject({ status: "unchanged", baseline: master });
        expect(item.vsBase).toBeUndefined();
    });

    it("shows the branch's baseline for an item unchanged within tolerance of a baseline the branch changed", async () => {
        const r = makeRepo();
        const DIR = "visual-baselines/compact-mantine";
        const badge = readFileSync(join(FIXTURE, "compact-mantine/badge--default.light.png"));
        git(r.repo, "checkout", "-q", "feature");
        writeFileSync(join(r.repo, DIR, "input--default.png"), badge);
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "earlier accepts");
        git(r.repo, "push", "-q", "origin", "feature");
        const head = git(r.repo, "rev-parse", "HEAD");
        git(r.repo, "checkout", "-q", "master");
        const master = contentHash(Buffer.from(git(r.repo, "show", `master:${DIR}/input--default.png`)));
        const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        // Within tolerance of the branch's baseline, with bytes of its own the artifact does not hold.
        const items = fixture.items.map((i) =>
            i.file === "input--default.png" ? { ...i, baseline: sha256(badge), capture: "f".repeat(64) } : i,
        );
        const s = await start({
            ...r,
            head,
            gh: onePr({
                results: {
                    "visual-compact-mantine-1": { commit: head, headSha: head, items, expected: items.length },
                    "visual-graphty-element-1": { commit: head, headSha: head },
                },
            }),
        });
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        const item = body.items.find((i) => i.file === "input--default.png");
        expect(item).toMatchObject({ status: "changed", baseline: master, capture: sha256(badge), vsBase: true });
        const capture = await s.api("GET", "/api/img/123/compact-mantine/capture/input--default.png");
        expect(sha256(capture.body)).toBe(sha256(badge));
    });
});
