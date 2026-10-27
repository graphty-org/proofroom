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
import { onePrFakes } from "./fakes/adapters.mjs";
import { FIXTURE_CONFIG, interceptedPage, isolateGit, makeRepo } from "./helpers.mjs";

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
        config: { ...FIXTURE_CONFIG, usage },
        token: TOKEN,
        origin,
        startCommand: "serve",
        ...onePrFakes()(r),
    });
    server.on("request", app);
    page = await interceptedPage(browser, { viewport: { width: 1000, height: 800 } });
    posts = 0;
    page.on("request", (q) => {
        if (q.method() === "POST" && new URL(q.url()).pathname === "/api/usage") {
            posts++;
        }
    });
    await page.goto(`${origin}/#token=${TOKEN}&change=123&snap=compact-mantine/button--primary.dark.png`);
}

const message = () => page.locator("#msg-t").innerText();
const current = () => page.locator("#snap-list .srow.cur").getAttribute("data-snap");
// The current snapshot's images are drawn and the page takes decisions on it.
const ready = () =>
    expect
        .poll(async () => {
            const key = await current();
            return key !== null && (await page.locator("#stage").getAttribute("data-ready")) === key;
        })
        .toBe(true);

// The changed button, by keys: Highlight, Accept, back with Left, Undo, then Reject with a reason.
async function review() {
    await ready();
    await page.keyboard.press("KeyH");
    await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(2);
    await ready();
    await page.keyboard.press("KeyA");
    await expect.poll(message).toMatch(/^Accepted #\d+\.$/);
    await ready();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(current).toBe("compact-mantine/button--primary.dark.png");
    await ready();
    await page.keyboard.press("KeyU");
    await expect.poll(message).toMatch(/^Undone: #\d+\.$/);
    await ready();
    await page.keyboard.press("KeyR");
    await page.locator("#reason:focus").waitFor();
    await page.keyboard.type(REASON);
    await page.keyboard.press("Enter");
    await expect.poll(message).toMatch(/^Rejected #\d+\.$/);
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
        await expect
            .poll(() => events().some((e) => e.type === "action" && e.a === "reject" && e.via === "key"))
            .toBe(true);
        const log = events();
        const text = readFileSync(file, "utf8");
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(REASON);
        // One page load, one session.
        expect(new Set(log.map((e) => e.s)).size).toBe(1);
        expect(log.every((e) => Number.isFinite(e.at))).toBe(true);
        expect(log.find((e) => e.type === "load")).toMatchObject({ w: 1000, h: 800, dpr: 1 });
        // Every press by its action id and how it came.
        const keys = log.filter((e) => e.type === "action" && e.via === "key").map((e) => e.a);
        expect(keys).toEqual(expect.arrayContaining(["view-highlight", "accept", "undo", "reject"]));
        // The controls shown, so the report names those never pressed.
        expect(log.filter((e) => e.type === "controls").flatMap((e) => e.c)).toEqual(
            expect.arrayContaining(["accept", "reject"]),
        );
    });

    it("sends and writes nothing when off", async () => {
        await open(false);
        await review();
        expect(posts).toBe(0);
        expect(existsSync(file)).toBe(false);
    });
});
