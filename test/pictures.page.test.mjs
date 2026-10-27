/*
 * The review page's pictures and images in Chromium, counted at the server: each is asked for once
 * by its content-addressed address and then answered by the browser's cache, so showing a change's
 * list again asks the server for nothing, and a list screen stays within its network budget.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sha256 } from "../trusted/lib/compare.mjs";
import { startApp, world } from "./faults.mjs";
import { FIXTURE, isolateGit, makeRepo, tempDir } from "./helpers.mjs";

const TOKEN = "q".repeat(43);
const CM_ITEMS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items;
const BUTTON = CM_ITEMS.find((i) => i.file === "button--primary.dark.png");

let browser;
let s;
let page;
// Every picture and image request the server answered, with the bytes it sent.
let answered;

beforeAll(async () => {
    isolateGit();
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterAll(() => browser?.close());
afterEach(async () => {
    await page?.context().close();
    page = null;
    await s?.close();
    s = null;
});

/**
 * A PNG of one color, with a red square when `mark` is set.
 * @param {number} n which color
 * @param {boolean} mark draw the square
 * @returns {Buffer} the PNG
 */
function png(n, mark) {
    const img = new PNG({ width: 40, height: 30 });
    for (let y = 0; y < 30; y++) {
        for (let x = 0; x < 40; x++) {
            const red = mark && x >= 10 && x < 15 && y >= 10 && y < 15;
            img.data.set(red ? [255, 0, 0, 255] : [n * 8, 100, 200, 255], (y * 40 + x) * 4);
        }
    }
    return PNG.sync.write(img);
}

/**
 * Gives `w`'s compact-mantine capture `count` changed snapshots, four to a component.
 * @param {object} w the fake GitHub
 * @param {number} count how many
 */
function snapshots(w, count) {
    const dir = tempDir("vr-pictures-");
    const items = [];
    const files = {};
    for (let n = 0; n < count; n++) {
        const id = `c${Math.floor(n / 4)}--s${n}`;
        const file = `${id}.png`;
        const [a, b] = [png(n % 32, false), png(n % 32, true)];
        writeFileSync(join(dir, `a${n}.png`), a);
        writeFileSync(join(dir, `b${n}.png`), b);
        // Each snapshot its own settings, so no two share a picture's name.
        items.push({
            ...BUTTON,
            id,
            mode: null,
            file,
            baseline: sha256(a),
            capture: sha256(b),
            threshold: n / 10000,
        });
        files[file] = join(dir, `b${n}.png`);
        files[`baselines/${file}`] = join(dir, `a${n}.png`);
    }
    w.data.results["visual-compact-mantine-1"] = { items, expected: items.length };
    w.data.files["visual-compact-mantine-1"] = files;
}

/**
 * Serves `w` as pull request #123, counting what the server answers under /api/pic and /api/blob,
 * and opens a tab of the page, not yet on any address.
 * @param {object} r the repository
 * @param {object} w the fake GitHub
 * @param {{ width: number, height: number }} viewport the tab's size
 */
async function serve(r, w, viewport) {
    s = await startApp(r, { gh: w.gh, token: TOKEN });
    answered = [];
    s.server.on("request", (req, res) => {
        if (!/^\/api\/(pic|blob)\//.test(req.url)) {
            return;
        }
        let bytes = 0;
        const end = res.end.bind(res);
        res.end = (chunk, ...rest) => {
            bytes += chunk ? Buffer.byteLength(chunk) : 0;
            return end(chunk, ...rest);
        };
        res.on("finish", () => answered.push({ path: req.url, status: res.statusCode, bytes }));
    });
    // Not a page that intercepts every request: Playwright turns the browser's cache off then.
    const context = await browser.newContext({ viewport });
    page = await context.newPage();
    page.setDefaultTimeout(0);
}

// Opens change #123 at one compact-mantine snapshot, and waits for its rows: a small change opens
// with its Snapshots pane as a rail, shown with its key.
async function visit(file) {
    await page.goto(`${s.origin}/#token=${TOKEN}&change=123&snap=${encodeURIComponent(`compact-mantine/${file}`)}`);
    await page.locator("#snap-list .srow.cur").waitFor({ state: "attached" });
    if ((await page.locator("#snaps").getAttribute("class")).includes("rail")) {
        await page.keyboard.press("Shift+Digit2");
    }
    await page.locator("#snap-list .srow").first().waitFor();
}

// Every row on the list's screen that has a picture (a story that did not render has none) shows
// it; resolves to how many rows were given one, and how many of those are on the screen. Rows draw
// their pictures as they come near the screen.
const shownOnScreen = async () => {
    const shown = await page.waitForFunction(() => {
        const list = globalThis.document.getElementById("snap-list").getBoundingClientRect();
        const rows = [...globalThis.document.querySelectorAll("#snap-list .srow")].filter((row) =>
            row.querySelector(".pic img"),
        );
        const onScreen = rows.filter((row) => {
            const box = row.getBoundingClientRect();
            return box.height > 0 && box.bottom > list.top && box.top < list.bottom;
        });
        const ready = onScreen.every((row) => {
            const img = row.querySelector(".pic img");
            return img.complete && img.naturalWidth > 0;
        });
        return (
            onScreen.length > 0 &&
            ready && {
                given: rows.length,
                onScreen: onScreen.length,
            }
        );
    });
    return shown.jsonValue();
};

const pictures = () => answered.filter((a) => a.path.startsWith("/api/pic/"));
const images = () => answered.filter((a) => a.path.startsWith("/api/blob/"));
const current = () => page.locator("#snap-list .srow.cur").getAttribute("data-snap");

describe("review page: pictures and images by their content", () => {
    it("asks once for each row's picture, and for none when the list is shown again", async () => {
        const r = makeRepo();
        const w = world(r);
        snapshots(w, 30);
        // Tall enough for 30 rows.
        await serve(r, w, { width: 1440, height: 4000 });
        await visit("c0--s0.png");
        const { given, onScreen } = await shownOnScreen();
        // Every row on the screen asked once for its picture, and no more were asked.
        expect(onScreen).toBeGreaterThanOrEqual(30);
        expect(given).toBe(onScreen);
        const first = pictures();
        expect(first.map((a) => a.status)).toEqual(Array(given).fill(200));
        expect(new Set(first.map((a) => a.path)).size).toBe(given);
        // The same list again: the browser has every picture.
        await page.goto("about:blank");
        await visit("c0--s0.png");
        expect(await shownOnScreen()).toEqual({ given, onScreen });
        expect(pictures()).toEqual(first);
    });

    it.each([300, 3000])(
        "asks only for the pictures on or near the screen of a list of %i snapshots",
        async (count) => {
            const r = makeRepo();
            const w = world(r);
            snapshots(w, count);
            await serve(r, w, { width: 1440, height: 900 });
            await visit("c0--s0.png");
            const { onScreen } = await shownOnScreen();
            // The rows on the screen, and the few the page started on as they came near: each asked
            // for once, in at most 0.6 MB, and at most 30 of them.
            expect(onScreen).toBeGreaterThan(0);
            expect(pictures().length).toBeGreaterThanOrEqual(onScreen);
            expect(pictures().length).toBeLessThanOrEqual(30);
            expect(new Set(pictures().map((p) => p.path)).size).toBe(pictures().length);
            expect(pictures().reduce((sum, p) => sum + p.bytes, 0)).toBeLessThanOrEqual(600_000);
        },
    );

    it("signs in again for no failed picture, and asks for a picture again on Retry", async () => {
        const r = makeRepo();
        const w = world(r);
        snapshots(w, 20);
        await serve(r, w, { width: 1440, height: 2400 });
        const posts = [];
        page.on("request", (req) => req.url().endsWith("/api/session") && posts.push(req.method()));
        const failing = (route) => route.fulfill({ status: 404, body: "{}" });
        await page.route("**/api/pic/**", failing);
        await visit("c0--s0.png");
        // Every row asked for has failed and offers Retry.
        const retry = page.locator("#snap-list .srow .pic").getByRole("button", { name: "Retry" });
        await expect.poll(() => retry.count()).toBeGreaterThan(12);
        // Only the page's first sign-in: the list's own requests showed the cookie good.
        expect(posts).toEqual(["POST"]);
        const asked = [];
        page.on("request", (req) => req.url().includes("/api/pic/") && asked.push(new URL(req.url()).search));
        await page.unroute("**/api/pic/**", failing);
        await retry.first().click();
        await expect.poll(() => page.locator("#snap-list .srow .pic.ready").count()).toBe(1);
        expect(asked).toEqual(["?try=1"]);
        expect(posts).toEqual(["POST"]);
    });

    it("sends at most 0.1 MB of pictures for a list of a few snapshots, and each image of a snapshot once", async () => {
        const r = makeRepo();
        // Tall enough for every row.
        await serve(r, world(r), { width: 1440, height: 2400 });
        await visit(BUTTON.file);
        const { given } = await shownOnScreen();
        expect(pictures()).toHaveLength(given);
        expect(pictures().reduce((sum, a) => sum + a.bytes, 0)).toBeLessThanOrEqual(100_000);
        // The changed button, on to the next snapshot and back: its two images were asked for once.
        await expect.poll(current).toBe(`compact-mantine/${BUTTON.file}`);
        await page.locator("#stage img").first().waitFor();
        await page.keyboard.press("ArrowRight");
        await expect.poll(current).not.toBe(`compact-mantine/${BUTTON.file}`);
        await page.keyboard.press("ArrowLeft");
        await expect.poll(current).toBe(`compact-mantine/${BUTTON.file}`);
        await page.locator("#stage img").first().waitFor();
        const button = images().filter((a) => [BUTTON.baseline, BUTTON.capture].some((h) => a.path.endsWith(h)));
        expect(button.map((a) => a.path).sort()).toEqual(
            [`/api/blob/${BUTTON.baseline}`, `/api/blob/${BUTTON.capture}`].sort(),
        );
    });
});
