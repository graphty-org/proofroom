/**
 * The decision index and compressed answers: at 3,000 stories a decision finds its item without a
 * scan of the list, the decisions file is read again only when it changed, Look alike is grouped
 * once per capture-set load, and JSON answers go gzipped to a client that takes them.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { decisionProblem } from "../trusted/lib/accept.mjs";
import * as filters from "../trusted/lib/filters.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import {
    capturedItems,
    FIXTURE_CONFIG,
    git,
    isolateGit,
    keepTiles,
    makeRepo,
    onePr,
    seedTiles,
} from "./helpers.mjs";

// Counts the calls of the item index's builder and of the Look alike grouping, by any app here.
vi.mock("../trusted/lib/filters.mjs", async (importOriginal) => {
    const real = /** @type {typeof import("../trusted/lib/filters.mjs")} */ (await importOriginal());
    return { ...real, clusters: vi.fn(real.clusters), itemsByFile: vi.fn(real.itemsByFile) };
});

const TOKEN = "t".repeat(43);
const N = 3000;
const PROJECT = "compact-mantine";

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
 * @param {object} [options.r] the repository (makeRepo); a new one when not given
 * @returns {Promise<object>} `api(method, path, body)`, `raw(path, encoding)`, the origin and tmp
 */
async function start({ tiles: seed = true, r = makeRepo(), ...options }) {
    const tmp = join(r.repo, "tmp/visual-review");
    if (seed && tiles) {
        seedTiles(tiles, tmp);
    }
    const box = {};
    server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    box.app = createApp({
        repo: r.repo,
        tmp,
        config: FIXTURE_CONFIG,
        token: TOKEN,
        origin,
        ...options,
        gh: options.gh(r),
    });
    app = box.app;
    const api = async (method, path, body) => {
        const res = await fetch(`${origin}${path}`, {
            method,
            headers: { "x-review-token": TOKEN, origin, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    // The answer's bytes as they come over the wire, with the Accept-Encoding given (none: none).
    const raw = (path, encoding) =>
        new Promise((resolve, reject) => {
            const headers = { "x-review-token": TOKEN, ...(encoding && { "accept-encoding": encoding }) };
            get(`${origin}${path}`, { headers }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ headers: res.headers, bytes: Buffer.concat(chunks) }));
            }).on("error", reject);
        });
    return { ...r, origin, api, raw, tmp };
}

/**
 * `n` new stories showing the badge's image, as compact-mantine's items.
 * @param {number} n how many
 * @returns {object[]} the items
 */
function newItems(n) {
    const badge = capturedItems().find((i) => i.file === "badge--default.light.png");
    return Array.from({ length: n }, (_, i) => ({
        ...badge,
        id: `many--story-${i}`,
        file: `many--story-${i}.light.png`,
    }));
}

const bigPr = (items) => (r) =>
    onePr({
        results: {
            "visual-compact-mantine-1": {
                commit: r.head,
                headSha: r.head,
                complete: true,
                expected: items.length,
                items,
            },
        },
    })(r);

/**
 * The decisions a run shows, as the server worked them out before the index: each saved decision
 * whose item is found by a scan of the list, on the same image and baseline, and still decidable.
 * Kept here as the oracle the index must agree with.
 * @param {object[]} items the project's items
 * @param {Record<string, object>} saved the decisions file
 * @returns {Record<string, object>} the decisions by file
 */
function scanned(items, saved) {
    const mine = {};
    for (const [k, { hash, base, ...d }] of Object.entries(saved)) {
        const file = k.slice(PROJECT.length + 1);
        const item = items.find((i) => i.file === file);
        if (
            k.startsWith(`${PROJECT}/`) &&
            item &&
            (item.capture ?? item.baseline ?? null) === hash &&
            (base === undefined || base === (item.baseline ?? null)) &&
            !decisionProblem(item, d.decision, d.reason ?? null)
        ) {
            mine[file] = d;
        }
    }
    return mine;
}

/**
 * A decisions file over the items with every case the server tells apart: kept accepts and
 * rejects, a reject without a reason, another image, another baseline, one saved before the
 * baseline was kept, and a story the run does not have.
 * @param {object[]} items the items
 * @returns {Record<string, object>} the decisions file
 */
function mixedState(items) {
    const saved = {};
    items.forEach((item, i) => {
        const key = `${PROJECT}/${item.file}`;
        const hash = item.capture;
        const cases = [
            { decision: "accept", reason: null, hash, base: null },
            { decision: "reject", reason: "looks wrong", hash, base: null },
            { decision: "reject", reason: null, hash, base: null },
            { decision: "accept", reason: null, hash: "0".repeat(64), base: null },
            { decision: "accept", reason: null, hash, base: "1".repeat(64) },
            { decision: "accept", reason: null, hash, bulk: true },
            null,
        ];
        const d = cases[i % cases.length];
        if (d) {
            saved[key] = d;
        }
    });
    saved[`${PROJECT}/no-such--story.png`] = { decision: "accept", reason: null, hash: "2".repeat(64), base: null };
    return saved;
}

describe("serve: the decision index", () => {
    it("shows the same decisions at 3,000 stories as the scan of the list did", async () => {
        const items = newItems(N);
        const s = await start({ gh: bigPr(items) });
        await s.api("GET", "/api/prs");
        const saved = mixedState(items);
        writeFileSync(join(s.tmp, "state/123.json"), JSON.stringify(saved));
        const { decisions } = (await s.api("GET", `/api/pr/123/${PROJECT}`)).body;
        const want = scanned(items, saved);
        expect(Object.keys(want).length).toBeGreaterThan(1000);
        expect(decisions).toEqual(want);
    });

    it("answers a decision with no scan of the list and no rebuild of the index", async () => {
        const items = newItems(N);
        const s = await start({ gh: bigPr(items) });
        await s.api("GET", "/api/prs");
        await s.api("GET", `/api/pr/123/${PROJECT}`);
        vi.mocked(filters.itemsByFile).mockClear();
        const find = vi.spyOn(Array.prototype, "find");
        // Every decision the server works out, saved or approved before, is counted: building the
        // index works out one per item, a write only the one it wrote.
        const worked = app.work.decisions;
        const body = { id: "123", project: PROJECT };
        for (const item of items.slice(0, 20)) {
            expect((await s.api("POST", "/api/decide", { ...body, file: item.file, decision: "accept" })).status).toBe(
                200,
            );
        }
        const undo = await s.api("POST", "/api/decide", { ...body, file: items[0].file, decision: null });
        expect(undo.body).toEqual({ ok: true, unpublished: 19 });
        const scans = find.mock.contexts.filter((list) => Array.isArray(list) && list.length >= N).length;
        find.mockRestore();
        expect(scans).toBe(0);
        expect(filters.itemsByFile).not.toHaveBeenCalled();
        expect(app.work.decisions - worked).toBe(21);
        // The list then answers from the same index, with what was written.
        const { decisions } = (await s.api("GET", `/api/pr/123/${PROJECT}`)).body;
        expect(Object.keys(decisions).sort()).toEqual(
            items
                .slice(1, 20)
                .map((i) => i.file)
                .sort(),
        );
        expect(app.work.decisions - worked).toBe(21);
    });

    it("updates on every decision written, by this server or by another process", async () => {
        const items = newItems(N);
        const s = await start({ gh: bigPr(items) });
        await s.api("GET", "/api/prs");
        const body = { id: "123", project: PROJECT };
        const [a, b, c] = items;
        await s.api("POST", "/api/decide", { ...body, file: a.file, decision: "accept" });
        await s.api("POST", "/api/decide", { ...body, file: b.file, decision: "reject", reason: "off" });
        const decided = async () => (await s.api("GET", `/api/pr/123/${PROJECT}`)).body.decisions;
        expect(Object.keys(await decided())).toEqual([a.file, b.file]);
        // Another tab's server on the same directory writes the file: read again at once.
        const file = join(s.tmp, "state/123.json");
        const saved = JSON.parse(readFileSync(file, "utf8"));
        delete saved[`${PROJECT}/${a.file}`];
        saved[`${PROJECT}/${c.file}`] = { decision: "accept", reason: null, hash: c.capture, base: null };
        writeFileSync(file, JSON.stringify(saved, null, 2));
        expect(Object.keys(await decided()).sort()).toEqual([b.file, c.file].sort());
        // A decision this server writes then keeps the other's.
        await s.api("POST", "/api/decide", { ...body, file: a.file, decision: "accept" });
        expect(Object.keys(await decided()).sort()).toEqual([a.file, b.file, c.file].sort());
        expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(
            [a, b, c].map((i) => `${PROJECT}/${i.file}`).sort(),
        );
    });

    it("builds the index and groups Look alike once per capture-set load, never per list request", async () => {
        const items = newItems(N);
        vi.mocked(filters.itemsByFile).mockClear();
        const s = await start({ gh: bigPr(items) });
        await s.api("GET", "/api/prs");
        // One index per capture set loaded: the big one, and graphty-element's.
        expect(vi.mocked(filters.itemsByFile).mock.calls.filter(([given]) => given.length >= N)).toHaveLength(1);
        expect(filters.itemsByFile).toHaveBeenCalledTimes(2);
        vi.mocked(filters.itemsByFile).mockClear();
        vi.mocked(filters.clusters).mockClear();
        const body = { id: "123", project: PROJECT };
        for (let i = 0; i < 3; i++) {
            await s.api("GET", `/api/pr/123/${PROJECT}?rows=1`);
            await s.api("POST", "/api/decide", { ...body, file: items[i].file, decision: "accept" });
        }
        expect(filters.clusters).toHaveBeenCalledTimes(1);
        expect(filters.itemsByFile).not.toHaveBeenCalled();
    });

    it("leaves an image approved before out of Look alike, even once it is rejected", async () => {
        const button = capturedItems().find((i) => i.file === "button--primary.dark.png");
        const items = ["a", "b", "c"].map((name) => ({
            ...button,
            id: `look--${name}`,
            file: `look--${name}.dark.png`,
        }));
        const r = makeRepo();
        mkdirSync(join(r.repo, "visual-baselines/reviews"), { recursive: true });
        writeFileSync(
            join(r.repo, "visual-baselines/reviews/20261001T000000Z-pr77.json"),
            JSON.stringify({
                version: 1,
                unproven: true,
                pr: 77,
                items: [
                    {
                        path: `visual-baselines/${PROJECT}/look--a.dark.png`,
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
        const s = await start({ r, gh: bigPr(items) });
        await s.api("GET", "/api/prs");
        const list = async () => (await s.api("GET", `/api/pr/123/${PROJECT}`)).body;
        const first = await list();
        expect(first.decisions["look--a.dark.png"]).toMatchObject({ decision: "accept", approvedBefore: { pr: 77 } });
        expect(first.clusters.map((c) => c.files)).toEqual([["look--b.dark.png", "look--c.dark.png"]]);
        const body = { id: "123", project: PROJECT, file: "look--a.dark.png" };
        const reject = await s.api("POST", "/api/decide", { ...body, decision: "reject", reason: "not this time" });
        expect(reject.status).toBe(200);
        const after = await list();
        expect(after.decisions["look--a.dark.png"]).toEqual({ decision: "reject", reason: "not this time" });
        expect(after.clusters.map((c) => c.files)).toEqual([["look--b.dark.png", "look--c.dark.png"]]);
        // Its Undo brings back the accept approved before.
        expect((await s.api("POST", "/api/decide", { ...body, decision: null })).status).toBe(200);
        expect((await list()).decisions["look--a.dark.png"]).toMatchObject({ approvedBefore: { pr: 77 } });
    });
});

describe("serve: compressed answers", () => {
    it("gzips a JSON answer for a client that takes it, and it decodes to the same JSON", async () => {
        const s = await start({ gh: bigPr(newItems(N)) });
        await s.api("GET", "/api/prs");
        const path = `/api/pr/123/${PROJECT}?rows=1`;
        const plain = await s.raw(path);
        const zipped = await s.raw(path, "gzip, deflate, br");
        expect(plain.headers["content-encoding"]).toBeUndefined();
        expect(zipped.headers["content-encoding"]).toBe("gzip");
        expect(zipped.headers.vary).toBe("accept-encoding");
        const json = (bytes) => JSON.parse(bytes.toString("utf8"));
        expect(json(gunzipSync(zipped.bytes))).toEqual(json(plain.bytes));
        // The list at 3,000 stories, on the wire: the budget is 200 KB.
        expect(zipped.bytes.length).toBeLessThan(200 * 1024);
        expect(zipped.bytes.length * 5).toBeLessThan(plain.bytes.length);
    });

    it("sends plain JSON when gzip is refused, and never gzips an image", async () => {
        const s = await start({ gh: onePr() });
        const list = await s.raw("/api/prs", "gzip;q=0, identity");
        expect(list.headers["content-encoding"]).toBeUndefined();
        expect(JSON.parse(list.bytes.toString("utf8")).targets).toBeDefined();
        const { items } = JSON.parse(
            gunzipSync((await s.raw(`/api/pr/123/${PROJECT}`, "gzip")).bytes).toString("utf8"),
        );
        const badge = items.find((i) => i.file === "badge--default.light.png");
        const image = await s.raw(`/api/img/123/${PROJECT}/capture/${badge.file}`, "gzip");
        expect(image.headers["content-type"]).toBe("image/png");
        expect(image.headers["content-encoding"]).toBeUndefined();
        expect(image.bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    });
});

describe("filters: Look alike grouping", () => {
    /**
     * The grouping as it was before, which copied each signature's list on every insert: the
     * oracle the push-based grouping must agree with.
     * @param {object[]} items results.json items
     * @returns {Map<string, object[]>} the members by signature
     */
    function copiedGroups(items) {
        const bySignature = new Map();
        for (const item of items) {
            const s = filters.signature(item);
            if (s !== null) {
                bySignature.set(s, [...(bySignature.get(s) ?? []), item]);
            }
        }
        return bySignature;
    }

    it("returns the same groups as before on 3,000 changes with one shared signature", () => {
        const items = Array.from({ length: N }, (_, i) => ({
            id: `c--s${i}`,
            file: `c--s${i}.png`,
            status: "changed",
            size: [400, 300],
            baselineSize: [400, 300],
            // Bands: a tenfold jump in changed pixels splits a cluster.
            changedPixels: i < 2000 ? 100 + (i % 50) : 5000 + i,
            bbox: [10, 10, 40, 40],
        }));
        const groups = copiedGroups(items);
        expect([...groups.keys()]).toEqual(["pixels top-left medium"]);
        const { clusters: found, outliers } = filters.clusters(items);
        expect(found.flatMap((c) => c.files).sort()).toEqual(
            groups
                .get("pixels top-left medium")
                .map((i) => i.file)
                .sort(),
        );
        expect(found.map((c) => [c.signature, c.files.length, c.pixels])).toEqual([
            ["pixels top-left medium", 2000, [100, 149]],
            ["pixels top-left medium", 1000, [7000, 7999]],
        ]);
        expect(outliers).toEqual([]);
    });
});
