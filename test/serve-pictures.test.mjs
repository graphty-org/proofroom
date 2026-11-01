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
import { autoKind, createPool, factsOf, firstChanged, PAIR_KINDS, pictures, shownKind, thumbnail } from "../trusted/lib/thumbs.mjs";
import { clusters, covered, ROW, ROW_MAX, rowCrop, SPOT_UNDER } from "../trusted/page/spot.js";
import { fakeAdapters, onePrFakes } from "./fakes/adapters.mjs";
import { capturedItems, copyFixture, FIXTURE, FIXTURE_CONFIG, job, makeRepo, until } from "./helpers.mjs";

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
// A compact-mantine item of the fixture's picture of one kind, by the name the list gives it.
const CM_ITEMS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items;
const pic = (file, kind) => {
    const i = CM_ITEMS.find((x) => x.file === file);
    return `/api/pic/${i.baseline ?? "none"}-${i.capture ?? "none"}-${i.threshold}-${i.includeAA ? 1 : 0}-${kind}`;
};
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
        const box = [100, 100, 500, 150];
        const { crop, zoom, how } = rowCrop([box], 2400, 1800, { scale: 2 });
        expect(how).toBe("all");
        expect(contains(crop, box)).toBe(true);
        expect(crop[2] / crop[3]).toBeCloseTo(SHAPE, 6);
        expect(crop[2]).toBeGreaterThan(500);
        expect(zoom).toBeCloseTo(Math.max(2400 / crop[2], 1800 / crop[3]), 6);
    });

    it("centers on the largest of several areas", () => {
        const big = [1500, 1200, 200, 60];
        const { crop } = rowCrop([[10, 10, 5, 5], big, [600, 300, 30, 30]], 2400, 1800);
        expect(contains(crop, big)).toBe(true);
        expect(crop[0] + crop[2] / 2).toBeCloseTo(1600, 6);
    });

    it("frames every area when that crop fits ROW_MAX, and says it frames them all", () => {
        const boxes = [
            [1000, 800, 20, 10],
            [1100, 830, 20, 10],
        ];
        const { crop, how, shown } = rowCrop(boxes, 2400, 1800);
        expect(shown).toBe(2);
        expect(how).toBe("all");
        for (const b of boxes) {
            expect(contains(crop, b)).toBe(true);
        }
    });

    it("frames the largest cluster of nearby areas when all of them would not fit ROW_MAX", () => {
        // Three areas close together at the top left (each gap under one area-height), one apart at
        // the bottom right: the box around all four is nearly the whole image.
        const near = [
            [100, 100, 40, 40],
            [150, 110, 40, 40],
            [200, 100, 40, 40],
        ];
        const far = [2300, 1700, 50, 50];
        const { crop, how, shown } = rowCrop([...near, far], 2400, 1800);
        expect(shown).toBe(3);
        expect(how).toBe("cluster");
        for (const b of near) {
            expect(contains(crop, b)).toBe(true);
        }
        expect(contains(crop, far)).toBe(false);
    });

    it("clusters areas within one area-height of each other, through chains of them", () => {
        const groups = clusters([
            [0, 0, 10, 10],
            [15, 0, 10, 10], // 5 px from the first: joined
            [30, 0, 10, 10], // 5 px from the second: joined through it
            [100, 0, 10, 10], // 60 px away: its own
        ]);
        expect(groups.map((g) => g.length)).toEqual([3, 1]);
    });

    it("with no area, shows a ROW_MAX crop centered on the image", () => {
        const { crop, how } = rowCrop([], 2400, 1800, { scale: 2 });
        expect(crop).toEqual([800, 744, 800, 312]);
        expect(how).toBe("size");
    });

    // A resized page, as measured on #4455's ddram: a small height change shifts everything under
    // it, so its largest area runs from the first shifted line to the bottom.
    const DDRAM = [
        [0, 1150, 2400, 2654],
        [40, 200, 30, 30],
    ];

    it("on a change too large for ROW_MAX, crops ROW_MAX where the largest area starts, a quarter in", () => {
        const opts = { scale: 2, base: [2400, 3770], first: [300, 1160] };
        const { crop, how, shown } = rowCrop(DDRAM, 2400, 3804, opts);
        expect(how).toBe("start");
        expect(shown).toBe(1);
        // Never larger than ROW_MAX of the page: 400 x 156 CSS px is 800 x 312 image px at scale 2.
        expect(crop).toEqual([300 - 200, 1160 - 78, ROW_MAX[0] * 2, ROW_MAX[1] * 2]);
        // At scale 1 the same rule holds ROW_MAX image pixels.
        expect(rowCrop(DDRAM, 2400, 3804, { ...opts, scale: 1 }).crop.slice(2)).toEqual(ROW_MAX);
    });

    it("without the first changed pixel, starts at the largest area's top-left corner, kept inside the image", () => {
        const { crop, how } = rowCrop(DDRAM, 2400, 3804, { scale: 2, base: [2400, 3770] });
        expect(how).toBe("start");
        expect(crop).toEqual([0, 1150 - 78, 800, 312]);
        // A first pixel outside the largest area is not its start: the corner stands in.
        expect(rowCrop(DDRAM, 2400, 3804, { scale: 2, first: [50, 210] }).crop).toEqual(crop);
        // Near the bottom-right corner, the crop stays inside the image.
        const late = rowCrop([[2000, 3700, 400, 104]], 2400, 3804, { scale: 2, first: [2390, 3800] });
        expect(late.how).toBe("all");
        const far = rowCrop(
            [
                [0, 3000, 2400, 804],
                [0, 0, 10, 10],
            ],
            2400,
            3804,
            { scale: 2, first: [2390, 3800] },
        );
        expect(far.how).toBe("start");
        expect(inside(far.crop, 2400, 3804)).toBe(true);
    });

    it.each([
        ["2 px shorter", [2400, 1802], [[0, 1790, 2400, 10]]],
        ["2 px taller", [2400, 1798], [[0, 1788, 2400, 12]]],
        ["10 px narrower", [2410, 1800], [[2390, 0, 10, 1800]]],
    ])("when only the size changed (%s), centers a ROW_MAX crop on the image", (_, base, boxes) => {
        const { crop, how, shown } = rowCrop(boxes, 2400, 1800, { scale: 2, base });
        expect(how).toBe("size");
        expect(shown).toBe(0);
        expect(crop).toEqual([800, 744, 800, 312]);
    });

    it("a resized image with a change inside it is not a size-only change", () => {
        const boxes = [
            [0, 1790, 2400, 10],
            [100, 100, 20, 20],
        ];
        expect(rowCrop(boxes, 2400, 1800, { scale: 2, base: [2400, 1802] }).how).not.toBe("size");
    });

    it("fills the row's shape on any page larger than ROW_MAX, never leaving bands beside it", () => {
        for (const [w, h] of [
            [2400, 15618],
            [900, 4000],
            [2400, 400],
        ]) {
            for (const r of [
                rowCrop([[0, 10, w, h - 10]], w, h, { scale: 2 }),
                rowCrop([], w, h, { scale: 2 }),
            ]) {
                expect(r.crop[2] / r.crop[3]).toBeCloseTo(SHAPE, 6);
                expect(r.crop[2]).toBeLessThanOrEqual(800);
                expect(inside(r.crop, w, h)).toBe(true);
            }
        }
    });

    it("shows an image smaller than ROW_MAX both ways whole when its change does not fit", () => {
        const { crop, how } = rowCrop([[0, 0, 390, 150]], 400, 156);
        expect(how).toBe("start");
        expect(crop).toEqual([0, 0, 400, 156]);
    });

    it("on an image narrower than the crop at the row's shape, keeps the crop inside it, its whole width, not zoomed further", () => {
        const { crop, zoom } = rowCrop([[160, 80, 40, 40]], 320, 200);
        expect(inside(crop, 320, 200)).toBe(true);
        expect(crop[2]).toBeCloseTo(320, 6);
        // The smallest height kept: the band beside the picture is the row's background.
        expect(crop[3]).toBeCloseTo(380 / SHAPE, 6);
        expect(crop[2] / crop[3]).toBeLessThan(SHAPE);
        expect(zoom).toBeCloseTo(200 / (380 / SHAPE), 6);
    });

    it("never frames the padding a larger baseline adds: areas are clipped to the new image", () => {
        const { crop, shown } = rowCrop(
            [
                [900, 0, 300, 300],
                [10, 10, 20, 20],
            ],
            800,
            600,
        );
        expect(inside(crop, 800, 600)).toBe(true);
        expect(shown).toBe(1);
    });

    it("says how much of the crop and of the whole image the areas cover", () => {
        const small = rowCrop([[1000, 800, 20, 10]], 2400, 1800);
        expect(small.cover).toBeLessThan(SPOT_UNDER);
        expect(small.coverAll).toBeCloseTo((20 * 10) / (2400 * 1800), 9);
        const most = rowCrop([[0, 0, 2000, 1500]], 2400, 1800);
        expect(most.cover).toBeGreaterThanOrEqual(SPOT_UNDER);
        expect(
            covered(
                [
                    [0, 0, 10, 10],
                    [5, 5, 10, 10],
                ],
                [0, 0, 10, 10],
            ),
        ).toBe(1);
    });
});

describe("the picture job", () => {
    it("makes every kind of a changed pair from one job, with its areas, and Auto crops onto a small change", () => {
        const baseline = png(2400, 1800, null);
        const capture = png(2400, 1800, [1000, 800, 30, 20]);
        const made = pictures({ baseline, capture, threshold: 0.1, includeAA: false });
        expect(Object.keys(made.images).sort()).toEqual([...PAIR_KINDS].sort());
        const size = (k) => {
            const p = PNG.sync.read(made.images[k]);
            return [p.width, p.height];
        };
        for (const k of ["spot", "plain"]) {
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

    it("counts each separate area, and shows an image-wide change cropped and plain under Auto", () => {
        const baseline = png(800, 600, null);
        const capture = PNG.sync.read(png(800, 600, [0, 0, 800, 600]));
        capture.data.set([240, 240, 240, 255], 0);
        const wide = pictures({ baseline, capture: PNG.sync.write(capture), threshold: 0.1, includeAA: false });
        // Plain: the change covers the whole image, so dimming would hide it.
        expect(autoKind(wide.facts)).toBe("row-plain");
        expect(shownKind("row-spot", wide.facts)).toBe("row-plain");
        expect(shownKind("spot", wide.facts)).toBe("plain");
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

    it("crops a resized page where its change starts, ROW_MAX of the page at the capture's scale", () => {
        // A 40 px band inserted at y 300 shifts everything below it: all of it counts as changed.
        const stripes = (h, at, extra) => {
            const img = new PNG({ width: 1200, height: h });
            for (let y = 0; y < h; y++) {
                const src = y >= at + extra ? y - extra : y;
                const v = y >= at && y < at + extra ? 90 : src % 20 < 10 ? 200 : 240;
                for (let x = 0; x < 1200; x++) {
                    img.data.set([v, v, v, 255], (y * 1200 + x) * 4);
                }
            }
            return PNG.sync.write(img);
        };
        const made = pictures({
            baseline: stripes(1800, 0, 0),
            capture: stripes(1840, 300, 40),
            threshold: 0.1,
            includeAA: false,
            scale: 2,
        });
        expect(made.facts.how).toBe("start");
        expect(made.facts.crop.slice(2)).toEqual([800, 312]);
        // The first changed line sits a quarter of the crop below the crop's top.
        expect(made.facts.crop[1]).toBe(300 - 78);
    });

    it("finds a box's first changed pixel: its top-most changed row, the leftmost pixel on it", () => {
        const mask = new Uint8Array(10 * 10 * 4);
        mask[(6 * 10 + 7) * 4 + 3] = 255;
        mask[(4 * 10 + 8) * 4 + 3] = 255;
        mask[(4 * 10 + 5) * 4 + 3] = 255;
        expect(firstChanged(mask, 10, [0, 0, 10, 10])).toEqual([5, 4]);
        expect(firstChanged(mask, 10, [6, 0, 4, 10])).toEqual([8, 4]);
        expect(firstChanged(mask, 10, [0, 0, 3, 3])).toBeNull();
    });

    it("factsOf crops at the capture's scale and knows a size-only change from compare's areas", () => {
        const item = { areas: [[0, 1790, 2400, 10]], size: [2400, 1800], baselineSize: [2400, 1802] };
        expect(factsOf(item, 2)).toMatchObject({ how: "size", crop: [800, 744, 800, 312], areas: 1 });
        // The same strip on a page whose size did not change is a real change: too wide for
        // ROW_MAX, so the crop starts where it does.
        expect(factsOf({ ...item, baselineSize: [2400, 1800] }, 2).how).toBe("start");
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
        // Every kind each needs is on disk, and nothing more: three pictures per pair beside the
        // thumbnails, one per item.
        const spots = readdirSync(join(s.tmp, "spots")).filter((f) => f.endsWith(".png"));
        expect(spots).toHaveLength(4 * 3);
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

    it("answers Auto with the row's crop from what the job found, and a restart reads the areas from one file, never per list", async () => {
        const first = fakePool();
        const s = await start({ fakes: onePrFakes(), pictures: first.pool });
        await s.api("GET", "/api/prs");
        await s.app.idle();
        // One job per item to decide: three pairs and two single images in compact-mantine, one in
        // graphty-element.
        expect(first.started).toHaveLength(6);
        const auto = await s.api("GET", pic("button--primary.dark.png", "auto"));
        expect(auto.status).toBe(200);
        // Auto is the row's crop: every changed row is cropped to its change.
        const row = await s.api("GET", pic("button--primary.dark.png", "row-spot"));
        expect(auto.body.equals(row.body)).toBe(true);
        const spot = row;
        // A 320 x 200 capture: its row crop is the image's whole width at the row's smallest
        // height, narrower than the row's shape, so the picture is too, and the page centers it.
        const drawn = PNG.sync.read(row.body);
        expect(drawn.height).toBe(ROW[1]);
        expect(drawn.width).toBeLessThan(ROW[0]);
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
        const restarted = await t.api("GET", pic("button--primary.dark.png", "auto"));
        expect(restarted.body.equals(spot.body)).toBe(true);
        await t.app.idle();
        // Nothing made again, and no areas file read for any list or picture request.
        expect(again.started).toHaveLength(0);
        expect(areasReads.count).toBe(readsBefore + 1);
    });

    it("makes the pairs' pictures again when an older version made them", async () => {
        const first = fakePool();
        const s = await start({ fakes: onePrFakes(), pictures: first.pool });
        await s.api("GET", "/api/prs");
        await s.app.idle();
        expect(readFileSync(join(s.tmp, "spots", "made-by"), "utf8")).toBe("4");
        // Made before the spotlight dimmed less and the row crop framed every area.
        writeFileSync(join(s.tmp, "spots", "made-by"), "1");
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
        // The three pairs again; the captures' own thumbnails are kept.
        expect(again.started).toHaveLength(3);
        expect(readFileSync(join(s.tmp, "spots", "made-by"), "utf8")).toBe("4");
    });

    it("makes a pair's pictures again for a spotlit crop or Auto when the areas file was lost", async () => {
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
        // A spotlit crop asked for before its areas are known is made first, then shown as what
        // the job found decides (plain when its areas cover a third or more), the same as Auto.
        const lit = await t.api("GET", pic("button--primary.dark.png", "row-spot"));
        expect(lit.status).toBe(200);
        expect(again.started.map((j) => basename(j.label))).toEqual(["button--primary.dark.png"]);
        const auto = await t.api("GET", pic("button--primary.dark.png", "auto"));
        expect(auto.status).toBe(200);
        expect(auto.body.equals(lit.body)).toBe(true);
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
        const shown = await u.api("GET", pic("button--primary.dark.png", "auto"));
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
        const asked = s.api("GET", pic("slider--sizes.png", "spot"));
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
            pic("button--primary.dark.png", "blur"),
            pic("button--primary.dark.png", "zoom"),
            pic("button--primary.dark.png", "both"),
            pic("badge--default.light.png", "auto"),
            pic("input--default.png", "row-spot"),
        ]) {
            expect((await s.api("GET", path)).status, path).toBe(404);
        }
    });
});
