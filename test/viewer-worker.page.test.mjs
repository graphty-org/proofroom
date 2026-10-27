/*
 * The viewer's modules in Chromium: the diff worked out in a worker gives the same changed pixels
 * as on the page's thread, and only the worker imports pixelmatch. Also the server side: the page's files at /,
 * and /next/, where the page was before 1.0.0, sent to /.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startApp } from "./faults.mjs";
import { onePrFakes } from "./fakes/adapters.mjs";
import { FIXTURE, isolateGit, makeRepo } from "./helpers.mjs";

const TOKEN = "w".repeat(43);
const CLI = new URL("../trusted/cli.mjs", import.meta.url).pathname;
const CM = join(FIXTURE, "compact-mantine");
const CM_ITEMS = JSON.parse(readFileSync(join(CM, "results.json"), "utf8")).items;
const settingsOf = (file) => {
    const { threshold, includeAA } = CM_ITEMS.find((i) => i.file === file);
    return { threshold, includeAA };
};
// Four real pairs of the fixture, with their changed pixels: three baselines with their captures
// (as results.json records them), and one capture with its second shot.
// tooltip--hover's two shots differ (it is unstable); results.json does not record by how much.
const SECOND_SHOT_CHANGED = 1392;
const changedOf = (file) => CM_ITEMS.find((i) => i.file === file).changedPixels;
const PAIRS = [
    ["baselines/button--primary.dark.png", "button--primary.dark.png", changedOf("button--primary.dark.png")],
    ["baselines/slider--sizes.png", "slider--sizes.png", changedOf("slider--sizes.png")],
    ["baselines/tooltip--hover.png", "tooltip--hover.png", changedOf("tooltip--hover.png")],
    ["tooltip--hover.png", "second/tooltip--hover.png", SECOND_SHOT_CHANGED],
];

let browser;
let s;
let page;

beforeAll(async () => {
    isolateGit();
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterAll(() => browser?.close());
afterEach(async () => {
    await page?.close();
    page = null;
    await s?.close();
    s = null;
});

// Puts the page's modules named in `urls` on globalThis.modules by their address. The import is
// sent as text: the test file's own dynamic imports are rewritten for Node by vitest.
const expose = (urls) =>
    page.evaluate(
        `Promise.all(${JSON.stringify(urls)}.map((u) => import(u))).then((ms) => { ` +
            `globalThis.modules = Object.fromEntries(ms.map((m, i) => [${JSON.stringify(urls)}[i], m])); })`,
    );

async function serve(options = {}) {
    const r = makeRepo();
    s = await startApp(r, { ...onePrFakes()(r), token: TOKEN, ...options });
    return s;
}

describe("the server", () => {
    it("serves the page at /, its folder's plain file names, and sends /next/ to /", async () => {
        await serve();
        const get = (path) => fetch(`${s.origin}${path}`, { redirect: "manual" });
        for (const path of ["/viewer/stage.js", "/viewer/diff-worker.js", "/viewer/prefetch.js", "/app.js"]) {
            const res = await get(path);
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        }
        const root = await get("/");
        expect(root.status).toBe(200);
        expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8");
        const html = await root.text();
        expect(html).toContain('src="/app.js"');
        expect(await (await get("/index.html")).text()).toBe(html);
        expect((await get("/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json");
        // Where the page was before 1.0.0: a link posted then opens the page at /.
        for (const path of ["/next", "/next/"]) {
            const old = await get(path);
            expect(old.status, path).toBe(301);
            expect(old.headers.get("location"), path).toBe("/");
        }
        // The page before 1.0.0 is gone, and the folder serves only its own plain file names.
        for (const path of [
            "/review.js",
            "/review.css",
            "/missing.js",
            "/%2e%2e%2fgate.mjs",
            "/sub/index.html",
            "/.hidden.js",
        ]) {
            expect((await get(path)).status, path).toBe(404);
        }
    });

    it("has no --ui option: there is one page", () => {
        const run = spawnSync(process.execPath, [CLI, "serve", "--ui", "next"], {
            env: { ...process.env, PORT: "1" },
            encoding: "utf8",
        });
        expect(run.status).toBe(2);
        expect(run.stderr).toContain("Unknown option '--ui'");
    });
});

describe("the diff worker", () => {
    it("gives the same changed pixels as the page's thread, for four real pairs", async () => {
        await serve();
        page = await browser.newPage();
        page.setDefaultTimeout(0);
        await page.route("**/fixture/**", (route) =>
            route.fulfill({
                contentType: "image/png",
                body: readFileSync(join(CM, decodeURIComponent(new URL(route.request().url()).pathname.slice(9)))),
            }),
        );
        await page.goto(`${s.origin}/`);
        await expose(["/viewer/stage.js", "/pixelmatch.mjs", "/spot.js"]);
        for (const [a, b, changed] of PAIRS) {
            const got = await page.evaluate(
                async ([first, second, settings]) => {
                    const { modules } = globalThis;
                    const { diffImages, diffCounts } = modules["/viewer/stage.js"];
                    const pixelmatch = modules["/pixelmatch.mjs"].default;
                    const { grow, regions } = modules["/spot.js"];
                    const load = (name) =>
                        new Promise((resolve, reject) => {
                            const img = new globalThis.Image();
                            img.onload = () => resolve(img);
                            img.onerror = reject;
                            img.src = `/fixture/${encodeURIComponent(name)}`;
                        });
                    const [ia, ib] = await Promise.all([load(first), load(second)]);
                    const before = diffCounts.worker;
                    const off = await diffImages(ia, ib, settings);
                    // As the page worked it out before the worker: on its own thread.
                    const [w, h] = [
                        Math.max(ia.naturalWidth, ib.naturalWidth),
                        Math.max(ia.naturalHeight, ib.naturalHeight),
                    ];
                    const pixels = (img) => {
                        const ctx = new globalThis.OffscreenCanvas(w, h).getContext("2d");
                        ctx.drawImage(img, 0, 0);
                        return ctx.getImageData(0, 0, w, h).data;
                    };
                    const [pa, pb] = [pixels(ia), pixels(ib)];
                    const mask = new Uint8ClampedArray(w * h * 4);
                    pixelmatch(pa, pb, mask, w, h, { ...settings, diffMask: true });
                    const grown = grow(mask, w, h);
                    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
                    return {
                        size: [off.w, off.h, w, h],
                        mask: same(off.mask, mask),
                        grown: same(off.grown, grown),
                        pixels: same(off.a, pa) && same(off.b, pb),
                        changed: mask.filter((v, i) => i % 4 === 3 && v !== 0).length,
                        boxes: [off.boxes, regions(grown, w, h)],
                        inWorker: diffCounts.worker - before,
                    };
                },
                [a, b, settingsOf(b.replace(/^.*\//, ""))],
            );
            expect(got.size.slice(0, 2), b).toEqual(got.size.slice(2));
            expect(got.mask, b).toBe(true);
            expect(got.grown, b).toBe(true);
            expect(got.pixels, b).toBe(true);
            expect(got.boxes[0], b).toEqual(got.boxes[1]);
            expect(got.inWorker, b).toBe(1);
            expect(got.changed, b).toBe(changed);
        }
    });
});

describe("the page's thread", () => {
    it("leaves no diff code on the page's thread: only the worker imports pixelmatch", () => {
        const PAGE = new URL("../trusted/page/", import.meta.url).pathname;
        const importers = readdirSync(PAGE, { recursive: true })
            .filter((f) => f.endsWith(".js"))
            .filter((f) => /from "\/pixelmatch\.mjs"/.test(readFileSync(join(PAGE, f), "utf8")));
        expect(importers).toEqual(["viewer/diff-worker.js"]);
    });
});
