/*
 * The review page's pictures and images in Chromium, counted at the server: each is asked for once
 * by its content-addressed address and then answered by the browser's cache, so showing a list or
 * an item again asks the server for nothing.
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
    await page?.close();
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
 * Serves `w` as pull request #123, counting what the server answers under /api/pic and /api/blob,
 * and opens the page on its targets screen.
 * @param {object} r the repository
 * @param {object} w the fake GitHub
 * @param {{ width: number, height: number }} viewport the tab's size
 */
async function open(r, w, viewport) {
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
    // Not interceptedPage: Playwright turns the browser's cache off while it intercepts requests.
    page = await browser.newPage({ viewport });
    page.setDefaultTimeout(0);
    await page.goto(`${s.origin}/#token=${TOKEN}`);
}

// Opens the first project with something to review, from the targets screen.
async function review() {
    await page.getByRole("button", { name: "Review", exact: true }).first().click();
    await page.locator(".component, .cluster").first().waitFor();
}

// Every tile on the screen shows its picture; resolves to how many tiles were given one, and how
// many are on the screen. Tiles load as they come into view, so the rest are not asked for yet.
const shownOnScreen = async () => {
    const shown = await page.waitForFunction(() => {
        const tiles = [...globalThis.document.querySelectorAll(".tile")];
        const onScreen = tiles.filter((t) => {
            const box = t.getBoundingClientRect();
            return t.checkVisibility() && box.bottom > 0 && box.top < globalThis.innerHeight;
        });
        const ready = onScreen.every((t) => {
            const img = t.querySelector("img");
            return img && !img.hidden && img.complete && img.naturalWidth > 0;
        });
        return (
            onScreen.length > 0 &&
            ready && { given: tiles.filter((t) => t.querySelector("img[src]")).length, onScreen: onScreen.length }
        );
    });
    return shown.jsonValue();
};

const pictures = () => answered.filter((a) => a.path.startsWith("/api/pic/"));
const images = () => answered.filter((a) => a.path.startsWith("/api/blob/"));

describe("review page: pictures and images by their content", () => {
    it("asks once for each tile's picture, and for none when the list is shown again", async () => {
        const r = makeRepo();
        const w = world(r);
        const dir = tempDir("vr-pictures-");
        const items = [];
        const files = {};
        for (let n = 0; n < 30; n++) {
            // Four stories a component: each component is one row of tiles.
            const id = `c${Math.floor(n / 4)}--s${n}`;
            const file = `${id}.png`;
            const [a, b] = [png(n, false), png(n, true)];
            writeFileSync(join(dir, `a${n}.png`), a);
            writeFileSync(join(dir, `b${n}.png`), b);
            items.push({ ...BUTTON, id, mode: null, file, baseline: sha256(a), capture: sha256(b) });
            files[file] = join(dir, `b${n}.png`);
            files[`baselines/${file}`] = join(dir, `a${n}.png`);
        }
        w.data.results["visual-compact-mantine-1"] = { items, expected: items.length };
        w.data.files["visual-compact-mantine-1"] = files;
        // Tall enough for 30 rows of tiles.
        await open(r, w, { width: 1000, height: 9000 });
        await review();
        // The 30 changes look alike, so they show as one group: show each as its own tile.
        await page.locator("#group-similar").click();
        await expect.poll(() => page.locator("#group-similar").getAttribute("aria-pressed")).toBe("false");
        const { given, onScreen } = await shownOnScreen();
        // Every tile on the screen asked once for its picture, and no more were asked.
        expect(onScreen).toBeGreaterThanOrEqual(30);
        expect(given).toBe(onScreen);
        const first = pictures();
        expect(first.map((a) => a.status)).toEqual(Array(given).fill(200));
        expect(new Set(first.map((a) => a.path)).size).toBe(given);
        // The full images are fetched only for a story.
        expect(images()).toEqual([]);
        // Back to the targets, and the same list again: the browser has every picture.
        await page.locator("#home").click();
        await page.locator(".card").first().waitFor();
        await review();
        expect(await shownOnScreen()).toEqual({ given, onScreen });
        expect(pictures()).toEqual(first);
    });

    it("asks only for the pictures on or near the screen of a list of 300 snapshots", async () => {
        const r = makeRepo();
        const w = world(r);
        const dir = tempDir("vr-pictures-");
        const items = [];
        const files = {};
        for (let n = 0; n < 300; n++) {
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
                threshold: n / 1000,
            });
            files[file] = join(dir, `b${n}.png`);
            files[`baselines/${file}`] = join(dir, `a${n}.png`);
        }
        w.data.results["visual-compact-mantine-1"] = { items, expected: items.length };
        w.data.files["visual-compact-mantine-1"] = files;
        await open(r, w, { width: 1000, height: 800 });
        await review();
        await page.locator("#group-similar").click();
        await expect.poll(() => page.locator("#group-similar").getAttribute("aria-pressed")).toBe("false");
        const { onScreen } = await shownOnScreen();
        // The tiles on the screen, and the few the page started on as they came near: each asked
        // for once, in at most 0.6 MB, and nowhere near all 300.
        expect(onScreen).toBeGreaterThan(0);
        expect(pictures().length).toBeGreaterThanOrEqual(onScreen);
        expect(pictures().length).toBeLessThan(30);
        expect(new Set(pictures().map((p) => p.path)).size).toBe(pictures().length);
        expect(pictures().reduce((sum, p) => sum + p.bytes, 0)).toBeLessThanOrEqual(600_000);
        expect(images()).toEqual([]);
    });

    it("sends at most 0.1 MB of pictures for a list of a few snapshots, and each image of an item once", async () => {
        const r = makeRepo();
        // Tall enough for every tile.
        await open(r, world(r), { width: 1000, height: 2400 });
        await review();
        // The five stories to decide that have an image.
        expect(await shownOnScreen()).toEqual({ given: 5, onScreen: 5 });
        expect(pictures()).toHaveLength(5);
        expect(pictures().reduce((sum, a) => sum + a.bytes, 0)).toBeLessThanOrEqual(100_000);
        // Item 2 (the changed button), on to item 3 and back: its two images were asked for once.
        await page.locator("#find").fill("2");
        await page.locator("#find").press("Enter");
        await page.locator('#stage img[alt^="new image of"]').waitFor();
        await page.keyboard.press("k");
        await expect.poll(() => page.locator(".itemline .number").textContent()).toBe("#3");
        await page.locator('#stage img[alt^="new image of slider"]').waitFor();
        await page.keyboard.press("j");
        await expect.poll(() => page.locator(".itemline .number").textContent()).toBe("#2");
        await page.locator('#stage img[alt^="new image of button"]').waitFor();
        const button = images().filter((a) => [BUTTON.baseline, BUTTON.capture].some((h) => a.path.endsWith(h)));
        expect(button.map((a) => a.path).sort()).toEqual(
            [`/api/blob/${BUTTON.baseline}`, `/api/blob/${BUTTON.capture}`].sort(),
        );
    });
});
