/**
 * The server routes the new page asks for: the bulk Undo, the guard against undoing a finished
 * accept, the pull request poll's authors and capture jobs, the list's row fields, and runs a page
 * keeps open while a newer capture lands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import { openPullRequests } from "../trusted/lib/github.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import {
    capturedItems,
    fakeGh,
    FIXTURE_CONFIG,
    git,
    isolateGit,
    job,
    keepTiles,
    makeRepo,
    onePr,
    seedTiles,
    until,
} from "./helpers.mjs";

// Every rename onto a decisions file (writeJson's last step), by any app in this file.
const rewrites = vi.hoisted(() => ({ paths: [] }));
vi.mock("node:fs", async (importOriginal) => {
    const fs = /** @type {typeof import("node:fs")} */ (await importOriginal());
    const renameSync = (from, to) => {
        rewrites.paths.push(String(to));
        return fs.renameSync(from, to);
    };
    return { ...fs, default: { ...fs, renameSync }, renameSync };
});

const TOKEN = "t".repeat(43);
const BADGE = "545ffef5962d1ba14e6caf9c56cf7d2304264425bc4196570612a0ed299bc0b1";
// Another image the fixture's tiles hold a thumbnail of: slider--sizes' capture.
const SLIDER = "c04b3488d89be593c79899a30c40a6f79cba82e0d237f6e2aada3ce0d662ae93";

let server;
let app;
afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.idle();
    app = null;
    server = null;
});

let tiles = null;
beforeAll(async () => {
    isolateGit();
    const s = await start({ gh: onePr(), tiles: false });
    tiles = await keepTiles({ ...s, token: TOKEN }, 123);
    await new Promise((resolve) => server.close(() => resolve()));
    await app.idle();
    server = null;
    app = null;
});

/**
 * Starts the app on a random port, with the fixture's tiles made already.
 * @param {object} options passed to createApp, with `gh(r)` making the gh runner
 * @param {boolean} [options.tiles] false: without the tiles
 * @returns {Promise<object>} `api(method, path, body)`, the repository and the app's tmp directory
 */
async function start({ tiles: seed = true, ...options }) {
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
    const api = async (method, path, body) => {
        const res = await fetch(`${origin}${path}`, {
            method,
            headers: { "x-review-token": TOKEN, origin, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const type = res.headers.get("content-type") ?? "";
        return {
            status: res.status,
            body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
        };
    };
    return { ...r, repo, origin, api, tmp };
}

/**
 * `n` new stories showing the badge's image (whose thumbnail the tiles hold), as compact-mantine's items.
 * @param {number} n how many
 * @param {(i: number) => string} [capture] each one's capture hash
 * @returns {object[]} the items
 */
function newItems(n, capture = () => BADGE) {
    const badge = capturedItems().find((i) => i.file === "badge--default.light.png");
    return Array.from({ length: n }, (_, i) => ({
        ...badge,
        id: `many--story-${i}`,
        file: `many--story-${i}.light.png`,
        capture: capture(i),
    }));
}

const at = (r, items) => ({ commit: r.head, headSha: r.head, complete: true, expected: items.length, items });

describe("serve: bulk Undo", () => {
    it("undoes 1,000 decisions in one request and one rewrite of the decisions file", async () => {
        const items = newItems(1000);
        const s = await start({
            gh: (r) => onePr({ results: { "visual-compact-mantine-1": at(r, items) } })(r),
        });
        await s.api("GET", "/api/prs");
        const body = { id: "123", project: "compact-mantine" };
        const files = items.map((i) => i.file);
        expect((await s.api("POST", "/api/accept-all", { ...body, files })).body.accepted).toBe(1000);
        const state = join(s.tmp, "state/123.json");
        rewrites.paths.length = 0;
        const undo = await s.api("POST", "/api/accept-all", { ...body, decision: null, files });
        expect(undo.status).toBe(200);
        expect(undo.body).toMatchObject({ undone: 1000, unpublished: 0 });
        expect(undo.body.files).toEqual(files);
        expect(rewrites.paths.filter((p) => p === state)).toHaveLength(1);
        expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({});
        const target = (await s.api("GET", "/api/target/123")).body;
        expect(target.projects.find((p) => p.project === "compact-mantine").decided).toBe(0);
    });

    it("needs the list of files, and undoes only the listed ones", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const body = { id: "123", project: "compact-mantine" };
        await s.api("POST", "/api/accept-all", body);
        expect((await s.api("POST", "/api/accept-all", { ...body, decision: null })).status).toBe(400);
        const undo = await s.api("POST", "/api/accept-all", {
            ...body,
            decision: null,
            files: ["badge--default.light.png", "no-such--story.png"],
        });
        expect(undo.body.files).toEqual(["badge--default.light.png"]);
        const { decisions } = (await s.api("GET", "/api/pr/123/compact-mantine")).body;
        expect(Object.keys(decisions).sort()).toEqual([
            "button--primary.dark.png",
            "card--legacy.png",
            "slider--sizes.png",
        ]);
    });

    it("skips an image approved before: nothing is stored for it", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => vi.restoreAllMocks());
        const r = makeRepo();
        mkdirSync(join(r.repo, "visual-baselines/reviews"), { recursive: true });
        const record = "visual-baselines/reviews/20261001T000000Z-pr77.json";
        const button = capturedItems().find((i) => i.file === "button--primary.dark.png");
        writeFileSync(
            join(r.repo, record),
            JSON.stringify({
                version: 1,
                unproven: true,
                pr: 77,
                items: [
                    {
                        path: "visual-baselines/compact-mantine/button--primary.dark.png",
                        from: button.baseline,
                        to: button.capture,
                        reason: null,
                    },
                ],
                reviewedAt: "2026-10-01T00:00:00.000Z",
            }),
        );
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "an earlier approval");
        git(r.repo, "push", "-q", "origin", "master");
        const s = await start({ ...r, gh: onePr() });
        await s.api("GET", "/api/prs");
        const body = { id: "123", project: "compact-mantine" };
        await s.api("POST", "/api/decide", { ...body, file: "badge--default.light.png", decision: "accept" });
        const undo = await s.api("POST", "/api/accept-all", {
            ...body,
            decision: null,
            files: ["button--primary.dark.png", "badge--default.light.png"],
        });
        expect(undo.body.files).toEqual(["badge--default.light.png"]);
        const { decisions } = (await s.api("GET", "/api/pr/123/compact-mantine")).body;
        expect(decisions["button--primary.dark.png"]).toMatchObject({ decision: "accept", approvedBefore: { pr: 77 } });
    });

    it("never undoes an accept an earlier Finish published, by either route", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => vi.restoreAllMocks());
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const one = { id: "123", project: "compact-mantine", file: "badge--default.light.png" };
        await s.api("POST", "/api/decide", { ...one, decision: "accept" });
        await s.api("POST", "/api/decide", { ...one, file: "slider--sizes.png", decision: "reject", reason: "moved" });
        await s.api("POST", "/api/finish", { id: "123" });
        let ended;
        await until(async () => {
            ({ job: ended } = (await s.api("GET", "/api/finish-status")).body);
            return ended && !ended.running;
        });
        expect(ended.error).toBeNull();
        await s.api("GET", "/api/prs");
        // As an out-of-date page would send them.
        const decide = await s.api("POST", "/api/decide", { ...one, decision: null });
        expect(decide.status).toBe(409);
        expect(decide.body.error).toMatch(/earlier Finish published/);
        const bulk = await s.api("POST", "/api/accept-all", {
            id: "123",
            project: "compact-mantine",
            decision: null,
            files: ["badge--default.light.png", "slider--sizes.png"],
        });
        // A reject an earlier Finish posted can still be undone, as the page offers.
        expect(bulk.body.files).toEqual(["slider--sizes.png"]);
        const { decisions } = (await s.api("GET", "/api/pr/123/compact-mantine")).body;
        expect(decisions).toEqual({ "badge--default.light.png": { decision: "accept", reason: null, posted: true } });
    });
});

/**
 * GitHub's cost of a GraphQL query: one request per page of each connection (a field with
 * `first` or `last`), each page as large as asked, summed and divided by 100.
 * @param {string} query the query
 * @returns {{ points: number, connections: { name: string, size: number }[] }} its cost and its connections
 */
function queryCost(query) {
    const connections = [];
    const stack = [1];
    let requests = 0;
    let pending = null;
    const tokens = query.match(/\w+\s*\([^)]*(?:\{[^}]*\}[^)]*)*\)|[{}]/g) ?? [];
    for (const token of tokens) {
        if (token === "{") {
            const top = stack.at(-1);
            stack.push(pending === null ? top : top * pending);
            pending = null;
        } else if (token === "}") {
            stack.pop();
        } else {
            const size = /\b(?:first|last):\s*(\d+)/.exec(token);
            if (size) {
                const n = Number(size[1]);
                connections.push({ name: /^\w+/.exec(token)[0], size: n });
                requests += stack.at(-1);
                pending = n;
            }
        }
    }
    return { points: Math.max(1, Math.round(requests / 100)), connections };
}

describe("serve: the pull request poll", () => {
    const recorded = readFileSync(new URL("fixtures/github/pulls-poll.json", import.meta.url), "utf8");

    it("reads each pull request's author and its capture jobs from GitHub's answer", async () => {
        const asked = [];
        const gh = async (args) => {
            asked.push(args);
            return recorded;
        };
        const prs = await openPullRequests(gh, { workflow: "ci.yml" });
        expect(prs).toEqual([
            {
                number: 3486,
                title: "Storybook 9 upgrade for every package and its stories",
                url: "https://github.com/graphty-org/graphty-monorepo/pull/3486",
                headSha: "6dfc21d0c4b1e0f8a5c2b0d9e7a4f3c2b1a09876",
                branch: "feat/3486-storybook-9",
                draft: false,
                author: "apowers",
                run: { id: 18800002, status: "in_progress", conclusion: null, updatedAt: "2026-10-25T10:12:00Z" },
                // Only the runs named "visual (<project>)".
                visual: {
                    "compact-mantine": { status: "completed", conclusion: "success" },
                    "graphty-element": { status: "in_progress", conclusion: null },
                    graphty: { status: "queued", conclusion: null },
                },
            },
            {
                number: 3471,
                title: "Legend overlay spacing",
                url: "https://github.com/graphty-org/graphty-monorepo/pull/3471",
                headSha: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
                branch: "fix/3471-legend-spacing",
                draft: true,
                author: null,
                run: null,
                visual: null,
            },
        ]);
        // One query, asking only GitHub Actions' suites and each one's newest runs.
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain("appId=15368");
        const query = asked[0].find((a) => a.startsWith("query=")).slice("query=".length);
        expect(query).toMatch(/author \{ login \}/);
        expect(query).toMatch(/checkSuites\(first: 10, filterBy: \{ appId: \$appId \}\)/);
        expect(query).toMatch(
            /checkRuns\(first: 50, filterBy: \{ checkType: LATEST \}\) \{ nodes \{ name status conclusion \} \}/,
        );
    });

    it("costs at most 15 points by GitHub's formula", async () => {
        let query = null;
        await openPullRequests(
            async (args) => {
                query = args.find((a) => a.startsWith("query=")).slice("query=".length);
                return recorded;
            },
            { workflow: "ci.yml" },
        );
        const { points, connections } = queryCost(query);
        expect(connections).toEqual([
            { name: "pullRequests", size: 100 },
            { name: "commits", size: 1 },
            { name: "checkSuites", size: 10 },
            { name: "checkRuns", size: 50 },
        ]);
        // 1 + 100 + 100 + 1,000 requests.
        expect(points).toBe(12);
        expect(points).toBeLessThanOrEqual(15);
    });

    it("lists each change's author and each project's capture job, from the jobs when the poll has none", async () => {
        const s = await start({
            gh: (r) =>
                fakeGh({
                    prs: [{ number: 123, head: r.head, branch: "feature", author: "apowers" }],
                    runs: {
                        [r.head]: {
                            id: 1000,
                            head: r.head,
                            checkRuns: [
                                { name: "visual (compact-mantine)", status: "COMPLETED", conclusion: "SUCCESS" },
                            ],
                        },
                    },
                    jobs: { 1000: [job("compact-mantine"), job("graphty-element", "failure")] },
                    artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                    results: {
                        "visual-compact-mantine-1": { commit: r.head, headSha: r.head },
                        "visual-graphty-element-1": { commit: r.head, headSha: r.head },
                    },
                }),
        });
        const t = (await s.api("GET", "/api/prs")).body.targets.find((x) => x.id === "123");
        expect(t.author).toBe("apowers");
        expect(t.projects.map((p) => [p.project, p.ci])).toEqual([
            ["compact-mantine", { status: "completed", conclusion: "success" }],
            // Not among the poll's runs: the run's jobs say it.
            ["graphty-element", { status: "completed", conclusion: "failure" }],
        ]);
        expect(t).toMatchObject({ behind: null, stale: 0, lookOnly: false, newerRun: null, downloading: false });
    });

    it("reports a capture job the poll has none of as queued while the jobs call says it is queued", async () => {
        const s = await start({
            gh: (r) =>
                fakeGh({
                    prs: [{ number: 123, head: r.head, branch: "feature" }],
                    runs: { [r.head]: { id: 1000, head: r.head } },
                    jobs: {
                        1000: [job("compact-mantine"), { ...job("graphty-element", null), status: "queued" }],
                    },
                    artifacts: { 1000: ["visual-compact-mantine-1"] },
                    results: { "visual-compact-mantine-1": { commit: r.head, headSha: r.head } },
                }),
        });
        const t = (await s.api("GET", "/api/prs")).body.targets.find((x) => x.id === "123");
        expect(t.projects.find((p) => p.project === "graphty-element").ci).toEqual({ status: "queued", conclusion: null });
    });
});

describe("serve: the list's rows", () => {
    it("sends only what a row shows, with each pair's picture name and areas", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const full = (await s.api("GET", "/api/pr/123/compact-mantine")).body;
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine?rows=1");
        expect(body.items.map((i) => i.file)).toEqual(full.items.map((i) => i.file));
        const button = body.items.find((i) => i.file === "button--primary.dark.png");
        const item = full.items.find((i) => i.file === "button--primary.dark.png");
        expect(button.pic).toBe(`${item.baseline}-${item.capture}-${item.threshold}-0`);
        expect(button.areas).toEqual({ crop: expect.any(Array), zoom: expect.any(Number), count: 1 });
        expect((await s.api("GET", `/api/pic/${button.pic}-row-spot`)).status).toBe(200);
        for (const row of body.items) {
            for (const gone of ["console", "bbox", "threshold", "includeAA", "flaky", "attempts", "pictures"]) {
                expect(row).not.toHaveProperty(gone);
            }
        }
        const failed = body.items.find((i) => i.status === "failed");
        expect(failed).toMatchObject({ pic: null, areas: null, reason: "story render errored" });
    });
});

describe("serve: a run a page has open", () => {
    /**
     * Pull request #123 with ten new stories in run 1000, and `next()` making run 1001 the newest,
     * in which three of them show another image.
     * @returns {(r: object) => Function} the gh runner, with `next` on the returned object
     */
    function twoRuns() {
        const data = {};
        const make = (r) => {
            Object.assign(data, {
                prs: [{ number: 123, head: r.head, branch: "feature" }],
                runs: { [r.head]: { id: 1000, head: r.head } },
                jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
                artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                results: {
                    "visual-compact-mantine-1": at(r, newItems(10)),
                    "visual-graphty-element-1": { commit: r.head, headSha: r.head },
                },
            });
            make.next = () => {
                data.runs[r.head] = { id: 1001, head: r.head };
                data.jobs[1001] = data.jobs[1000];
                data.artifacts[1001] = data.artifacts[1000];
                data.results["visual-compact-mantine-1"] = at(
                    r,
                    newItems(10, (i) => (i < 3 ? SLIDER : BADGE)),
                );
            };
            return fakeGh(data);
        };
        return make;
    }

    it("keeps serving it after a newer run lands, names the newer one, and says which decisions carry over", async () => {
        const gh = twoRuns();
        const s = await start({ gh });
        await s.api("GET", "/api/prs");
        const old = await s.api("GET", "/api/pr/123/compact-mantine?run=1000-1");
        expect(old.body.target).toMatchObject({ runId: 1000, newerRun: null });
        const body = { id: "123", project: "compact-mantine", run: "1000-1" };
        const files = old.body.items.filter((i) => i.id.startsWith("many--")).map((i) => i.file);
        expect((await s.api("POST", "/api/accept-all", { ...body, files })).body.accepted).toBe(10);
        gh.next();
        await s.api("GET", "/api/prs");
        // The list moved on.
        expect((await s.api("GET", "/api/target/123")).body).toMatchObject({ runId: 1001, newerRun: null });
        // The page that loaded run 1000 still gets its rows, and is told of run 1001.
        const pinned = await s.api("GET", "/api/pr/123/compact-mantine?run=1000-1");
        expect(pinned.status).toBe(200);
        const many = (items) => items.filter((i) => i.id.startsWith("many--"));
        expect(many(pinned.body.items).map((i) => i.capture)).toEqual(Array(10).fill(BADGE));
        expect(pinned.body.target).toMatchObject({ runId: 1000, newerRun: { runId: 1001, runAttempt: 1 } });
        expect((await s.api("GET", "/api/target/123?run=1000-1")).body.newerRun).toMatchObject({ runId: 1001 });
        // Its images too, and its downloads stay on disk.
        const thumb = await s.api("GET", "/api/thumb/123/compact-mantine/capture/many--story-0.light.png?run=1000-1");
        expect(thumb.status).toBe(200);
        expect(existsSync(join(s.tmp, "1000-1"))).toBe(true);
        // Loading run 1001 keeps the seven decisions whose image is the same, and names the three that are not.
        const newer = await s.api("GET", "/api/pr/123/compact-mantine?run=1001-1&since=1000-1");
        expect(newer.body.carried).toEqual({
            kept: 7,
            lost: [0, 1, 2].map((i) => ({ file: `many--story-${i}.light.png`, decision: "accept" })),
        });
        expect(Object.keys(newer.body.decisions)).toHaveLength(7);
        // A decision on the run the page has open is still taken.
        const undo = await s.api("POST", "/api/accept-all", {
            ...body,
            decision: null,
            files: ["many--story-0.light.png"],
        });
        expect(undo.body.files).toEqual(["many--story-0.light.png"]);
    });

    it("refuses a single Undo on a pinned run of a decision taken on the newer run's other image", async () => {
        const gh = twoRuns();
        const s = await start({ gh });
        await s.api("GET", "/api/prs");
        await s.api("GET", "/api/pr/123/compact-mantine?run=1000-1");
        const file = "many--story-0.light.png";
        const old = { id: "123", project: "compact-mantine", file, run: "1000-1" };
        expect((await s.api("POST", "/api/decide", { ...old, decision: "accept" })).status).toBe(200);
        gh.next();
        await s.api("GET", "/api/prs");
        await s.api("GET", "/api/pr/123/compact-mantine?run=1001-1");
        const now = { ...old, run: "1001-1" };
        const reject = await s.api("POST", "/api/decide", { ...now, decision: "reject", reason: "moved" });
        expect(reject.status).toBe(200);
        // The page on run 1000 still shows its accept; its Undo must not delete run 1001's reject.
        const undo = await s.api("POST", "/api/decide", { ...old, decision: null });
        expect(undo.status).toBe(409);
        expect(undo.body.error).toMatch(/reload the page/);
        const page = await s.api("GET", "/api/pr/123/compact-mantine?run=1001-1");
        expect(page.body.decisions[file]).toMatchObject({ decision: "reject", reason: "moved" });
        // Undo on the run that shows it still works, and a second Undo there does nothing.
        expect((await s.api("POST", "/api/decide", { ...now, decision: null })).status).toBe(200);
        expect((await s.api("POST", "/api/decide", { ...now, decision: null })).status).toBe(200);
    });

    it("lets go of a run no page has open: its downloads go, and asking for it says so", async () => {
        const gh = twoRuns();
        const s = await start({ gh });
        await s.api("GET", "/api/prs");
        await s.api("GET", "/api/pr/123/compact-mantine");
        expect(existsSync(join(s.tmp, "1000-1"))).toBe(true);
        gh.next();
        await s.api("GET", "/api/prs");
        expect(existsSync(join(s.tmp, "1000-1"))).toBe(false);
        const old = await s.api("GET", "/api/pr/123/compact-mantine?run=1000-1");
        expect(old.status).toBe(410);
        expect(old.body.error).toMatch(/not kept any more/);
        expect((await s.api("GET", "/api/pr/123/compact-mantine?run=1001-1")).status).toBe(200);
    });
});
