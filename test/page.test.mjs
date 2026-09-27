/*
 * The review page in Chromium, served from the local results fixture: zoom, hold Space to flash,
 * the keys, Accept all and what Finish asks before it commits.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../trusted/lib/serve.mjs";
import { FIXTURE, isolateGit, makeRepo } from "./helpers.mjs";

const PROJECTS = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
const TOKEN = "p".repeat(43);

let browser;
let server;
let page;
let dialogs;

beforeAll(async () => {
    isolateGit();
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterAll(() => browser?.close());

beforeEach(async () => {
    const r = makeRepo();
    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const app = createApp({
        repo: r.repo,
        tmp: join(r.repo, "tmp/visual-review"),
        projects: PROJECTS,
        token: TOKEN,
        origin,
        gh: async () => "",
        results: FIXTURE,
        branch: "feature",
    });
    server.on("request", app);
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    dialogs = [];
    // Accept all is confirmed; Finish is refused, so no test commits anything.
    page.on("dialog", (d) => {
        dialogs.push(d.message());
        return d.message().startsWith("Finish") ? d.dismiss() : d.accept();
    });
    await page.goto(`${origin}/#token=${TOKEN}`);
    await page.getByRole("button", { name: "Review", exact: true }).first().click();
    await page.locator(".tile").first().waitFor();
});
afterEach(async () => {
    await page?.close();
    server?.close();
});

// The first tile is button--primary.dark.png: changed, 320x200, box [160, 80, 40, 40].
async function openFirstStory() {
    await page.locator(".tile").first().click();
    await page.locator("#stage img").first().waitFor();
}

describe("review page", () => {
    it("Z zooms pixelated at four times and scrolls to the changed box", async () => {
        await openFirstStory();
        await page.keyboard.press("z");
        const figure = page.locator("#stage figure").first();
        await expect.poll(() => figure.evaluate((f) => f.scrollLeft)).toBeGreaterThan(0);
        const zoom = await figure.evaluate((f) => {
            const img = f.querySelector("img");
            return {
                rendering: img.ownerDocument.defaultView.getComputedStyle(img).imageRendering,
                width: img.getBoundingClientRect().width,
                natural: img.naturalWidth,
                offsetLeft: img.offsetLeft,
                offsetTop: img.offsetTop,
                left: f.scrollLeft,
                top: f.scrollTop,
                viewW: f.clientWidth,
                viewH: f.clientHeight,
            };
        });
        expect(zoom.rendering).toBe("pixelated");
        expect(zoom.width).toBe(zoom.natural * 4);
        // The box's centre (180, 100) at four times sits in the middle of the view.
        expect(Math.abs(zoom.left + zoom.viewW / 2 - (zoom.offsetLeft + 720))).toBeLessThanOrEqual(2);
        expect(Math.abs(zoom.top + zoom.viewH / 2 - (zoom.offsetTop + 400))).toBeLessThanOrEqual(2);
        await page.keyboard.press("z");
        expect(
            await page
                .locator("#stage img")
                .first()
                .evaluate((i) => i.ownerDocument.defaultView.getComputedStyle(i).imageRendering),
        ).toBe("auto");
    });

    it("flashes while Space is held and returns to the view it came from", async () => {
        await openFirstStory();
        await page.keyboard.down(" ");
        await expect.poll(() => page.locator("#stage").getAttribute("class")).toContain("flash");
        const seen = new Set();
        await expect
            .poll(async () => {
                seen.add(await page.locator("#stage .label").textContent());
                return seen.size;
            })
            .toBe(2);
        await page.keyboard.up(" ");
        await expect.poll(() => page.locator("#stage").getAttribute("class")).toContain("side");
        expect(await page.locator("#stage figure").count()).toBe(2);
    });

    it("F, H and E switch to flash, to highlight and to an exclude reason", async () => {
        await openFirstStory();
        await page.keyboard.press("f");
        await expect.poll(() => page.locator("#stage").getAttribute("class")).toContain("flash");
        await page.keyboard.press("h");
        await page.locator("#stage canvas").waitFor();
        await page.keyboard.press("e");
        await expect
            .poll(() => page.locator("#reason").evaluate((r) => r === r.ownerDocument.activeElement))
            .toBe(true);
        await page.keyboard.type("races on hover");
        await page.keyboard.press("Enter");
        await expect.poll(() => page.locator("#status").textContent()).toContain("exclude");
    });

    it("Shift+A accepts the project, and Finish counts what was never opened and what is left", async () => {
        await page.keyboard.press("Shift+A");
        await expect.poll(() => page.locator("#progress").textContent()).toBe("4 / 6 reviewed");
        expect(dialogs[0]).toContain("Accept 4 items in compact-mantine");
        await page.getByRole("button", { name: /^Finish/ }).click();
        await expect.poll(() => dialogs.length).toBe(2);
        expect(dialogs[1]).toContain("4 accepted without being opened");
        expect(dialogs[1]).toContain("graphty-element: 1 undecided");
        expect(dialogs[1]).toContain("compact-mantine: 2 undecided");
    });

    it("shows a re-review flag on an item whose earlier accept master replaced", async () => {
        // The flag comes from the server (a serve test covers when); here only its display.
        await page.route("**/api/pr/**", async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            body.items[0].reReview = true;
            await route.fulfill({ response: res, json: body });
        });
        await page.locator("#home").click();
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await expect.poll(() => page.locator(".tile").first().textContent()).toContain("re-review");
        await openFirstStory();
        await expect
            .poll(() => page.locator("h2").textContent())
            .toContain("re-review: your earlier accept was replaced by master's baseline");
    });
});
