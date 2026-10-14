/*
 * Usage events from the review page, in Chromium: with `usage` on, a review driven by real keys
 * leaves its timeline in <tmp>/state/usage-events.jsonl (no reason text, no token); with it off,
 * the page sends nothing and nothing is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../trusted/lib/serve.mjs";
import { CONFIG, interceptedPage, isolateGit, makeRepo, onePr } from "./helpers.mjs";

const TOKEN = "u".repeat(43);
const REASON = "secret reason words";

let browser;
let server;
let page;
let app;
let file;
let posts;

beforeAll(async () => {
    isolateGit();
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterAll(() => browser?.close());
afterEach(async () => {
    await page?.close();
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.idle();
});

async function open(usage) {
    const r = makeRepo();
    const tmp = join(r.repo, "tmp/visual-review");
    file = join(tmp, "state/usage-events.jsonl");
    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    app = createApp({
        repo: r.repo,
        tmp,
        config: { ...CONFIG, usage },
        token: TOKEN,
        origin,
        startCommand: "serve",
        gh: onePr()(r),
    });
    server.on("request", app);
    page = await interceptedPage(browser, { viewport: { width: 1000, height: 800 } });
    posts = 0;
    page.on("request", (q) => {
        if (q.method() === "POST" && new URL(q.url()).pathname === "/api/usage") {
            posts++;
        }
    });
    await page.goto(`${origin}/#token=${TOKEN}`);
    await page.getByRole("button", { name: "Review", exact: true }).first().click();
    await page.locator(".component").first().waitFor();
}

const status = () => page.locator("#status").textContent();
// The item's images are drawn and the page takes decisions on it.
const ready = () => page.locator("#stage[data-ready]").waitFor();

// Item 2 (button--primary.dark, changed): Highlight, Accept, back with J, Undo, then Reject with a
// reason, all by keys.
async function review() {
    await page.locator("#find").fill("2");
    await page.locator("#find").press("Enter");
    await ready();
    await page.keyboard.press("h");
    await expect.poll(() => page.locator("#stage").getAttribute("class")).toContain("highlight");
    await ready();
    await page.keyboard.press("a");
    await expect.poll(status).toMatch(/^Accepted #2/);
    await page.keyboard.press("j");
    await ready();
    await page.keyboard.press("u");
    await expect.poll(status).toBe("Undid #2: undecided again.");
    await ready();
    await page.keyboard.press("r");
    await page.locator("#reason:focus").waitFor();
    await page.keyboard.type(REASON);
    await page.keyboard.press("Enter");
    await expect.poll(status).toMatch(/^Rejected #2/);
}

const events = () =>
    existsSync(file)
        ? readFileSync(file, "utf8")
              .trim()
              .split("\n")
              .map((l) => JSON.parse(l))
        : [];

describe("review page: usage events", () => {
    it("records the review's timeline when on, without the reason text or the token", async () => {
        await open(true);
        await review();
        await expect.poll(() => events().some((e) => e.type === "decide" && e.d === "reject")).toBe(true);
        const log = events();
        const text = readFileSync(file, "utf8");
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(REASON);
        // One page load, one session.
        expect(new Set(log.map((e) => e.s)).size).toBe(1);
        expect(log.every((e) => Number.isFinite(e.at))).toBe(true);
        const load = log.find((e) => e.type === "load");
        expect(load).toMatchObject({ w: 1000, h: 800, dpr: 1, coarse: false });
        expect(log.find((e) => e.type === "project")).toMatchObject({ id: "123", project: "compact-mantine" });
        const shown = log.filter((e) => e.type === "item" && e.file === "button--primary.dark.png");
        // Opened, then reached again with J after the accept moved on: going back.
        expect(shown.map((e) => e.back)).toEqual([false, true]);
        expect(log.some((e) => e.type === "drawn" && e.file === "button--primary.dark.png")).toBe(true);
        expect(log.some((e) => e.type === "set" && e.key === "view" && e.to === "highlight")).toBe(true);
        expect(log.filter((e) => e.type === "press").map((e) => e.c)).toEqual(
            expect.arrayContaining(["Review", "key-H", "key-A", "key-J", "key-U", "key-R"]),
        );
        expect(log.find((e) => e.type === "move")).toMatchObject({ step: -1 });
        const decided = log.filter((e) => e.type === "decide" || e.type === "undo");
        expect(decided.map((e) => [e.type, e.d, e.was, e.view])).toEqual([
            ["decide", "accept", null, "highlight"],
            ["undo", null, "accept", "highlight"],
            ["decide", "reject", null, "highlight"],
        ]);
        expect(decided.every((e) => Number.isInteger(e.ms) && e.ms >= 0)).toBe(true);
        expect(decided.at(-1).reasonLength).toBe(REASON.length);
        // The controls shown, on the targets, grid and story screens, so the report names those never pressed.
        expect(log.filter((e) => e.type === "controls").flatMap((e) => e.c)).toEqual(
            expect.arrayContaining(["Review", "accept", "reject"]),
        );
    });

    it("sends and writes nothing when off", async () => {
        await open(false);
        await review();
        expect(posts).toBe(0);
        expect(existsSync(file)).toBe(false);
    });
});
