/*
 * The viewer's modules in Chromium: the diff worked out in a worker gives the same changed pixels
 * as on the page's thread; moving on to a snapshot whose diff was worked out ahead draws it with no
 * new diff, and only the worker imports pixelmatch. Also the server side: the viewer's files,
 * the new page's folder at /next/, and `serve --ui next`.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startApp } from "./faults.mjs";
import { FIXTURE, isolateGit, makeRepo, onePr } from "./helpers.mjs";

const TOKEN = "w".repeat(43);
const CLI = new URL("../trusted/cli.mjs", import.meta.url).pathname;
const CM = join(FIXTURE, "compact-mantine");
const CM_ITEMS = JSON.parse(readFileSync(join(CM, "results.json"), "utf8")).items;
const settingsOf = (file) => {
    const { threshold, includeAA } = CM_ITEMS.find((i) => i.file === file);
    return { threshold, includeAA };
};
// Four real pairs of the fixture: three baselines with their captures, and one capture with its
// second shot.
const PAIRS = [
    ["baselines/button--primary.dark.png", "button--primary.dark.png"],
    ["baselines/slider--sizes.png", "slider--sizes.png"],
    ["baselines/tooltip--hover.png", "tooltip--hover.png"],
    ["tooltip--hover.png", "second/tooltip--hover.png"],
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
    s = await startApp(r, { gh: onePr()(r), token: TOKEN, ...options });
    return s;
}

describe("the server", () => {
    it("serves the viewer's modules and the new page's folder at /next/", async () => {
        await serve();
        const get = (path) => fetch(`${s.origin}${path}`, { redirect: "manual" });
        for (const path of ["/viewer/stage.js", "/viewer/diff-worker.js", "/viewer/prefetch.js"]) {
            const res = await get(path);
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        }
        const next = await get("/next/");
        expect(next.status).toBe(200);
        expect(next.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await (await get("/next/index.html")).text()).toBe(await next.text());
        const bare = await get("/next");
        expect(bare.status).toBe(301);
        expect(bare.headers.get("location")).toBe("/next/");
        // Today's page stays the page at /, and the folder serves only its own plain file names.
        expect(await (await get("/")).text()).toContain('src="review.js"');
        for (const path of [
            "/next/missing.js",
            "/next/%2e%2e%2freview.js",
            "/next/sub/index.html",
            "/next/.hidden.js",
        ]) {
            expect((await get(path)).status, path).toBe(404);
        }
    });

    it("serves the new page at / with ui next", async () => {
        await serve({ ui: "next" });
        const root = await fetch(`${s.origin}/`);
        expect(await root.text()).toBe(await (await fetch(`${s.origin}/next/`)).text());
    });

    it("refuses an unknown --ui before starting", () => {
        const run = spawnSync(process.execPath, [CLI, "serve", "--ui", "old"], {
            env: { ...process.env, PORT: "1" },
            encoding: "utf8",
        });
        expect(run.status).toBe(2);
        expect(run.stderr).toContain("--ui next");
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
        await page.goto(`${s.origin}/next/`);
        await expose(["/viewer/stage.js", "/pixelmatch.mjs", "/spot.js"]);
        for (const [a, b] of PAIRS) {
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
            if (!a.includes("tooltip")) {
                expect(got.changed, b).toBeGreaterThan(0);
            }
        }
    });
});

describe("prefetch", () => {
    it("draws the next snapshot after K with no new diff", async () => {
        await serve();
        page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
        page.setDefaultTimeout(0);
        await page.goto(`${s.origin}/#token=${TOKEN}`);
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await page.locator(".component").first().waitFor();
        // The page's own copy of the module: the same address, so the same counts.
        await expose(["/viewer/stage.js"]);
        const counts = () => page.evaluate(() => ({ ...globalThis.modules["/viewer/stage.js"].diffCounts }));
        // Item #2 (button--primary.dark, changed) from the grid's Find: a cold open, one diff.
        await page.locator("#find").fill("2");
        await page.keyboard.press("Enter");
        await expect.poll(() => page.locator(".itemline .number").textContent()).toBe("#2");
        await expect.poll(() => page.locator("#box-count").textContent()).toBe("1 of 1");
        expect((await counts()).waited).toBe(1);
        // Its next one, slider--sizes, is worked out ahead: wait until the worker has answered all.
        await page.waitForFunction(() => {
            const { diffCounts } = globalThis.modules["/viewer/stage.js"];
            return diffCounts.done === diffCounts.worker && diffCounts.worker >= 2;
        });
        const before = await counts();
        await page.keyboard.press("k");
        await expect.poll(() => page.locator(".itemline .number").textContent()).toBe("#3");
        await expect.poll(() => page.locator("#stage").getAttribute("data-file")).toBe("slider--sizes.png");
        await expect.poll(() => page.locator("#box-count").textContent()).toMatch(/^1 of \d+$/);
        // Highlight draws from the same diff: still none waited for.
        await page.keyboard.press("h");
        await page.locator("#stage .diffmark").first().waitFor();
        expect((await counts()).waited).toBe(before.waited);
    });

    it("leaves no diff code on the page's thread: only the worker imports pixelmatch", () => {
        const PAGE = new URL("../trusted/page/", import.meta.url).pathname;
        const importers = readdirSync(PAGE, { recursive: true })
            .filter((f) => f.endsWith(".js"))
            .filter((f) => /from "\/pixelmatch\.mjs"/.test(readFileSync(join(PAGE, f), "utf8")));
        expect(importers).toEqual(["viewer/diff-worker.js"]);
    });
});
