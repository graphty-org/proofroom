import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { pinFixedInPage } from "../capture/capture.mjs";
import { visualStoryTest } from "../capture/story-test.mjs";
import { validateResults } from "../trusted/lib/results.mjs";

import { tempDir } from "./helpers.mjs";
import { context, png, read, report, repo } from "./story-test-fakes.mjs";

describe("story tests' visual step", () => {
    it("launches Chromium with FC_FONTATIONS preset, whatever the caller's environment (#3787)", () => {
        const saved = process.env.FC_FONTATIONS;
        delete process.env.FC_FONTATIONS;
        try {
            const v = visualStoryTest({ project: "graphty-element", out: tempDir("story-test-out-"), root: repo({}) });
            expect(v.providerOptions.launchOptions.env).toMatchObject({ FC_FONTATIONS: "1", TZ: "UTC" });
        } finally {
            if (saved !== undefined) process.env.FC_FONTATIONS = saved;
        }
    });

    it("shoots a story taller than the viewport in scrolled tiles, keeping its layout at the viewport", async () => {
        const root = repo({});
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: "graphty-element", out, root });
        // 905 CSS px tall: the second tile is the document scrolled to its end (5 px), whose last
        // 5 px (10 device rows) are the rows below the first tile.
        const tiles = [png(10, 2400, 1800), png(20, 2400, 1800)];
        const ctx = context([...tiles, ...tiles], { width: 1200, height: 905 });
        await v.commands.visualPlan(ctx, { id: "a--tall", chromatic: {} });
        const first = await v.commands.visualShot(ctx, { id: "a--tall", mode: null, chromatic: {}, console: [] });
        expect(first.again).toBe(true);
        expect(await v.commands.visualShot(ctx, { id: "a--tall", mode: null, chromatic: {}, console: [] })).toEqual({
            status: "new",
        });
        const shot = PNG.sync.read(readFileSync(join(out, "a--tall.png")));
        expect([shot.width, shot.height]).toEqual([2400, 1810]);
        const gray = (y) => shot.data[y * 2400 * 4];
        expect([gray(0), gray(1799), gray(1800), gray(1809)]).toEqual([10, 10, 20, 20]);
        // The second tile is shot only for the 5 rows it adds, and Chromium stitches the tiles, so this
        // process never decodes or encodes a PNG: that work, on the one Node thread all four capture
        // workers share, made the graph-io-fidelity capture twice as slow (#3980).
        const viewport = { x: 0, y: 0, width: 1200, height: 900 };
        expect(ctx.clips).toEqual([
            viewport,
            { x: 0, y: 895, width: 1200, height: 5 },
            viewport,
            { ...viewport, y: 895, height: 5 },
        ]);
        expect(ctx.pages.map((html) => html.match(/<img /g).length)).toEqual([2, 2]);
    });

    // 1,063 CSS px tall, as graphty's CompactOverview Size Specifications: the window scrolls
    // `windowMax` px at most and the body scrolls the rest of the way to the end (163 px), whose
    // last 163 px are the rows below the first tile. A fixed toast pinned at document row 1,000
    // must follow the body's scroll, since its containing block does not.
    it.each([
        { name: "the window cannot scroll (html and body overflow: hidden, height: 100%)", windowMax: 0, short: 0 },
        { name: "the window scrolls 16 px (the body's margin) and the body the rest", windowMax: 16, short: 0 },
        // The body stops 63 px short of the measured end: the rows it never shows stay empty, and the
        // tile's clip never reads past the screenshot (it threw "bitblt reading outside image").
        { name: "the body stops 63 px short of the measured size", windowMax: 0, short: 63 },
    ])("scrolls the body by what the window could not when $name", async ({ windowMax, short }) => {
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: "graphty-element", out, root: repo({}) });
        // Short, a third tile would find the frame where the second left it, and nothing more to
        // copy: it is never shot.
        const tiles = [png(10, 2400, 1800), png(20, 2400, 1800)];
        const ctx = context([...tiles, ...tiles], { width: 1200, height: 1063 });
        const frame = await ctx.frame();
        const measured = frame.evaluate;
        const win = { scrollX: 0, scrollY: 0 };
        const body = { scrollLeft: 0, scrollTop: 0 };
        body.scrollTo = (x, y) =>
            Object.assign(body, {
                scrollLeft: Math.max(0, x),
                scrollTop: Math.max(0, Math.min(y, 163 - windowMax - short)),
            });
        // Absolute against the initial containing block: the window's scroll moves it, the body's does not.
        const toast = { style: { top: "1000px", left: "8px", setProperty: (n, value) => (toast.style[n] = value) } };
        toast.getBoundingClientRect = () => ({
            top: parseFloat(toast.style.top) - win.scrollY,
            left: parseFloat(toast.style.left) - win.scrollX,
        });
        const toastTops = [];
        frame.evaluate = async (fn, arg) => {
            if (!fn.toString().includes("scrollTo")) {
                return measured(fn, arg);
            }
            Object.assign(globalThis, {
                scrollTo: (_x, y) => Object.assign(win, { scrollX: 0, scrollY: Math.max(0, Math.min(y, windowMax)) }),
                document: { body },
                __visualReviewPinned: [[toast, "", 1000, 8]],
            });
            Object.defineProperties(globalThis, {
                scrollX: { get: () => win.scrollX, configurable: true },
                scrollY: { get: () => win.scrollY, configurable: true },
            });
            try {
                const at = fn(arg);
                // Where the toast shows in the document the tile draws: its viewport top plus the scroll.
                toastTops.push(toast.getBoundingClientRect().top + at.y);
                return at;
            } finally {
                for (const name of ["scrollTo", "document", "__visualReviewPinned", "scrollX", "scrollY"]) {
                    delete globalThis[name];
                }
            }
        };
        await v.commands.visualPlan(ctx, { id: "a--app-css", chromatic: {} });
        const shoot = () => v.commands.visualShot(ctx, { id: "a--app-css", mode: null, chromatic: {}, console: [] });
        expect(await shoot()).toEqual({ again: true });
        expect(await shoot()).toEqual({ status: "new" });
        const shot = PNG.sync.read(readFileSync(join(out, "a--app-css.png")));
        expect([shot.width, shot.height]).toEqual([2400, 2126]);
        const gray = (y) => shot.data[y * 2400 * 4];
        const end = 2 * (1063 - short);
        expect([gray(0), gray(1799), gray(1800), gray(end - 1), gray(2125)]).toEqual([10, 10, 20, 20, short ? 0 : 20]);
        expect(new Set(toastTops)).toEqual(new Set([1000]));
    });

    it("records unchanged, changed (after a second render), unstable and failed stories as capture.mjs does", async () => {
        const root = repo({ "a--same.png": png(10), "a--moves.png": png(10), "a--wobbles.png": png(10) });
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: "graphty-element", out, root });
        const shoot = async (id, shots) => {
            const ctx = context(shots);
            await v.commands.visualPlan(ctx, { id, chromatic: {} });
            const first = await v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: ["log: one"] });
            return first.again ? v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] }) : first;
        };

        expect(await shoot("a--same", [png(10)])).toEqual({ status: "unchanged" });
        expect(await shoot("a--moves", [png(200), png(200)])).toEqual({ status: "changed" });
        expect(await shoot("a--wobbles", [png(200), png(100)])).toEqual({ status: "unstable" });
        expect(await shoot("a--fresh", [png(50), png(50)])).toEqual({ status: "new" });
        await v.commands.visualPlan(context([]), { id: "a--broken", chromatic: {} });
        await v.commands.visualFail(context([]), { id: "a--broken", modes: [null], reason: "play threw", console: [] });
        // An excluded story is not shot, but the page still waits for it to finish, so its late
        // console lines cannot fail the story after it.
        expect(
            await v.commands.visualPlan(context([]), { id: "a--off", chromatic: { disableSnapshot: true } }),
        ).toEqual({ modes: [], waitFor: expect.objectContaining({ method: "waitForStableFrame" }), delay: 0 });

        await report(v, root, {
            files: ["a.stories.ts", "b.stories.ts", "c.stories.ts", "d.stories.ts"],
            ran: {
                "a.stories.ts": ["a--same", "a--moves", "a--wobbles", "a--fresh", "a--broken", "a--off"],
                "c.stories.ts": [],
                // Docs only: no story test, which vitest reports as a skipped file.
                "d.stories.ts": [],
            },
            broken: ["c.stories.ts"],
        });
        const r = read(out);
        // Never complete on its own: only merge-results makes a capture the gate takes.
        expect(r.complete).toBe(false);
        // Every story file of the project, and only those this run loaded and ran (not the broken one;
        // the docs-only one loaded).
        expect(r.partial).toEqual({
            shard: { index: 1, count: 1 },
            reported: true,
            missing: [],
            files: ["a.stories.ts", "b.stories.ts", "c.stories.ts", "d.stories.ts"],
            ran: ["a.stories.ts", "d.stories.ts"],
        });
        expect(validateResults(r)).toEqual([]);
        expect(Object.fromEntries(r.items.map((i) => [i.id, i.status]))).toEqual({
            "a--broken": "failed",
            "a--fresh": "new",
            "a--moves": "changed",
            "a--off": "excluded",
            "a--same": "unchanged",
            "a--wobbles": "unstable",
        });
        // The images the review page reads: the capture, the second of an unstable one, the baseline.
        expect(readFileSync(join(out, "a--moves.png"))).toEqual(png(200));
        expect(readFileSync(join(out, "second/a--wobbles.png"))).toEqual(png(100));
        expect(readFileSync(join(out, "baselines/a--moves.png"))).toEqual(png(10));
        expect(r.items.find((i) => i.id === "a--moves").console).toEqual(["log: one"]);
        expect(r.items.find((i) => i.id === "a--same").console).toEqual([]);
    });

    it("never resizes the page, and stitches a story taller than one screenshot as capture.mjs does", async () => {
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: "graphty-element", out, root: repo({}) });
        // 5,000 CSS px is 10,000 device px, over one screenshot: six tiles, encoded here, not by Chromium.
        const tile = png(50, 2400, 1800);
        const ctx = context(
            Array.from({ length: 6 }, () => tile),
            { width: 1200, height: 5000 },
        );
        await v.commands.visualPlan(ctx, { id: "a--tall", chromatic: {} });
        const first = await v.commands.visualShot(ctx, { id: "a--tall", mode: null, chromatic: {}, console: [] });
        expect(first).toEqual({ again: true });
        // A viewport taller than the GPU's largest texture leaves the tab compositing another way.
        expect(ctx.viewports).toEqual([]);
    });

    it("marks a partial unreported when a story test that ran never reached the visual step", async () => {
        const out = tempDir("story-test-out-");
        const root = repo({});
        const v = visualStoryTest({ project: "graphty-element", out, root });
        await report(v, root, { files: ["a.stories.ts"], ran: { "a.stories.ts": ["a--lost"] } });
        expect(read(out).partial).toMatchObject({ reported: false, missing: ["a--lost"] });
    });
    it("keeps the first run's items when the failed story files are run again into the same directory", async () => {
        const root = repo({ "a--same.png": png(10), "b--wobbles.png": png(10) });
        const out = tempDir("story-test-out-");
        const shoot = async (v, id, shots) => {
            const ctx = context(shots);
            await v.commands.visualPlan(ctx, { id, chromatic: {} });
            const first = await v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] });
            return first.again ? v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] }) : first;
        };
        const files = ["a.stories.ts", "b.stories.ts"];
        const first = visualStoryTest({ project: "graphty-element", out, root });
        expect(await shoot(first, "a--same", [png(10)])).toEqual({ status: "unchanged" });
        expect(await shoot(first, "b--wobbles", [png(200), png(100)])).toEqual({ status: "unstable" });
        await report(first, root, { files, ran: { "a.stories.ts": ["a--same"], "b.stories.ts": ["b--wobbles"] } });
        expect(existsSync(join(out, "second/b--wobbles.png"))).toBe(true);

        // The retry (tools/test-quarantine.mjs) runs only b.stories.ts, and this time it settles.
        const retry = visualStoryTest({ project: "graphty-element", out, root });
        expect(await shoot(retry, "b--wobbles", [png(10)])).toEqual({ status: "unchanged" });
        await report(retry, root, { files, ran: { "b.stories.ts": ["b--wobbles"] } });

        const r = read(out);
        expect(r.retried).toBe(1);
        expect(r.partial).toMatchObject({ reported: true, missing: [], ran: files });
        expect(Object.fromEntries(r.items.map((i) => [i.id, i.status]))).toEqual({
            "a--same": "unchanged",
            "b--wobbles": "unchanged",
        });
        expect(existsSync(join(out, "second/b--wobbles.png"))).toBe(false);
    });

    it("keeps a split leg's shard when its failed files are run again unsliced", async () => {
        const root = repo({ "b--wobbles.png": png(10) });
        const out = tempDir("story-test-out-");
        const shoot = async (v, shots) => {
            const ctx = context(shots);
            await v.commands.visualPlan(ctx, { id: "b--wobbles", chromatic: {} });
            const first = await v.commands.visualShot(ctx, {
                id: "b--wobbles",
                mode: null,
                chromatic: {},
                console: [],
            });
            return first.again
                ? v.commands.visualShot(ctx, { id: "b--wobbles", mode: null, chromatic: {}, console: [] })
                : first;
        };
        const files = ["a.stories.ts", "b.stories.ts"];
        const ran = { "b.stories.ts": ["b--wobbles"] };
        const first = visualStoryTest({ project: "graphty-element", out, root });
        await shoot(first, [png(200), png(100)]);
        await report(first, root, { shard: { index: 2, count: 2 }, files, ran });
        // the retry's vitest has no --shard (tools/test-select.mjs drops it from a selection)
        const retry = visualStoryTest({ project: "graphty-element", out, root });
        await shoot(retry, [png(10)]);
        await report(retry, root, { files, ran });
        const r = read(out);
        expect(r.retried).toBe(1);
        expect(r.partial.shard).toEqual({ index: 2, count: 2 });
    });
});

describe("pinFixedInPage", () => {
    it("draws a sticky element static while tiles are shot, and puts its style back", () => {
        const el = (position) => {
            const e = { position, style: { cssText: "", setProperty: (n, v) => (e.style[n] = v) } };
            e.getBoundingClientRect = () => ({ top: 0, left: 0, width: 10, height: 10 });
            e.querySelectorAll = () => [];
            return e;
        };
        const header = el("sticky");
        const plain = el("static");
        Object.assign(globalThis, {
            document: { querySelectorAll: () => [header, plain] },
            getComputedStyle: (e) => ({ position: e.position }),
        });
        try {
            pinFixedInPage(false);
            expect(header.style.position).toBe("static");
            expect(plain.style.position).toBeUndefined();
            header.style.cssText = "changed";
            pinFixedInPage(true);
            expect(header.style.cssText).toBe("");
            expect(globalThis.__visualReviewUnstuck).toBeUndefined();
        } finally {
            delete globalThis.document;
            delete globalThis.getComputedStyle;
        }
    });
});
