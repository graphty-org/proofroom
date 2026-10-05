/*
 * The review page without a session token, in Chromium: a home-screen web app keeps its own
 * storage, so the page asks for the token (or the URL serve printed) and keeps it, and asks again
 * when the server refuses it. The token is never shown on the page.
 */

import { createServer } from "node:http";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../trusted/lib/serve.mjs";
import { CONFIG, isolateGit, makeRepo, onePr } from "./helpers.mjs";

const TOKEN = "k".repeat(43);
// Each test starts a server on a new repository and opens a tab: about a second each, more on CI.
vi.setConfig({ testTimeout: 20000 });

const LABEL = "Paste the session token (or the full URL serve printed)";

let browser;
let server;
let origin;
let page;

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
    origin = `http://127.0.0.1:${server.address().port}`;
    server.on(
        "request",
        createApp({
            repo: r.repo,
            tmp: join(r.repo, "tmp/visual-review"),
            config: CONFIG,
            token: TOKEN,
            origin,
            startCommand: "serve",
            gh: onePr()(r),
        }),
    );
    // A new context each test: its own storage, as a home-screen web app has.
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
});
afterEach(async () => {
    await page?.close();
    server?.close();
});

const field = () => page.getByLabel(LABEL);
const stored = () => page.evaluate(() => globalThis.localStorage.getItem("visual-review:token"));
const loaded = () => page.getByRole("button", { name: "Review", exact: true }).first().waitFor();

async function paste(text) {
    await field().fill(text);
    await page.getByRole("button", { name: "Open", exact: true }).click();
}

describe("review page: the session token", () => {
    it("asks for the token when it has none, with a labelled field and touch-sized controls", async () => {
        await page.goto(`${origin}/`);
        await field().waitFor();
        expect(await field().getAttribute("type")).toBe("password");
        for (const control of [field(), page.getByRole("button", { name: "Open", exact: true })]) {
            expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
        }
    });

    it("loads once the token is pasted, and keeps it for the next visit", async () => {
        await page.goto(`${origin}/`);
        await paste(TOKEN);
        await loaded();
        expect(await stored()).toBe(TOKEN);
        await page.goto(`${origin}/`);
        await loaded();
    });

    it("takes the token out of the full URL serve printed", async () => {
        await page.goto(`${origin}/`);
        await paste(`  ${origin}/#token=${TOKEN}  `);
        await loaded();
        expect(await stored()).toBe(TOKEN);
    });

    it("says a wrong token was refused, asks again, and never shows the token", async () => {
        const wrong = "w".repeat(43);
        await page.goto(`${origin}/`);
        await paste(wrong);
        await expect.poll(() => page.locator("#token-error").textContent()).toMatch(/did not accept/);
        await field().waitFor();
        expect(await field().inputValue()).toBe("");
        expect(await stored()).toBeNull();
        expect(await page.locator("body").innerText()).not.toContain(wrong);
        // A wrong token in the address is refused the same way, and leaves the address.
        await page.goto("about:blank");
        await page.goto(`${origin}/#token=${wrong}`);
        await expect.poll(() => page.locator("#token-error").textContent()).toMatch(/did not accept/);
        expect(page.url()).not.toContain(wrong);
        await paste(TOKEN);
        await loaded();
    });
});
