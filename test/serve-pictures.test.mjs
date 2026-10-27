/**
 * The list's pictures: one job per item (every kind of a changed pair from one decode), queued in
 * list order with the change just opened first, and each pair's areas kept in one file.
 */

import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../trusted/lib/serve.mjs";
import { autoKind, createPool, PAIR_KINDS, pictures, thumbnail } from "../trusted/lib/thumbs.mjs";
import { ROW, rowCrop } from "../trusted/page/spot.js";
import { fakeAdapters, onePrFakes } from "./fakes/adapters.mjs";
import { capturedItems, copyFixture, FIXTURE_CONFIG, job, makeRepo, until } from "./helpers.mjs";

// Every read of the areas file, by any app in this file.
const areasReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
    const fs = /** @type {typeof import("node:fs")} */ (await importOriginal());
    const readFileSync = (path, ...rest) => {
        if (String(path).endsWith("areas.jsonl")) {
            areasReads.count++;
        }
        return fs.readFileSync(path, ...rest);
    };
    return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

const TOKEN = "t".repeat(43);
const SHAPE = ROW[0] / ROW[1];

/**
 * A picture queue of one that runs each job in this process and records the jobs in the order
 * they start, and how urgent each one asked for was; `hold()` keeps the next ones from finishing
 * until `release()`.
 * @returns {{ pool: import("../trusted/lib/thumbs.mjs").Pool, started: any[], asked: string[],
 *     hold: () => void, release: () => void }} the queue, and what it started
 */
function fakePool() {
    const started = [];
    const asked = [];
    let gate = null;
    let open = () => {};
    const real = createPool(async (input) => {
        started.push(input);
        await gate;
        return pictures(input);
    }, 1);
    const pool = {
        ...real,
        run: (load, when, tag) => {
            asked.push(when);
            return real.run(load, when, tag);
        },
    };
    return {
        pool,
        started,
        asked,
        hold: () => {
            gate = new Promise((resolve) => (open = resolve));
        },
        release: () => {
            gate = null;
            open();
        },
    };
}

const servers = [];
afterEach(async () => {
    for (const { server, app } of servers.splice(0)) {
        await new Promise((resolve) => server.close(() => resolve()));
        await app.idle();
    }
});

/**
 * Starts the app on a random port.
 * @param {object} options passed to createApp, with `gh(r)` making the gh runner
 * @param {string} [options.tmp] the app's tmp directory; by default one in a new repository
 * @returns {Promise<object>} `api(method, path)`, the repository and the app's tmp directory
 */
async function start({ tmp, ...options }) {
    const r = options.repo ? options : makeRepo();
    const repo = options.repo ?? r.repo;
    const box = {};
    const server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const at = tmp ?? join(repo, "tmp/visual-review");
    box.app = createApp({
        repo,
        tmp: at,
        config: FIXTURE_CONFIG,
        token: TOKEN,
        origin,
        ...options,
        ...(options.fakes ? options.fakes(r) : { gh: options.gh(r) }),
    });
    servers.push({ server, app: box.app });
    const api = async (method, path) => {
        const res = await fetch(`${origin}${path}`, { method, headers: { "x-review-token": TOKEN, origin } });
        const type = res.headers.get("content-type") ?? "";
        return {
            status: res.status,
            body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
        };
    };
    return { ...r, repo, api, tmp: at, app: box.app };
}

/**
 * An RGBA image of one color with a rectangle of another.
 * @param {number} w its width
 * @param {number} h its height
 * @param {number[] | null} rect [x, y, width, height] drawn red, or none
 * @returns {Buffer} the PNG
 */
function png(w, h, rect) {
    const img = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const inside = rect && x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
            img.data.set(inside ? [255, 0, 0, 255] : [240, 240, 240, 255], (y * w + x) * 4);
        }
    }
    return PNG.sync.write(img);
}

const contains = ([x, y, w, h], [bx, by, bw, bh]) => x <= bx && y <= by && x + w >= bx + bw && y + h >= by + bh;
const inside = ([x, y, w, h], iw, ih) => x >= 0 && y >= 0 && x + w <= iw + 1e-9 && y + h <= ih + 1e-9;

describe("rowCrop", () => {
    it("crops a small area at the row's shape and its smallest size, centered on it", () => {
        const { crop, zoom } = rowCrop([[1000, 800, 20, 10]], 2400, 1800);
        expect(crop[2] / crop[3]).toBeCloseTo(SHAPE, 6);
        expect(crop[2]).toBeCloseTo(380, 6);
        expect(crop[3]).toBeGreaterThanOrEqual(148);
        expect(crop[0] + crop[2] / 2).toBeCloseTo(1010, 6);
        expect(crop[1] + crop[3] / 2).toBeCloseTo(805, 6);
        // Against the whole image fitted in the row, the crop shows it 12 times larger.
        expect(zoom).toBeCloseTo(1800 / crop[3], 6);
        expect(zoom).toBeGreaterThan(12);
    });

    it("keeps an area at the image's edge inside the image, not centered past it", () => {
        const { crop } = rowCrop([[0, 0, 20, 10]], 2400, 1800);
        expect(crop.slice(0, 2)).toEqual([0, 0]);
        expect(crop[2] / crop[3]).toBeCloseTo(SHAPE, 6);
        const corner = rowCrop([[2390, 1795, 10, 5]], 2400, 1800).crop;
        expect(inside(corner, 2400, 1800)).toBe(true);
        expect(contains(corner, [2390, 1795, 10, 5])).toBe(true);
    });

    it("grows past its smallest size to hold an area larger than it, still at the row's shape", () => {
        const box = [100, 100, 1000, 300];
        const { crop, zoom } = rowCrop([box], 2400, 1800);
        expect(contains(crop, box)).toBe(true);
        expect(crop[2] / crop[3]).toBeCloseTo(SHAPE, 6);
        expect(crop[2]).toBeGreaterThan(1000);
        expect(zoom).toBeCloseTo(Math.max(2400 / crop[2], 1800 / crop[3]), 6);
    });

    it("centers on the largest of several areas", () => {
        const big = [1500, 1200, 200, 60];
        const { crop } = rowCrop([[10, 10, 5, 5], big, [600, 300, 30, 30]], 2400, 1800);
        expect(contains(crop, big)).toBe(true);
        expect(crop[0] + crop[2] / 2).toBeCloseTo(1600, 6);
    });

    it("with no area, shows the middle of the image at the row's shape, as large as fits", () => {
        const { crop, zoom } = rowCrop([], 2400, 1800);
        expect(crop[0]).toBe(0);
        expect(crop[2]).toBeCloseTo(2400, 6);
        expect(crop[2] / crop[3]).toBeCloseTo(SHAPE, 6);
        expect(crop[1] + crop[3] / 2).toBeCloseTo(900, 6);
        expect(zoom).toBeLessThan(2);
    });

    it("on an image smaller than its smallest size, crops inside the image at the row's shape", () => {
        const { crop } = rowCrop([[160, 80, 40, 40]], 320, 200);
        expect(inside(crop, 320, 200)).toBe(true);
        expect(crop[2]).toBeCloseTo(320, 6);
        expect(crop[2] / crop[3]).toBeCloseTo(SHAPE, 6);
    });
});

describe("the picture job", () => {
    it("makes every kind of a changed pair from one job, with its areas, and Zoom Auto zooms a small change", () => {
        const baseline = png(2400, 1800, null);
        const capture = png(2400, 1800, [1000, 800, 30, 20]);
        const made = pictures({ baseline, capture, threshold: 0.1, includeAA: false });
        expect(Object.keys(made.images).sort()).toEqual([...PAIR_KINDS].sort());
        const size = (k) => {
            const p = PNG.sync.read(made.images[k]);
            return [p.width, p.height];
        };
        for (const k of ["spot", "zoom", "both", "plain"]) {
            expect(size(k)).toEqual([400, 300]);
        }
        expect(size("row-plain")).toEqual(ROW);
        expect(size("row-spot")).toEqual(ROW);
        // Its plain picture is the capture's own thumbnail.
        expect(made.images.plain.equals(thumbnail(capture))).toBe(true);
        expect(made.facts.areas).toBe(1);
        expect(made.facts.zoom).toBeGreaterThan(2);
        expect(contains(made.facts.crop, [1000, 800, 30, 20])).toBe(true);
        expect(autoKind(made.facts)).toBe("row-spot");
    });

    it("counts each separate area, and leaves an image-wide change unzoomed under Auto", () => {
        const baseline = png(800, 600, null);
        const capture = PNG.sync.read(png(800, 600, [0, 0, 800, 600]));
        capture.data.set([240, 240, 240, 255], 0);
        const wide = pictures({ baseline, capture: PNG.sync.write(capture), threshold: 0.1, includeAA: false });
        expect(autoKind(wide.facts)).toBe("spot");
        const two = pictures({
            baseline,
            capture: png(800, 600, [10, 10, 5, 5]),
            threshold: 0.1,
            includeAA: false,
        });
        const both = PNG.sync.read(png(800, 600, [10, 10, 5, 5]));
        for (let y = 500; y < 505; y++) {
            for (let x = 700; x < 705; x++) {
                both.data.set([255, 0, 0, 255], (y * 800 + x) * 4);
            }
        }
        const pair = pictures({ baseline, capture: PNG.sync.write(both), threshold: 0.1, includeAA: false });
        expect(two.facts.areas).toBe(1);
        expect(pair.facts.areas).toBe(2);
    });

    it("makes only the plain picture of a snapshot with one image", () => {
        const image = png(320, 200, null);
        const made = pictures({ image });
        expect(Object.keys(made.images)).toEqual(["plain"]);
        expect(made.facts).toBeUndefined();
        expect(made.images.plain.equals(thumbnail(image))).toBe(true);
    });
});

describe("serve: the picture queue", () => {
    /**
     * The fixture as a local preview, with button--secondary added: the button's pair again (with
     * its own diff settings, so its own job), last in results.json but in the button component.
     * @param {string} dir where to write it
     * @returns {string} dir
     */
    function preview(dir) {
        const at = join(dir, "compact-mantine");
        copyFixture("compact-mantine", at, { pr: null, runId: null, runAttempt: null });
        const results = JSON.parse(readFileSync(join(at, "results.json"), "utf8"));
        const button = results.items.find((i) => i.file === "button--primary.dark.png");
        const secondary = { ...button, id: "button--secondary", file: "button--secondary.dark.png", threshold: 0.1 };
        cpSync(join(at, button.file), join(at, secondary.file));
        cpSync(join(at, "baselines", button.file), join(at, "baselines", secondary.file));
        results.items.push(secondary);
        results.expected += 1;
        writeFileSync(join(at, "results.json"), JSON.stringify(results));
        return dir;
    }

    it("starts one job per item in list order: component, then number", async () => {
        const fake = fakePool();
        fake.hold();
        const r = makeRepo();
        const s = await start({
            ...r,
            fakes: () => fakeAdapters(),
            results: preview(join(r.dir, "local")),
            pictures: fake.pool,
        });
        await s.api("GET", "/api/prs");
        await until(() => fake.started.length === 1);
        fake.release();
        await s.app.idle();
        expect(fake.started.map((j) => basename(j.label))).toEqual([
            "button--primary.dark.png",
            "button--secondary.dark.png",
            "slider--sizes.png",
            "badge--default.light.png",
            "card--legacy.png",
            "tooltip--hover.png",
        ]);
        // The pairs are each one job, the new and the removed snapshot one image each.
        expect(fake.started.map((j) => "baseline" in j)).toEqual([true, true, true, false, false, true]);
        // Every kind each needs is on disk, and nothing more: five pictures per pair beside the
        // thumbnails, one per item.
        const spots = readdirSync(join(s.tmp, "spots")).filter((f) => f.endsWith(".png"));
        expect(spots).toHaveLength(4 * 5);
        expect(readdirSync(join(s.tmp, "thumbs")).filter((f) => f.endsWith(".png"))).toHaveLength(5);
        const badge = capturedItems().find((i) => i.file === "badge--default.light.png");
        expect(spots.some((f) => f.includes(badge.capture))).toBe(false);
    });

    it("makes the open change's pictures before those of changes nobody opened", async () => {
        const OTHER = "5".repeat(40);
        // #124 has the same images with other diff settings: pictures of its own.
        const theirs = capturedItems().map((i) => ({ ...i, threshold: 0.07 }));
        const fakes = (r) =>
            fakeAdapters({
                prs: [
                    { number: 123, head: r.head, branch: "feature" },
                    { number: 124, head: OTHER, branch: "other" },
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
                    "visual-compact-mantine-1": { headSha: r.head },
                    "visual-graphty-element-1": { headSha: r.head },
                    "visual-compact-mantine-2": { headSha: OTHER, items: theirs },
                    "visual-graphty-element-2": { headSha: OTHER },
                },
            });
        const fake = fakePool();
        fake.hold();
        const s = await start({ fakes, pictures: fake.pool });
        await s.api("GET", "/api/prs");
        await until(() => fake.started.length === 1);
        const opened = (j) => j.label.startsWith(join(s.tmp, "1001-"));
        // Every job is queued; one runs. Opening #124 puts its queued jobs first.
        expect((await s.api("GET", "/api/pr/124/compact-mantine")).status).toBe(200);
        fake.release();
        await s.app.idle();
        const after = fake.started.slice(1).map(opened);
        expect(after).toContain(true);
        expect(after).toContain(false);
        // All of #124's, then the rest.
        expect(after.indexOf(false)).toBeGreaterThan(after.lastIndexOf(true));
        // Its three changed pairs, in its list order.
        expect(fake.started.filter((j) => opened(j) && "baseline" in j).map((j) => basename(j.label))).toEqual([
            "button--primary.dark.png",
            "slider--sizes.png",
            "tooltip--hover.png",
        ]);
    });

    it("answers Zoom Auto from what the job found, and a restart reads the areas from one file, never per list", async () => {
        const first = fakePool();
        const s = await start({ fakes: onePrFakes(), pictures: first.pool });
        await s.api("GET", "/api/prs");
        await s.app.idle();
        // One job per item to decide: three pairs and two single images in compact-mantine, one in
        // graphty-element.
        expect(first.started).toHaveLength(6);
        const auto = await s.api("GET", "/api/spot/123/compact-mantine/auto/button--primary.dark.png");
        expect(auto.status).toBe(200);
        // A 320 x 200 capture: its row crop is the whole width, under twice Fit, so Auto is spotlit.
        const spot = await s.api("GET", "/api/spot/123/compact-mantine/spot/button--primary.dark.png");
        expect(auto.body.equals(spot.body)).toBe(true);
        const row = await s.api("GET", "/api/spot/123/compact-mantine/row-spot/button--primary.dark.png");
        const drawn = PNG.sync.read(row.body);
        expect([drawn.width, drawn.height]).toEqual(ROW);
        const lines = readFileSync(join(s.tmp, "spots", "areas.jsonl"), "utf8")
            .trim()
            .split("\n");
        expect(lines).toHaveLength(3);
        expect(first.started).toHaveLength(6);

        const readsBefore = areasReads.count;
        const again = fakePool();
        const t = await start({
            repo: s.repo,
            remote: s.remote,
            head: s.head,
            fakes: onePrFakes(),
            pictures: again.pool,
            tmp: s.tmp,
        });
        expect(areasReads.count).toBe(readsBefore + 1);
        await t.api("GET", "/api/prs");
        for (let i = 0; i < 3; i++) {
            expect((await t.api("GET", "/api/pr/123/compact-mantine")).status).toBe(200);
        }
        const restarted = await t.api("GET", "/api/spot/123/compact-mantine/auto/button--primary.dark.png");
        expect(restarted.body.equals(spot.body)).toBe(true);
        await t.app.idle();
        // Nothing made again, and no areas file read for any list or picture request.
        expect(again.started).toHaveLength(0);
        expect(areasReads.count).toBe(readsBefore + 1);
    });

    it("makes a pair's pictures again for Auto when the areas file was lost", async () => {
        const first = fakePool();
        const s = await start({ fakes: onePrFakes(), pictures: first.pool });
        await s.api("GET", "/api/prs");
        await s.app.idle();
        writeFileSync(join(s.tmp, "spots", "areas.jsonl"), "{cut");
        const again = fakePool();
        const t = await start({
            repo: s.repo,
            remote: s.remote,
            head: s.head,
            fakes: onePrFakes(),
            pictures: again.pool,
            tmp: s.tmp,
        });
        await t.api("GET", "/api/prs");
        await t.app.idle();
        expect(again.started).toHaveLength(0);
        const auto = await t.api("GET", "/api/spot/123/compact-mantine/auto/button--primary.dark.png");
        expect(auto.status).toBe(200);
        expect(again.started.map((j) => basename(j.label))).toEqual(["button--primary.dark.png"]);
        expect(existsSync(join(s.tmp, "spots", "areas.jsonl"))).toBe(true);
        // The cut line was ended first, so the new line reads back: a third start makes nothing.
        const third = fakePool();
        const u = await start({
            repo: s.repo,
            remote: s.remote,
            head: s.head,
            fakes: onePrFakes(),
            pictures: third.pool,
            tmp: s.tmp,
        });
        await u.api("GET", "/api/prs");
        const shown = await u.api("GET", "/api/spot/123/compact-mantine/auto/button--primary.dark.png");
        expect(shown.status).toBe(200);
        expect(shown.body.equals(auto.body)).toBe(true);
        await u.app.idle();
        expect(third.started).toHaveLength(0);
    });

    it("makes a pair asked for now while it waits in the advance queue once, not twice", async () => {
        const fake = fakePool();
        fake.hold();
        const s = await start({ fakes: onePrFakes(), pictures: fake.pool });
        await s.api("GET", "/api/prs");
        await until(() => fake.started.length === 1);
        // The slider's advance job is queued behind the button's, which is held.
        const asked = s.api("GET", "/api/spot/123/compact-mantine/spot/slider--sizes.png");
        await until(() => fake.asked.includes("now"));
        fake.release();
        expect((await asked).status).toBe(200);
        await s.app.idle();
        expect(fake.started.filter((j) => basename(j.label) === "slider--sizes.png")).toHaveLength(1);
        expect(fake.started).toHaveLength(6);
    });

    it("answers no picture for an unknown kind or a snapshot with nothing to light", async () => {
        const s = await start({ fakes: onePrFakes(), pictures: fakePool().pool });
        await s.api("GET", "/api/prs");
        for (const path of [
            "blur/button--primary.dark.png",
            "auto/badge--default.light.png",
            "row-spot/input--default.png",
        ]) {
            expect((await s.api("GET", `/api/spot/123/compact-mantine/${path}`)).status).toBe(404);
        }
    });
});
