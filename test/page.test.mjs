/*
 * The review page in Chromium, over the results fixture served as pull request #123 by a fake gh:
 * the targets, the grid, the story views, zoom, the keys, decisions, Accept all, what Finish says
 * before it commits, and a Finish followed while it runs; the decision bar that never moves, the
 * waits that say what they wait for, and the way on to the next project and the next target. A
 * last block serves the fixture as a local preview.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parsePasskeys, verifyApproval } from "../trusted/lib/approval.mjs";
import { withRetries } from "../trusted/lib/github.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { CONFIG, FIXTURE, fakeGh, git, isolateGit, job, makeRepo, onePr, pushCommit, withMoved } from "./helpers.mjs";

const TOKEN = "p".repeat(43);
const START = "cd /repo && PORT=9 node visual-review/trusted/cli.mjs serve";

let browser;
let server;
let origin;
let page;
let dialogs;
let confirmFinish = false;

beforeAll(async () => {
    isolateGit();
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterAll(() => browser?.close());

// Two pull requests, #123 and #124, on the same head and CI run.
const twoPrs = (r) =>
    fakeGh({
        prs: [
            { number: 123, head: r.head, branch: "feature" },
            { number: 124, head: r.head, branch: "feature" },
        ],
        runs: { [r.head]: { id: 1000, head: r.head, attempt: 1 } },
        jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
        artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
        results: {
            "visual-compact-mantine-1": { commit: r.head, headSha: r.head },
            "visual-graphty-element-1": { commit: r.head, headSha: r.head },
        },
    });

// `host` localhost: WebAuthn needs a host name (an IP address is never a passkey's site).
// `touch`: a touch screen (an iPad), where `pointer: coarse` matches.
async function open(
    options,
    { viewport = { width: 1000, height: 800 }, review = true, host = "127.0.0.1", touch = false } = {},
) {
    const r = makeRepo();
    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://${host}:${server.address().port}`;
    const app = createApp({
        repo: r.repo,
        tmp: join(r.repo, "tmp/visual-review"),
        config: CONFIG,
        token: TOKEN,
        origin,
        startCommand: START,
        ...options(r),
    });
    server.on("request", app);
    page = await browser.newPage({ viewport, hasTouch: touch, isMobile: touch });
    dialogs = [];
    // The page asks in its own dialog (ask in review.js). Accept all, Undo and Exclude are
    // confirmed; Finish is refused unless a test sets confirmFinish.
    await page.exposeFunction("asked", (message) => {
        dialogs.push(message);
        return !message.startsWith("Finish") || confirmFinish;
    });
    await page.addInitScript(() => {
        // In the browser: its globals, not Node's.
        const { document, MutationObserver } = globalThis;
        new MutationObserver(() => {
            for (const d of document.querySelectorAll("dialog.ask[open]:not([data-seen])")) {
                d.dataset.seen = "";
                globalThis
                    .asked(d.querySelector(".ask-text").innerText)
                    .then((yes) => d.querySelectorAll(".actions button")[yes ? 1 : 0].click());
            }
        }).observe(document, { childList: true, subtree: true, attributes: true });
    });
    // A browser dialog is never answered: one a browser blocks returns at once as if refused.
    page.on("dialog", (d) => {
        dialogs.push(`browser dialog: ${d.message()}`);
        return d.dismiss();
    });
    await page.goto(`${origin}/#token=${TOKEN}`);
    if (review) {
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
    }
    return r;
}

afterEach(async () => {
    confirmFinish = false;
    await page?.close();
    server?.close();
});

// Item numbers, fixed for the project (the All order): 1 menu--open (failed), 2
// button--primary.dark (changed, area [160, 80, 40, 40]), 3 slider--sizes (changed), 4
// badge--default.light (new), 5 tooltip--hover (unstable), 6 card--legacy (removed).
async function openStory(number) {
    await page.locator("#find").fill(String(number));
    await page.locator("#find").press("Enter");
    await expect.poll(() => page.locator(".itemline .number").textContent()).toBe(`#${number}`);
}

const stageClass = () => page.locator("#stage").getAttribute("class");
// The status row's message: the live line, the time spent beside it, and the alert.
const status = () =>
    page.evaluate(() =>
        ["status", "elapsed", "alert"]
            .map((id) => globalThis.document.getElementById(id).textContent)
            .filter(Boolean)
            .join(" "),
    );
const position = () => page.locator("#position").textContent();
// The wait box: whether it is open, and each of its lines.
const box = (part = null) =>
    page.evaluate((name) => {
        const d = globalThis.document.getElementById("wait");
        if (!d?.open) {
            return null;
        }
        return name ? globalThis.document.getElementById(`wait-${name}`).textContent : "open";
    }, part);
// The item's images have been on screen long enough for a decision to count.
const ready = () => page.locator("#stage[data-ready]").waitFor();
const progress = () => page.locator("#progress").textContent();
const visibleTiles = () => page.locator(".tile-box:not([hidden]) .tile").count();
// The grid's More filters menu: a status or a decision.
const show = (value) => page.locator("#more-filters").selectOption(value);
const option = (value) => page.locator(`#more-filters option[value="${value}"]`).textContent();

// Thirty more components of six new stories each: a grid far taller than the screen.
const MANY = [];
{
    const badge = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items.find(
        (i) => i.file === "badge--default.light.png",
    );
    for (let c = 0; c < 30; c++) {
        for (let m = 0; m < 6; m++) {
            const id = `comp${String(c).padStart(2, "0")}--s${m}`;
            MANY.push({ ...badge, id, mode: null, file: `${id}.png` });
        }
    }
}

describe("review page: a component's Accept in a long grid, on an iPad", () => {
    const section = (c) => page.locator(`.component[data-component="${c}"]`);
    // Where the grid is scrolled, where a component starts on screen, and what has the focus.
    const where = (c) =>
        page.evaluate((name) => {
            const { document } = globalThis;
            const s = document.querySelector(`.component[data-component="${name}"]`);
            const a = document.activeElement;
            return {
                scroll: document.getElementById("app").scrollTop,
                top: s ? Math.round(s.getBoundingClientRect().top) : null,
                focus: a.closest(".component") ? `${a.closest(".component").dataset.component} ${a.textContent}` : a.id,
            };
        }, c);
    let reloads;

    async function openMany(viewport) {
        await open((r) => ({ gh: withMoved(r, MANY) }), { viewport, touch: true });
        await section("comp20").waitFor();
        await page.evaluate(() => {
            const { document } = globalThis;
            const app = document.getElementById("app");
            app.scrollTop +=
                document.querySelector('.component[data-component="comp20"]').getBoundingClientRect().top - 400;
            // A tile of another component, to see that it is never drawn again.
            globalThis.kept = document.querySelector('.component[data-component="comp25"] .tile-box');
        });
        reloads = 0;
        page.on("request", (req) => {
            if (req.method() === "GET" && new URL(req.url()).pathname.startsWith("/api/pr/")) {
                reloads++;
            }
        });
    }

    for (const [held, viewport] of [
        ["upright", { width: 1024, height: 1366 }],
        ["sideways", { width: 1366, height: 1024 }],
    ]) {
        it(`held ${held}: accepts in place, puts the next component where it was, and Enter takes that one too`, async () => {
            await openMany(viewport);
            const before = await where("comp20");
            expect(before.scroll).toBeGreaterThan(5000);
            await section("comp20").locator("h3 .accept").click();
            await expect.poll(status).toBe("Accepted 6 items in comp20.");
            expect(dialogs).toEqual([]);
            expect(reloads).toBe(0);
            expect(await section("comp20").count()).toBe(0);
            // The grid did not move: the next component slid up into the accepted one's place.
            expect(await where("comp21")).toEqual({ scroll: before.scroll, top: before.top, focus: "comp21 Accept 6" });
            expect(await page.evaluate(() => globalThis.kept.isConnected)).toBe(true);
            expect(await progress()).toBe("6 of 186 decided");
            expect(await page.locator("#review-undecided").textContent()).toBe("Review 180 undecided");
            // The focus is on the next Accept: one more press takes that component, in the same place.
            await page.keyboard.press("Enter");
            await expect.poll(status).toBe("Accepted 6 items in comp21.");
            expect(await where("comp22")).toEqual({ scroll: before.scroll, top: before.top, focus: "comp22 Accept 6" });
            expect(reloads).toBe(0);
            expect(await page.getByRole("button", { name: /^Finish/ }).textContent()).toBe("Finish #123 (12)");
        });
    }

    it("brings the next component to the top of the grid when the accepted one began above it", async () => {
        await open((r) => ({ gh: withMoved(r, MANY) }), { viewport: { width: 1000, height: 800 } });
        await section("comp20").waitFor();
        // Scrolled into comp20, its heading out of sight above, its Accept reached by Tab.
        const gridTop = await page.evaluate(() => {
            const { document } = globalThis;
            const app = document.getElementById("app");
            const s = document.querySelector('.component[data-component="comp20"]');
            app.scrollTop += s.getBoundingClientRect().top - app.getBoundingClientRect().top + 150;
            s.querySelector("h3 .accept").focus({ preventScroll: true });
            return Math.round(app.getBoundingClientRect().top);
        });
        await page.keyboard.press("Enter");
        await expect.poll(status).toBe("Accepted 6 items in comp20.");
        expect((await where("comp21")).top).toBe(gridTop);
    });

    it("under All, marks the tiles accepted where they stand, and Undo 6 keeps the place", async () => {
        await openMany({ width: 1024, height: 1366 });
        await page.getByRole("button", { name: /^All/ }).click();
        await page.evaluate(() => {
            const { document } = globalThis;
            document.getElementById("app").scrollTop +=
                document.querySelector('.component[data-component="comp20"]').getBoundingClientRect().top - 400;
        });
        const before = await where("comp20");
        await section("comp20").locator("h3 .accept").click();
        await expect.poll(status).toBe("Accepted 6 items in comp20.");
        expect(reloads).toBe(0);
        expect(await section("comp20").locator(".decision .what").allTextContents()).toEqual(
            Array(6).fill("Accepted (not opened)"),
        );
        expect(await section("comp20").locator("h3").textContent()).toBe("comp20Undo 6");
        expect(await where("comp20")).toEqual({ ...before, focus: "comp21 Accept 6" });
        // Undo reloads the project, and the grid stays where it was.
        await section("comp20").locator("h3 .undo-all").click();
        await expect.poll(status).toBe("Undid 6 decisions of the component comp20.");
        expect((await where("comp20")).scroll).toBe(before.scroll);
        expect((await where("comp20")).top).toBe(before.top);
    });
});

// Thirty components of three removed and three new stories each.
const MIXED = [];
{
    const items = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items;
    const card = items.find((i) => i.file === "card--legacy.png");
    const badge = items.find((i) => i.file === "badge--default.light.png");
    for (let c = 0; c < 30; c++) {
        for (let m = 0; m < 6; m++) {
            const id = `comp${String(c).padStart(2, "0")}--s${m}`;
            MIXED.push({ ...(m < 3 ? card : badge), id, mode: null, file: `${id}.png` });
        }
    }
}

describe("review page: Accept takes what the filter shows, on an iPad", () => {
    const scroll = () => page.evaluate(() => globalThis.document.getElementById("app").scrollTop);

    for (const [held, viewport] of [
        ["upright", { width: 1024, height: 1366 }],
        ["sideways", { width: 1366, height: 1024 }],
    ]) {
        it(`held ${held}: under Removed, a component's Accept and the bar's take only removed items`, async () => {
            await open((r) => ({ gh: withMoved(r, MIXED) }), { viewport, touch: true });
            await show("removed");
            const bar = page.locator("#accept-all");
            await expect.poll(() => bar.textContent()).toBe("Accept 91 removed");
            const comp = page.locator('.component[data-component="comp20"]');
            expect(await comp.locator("h3").textContent()).toBe("comp20Accept 3");
            await comp.locator("h3 .accept").click();
            await expect.poll(status).toBe("Accepted 3 items in comp20.");
            expect(dialogs).toEqual([]);
            expect(await comp.locator(".decision .what").allTextContents()).toEqual(
                Array(3).fill("Accepted (not opened)"),
            );
            expect(await comp.locator("h3").textContent()).toBe("comp20Undo 3");
            expect(await bar.textContent()).toBe("Accept 88 removed");
            expect(await progress()).toBe("3 of 186 decided");
            // Find story narrows both Accepts as it narrows the grid.
            await page.locator("#find").fill("comp05--s0");
            await expect.poll(() => bar.textContent()).toBe("Accept 1 matching");
            expect(await page.locator('.component[data-component="comp05"] h3').textContent()).toBe("comp05Accept 1");
            await page.locator("#find").fill("");
            await expect.poll(() => bar.textContent()).toBe("Accept 88 removed");
            // Find story's short grid scrolled it to the top: down to comp20 again.
            await comp.evaluate((c) => c.scrollIntoView());
            const before = await scroll();
            expect(before).toBeGreaterThan(0);
            await bar.click();
            await expect.poll(progress).toBe("91 of 186 decided");
            expect(dialogs).toEqual([
                "Accept 88 removed items of compact-mantine without opening them? This includes 88 removals: " +
                    "accepting deletes their baselines.",
            ]);
            expect(await scroll()).toBe(before);
            expect(await bar.textContent()).toBe("Accept 0 removed");
            // Nothing new was taken: the 90 new stories and the fixture's three are still undecided.
            await page.getByRole("button", { name: /^Needs a decision/ }).click();
            expect(await bar.textContent()).toBe("Accept all undecided (93)");
        });
    }
});

describe("review page: the Baseline pane, on an iPad", () => {
    // Each pane's frame, its label and its picture, and where the decision buttons are.
    const stage = () =>
        page.evaluate(() => {
            const { document } = globalThis;
            const rect = (e) => {
                const r = e.getBoundingClientRect();
                return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: r.width };
            };
            return {
                panes: [...document.querySelectorAll("#stage figure")].map((f) => ({
                    label: f.querySelector(".label").textContent,
                    frame: rect(f.querySelector(".frame")),
                    pic: f.querySelector("img, canvas") ? rect(f.querySelector("img, canvas")) : null,
                })),
                accept: rect(document.getElementById("accept")),
                reject: rect(document.getElementById("reject")),
            };
        });
    const labels = async () => (await stage()).panes.map((p) => p.label);

    for (const [held, viewport] of [
        ["upright", { width: 1024, height: 1366 }],
        ["sideways", { width: 1366, height: 1024 }],
    ]) {
        it(`held ${held}: P shows the new image alone across both panes, and the buttons stay put`, async () => {
            await open((r) => ({ gh: onePr()(r) }), { viewport, touch: true });
            await page.locator(".component").first().waitFor();
            await openStory(2);
            await page.locator("#stage figure:nth-child(2) img").waitFor();
            const two = await stage();
            expect(two.panes.map((p) => p.label)).toEqual(["Baseline", "New"]);
            const option = page.locator("#opt-baselinePane");
            expect(await option.getAttribute("aria-pressed")).toBe("true");
            await page.keyboard.press("p");
            await expect.poll(labels).toEqual(["New"]);
            await page.locator("#stage img").waitFor();
            const one = await stage();
            expect(await option.getAttribute("aria-pressed")).toBe("false");
            // One frame from the left edge of the baseline's to the right edge of the new one's.
            expect(one.panes[0].frame.left).toBe(two.panes[0].frame.left);
            expect(one.panes[0].frame.right).toBe(two.panes[1].frame.right);
            expect(one.panes[0].frame.width).toBeGreaterThan(2 * two.panes[1].frame.width);
            // The image is never smaller, and larger when the width was what limited it.
            expect(one.panes[0].pic.width).toBeGreaterThanOrEqual(two.panes[1].pic.width);
            expect(one.panes[0].frame.top).toBe(two.panes[1].frame.top);
            expect(one.accept).toEqual(two.accept);
            expect(one.reject).toEqual(two.reject);
            expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("baseline")).toBe("off");
            // The option is in the Options menu, so the view bar stays one row.
            const top = (name) =>
                page
                    .getByRole("button", { name, exact: true })
                    .evaluate((e) => Math.round(e.getBoundingClientRect().top));
            expect(await top("Fit")).toBe(await top("Side by side"));
            // P again brings the baseline back.
            await page.keyboard.press("p");
            await expect.poll(labels).toEqual(["Baseline", "New"]);
        });
    }

    it("keeps the choice for the next item and a fresh page, shows a removed item's baseline, and still flashes", async () => {
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 1024, height: 1366 }, touch: true });
        await page.locator(".component").first().waitFor();
        await openStory(2);
        await (await menuOption("Baseline")).click();
        await expect.poll(labels).toEqual(["New"]);
        // The next item opens the same way.
        await page.keyboard.press("j");
        await expect.poll(() => page.locator(".itemline .number").textContent()).not.toBe("#2");
        await expect.poll(labels).toEqual(["New"]);
        // A fresh page on a link that does not say: this browser's choice holds.
        await openStoryFromGrid(2);
        const link = new URL(page.url());
        const p = new URLSearchParams(link.hash.slice(1));
        p.delete("baseline");
        link.hash = String(p);
        await page.goto("about:blank");
        await page.goto(link.href);
        await expect.poll(position).toMatch(/^2 of /);
        await expect.poll(labels).toEqual(["New"]);
        // Flash alternates baseline and new in the one pane.
        await page.keyboard.press("f");
        await expect.poll(stageClass).toContain("flash");
        // A flash view's stage is empty until its pictures are made: only a drawn pane counts.
        const seen = new Set();
        await expect
            .poll(async () => {
                const shown = (await labels()).join();
                if (shown) {
                    seen.add(shown);
                }
                return [...seen].sort().join("|");
            })
            .toBe("Flash: baseline|Flash: new");
        await page.keyboard.press("f");
        // A removed story has only a baseline: that is what the one pane shows.
        await openStoryFromGrid(6);
        await expect.poll(labels).toEqual(["Baseline"]);
        await page.locator("#stage img").waitFor();
    });

    it("labels a Flash still loading as Flash, never as the side-by-side view's New", async () => {
        // The new image is slow, and F is pressed before it arrives: the pane waits under the
        // Flash's own label.
        let release;
        const held = new Promise((resolve) => (release = resolve));
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 1024, height: 1366 }, touch: true });
        await page.route("**/api/img/123/compact-mantine/capture/button--primary.dark.png", async (route) => {
            await held;
            await route.continue();
        });
        await page.locator(".component").first().waitFor();
        await openStory(2);
        await (await menuOption("Baseline")).click();
        await expect.poll(labels).toEqual(["New"]);
        await page.keyboard.press("f");
        await expect.poll(stageClass).toContain("flash");
        await expect.poll(labels).toEqual(["Flash: baseline"]);
        expect(await page.locator("#stage .wait").count()).toBe(1);
        release();
        await page.locator("#stage img").first().waitFor();
        expect(await labels()).toEqual(["Flash: baseline"]);
    });
});

describe("review page: the Focus point, on an iPad", () => {
    // For each pane with a picture: where it is scrolled, how far it can scroll, where the image
    // starts in it and the CSS pixels per image pixel.
    const panes = () =>
        page.evaluate(() =>
            [...globalThis.document.querySelectorAll("#stage .frame")]
                .filter((f) => f.querySelector(".sheet img, .sheet canvas"))
                .map((f) => {
                    const sheet = f.querySelector(".sheet");
                    const pic = sheet.querySelector("img, canvas");
                    const [fr, sr] = [f.getBoundingClientRect(), sheet.getBoundingClientRect()];
                    return {
                        scroll: [f.scrollLeft, f.scrollTop],
                        max: [f.scrollWidth - f.clientWidth, f.scrollHeight - f.clientHeight],
                        client: [f.clientWidth, f.clientHeight],
                        start: [
                            sr.left - fr.left - f.clientLeft + f.scrollLeft,
                            sr.top - fr.top - f.clientTop + f.scrollTop,
                        ],
                        k: pic.getBoundingClientRect().width / (pic.naturalWidth ?? pic.width),
                    };
                }),
        );
    // Every pane is scrolled to put image point [x, y] in its middle, as near as its edges allow,
    // within `tolerance` image pixels.
    const centeredOn = async ([x, y], tolerance = 1) => {
        const all = await panes();
        return (
            all.length > 0 &&
            all.every((p) =>
                [x, y].every((v, a) => {
                    const want = Math.min(p.max[a], Math.max(0, p.start[a] + v * p.k - p.client[a] / 2));
                    return Math.abs(p.scroll[a] - want) <= tolerance * p.k + 1;
                }),
            )
        );
    };
    const scrolled = async () => (await panes()).every((p) => p.scroll[0] > 0 || p.scroll[1] > 0);
    const focus = () => page.locator("#opt-focus");

    for (const [held, viewport] of [
        ["upright", { width: 1024, height: 1366 }],
        ["sideways", { width: 1366, height: 1024 }],
    ]) {
        it(`held ${held}: O at 4x centers the largest change, and after Accept the next item opens on its own`, async () => {
            await open((r) => ({ gh: onePr()(r) }), { viewport, touch: true });
            await page.locator(".component").first().waitFor();
            await openStory(2);
            await page.locator("#stage figure:nth-child(2) img").waitFor();
            await page.getByRole("button", { name: "4x", exact: true }).click();
            expect(await focus().getAttribute("aria-pressed")).toBe("false");
            await page.keyboard.press("o");
            await expect.poll(() => focus().getAttribute("aria-pressed")).toBe("true");
            expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("focus")).toBe("on");
            // The changed area [160, 80, 40, 40] has its middle at (180, 100), in both panes.
            await expect.poll(() => centeredOn([180, 100])).toBe(true);
            expect((await panes()).length).toBe(2);
            expect(await scrolled()).toBe(true);
            await ready();
            // Whether the next item's new image is already scrolled in the first frame that draws it.
            await page.evaluate(() => {
                const { document, requestAnimationFrame } = globalThis;
                globalThis.firstFramed = null;
                const tick = () => {
                    const img = document.querySelector('#stage img[alt="new image of slider--sizes"]');
                    if (!img) {
                        requestAnimationFrame(tick);
                        return;
                    }
                    const f = img.closest(".frame");
                    globalThis.firstFramed = f.scrollLeft > 0 || f.scrollTop > 0;
                };
                requestAnimationFrame(tick);
            });
            await page.keyboard.press("a");
            await expect.poll(() => page.locator(".itemline .number").textContent()).toBe("#3");
            await expect.poll(() => page.evaluate(() => globalThis.firstFramed)).toBe(true);
            // slider--sizes grew 40 rows at the bottom, across its width: its middle is (160, 220).
            await page.locator("#stage figure:nth-child(2) img").waitFor();
            await expect.poll(() => centeredOn([160, 220], 12)).toBe(true);
            await ready();
            expect(await centeredOn([160, 220], 12)).toBe(true);
            // At Fit the whole image shows: nothing scrolls.
            await page.getByRole("button", { name: "Fit", exact: true }).click();
            await expect
                .poll(async () => (await panes()).map((p) => p.scroll))
                .toEqual([
                    [0, 0],
                    [0, 0],
                ]);
        });
    }

    it("opens the next item framed even when its focus point is not known yet", async () => {
        // slider--sizes's baseline is slow, so its changed area is still unknown when its new
        // image arrives: the new image waits for it rather than showing at the top left first.
        let release;
        const held = new Promise((resolve) => (release = resolve));
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 1024, height: 1366 }, touch: true });
        await page.route("**/api/img/123/compact-mantine/baseline/slider--sizes.png", async (route) => {
            await held;
            await route.continue();
        });
        await page.locator(".component").first().waitFor();
        await openStory(2);
        await page.locator("#stage figure:nth-child(2) img").waitFor();
        await page.getByRole("button", { name: "4x", exact: true }).click();
        await page.keyboard.press("o");
        await expect.poll(() => centeredOn([180, 100])).toBe(true);
        await ready();
        await page.evaluate(() => {
            const { document, requestAnimationFrame } = globalThis;
            globalThis.firstFramed = null;
            const tick = () => {
                const img = document.querySelector('#stage img[alt="new image of slider--sizes"]');
                if (!img) {
                    requestAnimationFrame(tick);
                    return;
                }
                const f = img.closest(".frame");
                globalThis.firstFramed = f.scrollLeft > 0 || f.scrollTop > 0;
            };
            requestAnimationFrame(tick);
        });
        await page.keyboard.press("a");
        await expect.poll(() => page.locator(".itemline .number").textContent()).toBe("#3");
        // Give the new image time to arrive while the baseline is held.
        await page.waitForTimeout(300);
        release();
        await expect.poll(() => page.evaluate(() => globalThis.firstFramed)).toBe(true);
        await expect.poll(() => centeredOn([160, 220], 12)).toBe(true);
    });

    it("centers a new image on its content, and stays off until turned on", async () => {
        // The new badge capture: the story's background with one dark box at [200, 120, 40, 30].
        const png = new PNG({ width: 320, height: 200 });
        for (let y = 0; y < 200; y++) {
            for (let x = 0; x < 320; x++) {
                const inside = x >= 200 && x < 240 && y >= 120 && y < 150;
                png.data.set(inside ? [30, 30, 40, 255] : [248, 249, 250, 255], (y * 320 + x) * 4);
            }
        }
        const body = PNG.sync.write(png);
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 1024, height: 1366 }, touch: true });
        await page.route("**/api/img/123/compact-mantine/capture/badge--default.light.png", (route) =>
            route.fulfill({ status: 200, contentType: "image/png", body }),
        );
        await page.locator(".component").first().waitFor();
        await openStory(4);
        await page.locator("#stage img").waitFor();
        await page.getByRole("button", { name: "8x", exact: true }).click();
        // Off (the default), the pane opens at the top left as before.
        await expect.poll(async () => (await panes()).map((p) => p.scroll)).toEqual([[0, 0]]);
        await (await menuOption("Focus")).click();
        await expect.poll(() => centeredOn([220, 135])).toBe(true);
        expect(await scrolled()).toBe(true);
        // A fresh page remembers it, and opens the item framed.
        await page.reload();
        await page.locator("#stage img").waitFor();
        expect(await focus().getAttribute("aria-pressed")).toBe("true");
        await expect.poll(() => centeredOn([220, 135])).toBe(true);
    });
});

describe("review page: the control panel, on an iPad", () => {
    // Where each control people use on most items is, whether a menu hides it, and how much of
    // the screen the controls above the panes take.
    const panel = () =>
        page.evaluate(() => {
            const { document, innerWidth } = globalThis;
            const byName = (name) =>
                [...document.querySelectorAll("button")].find(
                    (b) => (b.getAttribute("aria-label") ?? b.firstChild?.textContent?.trim()) === name,
                );
            const names = ["Side by side", "Flash", "Highlight", "Spotlight", "Fit", "1x", "2x", "4x", "8x"];
            const controls = {
                ...Object.fromEntries(
                    ["prev", "next", "undo", "exclude", "reject", "accept"].map((id) => [
                        id,
                        document.getElementById(id),
                    ]),
                ),
                ...Object.fromEntries(names.map((n) => [n, byName(n)])),
                finish: document.querySelector("#finish-slot .finish"),
            };
            const out = {};
            for (const [name, e] of Object.entries(controls)) {
                const r = e?.getBoundingClientRect();
                out[name] =
                    e && e.checkVisibility() && !e.closest("details:not([open])")
                        ? { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height }
                        : null;
            }
            const short = [...document.querySelectorAll("button, select, input, summary")]
                .filter((e) => e.checkVisibility() && e.getBoundingClientRect().height < 44)
                .map((e) => e.id || e.textContent.trim());
            return {
                controls: out,
                stageTop: document.getElementById("stage").getBoundingClientRect().top,
                sideways: document.documentElement.scrollWidth > innerWidth,
                outside: Object.entries(out)
                    .filter(([, r]) => r && (r.left < 0 || r.right > innerWidth + 0.5))
                    .map(([n]) => n),
                short,
            };
        });

    for (const [held, viewport, most] of [
        ["upright", { width: 1024, height: 1366 }, 220],
        ["sideways", { width: 1366, height: 1024 }, 190],
        ["upright (iPad Air)", { width: 820, height: 1180 }, 220],
        ["sideways (iPad Air)", { width: 1180, height: 820 }, 190],
        ["upright (iPad mini)", { width: 744, height: 1133 }, 220],
    ]) {
        it(`held ${held}: the controls used on most items show without a menu, in ${most} px above the panes`, async () => {
            await open((r) => ({ gh: onePr()(r) }), { viewport, touch: true });
            await page.locator(".component").first().waitFor();
            await openStory(2);
            await ready();
            const p = await panel();
            const hidden = Object.entries(p.controls)
                .filter(([, r]) => r === null)
                .map(([n]) => n);
            expect(hidden).toEqual([]);
            expect(p.outside).toEqual([]);
            expect(p.sideways).toBe(false);
            expect(p.short).toEqual([]);
            expect(p.stageTop).toBeLessThanOrEqual(most);
            const c = p.controls;
            // The decision row is one row: Previous and Next at the left end, then Undo and
            // Exclude, then Reject and Accept, the widest, with a gap between Exclude and Reject.
            const row = ["prev", "next", "undo", "exclude", "reject", "accept"];
            expect(new Set(row.map((id) => c[id].top)).size).toBe(1);
            for (let i = 1; i < row.length; i++) {
                expect(c[row[i]].left).toBeGreaterThan(c[row[i - 1]].left);
            }
            expect(Math.max(...row.slice(0, -1).map((id) => c[id].width))).toBeLessThan(c.accept.width);
            expect(c.reject.left - c.exclude.right).toBeGreaterThan(c.accept.left - c.reject.right);
            // The views and the zoom steps share one row.
            expect(new Set(["Side by side", "Spotlight", "Fit", "8x"].map((n) => c[n].top)).size).toBe(1);
        });
    }

    it("opens the note for a reject in the row it is in, moving nothing", async () => {
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 820, height: 1180 }, touch: true });
        await page.locator(".component").first().waitFor();
        await openStory(2);
        await ready();
        const before = await panel();
        await page.keyboard.press("r");
        await expect.poll(() => page.locator("#note:focus").count()).toBe(1);
        expect(await page.locator("#note").getAttribute("placeholder")).toBe("Reason to reject, then Enter");
        const after = await panel();
        expect(after.controls).toEqual(before.controls);
        expect(after.stageTop).toBe(before.stageTop);
        // Upright, the note box ends the item row; on its side, the decision row.
        expect(await page.locator(".itemline #note").count()).toBe(1);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1180, height: 820 });
        await expect.poll(() => page.locator(".decisionbar #note").count()).toBe(1);
    });

    it("keeps the rarer options in one Options menu, each with its key, and Escape closes it first", async () => {
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 1024, height: 1366 }, touch: true });
        await page.locator(".component").first().waitFor();
        await openStory(2);
        await ready();
        const menu = page.locator("#options");
        expect(await menu.evaluate((d) => d.open)).toBe(false);
        await page.locator("#options > summary").click();
        const names = await menu.locator("button").evaluateAll((bs) => bs.map((b) => b.textContent.trim()));
        expect(names).toEqual(["OutlineB", "BaselineP", "FocusO", "Next change1 of 1N", "Copy link"]);
        // An option stays open for the next, and its key works as before.
        await page.getByRole("button", { name: "Outline", exact: true }).click();
        await expect.poll(() => page.locator("#opt-showBox").getAttribute("aria-pressed")).toBe("false");
        expect(await menu.evaluate((d) => d.open)).toBe(true);
        await page.keyboard.press("b");
        await expect.poll(() => page.locator("#opt-showBox").getAttribute("aria-pressed")).toBe("true");
        // Escape closes the menu and stays on the item; the next Escape goes up to the grid.
        await page.keyboard.press("Escape");
        await expect.poll(() => menu.evaluate((d) => d.open)).toBe(false);
        expect(await page.locator("#stage").count()).toBe(1);
        // A tap outside closes it too.
        await page.locator("#options > summary").click();
        await page.locator("#stage").click();
        await expect.poll(() => menu.evaluate((d) => d.open)).toBe(false);
        await page.keyboard.press("Escape");
        await page.locator(".component").first().waitFor();
    });

    it("counts each tap and key in this browser only, and lists the most used in Keys", async () => {
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 1024, height: 1366 }, touch: true });
        await page.locator(".component").first().waitFor();
        await openStory(2);
        await ready();
        await page.getByRole("button", { name: "4x", exact: true }).click();
        await page.locator("#accept").click();
        await expect.poll(position).toMatch(/^3 of /);
        await page.keyboard.press("j");
        await expect.poll(position).toMatch(/^4 of /);
        const counted = await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem("visual-review:usage")));
        expect(counted).toMatchObject({ "zoom-4": 1, accept: 1, "key-J": 1 });
        await page.keyboard.press("?");
        const list = await page.locator("dialog.keys .usage li").allTextContents();
        expect(list).toEqual(expect.arrayContaining(["zoom-4: 1", "accept: 1", "key-J: 1"]));
        expect(list.length).toBeLessThanOrEqual(10);
    });
});

describe("review page: a pull request", () => {
    beforeEach(async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator(".component").first().waitFor();
    });

    it("opens on what needs a decision: failed captures first, then components, changed first", async () => {
        const needs = page.getByRole("button", { name: /^Needs a decision/ });
        expect(await needs.getAttribute("aria-pressed")).toBe("true");
        // One count everywhere: 6 undecided, of which the failed capture is listed on its own.
        expect(await needs.textContent()).toBe("Needs a decision (6)");
        expect(await progress()).toBe("0 of 6 decided");
        expect(await page.locator("#review-undecided").textContent()).toBe("Review 6 undecided");
        expect(await page.locator(".errors > summary").textContent()).toBe("1 failed capture: only Exclude applies");
        const error = page.locator(".errors li").first();
        expect(await error.textContent()).toContain("1 menu--open");
        expect(await error.textContent()).toContain("story render errored");
        expect(await error.locator("pre").textContent()).toContain("at play (menu.stories.tsx:12:5)");
        const components = await page.locator(".component").evaluateAll((s) => s.map((c) => c.dataset.component));
        expect(components).toEqual(["button", "slider", "badge", "tooltip", "card"]);
        // Each story's modes are nested under it, numbered in the project's order.
        const button = page.locator('.component[data-component="button"] .story');
        expect(await button.locator(".story-name").textContent()).toBe("primary");
        expect(await button.locator(".tile .name").textContent()).toBe("2 dark");
        // A story without modes shows no mode name.
        expect(await page.locator('.component[data-component="slider"] .tile .name').textContent()).toBe("3 ");
        // A thumbnail shows the whole capture, however wide.
        expect(
            await button
                .locator(".tile img")
                .evaluate((i) => i.ownerDocument.defaultView.getComputedStyle(i).objectFit),
        ).toBe("contain");
    });

    it("loads each tile's thumbnail from the server, not the full image", async () => {
        const img = page.locator('.component[data-component="button"] .tile img');
        await expect.poll(() => img.getAttribute("src")).toMatch(/^blob:/);
        const urls = await page.evaluate(() => globalThis.performance.getEntriesByType("resource").map((e) => e.name));
        expect(urls.some((u) => u.includes("/api/thumb/123/compact-mantine/capture/button--primary.dark.png"))).toBe(
            true,
        );
        expect(urls.some((u) => u.includes("/api/img/"))).toBe(false);
    });

    // Where each pane and each image is on the screen, and whether anything scrolls.
    const layout = () =>
        page.locator("body").evaluate((body) => {
            const doc = body.ownerDocument;
            const rect = (e) => {
                const r = e.getBoundingClientRect();
                return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
            };
            const main = doc.querySelector("main");
            return {
                frames: [...doc.querySelectorAll("#stage .frame")].map(rect),
                pics: [...doc.querySelectorAll("#stage figure")].map((f) => {
                    const p = f.querySelector("img, canvas");
                    return p ? rect(p) : null;
                }),
                labels: [...doc.querySelectorAll("#stage .label")].map((l) => l.textContent),
                scrolls:
                    main.scrollHeight > main.clientHeight ||
                    doc.documentElement.scrollHeight > doc.defaultView.innerHeight,
            };
        });
    const inside = (p, f) =>
        p.left >= f.left - 0.5 && p.right <= f.right + 0.5 && p.top >= f.top - 0.5 && p.bottom <= f.bottom + 0.5;

    it("fits both whole images side by side on one screen, at one scale, in panes of one size", async () => {
        // Short enough that the images shrink to the height of the panes, not their width.
        for (const [w, h] of [
            [1000, 400],
            [600, 900],
        ]) {
            await page.setViewportSize({ width: w, height: h });
            await openStory(2);
            await page.locator("#stage img").nth(1).waitFor();
            const l = await layout();
            expect(l.scrolls).toBe(false);
            expect(l.frames).toHaveLength(2);
            expect(l.frames[0].width).toBeCloseTo(l.frames[1].width, 0);
            expect(l.frames[0].height).toBeCloseTo(l.frames[1].height, 0);
            expect(l.frames[0].top).toBe(l.frames[1].top);
            expect(l.frames[1].left).toBeGreaterThan(l.frames[0].right);
            const [base, next] = l.pics;
            // Smaller than real size (320 x 200): it had to shrink to fit.
            expect(base.width).toBeLessThan(320);
            expect(inside(base, l.frames[0]) && inside(next, l.frames[1])).toBe(true);
            // One scale, one place in each pane: equal images line up pixel for pixel.
            expect(next.width).toBe(base.width);
            expect(next.top).toBe(base.top);
            expect(next.left - l.frames[1].left).toBeCloseTo(base.left - l.frames[0].left, 5);
            await page.keyboard.press("Escape");
        }
    });

    it("draws both panes at once, saying what each waits for, and keeps the left one empty without a baseline", async () => {
        // The new image is slow: its pane says so, in the place the image will take.
        let release;
        const held = new Promise((resolve) => (release = resolve));
        await page.route("**/api/img/123/compact-mantine/capture/button--primary.dark.png", async (route) => {
            await held;
            await route.continue();
        });
        await openStory(2);
        await expect.poll(() => page.locator("#stage figure").nth(1).textContent()).toBe("NewLoading new image...");
        // Accept waits for the images, and says so when pressed.
        expect(await page.locator("#accept").getAttribute("class")).toContain("loading");
        await page.locator("#accept").click();
        await expect.poll(status).toBe("Loading images: Accept waits for them.");
        release();
        await page.locator('#stage img[alt="new image of button--primary (dark)"]').waitFor();
        const withBaseline = await layout();
        await openStoryFromGrid(4);
        await expect.poll(async () => (await layout()).labels).toEqual(["No baseline", "New"]);
        const l = await layout();
        expect(await page.locator("#stage .frame").first().getAttribute("class")).toBe("frame empty");
        expect(l.pics[0]).toBeNull();
        // The right pane is exactly where it is when a baseline exists.
        expect(l.frames[1].left).toBe(withBaseline.frames[1].left);
        expect(l.frames[1].width).toBe(withBaseline.frames[1].width);
        expect(l.frames[0].width).toBe(l.frames[1].width);
        // A removed story keeps the right pane the same way.
        await openStoryFromGrid(6);
        await expect.poll(async () => (await layout()).labels).toEqual(["Baseline", "No capture"]);
    });

    it("zooms past the panes, which scroll together; Fit brings the whole image back", async () => {
        await openStory(2);
        await page.locator("#stage img").nth(1).waitFor();
        await page.getByRole("button", { name: "8x", exact: true }).click();
        const frames = page.locator("#stage .frame");
        await expect.poll(() => frames.first().evaluate((f) => f.scrollWidth > f.clientWidth)).toBe(true);
        expect((await layout()).scrolls).toBe(false);
        await frames.nth(1).evaluate((f) => f.scrollTo(300, 200));
        await expect.poll(() => frames.first().evaluate((f) => [f.scrollLeft, f.scrollTop])).toEqual([300, 200]);
        // Flash keeps the zoom and the place.
        await page.keyboard.press("f");
        await expect.poll(stageClass).toContain("flash");
        await expect.poll(() => frames.nth(1).evaluate((f) => [f.scrollLeft, f.scrollTop])).toEqual([300, 200]);
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        await expect.poll(() => frames.first().evaluate((f) => f.scrollWidth <= f.clientWidth)).toBe(true);
    });

    it("shows images at real size, zooms at a labelled factor, crisp only from 4x, and jumps to the change", async () => {
        await openStory(2);
        const img = page.locator("#stage img").first();
        await img.waitFor();
        const shape = () =>
            img.evaluate((i) => ({
                width: i.getBoundingClientRect().width,
                natural: i.naturalWidth,
                rendering: i.ownerDocument.defaultView.getComputedStyle(i).imageRendering,
            }));
        let s = await shape();
        expect(s.width).toBe(s.natural);
        const frame = page.locator("#stage .frame").first();
        // Real size opens at the top left of the image.
        expect(await frame.evaluate((f) => [f.scrollLeft, f.scrollTop])).toEqual([0, 0]);
        await page.getByRole("button", { name: "2x", exact: true }).click();
        await expect.poll(async () => (await shape()).width).toBe(s.natural * 2);
        expect((await shape()).rendering).toBe("auto");
        await page.getByRole("button", { name: "4x", exact: true }).click();
        await expect.poll(async () => (await shape()).width).toBe(s.natural * 4);
        s = await shape();
        expect(s.rendering).toBe("pixelated");
        await expect.poll(() => page.locator("#box-count").textContent()).toBe("1 of 1");
        // At 4x the area (smaller than the pane) is out of sight at the top left, so the pane
        // scrolls just far enough to show all of it, outlined.
        const inView = () =>
            frame.evaluate((f) => {
                const [m, v] = [f.querySelector(".boxmark").getBoundingClientRect(), f.getBoundingClientRect()];
                return (
                    m.width > 20 &&
                    m.left >= v.left &&
                    m.right <= v.left + f.clientWidth &&
                    m.top >= v.top &&
                    m.bottom <= v.top + f.clientHeight
                );
            });
        await expect.poll(inView).toBe(true);
        await frame.evaluate((f) => f.scrollTo(0, 0));
        await page.keyboard.press("n");
        await expect.poll(inView).toBe(true);
        await page.keyboard.press("z");
        await expect.poll(async () => (await shape()).width).toBe(s.natural * 8);
        await page.keyboard.press("z");
        await expect.poll(async () => (await shape()).width).toBe(s.natural);
    });

    it("flashes the two images themselves in the right pane, with F and while Space is held", async () => {
        await openStory(2);
        await page.locator("#stage img").first().waitFor();
        await page.keyboard.press("f");
        await expect.poll(stageClass).toContain("flash");
        const flashing = page.locator("#stage .flashing img");
        await expect.poll(() => flashing.count()).toBe(2);
        // Both at the same place; one shown at a time, each in turn.
        const [a, b] = await flashing.evaluateAll((imgs) => imgs.map((i) => i.getBoundingClientRect().toJSON()));
        expect([a.left, a.top]).toEqual([b.left, b.top]);
        const seen = new Set();
        await expect
            .poll(async () => {
                seen.add(await flashing.evaluateAll((imgs) => imgs.findIndex((i) => i.style.visibility !== "hidden")));
                return seen.size;
            })
            .toBe(2);
        await page.keyboard.press("f");
        await expect.poll(stageClass).toContain("side");
        await page.keyboard.down(" ");
        await expect.poll(stageClass).toContain("flash");
        await page.keyboard.up(" ");
        await expect.poll(stageClass).toContain("side");
        await expect.poll(() => page.locator("#stage figure").count()).toBe(2);
    });

    it("spotlights the change: dimmed everywhere but around the changed pixels", async () => {
        await openStory(2);
        await page.keyboard.press("s");
        const canvas = page.locator("#stage canvas");
        await canvas.waitFor();
        const [far, near] = await canvas.evaluate((c) => {
            const ctx = c.getContext("2d");
            return [5, 180].map((x) => [...ctx.getImageData(x, x === 5 ? 5 : 100, 1, 1).data]);
        });
        // Outside the grown area the new image is darkened to 65/255 of itself; inside it is not.
        expect(far[0]).toBeLessThanOrEqual(Math.ceil(255 * (1 - 190 / 255)));
        expect(near[0] + near[1] + near[2]).toBeGreaterThan(far[0] + far[1] + far[2]);
        expect(await stageClass()).toContain("spotlight");
    });

    it("flashes the spotlighted baseline and new with F in Spotlight, and keeps it for the next item", async () => {
        await openStory(2);
        await page.keyboard.press("s");
        await page.locator("#stage canvas").first().waitFor();
        const toggle = page.locator("#opt-spotFlash");
        expect(await toggle.getAttribute("aria-pressed")).toBe("false");
        await page.keyboard.press("f");
        // Still Spotlight, now two dimmed canvases in the same place, one shown at a time.
        await expect.poll(() => toggle.getAttribute("aria-pressed")).toBe("true");
        expect(await stageClass()).toContain("spotlight");
        const canvases = page.locator("#stage .flashing canvas");
        const shown = async () => {
            await expect.poll(() => canvases.count()).toBe(2);
            // The label and the shown canvas are read in one task: read apart, a flip between the
            // two reads paired one image's label with the other's canvas.
            const [index, far, label] = await canvases.evaluateAll((cs) => {
                const i = cs.findIndex((c) => c.style.visibility !== "hidden");
                const text = globalThis.document.querySelector("#stage .flashing .label").textContent;
                return [i, [...cs[i].getContext("2d").getImageData(5, 5, 1, 1).data], text];
            });
            // Both images are dimmed outside the changed pixels.
            expect(far[0]).toBeLessThanOrEqual(Math.ceil(255 * (1 - 190 / 255)));
            return `${index} ${label}`;
        };
        const seen = new Set();
        await expect
            .poll(async () => {
                seen.add(await shown());
                return [...seen].sort();
            })
            .toEqual(["0 Spotlight: baseline", "1 Spotlight: new"]);
        // The two are the spotlighted baseline and the spotlighted new image: they differ at the change.
        const near = await canvases.evaluateAll((cs) =>
            cs.map((c) => [...c.getContext("2d").getImageData(180, 100, 1, 1).data].join()),
        );
        expect(near[0]).not.toBe(near[1]);
        const hash = () => new URLSearchParams(new URL(page.url()).hash.slice(1));
        expect(hash().get("flash")).toBe("on");
        // The next item opens in Spotlight, still flashing.
        await page.keyboard.press("j");
        await expect.poll(position).toMatch(/^3 of /);
        await expect.poll(() => canvases.count()).toBe(2);
        expect(await page.locator("#stage .flashing .label").textContent()).toMatch(/^Spotlight: (baseline|new)$/);
        expect(hash().get("flash")).toBe("on");
        // F again stops flashing and stays in Spotlight; elsewhere F still switches to Flash.
        await page.keyboard.press("f");
        await expect.poll(() => toggle.getAttribute("aria-pressed")).toBe("false");
        await expect.poll(() => page.locator("#stage canvas").count()).toBe(1);
        expect(await stageClass()).toContain("spotlight");
        await page.keyboard.press("s");
        await page.keyboard.press("f");
        await expect.poll(stageClass).toContain("flash");
    });

    it("lays the changed pixels over both images in red with H, and blinks them with L", async () => {
        await openStory(2);
        await page.keyboard.press("h");
        await expect.poll(stageClass).toContain("highlight");
        const marks = page.locator("#stage .diffmark");
        await expect.poll(() => marks.count()).toBe(2);
        // Each pane still shows its real image, with the overlay exactly on top of it.
        expect(await page.locator("#stage img").count()).toBe(2);
        for (const i of [0, 1]) {
            const [img, mark] = await page
                .locator("#stage figure")
                .nth(i)
                .evaluate((f) =>
                    [f.querySelector("img"), f.querySelector(".diffmark")].map((e) =>
                        e.getBoundingClientRect().toJSON(),
                    ),
                );
            expect([mark.left, mark.top, mark.width, mark.height]).toEqual([img.left, img.top, img.width, img.height]);
        }
        // Solid red on the changed pixels, which all lie in the changed area; clear everywhere else.
        const red = await marks.nth(1).evaluate((c) => {
            const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
            let [count, other, x0, y0, x1, y1] = [0, 0, Infinity, Infinity, -1, -1];
            for (let i = 0; i < c.width * c.height; i++) {
                const [r, g, b, a] = data.slice(i * 4, i * 4 + 4);
                if (a === 0) {
                    continue;
                }
                if (r !== 255 || g !== 0 || b !== 0 || a !== 255) {
                    other++;
                    continue;
                }
                const [x, y] = [i % c.width, Math.floor(i / c.width)];
                count++;
                [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
            }
            return { count, other, box: [x0, y0, x1, y1] };
        });
        expect(red.count).toBeGreaterThan(0);
        expect(red.other).toBe(0);
        expect(red.box[0]).toBeGreaterThanOrEqual(160);
        expect(red.box[1]).toBeGreaterThanOrEqual(80);
        expect(red.box[2]).toBeLessThan(200);
        expect(red.box[3]).toBeLessThan(120);
        // L blinks both overlays together; L again holds them on.
        const blink = page.locator("#opt-blink");
        await page.keyboard.press("l");
        await expect.poll(() => blink.getAttribute("aria-pressed")).toBe("true");
        const seen = new Set();
        await expect
            .poll(async () => {
                const shown = await page
                    .locator("#stage .diffmark")
                    .evaluateAll((ms) => ms.map((m) => m.style.visibility || "visible"));
                // L re-renders the stage, which holds no overlay for a moment: count only the
                // samples taken with both overlays drawn.
                if (shown.length === 2) {
                    seen.add(shown.join());
                }
                return [...seen].sort().join("|");
            })
            .toBe("hidden,hidden|visible,visible");
        await page.keyboard.press("l");
        await expect.poll(() => blink.getAttribute("aria-pressed")).toBe("false");
        // Blink only means something in Highlight, so it is only shown there.
        await page.keyboard.press("h");
        await expect.poll(stageClass).toContain("side");
        expect(await page.locator("#stage .diffmark").count()).toBe(0);
        expect(await blink.count()).toBe(0);
    });

    it("hides the outline with B, and remembers it in this browser", async () => {
        await openStory(2);
        await expect.poll(() => page.locator("#box-count").textContent()).toBe("1 of 1");
        await expect.poll(() => page.locator("#stage .boxmark").count()).toBe(2);
        const box = page.locator("#opt-showBox");
        expect(await box.getAttribute("aria-pressed")).toBe("true");
        await page.keyboard.press("b");
        // B re-renders the story; the count is written once the diff is ready, so wait for it
        // before judging the outline, which an unfinished render would also lack.
        await expect.poll(() => box.getAttribute("aria-pressed")).toBe("false");
        await expect.poll(() => page.locator("#box-count").textContent()).toBe("1 of 1");
        expect(await page.locator("#stage .boxmark").count()).toBe(0);
        // A fresh page on a link that does not say (an older one): this browser's choice holds.
        const link = new URL(page.url());
        const p = new URLSearchParams(link.hash.slice(1));
        expect(p.get("box")).toBe("off");
        p.delete("box");
        p.delete("blink");
        link.hash = String(p);
        await page.goto("about:blank");
        await page.goto(link.href);
        await expect.poll(position).toMatch(/^2 of /);
        await expect.poll(() => page.locator("#box-count").textContent()).toBe("1 of 1");
        expect(await page.locator("#stage .boxmark").count()).toBe(0);
        await page.keyboard.press("b");
        await expect.poll(() => page.locator("#stage .boxmark").count()).toBe(2);
    });

    it("keeps focus on the page, so an iPad's keyboard reaches the shortcuts", async () => {
        // Safari on an iPad delivers keys only to a focused element; tapping an image focuses none.
        const focused = async () => ((await page.locator("#app:focus").count()) === 1 ? "app" : "");
        await openStory(2);
        await expect.poll(focused).toBe("app");
        await page.locator("#stage").click();
        await expect.poll(focused).toBe("app");
        // Leaving the note box hands focus back to the page.
        await page.locator("#note").focus();
        await page.keyboard.press("Escape");
        await expect.poll(focused).toBe("app");
    });

    it("says why Flash and Highlight are off when there is one image", async () => {
        await openStory(4);
        expect(await page.locator("#explain").textContent()).toBe("New story: no baseline yet.");
        const flash = page.getByRole("button", { name: "Flash", exact: true });
        expect(await flash.getAttribute("aria-disabled")).toBe("true");
        await page.keyboard.press("h");
        await expect.poll(status).toBe("Only one image: there is no baseline to compare it with.");
        expect(await stageClass()).toContain("side");
        await openStoryFromGrid(6);
        expect(await page.locator("#explain").textContent()).toBe(
            "Removed from the Storybook: Accept deletes its baseline.",
        );
    });

    it("leaves the note box with Escape, keeping its text; a second Escape goes back to the grid", async () => {
        await openStory(3);
        await page.locator("#note").click();
        await page.keyboard.type("half a thought");
        await page.keyboard.press("Escape");
        expect(await page.locator("#position").count()).toBe(1);
        expect(await page.locator("#note").inputValue()).toBe("half a thought");
        await page.keyboard.press("Escape");
        await page.locator(".component").first().waitFor();
        await expect.poll(() => page.locator(".tile.current").getAttribute("data-file")).toBe("slider--sizes.png");
        // The text stays with its item, and only there.
        await page.locator('.tile[data-file="slider--sizes.png"]').click();
        await expect.poll(() => page.locator("#note").inputValue()).toBe("half a thought");
        await page.keyboard.press("k");
        await expect.poll(position).toMatch(/^2 of /);
        expect(await page.locator("#note").inputValue()).toBe("");
        await page.getByRole("button", { name: "Next", exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect
            .poll(() => page.locator(".tile.current").getAttribute("data-file"))
            .toBe("button--primary.dark.png");
    });

    it("needs a reason for a reject, and never reverses a decision without Undo", async () => {
        await page.getByRole("button", { name: /^All/ }).click();
        await openStoryFromGrid(2);
        await ready();
        await page.keyboard.press("r");
        await expect.poll(status).toBe("Type the reason, then press Enter to reject.");
        expect(await page.locator("#note").getAttribute("placeholder")).toBe("Reason to reject, then Enter");
        expect(await page.locator("#reject").getAttribute("class")).toContain("waiting");
        await page.locator("#note").press("Enter");
        await expect.poll(status).toBe("Type the reason, then press Enter to reject.");
        await page.keyboard.type("darker than before");
        await page.keyboard.press("Enter");
        await expect.poll(status).toBe("Rejected #2. Now #3, 3 of 6: slider--sizes, changed.");
        // Deciding moved on to 3; back on 2, A and R do nothing until Undo.
        await page.keyboard.press("k");
        await expect.poll(position).toMatch(/^2 of/);
        await page.keyboard.press("a");
        await expect.poll(status).toBe("Already rejected. Undo it to change it.");
        expect(await page.locator("h2").textContent()).toContain("Rejected: darker than before");
        expect(await page.locator("#reject").getAttribute("aria-pressed")).toBe("true");
        expect(await page.locator("#note").inputValue()).toBe("darker than before");
        await page.keyboard.press("u");
        await expect.poll(status).toBe("Undid #2: undecided again.");
        await ready();
        await page.keyboard.press("a");
        await expect.poll(status).toBe("Accepted #2. Now #3, 3 of 6: slider--sizes, changed.");
        await page.keyboard.press("k");
        await page.keyboard.press("a");
        await expect.poll(status).toBe("Already accepted. Undo it to change it.");
    });

    it("draws all four sides of a changed area at the image's edge", async () => {
        // slider--sizes grew 40 px at the bottom: its changed area runs to the image's edges.
        await openStory(3);
        const frame = page.locator("#stage .frame").last();
        await frame.locator(".boxmark").waitFor();
        const [mark, pic] = await frame.evaluate((f) =>
            [f.querySelector(".boxmark"), f.querySelector("img")].map((e) => {
                const r = e.getBoundingClientRect();
                return [r.left, r.top, r.right, r.bottom];
            }),
        );
        expect(mark[0]).toBeGreaterThanOrEqual(pic[0]);
        expect(mark[2]).toBeLessThanOrEqual(pic[2]);
        expect(mark[3]).toBeLessThanOrEqual(pic[3]);
        expect(mark[2] - mark[0]).toBeGreaterThan(100);
    });

    it("clears a Find error once another story opens", async () => {
        await page.locator("#find").fill("99999");
        await page.locator("#find").press("Enter");
        await expect.poll(status).toBe("No item 99999: items are numbered 1 to 6 in All.");
        await openStory(2);
        expect(await status()).toBe("");
    });

    it("narrows by text and opens a number or a story id", async () => {
        await page.locator("#find").fill("slider");
        await expect.poll(visibleTiles).toBe(1);
        await page.locator("#find").fill("");
        await expect.poll(visibleTiles).toBe(5);
        await openStory(5);
        expect(await page.locator("h2").textContent()).toContain("tooltip--hover");
        await page.keyboard.press("Escape");
        await page.locator("#find").fill("card--");
        await page.locator("#find").press("Enter");
        await expect.poll(() => page.locator("h2").textContent()).toContain("card--legacy");
        // "/" on the grid goes to Find story.
        await page.keyboard.press("Escape");
        await page.locator(".component").first().waitFor();
        await page.keyboard.press("/");
        expect(await page.locator("#find:focus").count()).toBe(1);
    });

    it("accepts one component's undecided items without asking: Undo 1 takes them back", async () => {
        await page.locator('.component[data-component="badge"] h3 button').click();
        await expect.poll(progress).toBe("1 of 6 decided");
        expect(await status()).toBe("Accepted 1 item in badge.");
        expect(dialogs).toEqual([]);
        expect(await page.getByRole("button", { name: /^Finish/ }).textContent()).toBe("Finish #123 (1)");
    });

    it("under New, Shift+A accepts only the new items, after naming them", async () => {
        await show("new");
        expect(await page.locator("#accept-all").textContent()).toBe("Accept 1 new");
        await page.evaluate(() => globalThis.document.activeElement.blur());
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("1 of 6 decided");
        expect(dialogs).toEqual(["Accept 1 new item of compact-mantine without opening them?"]);
        await show("accept");
        expect(await page.locator(".tile-box").evaluateAll((b) => b.map((x) => x.dataset.file))).toEqual([
            "badge--default.light.png",
        ]);
    });

    it("Find story narrows Accept to the stories it shows, and the question says so", async () => {
        await page.locator("#find").fill("slider");
        const bar = page.locator("#accept-all");
        await expect.poll(() => bar.textContent()).toBe("Accept 1 matching");
        await bar.click();
        await expect.poll(progress).toBe("1 of 6 decided");
        expect(dialogs).toEqual(['Accept 1 undecided item of compact-mantine matching "slider" without opening them?']);
        expect(await bar.textContent()).toBe("Accept 0 matching");
    });

    it("Shift+A accepts the project, and Finish states what it will do and who signs", async () => {
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("4 of 6 decided");
        expect(dialogs[0]).toBe(
            "Accept 4 undecided items of compact-mantine without opening them? This includes 1 removal: accepting " +
                "deletes its baseline. 2 more (failed, unstable) can only be excluded and stay undecided.",
        );
        await expect.poll(status).toBe("Accepted 4 items in compact-mantine.");
        const finish = page.getByRole("button", { name: /^Finish/ });
        expect(await finish.textContent()).toBe("Finish #123 (4)");
        await finish.click();
        await expect.poll(() => dialogs.length).toBe(2);
        const sheet = dialogs[1].split("\n").filter(Boolean);
        expect(sheet.slice(0, 6)).toEqual([
            "Finish #123, every project:",
            "Commit 4 accepts to feature.",
            "Then set the commit status 'Visual review' to pending (3 undecided; not loaded: layout, algorithms, graphty).",
            "Accepted without opening: 4.",
            "Still undecided, left for a later round: compact-mantine 2, graphty-element 1.",
            "Not loaded, so not reviewed: layout, algorithms, graphty.",
        ]);
        expect(dialogs[1]).toMatch(/Finish commits are (signed with|NOT signed)/);
        expect(dialogs[1]).toContain(`start the server from your own shell:\n${START}`);
        await expect.poll(status).toBe("Finish cancelled: nothing was changed.");
        await page.locator("#home").click();
        await expect.poll(() => page.locator(".signer pre").textContent()).toBe(START);
    });

    it("shows at once that Finish is checking, and says when it is cancelled", async () => {
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("4 of 6 decided");
        // The server is slow to answer the check.
        let answer;
        const answered = new Promise((resolve) => (answer = resolve));
        await page.route("**/api/target/**", async (route) => {
            await answered;
            await route.continue();
        });
        const finish = page.getByRole("button", { name: /^Finish/ });
        await finish.click();
        expect(await finish.getAttribute("class")).toContain("busy");
        expect(await finish.locator(".spinner").count()).toBe(1);
        answer();
        await expect.poll(status).toBe("Finish cancelled: nothing was changed.");
        expect(dialogs).toHaveLength(2);
        expect(dialogs[1]).toMatch(/^Finish #123, every project:/);
        expect(await finish.getAttribute("aria-disabled")).toBe("false");
    });

    it("offers no Finish while nothing is decided, and says why", async () => {
        const finish = page.getByRole("button", { name: /^Finish/ });
        expect(await finish.textContent()).toBe("Finish #123 (0)");
        expect(await finish.getAttribute("aria-disabled")).toBe("true");
        expect(await page.locator("#finish-slot").textContent()).toContain("Nothing new to finish");
        // Unavailable, not removed: a press says why (force: Playwright never presses it otherwise).
        await finish.click({ force: true });
        await expect.poll(status).toBe("Nothing new to finish.");
        expect(dialogs).toHaveLength(0);
    });

    const decisionText = (file) => page.locator(`.decision[data-file="${file}"] .what`).textContent();

    it("filters by decision, shows each decision on its tile, and undoes one without opening it", async () => {
        await page.getByRole("button", { name: /^All/ }).click();
        await openStoryFromGrid(2);
        await ready();
        await page.keyboard.press("r");
        await page.keyboard.type("darker than before");
        await page.keyboard.press("Enter");
        await expect.poll(status).toMatch(/^Rejected #2\./);
        await openStoryFromGrid(1);
        await ready();
        await page.keyboard.press("e");
        await page.keyboard.type("flaky timeout");
        await page.keyboard.press("Enter");
        await expect.poll(status).toMatch(/^Excluded #1\./);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("5 of 6 decided");
        expect(await option("accept")).toBe("Accepted (3)");
        expect(await option("reject")).toBe("Rejected (1)");
        expect(await option("exclude")).toBe("Excluded (1)");
        await show("reject");
        await expect.poll(visibleTiles).toBe(1);
        expect(await decisionText("button--primary.dark.png")).toBe("Rejected: darker than before");
        await show("exclude");
        await expect.poll(() => decisionText("menu--open.png")).toBe("Excluded: flaky timeout");
        await show("accept");
        await expect.poll(visibleTiles).toBe(3);
        expect(await decisionText("slider--sizes.png")).toBe("Accepted (not opened)");
        const dialogsBefore = dialogs.length;
        await page.locator('.decision[data-file="slider--sizes.png"] button').click();
        await expect.poll(() => option("accept")).toBe("Accepted (2)");
        expect(await progress()).toBe("4 of 6 decided");
        expect(await status()).toBe("Undid #3: undecided again.");
        expect(dialogs.length).toBe(dialogsBefore);
        // Undone, it needs a decision again; the rest keep theirs.
        expect(await page.getByRole("button", { name: /^Needs a decision/ }).textContent()).toBe(
            "Needs a decision (2)",
        );
    });

    it("undoes one component's decisions after asking, naming the count", async () => {
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("4 of 6 decided");
        await page.getByRole("button", { name: /^All/ }).click();
        const undoButton = page.locator('.component[data-component="button"] h3 .undo-all');
        expect(await undoButton.textContent()).toBe("Undo 1");
        await undoButton.click();
        await expect.poll(progress).toBe("3 of 6 decided");
        expect(dialogs[1]).toBe("Undo the 1 decision of button?");
        expect(await status()).toBe("Undid 1 decision of the component button.");
        expect(await undoButton.count()).toBe(0);
    });

    it("undoes every decision of the project from More, after asking", async () => {
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("4 of 6 decided");
        await page.locator("details.menu > summary").click();
        await page.getByRole("button", { name: "Undo all decisions..." }).click();
        await expect.poll(progress).toBe("0 of 6 decided");
        expect(dialogs[1]).toBe("Undo all 4 decisions of compact-mantine?");
        expect(await status()).toBe("Undid 4 decisions of compact-mantine.");
        expect(await option("accept")).toBe("Accepted (0)");
    });

    it("keeps a reject an earlier Finish posted, and says so on its tile", async () => {
        await page.route("**/api/pr/**", async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            body.decisions["slider--sizes.png"] = { decision: "reject", reason: "thumb moved", posted: true };
            await route.fulfill({ response: res, json: body });
        });
        await page.locator("#home").click();
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await page.locator(".component").first().waitFor();
        await show("reject");
        const line = page.locator('.decision[data-file="slider--sizes.png"]');
        await expect.poll(() => line.textContent()).toBe("Rejected: thumb movedPosted by an earlier Finish: it stays.");
        expect(await line.locator("button").count()).toBe(0);
        // Nothing else is decided, so no bulk Undo applies to the posted reject.
        expect(await page.locator(".undo-all").getAttribute("aria-disabled")).toBe("true");
        await openStory(3);
        await page.keyboard.press("u");
        await expect.poll(status).toBe("Posted by an earlier Finish: it stays.");
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
        await openStory(2);
        await expect
            .poll(() => page.locator("h2").textContent())
            .toContain("re-review: your earlier accept was replaced by master's baseline");
    });
});

describe("review page: the decision bar", () => {
    // Every decision-bar button's box, and the panes' top edge.
    const boxes = () =>
        page.evaluate(() => {
            const doc = globalThis.document;
            const ids = ["to-grid", "prev", "next", "accept", "reject", "exclude", "undo", "note"];
            const out = Object.fromEntries(
                ids.map((id) => {
                    const r = doc.getElementById(id).getBoundingClientRect();
                    return [id, [r.left, r.top, r.width, r.height]];
                }),
            );
            out.stage = doc.getElementById("stage")?.getBoundingClientRect().top ?? null;
            out.right = Math.max(...ids.map((id) => doc.getElementById(id).getBoundingClientRect().right));
            return out;
        });

    for (const [w, h] of [
        [1180, 820],
        [768, 1024],
    ]) {
        it(`keeps every button in one place across items, decisions, zooms and scrolling at ${w} x ${h}`, async () => {
            await open((r) => ({ gh: onePr()(r) }), { viewport: { width: w, height: h } });
            await page.locator(".component").first().waitFor();
            await page.getByRole("button", { name: /^All/ }).click();
            await page.locator("#review-undecided").click();
            await ready();
            const first = await boxes();
            // Every button is inside the window, and above the images.
            expect(first.right).toBeLessThanOrEqual(w);
            expect(first.accept[1] + first.accept[3]).toBeLessThan(first.stage);
            const seen = [first];
            // Every status of the fixture, decided and not, at every zoom, scrolled.
            for (let n = 0; n < 6; n++) {
                await page.keyboard.press("z");
                await page.keyboard.press("z");
                await page
                    .locator("#stage .frame")
                    .first()
                    .evaluate((f) => f.scrollTo(200, 200));
                seen.push(await boxes());
                if (n === 1) {
                    await ready();
                    await page.keyboard.press("a");
                    await expect.poll(position).toMatch(/^3 of /);
                    await page.keyboard.press("k");
                    await expect.poll(position).toMatch(/^2 of /);
                    seen.push(await boxes());
                }
                await page.keyboard.press("j");
                await expect.poll(position).toMatch(new RegExp(`^${Math.min(n + 2, 6)} of |End of`));
                seen.push(await boxes());
            }
            for (const b of seen) {
                const { stage, ...rest } = b;
                const { stage: firstStage, ...firstRest } = first;
                expect(rest).toEqual(firstRest);
                if (stage !== null) {
                    expect(stage).toBe(firstStage);
                }
            }
            // A message in the status row moves nothing either.
            await page.locator("#accept").click({ force: true });
            await expect.poll(status).not.toBe("");
            expect(await boxes()).toEqual(seen.at(-1));
        }, 60000);
    }

    it("never types a decision key into the note box: R, type, Enter, then A accepts the next item", async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await expect.poll(position).toMatch(/^2 of /);
        await ready();
        await page.keyboard.press("r");
        await page.keyboard.type("too dark");
        await page.keyboard.press("Enter");
        await expect.poll(position).toMatch(/^3 of /);
        expect(await page.locator("#note:focus").count()).toBe(0);
        await ready();
        await page.keyboard.press("a");
        await expect.poll(status).toBe("Accepted #3. Now #4, 4 of 6: badge--default (light), new.");
        expect(await page.locator("#note").inputValue()).toBe("");
    });

    it("accepts with a note typed first, and keeps the note with its own item", async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await expect.poll(position).toMatch(/^2 of /);
        await ready();
        await page.locator("#note").fill("intended spacing");
        // Moving away keeps it with #2, and the next item's box is empty.
        await page.locator("#note").press("Escape");
        await page.keyboard.press("j");
        await expect.poll(position).toMatch(/^3 of /);
        expect(await page.locator("#note").inputValue()).toBe("");
        await page.keyboard.press("k");
        await expect.poll(() => page.locator("#note").inputValue()).toBe("intended spacing");
        await ready();
        await page.keyboard.press("a");
        await expect.poll(status).toMatch(/^Accepted #2\./);
        const { decisions } = await page.evaluate(
            async (token) =>
                (await fetch("/api/pr/123/compact-mantine", { headers: { "x-review-token": token } })).json(),
            TOKEN,
        );
        expect(decisions["button--primary.dark.png"]).toEqual({ decision: "accept", reason: "intended spacing" });
    });

    it("keeps focus on a decision button it was on: Tab to Accept, Space twice", async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await ready();
        await page.locator("#accept").focus();
        await page.keyboard.press(" ");
        await expect.poll(position).toMatch(/^3 of /);
        await page.keyboard.press(" ");
        expect(await page.evaluate(() => globalThis.document.activeElement.id)).toBe("accept");
        // The second press came within a quarter second of the new image: it decided nothing.
        await expect
            .poll(status)
            .toMatch(
                /^(Ignored: this image appeared less than a quarter second ago\.|Loading images: Accept waits for them\.)$/,
            );
    });

    it("ignores the second tap of a double tap, which lands on the next item's Accept", async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await ready();
        await page.locator("#accept").click();
        await page.locator("#accept").click();
        await expect.poll(position).toMatch(/^3 of /);
        await expect.poll(status).toMatch(/^(Ignored|Loading images|Still saving)/);
        expect(await page.locator("#accept").getAttribute("aria-pressed")).toBe("false");
    });
});

describe("review page: waits that say what they wait for", () => {
    it("shows the server's step, counts and time in the wait box while the first list loads, then the targets", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        await open(
            (r) => {
                const gh = onePr()(r);
                return {
                    gh: async (args, input) => {
                        if (args[1]?.includes("/pulls?")) {
                            await held;
                        }
                        return gh(args, input);
                    },
                };
            },
            { review: false },
        );
        await expect.poll(() => box("title")).toBe("Loading the pull requests");
        expect(await box("text")).toBe("Reading the open pull requests and their CI runs from GitHub.");
        expect(await box("detail")).toBe("Listing pull requests");
        await expect.poll(() => box("elapsed")).toMatch(/^\d+ s$/);
        // Nothing to cancel: there is nothing else to show yet.
        expect(await page.locator("#wait-cancel").isVisible()).toBe(false);
        expect(await page.locator(".card.placeholder").count()).toBe(1);
        release();
        await page.getByRole("button", { name: "Review", exact: true }).first().waitFor();
        expect(await box()).toBeNull();
        await expect.poll(() => page.locator("#listline").textContent()).toMatch(/^Updated \d+ s agoRefresh$/);
    });

    it("lists captures still downloading, and fills the rows in when they land", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        await open(
            (r) => {
                const gh = onePr()(r);
                return {
                    gh: async (args, input) => {
                        if (args[0] === "run") {
                            await held;
                        }
                        return gh(args, input);
                    },
                };
            },
            { review: false },
        );
        const downloading = page.getByRole("button", { name: "Downloading..." });
        // The two projects the run uploaded captures for, while they download; the three it did
        // not are listed as such at once.
        await expect.poll(() => downloading.count(), { timeout: 10000 }).toBe(2);
        const card = await page.locator('.card[data-target="123"]').textContent();
        // How many artifacts and bytes have landed, and for how long it has been downloading.
        expect(card).toMatch(/Downloading: 0 of 2 artifacts, 0\.0 MB of 2\.0 MB, \d+ s/);
        expect(card).not.toContain("none");
        // In the background: said in the status row, never in the box.
        await expect.poll(status).toMatch(/^Downloading captures in the background: #123/);
        expect(await box()).toBeNull();
        release();
        await page.getByRole("button", { name: "Review", exact: true }).first().waitFor({ timeout: 10000 });
        expect(await downloading.count()).toBe(0);
    }, 30000);

    it("says what a slow project or a slow save waits for", async () => {
        await open((r) => ({ gh: onePr()(r) }), { review: false });
        let release;
        const held = new Promise((resolve) => (release = resolve));
        await page.route("**/api/pr/123/compact-mantine", async (route) => {
            await held;
            await route.continue();
        });
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await expect.poll(() => box("title")).toBe("Opening compact-mantine");
        expect(await box("text")).toBe("Reading the compact-mantine captures from the server.");
        release();
        await page.locator(".component").first().waitFor();
        expect(await box()).toBeNull();
        await page.unroute("**/api/pr/123/compact-mantine");
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await ready();
        let save;
        const saved = new Promise((resolve) => (save = resolve));
        await page.route("**/api/decide", async (route) => {
            await saved;
            await route.continue();
        });
        await page.keyboard.press("a");
        await expect.poll(status).toBe("Saving the last decision...");
        await page.keyboard.press("r");
        await expect.poll(status).toBe("Still saving the last decision.");
        save();
        await expect.poll(status).toMatch(/^Accepted #2\. Now #3/);
    });
});

describe("review page: the wait box", () => {
    // graphty-element's captures are held until the test releases them.
    const heldDownload = () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        const options = (r) => {
            const gh = onePr()(r);
            return {
                gh: async (args, input) => {
                    if (args[0] === "run" && args[4] === "visual-graphty-element-1") {
                        await held;
                    }
                    return gh(args, input);
                },
            };
        };
        return { options, release: () => release() };
    };
    const geRow = () => page.locator('.card[data-target="123"] tr', { hasText: "graphty-element" });

    it("shows a project still downloading in the middle of an iPad's screen, with its progress, and opens it when it lands", async () => {
        const { options, release } = heldDownload();
        const viewport = { width: 820, height: 1180 };
        await open(options, { review: false, touch: true, viewport });
        await geRow().getByRole("button", { name: "Downloading..." }).waitFor({ timeout: 10000 });
        await geRow().getByRole("button", { name: "Downloading..." }).click();
        await expect.poll(() => box("title")).toBe("Downloading graphty-element captures for #123");
        expect(await box("text")).toBe(
            "CI run 1000's captures are not on this computer yet. graphty-element (1.0 MB) downloads first; " +
                "the rest go on in the background.",
        );
        await expect.poll(() => box("detail")).toBe("1 of 2 artifacts, 1.0 MB of 2.0 MB");
        await expect.poll(() => box("elapsed")).toMatch(/^\d+ s$/);
        expect(await page.locator("#wait-bar").evaluate((b) => [b.value, b.max])).toEqual([1, 2]);
        // Centered, whole on the screen, and the same size while its lines change.
        const at = await page.locator("#wait").boundingBox();
        expect(Math.abs(at.x + at.width / 2 - viewport.width / 2)).toBeLessThan(2);
        expect(Math.abs(at.y + at.height / 2 - viewport.height / 2)).toBeLessThan(2);
        expect(at.x).toBeGreaterThanOrEqual(16);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(await page.locator("#wait").boundingBox()).toEqual(at);
        // Cancel closes it and leaves the targets as they were; the download goes on.
        expect(await page.locator("#wait-retry").isVisible()).toBe(false);
        await page.locator("#wait-cancel").click();
        expect(await box()).toBeNull();
        expect(await page.locator('.card[data-target="123"]').count()).toBe(1);
        await geRow().getByRole("button", { name: "Downloading..." }).click();
        await expect.poll(() => box("title")).toBe("Downloading graphty-element captures for #123");
        release();
        await page.locator(".component").first().waitFor({ timeout: 10000 });
        expect(await box()).toBeNull();
        expect(await page.locator("#pick-project").inputValue()).toBe("graphty-element");
    }, 30000);

    it("says in the box which GitHub call waits to retry, then turns a failure into an error with Retry", async () => {
        let fails = 1;
        let down = false;
        await open(
            (r) => {
                const gh = onePr()(r);
                return {
                    gh: withRetries(
                        async (args, input) => {
                            if ((args[1] ?? "").includes("/pulls?")) {
                                if (down) {
                                    throw new Error("HTTP 401: Bad credentials");
                                }
                                if (fails-- > 0) {
                                    throw new Error("Could not resolve host: api.github.com");
                                }
                            }
                            return gh(args, input);
                        },
                        [1500],
                    ),
                };
            },
            { review: false },
        );
        await expect
            .poll(() => box("net"))
            .toMatch(
                /^GitHub did not answer \(Could not resolve host: api\.github\.com\)\. Trying again in \d s, try 2 of 2\.$/,
            );
        await page.getByRole("button", { name: "Review", exact: true }).first().waitFor({ timeout: 10000 });
        expect(await box()).toBeNull();
    }, 30000);

    it("turns the first load into an error with Retry when GitHub refuses, and Retry loads the list", async () => {
        let down = true;
        await open(
            (r) => {
                const gh = onePr()(r);
                return {
                    gh: async (args, input) => {
                        if (down && (args[1] ?? "").includes("/pulls?")) {
                            throw new Error("HTTP 401: Bad credentials");
                        }
                        return gh(args, input);
                    },
                };
            },
            { review: false },
        );
        await expect
            .poll(() => box("error"))
            .toBe("Could not read the pull requests from GitHub: HTTP 401: Bad credentials");
        expect(await box("title")).toBe("Loading the pull requests");
        await expect.poll(() => box("elapsed")).toMatch(/^Stopped after \d+ s$/);
        expect(await page.locator("#wait-retry").isVisible()).toBe(true);
        expect(await page.locator("#wait-cancel").textContent()).toBe("Close");
        down = false;
        await page.locator("#wait-retry").click();
        await page.getByRole("button", { name: "Review", exact: true }).first().waitFor({ timeout: 10000 });
        expect(await box()).toBeNull();
    }, 30000);

    it("never shows the box for a refresh in the background: the status row says it", async () => {
        let release = () => {};
        let hold = false;
        await open(
            (r) => {
                const gh = onePr()(r);
                return {
                    gh: async (args, input) => {
                        if (hold && (args[1] ?? "").includes("/pulls?")) {
                            await new Promise((resolve) => (release = resolve));
                        }
                        return gh(args, input);
                    },
                };
            },
            { review: false },
        );
        await page.getByRole("button", { name: "Review", exact: true }).first().waitFor();
        hold = true;
        await page.getByRole("button", { name: "Refresh" }).click();
        await expect.poll(status).toMatch(/^Checking GitHub for new CI runs Listing pull requests, \d+ s$/);
        for (let i = 0; i < 5; i++) {
            expect(await box()).toBeNull();
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // The targets stay usable meanwhile.
        expect(await page.getByRole("button", { name: "Review", exact: true }).first().isEnabled()).toBe(true);
        release();
        await expect.poll(status).toBe("");
    }, 30000);
});

describe("review page: moving on", () => {
    it("offers the next project at the end of a pass, opening its first undecided item", async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator("#review-undecided").click();
        for (let n = 2; n <= 6; n++) {
            await page.keyboard.press("j");
            await expect.poll(position).toMatch(new RegExp(`^${n} of `));
        }
        // J on the last item does not wrap: it shows what is next.
        await page.keyboard.press("j");
        await expect
            .poll(() => page.locator("#end-heading").textContent())
            .toBe("End of compact-mantine: 0 of 6 decided, 6 undecided.");
        const offers = await page.locator("#endcard .offers button").allTextContents();
        // The next project comes first, so Enter moves on; the items left here come next.
        expect(offers).toEqual([
            "Next project: graphty-element (1 undecided)",
            "Review the 6 undecided",
            "Back to the grid",
        ]);
        expect(await page.evaluate(() => globalThis.document.activeElement.textContent)).toBe(offers[0]);
        // K comes back to the last item.
        await page.keyboard.press("k");
        await expect.poll(position).toMatch(/^6 of /);
        await page.keyboard.press("j");
        await page.locator("#endcard .offers button").first().waitFor();
        await page.getByRole("button", { name: "Next project: graphty-element (1 undecided)" }).click();
        await expect.poll(() => page.locator("#pick-project").inputValue()).toBe("graphty-element");
        await expect.poll(position).toMatch(/^1 of 1 /);
        // Deciding the last item of a pass shows the same card.
        await ready();
        await page.keyboard.press("a");
        await expect
            .poll(() => page.locator("#end-heading").textContent())
            .toBe("End of graphty-element: 1 of 1 decided, 0 undecided.");
        expect(await page.locator("#endcard .offers button").first().textContent()).toBe(
            "Next project: compact-mantine (6 undecided)",
        );
    });

    it("offers Finish and the next target when every project of a target is decided", async () => {
        await open((r) => ({ gh: twoPrs(r) }));
        await page.locator(".component").first().waitFor();
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("4 of 6 decided");
        // Only the failed and unstable items are left. At the end of a pass over them the next
        // project still comes first, and the card says these can only be excluded.
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await page.keyboard.press("j");
        await page.locator("#endcard .offers button").first().waitFor();
        expect((await page.locator("#endcard .offers button").allTextContents()).slice(0, 2)).toEqual([
            "Next project: graphty-element (1 undecided)",
            "Review the 2 undecided (Exclude only)",
        ]);
        await page.keyboard.press("Escape");
        await page.locator(".component").first().waitFor();
        // Exclude them.
        for (const n of [1, 5]) {
            await openStory(n);
            await ready();
            await page.locator("#note").fill("flaky");
            await page.keyboard.press("Escape");
            await page.keyboard.press("e");
            await expect.poll(status).toMatch(/^Excluded #/);
            await page.keyboard.press("Escape");
        }
        await page.locator("#pick-project").selectOption("graphty-element");
        await page.locator(".component").first().waitFor();
        await page.locator("#review-undecided").click();
        await ready();
        await page.keyboard.press("a");
        await expect.poll(() => page.locator("#endcard").textContent()).toContain("Every project of #123 is decided.");
        expect(await page.locator("#endcard .offers button").allTextContents()).toEqual([
            "Finish #123 (7)",
            "Back to the grid",
            "Next: #124 (7 undecided)",
        ]);
        await page.getByRole("button", { name: "Next: #124 (7 undecided)" }).click();
        await expect.poll(() => page.locator("#pick-target").inputValue()).toBe("124");
        await expect.poll(position).toMatch(/^1 of 6 /);
    });

    it("jumps to another target and project from the header's pickers", async () => {
        await open((r) => ({ gh: twoPrs(r) }));
        await page.locator(".component").first().waitFor();
        expect(await page.locator("#pick-target option").allTextContents()).toEqual(["#123 (7)", "#124 (7)"]);
        expect(await page.locator("#pick-project option").allTextContents()).toEqual([
            "compact-mantine (6)",
            "graphty-element (1)",
        ]);
        await page.locator("#pick-target").selectOption("124");
        await page.locator(".component").first().waitFor();
        await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.slice(1)).get("target")).toBe("124");
    });
});

describe("review page: navigation, on an iPad", () => {
    const hash = () => new URLSearchParams(new URL(page.url()).hash.slice(1));
    const shown = (id) => page.locator(`#${id}`).isVisible();
    const project = () => page.locator("#pick-project").inputValue();

    for (const [held, viewport] of [
        ["upright", { width: 1024, height: 1366 }],
        ["sideways", { width: 1366, height: 1024 }],
    ]) {
        it(`held ${held}: the header's crumbs go up to the grid and the targets, and forward into the item last opened`, async () => {
            await open((r) => ({ gh: onePr()(r) }), { viewport, touch: true });
            await page.locator(".component").first().waitFor();
            // The grid: target and project, no Grid crumb, nothing opened yet.
            expect(await shown("crumbs")).toBe(true);
            expect(await shown("to-grid")).toBe(false);
            expect(await shown("to-item")).toBe(false);
            // A pass, two items in: the Grid crumb goes up, keeping the pass.
            await page.locator("#review-undecided").click();
            await page.keyboard.press("j");
            await page.keyboard.press("j");
            await expect.poll(position).toMatch(/^3 of 6 /);
            expect(await shown("to-grid")).toBe(true);
            expect(await shown("to-item")).toBe(false);
            await page.locator("#to-grid").click();
            await page.locator(".component").first().waitFor();
            expect(hash().has("item")).toBe(false);
            // On the grid the last crumb is the item just left; it goes back into it, in its pass.
            expect(await page.locator("#to-item").textContent()).toBe("#3 slider--sizes");
            await page.locator("#to-item").click();
            await expect.poll(position).toMatch(/^3 of 6 /);
            expect(hash().get("pass")).toBe("undecided");
            // Escape goes up one level at a time: the grid, then the targets; an open More closes first.
            await page.keyboard.press("Escape");
            await page.locator(".component").first().waitFor();
            await page.locator(".gridbar details.menu > summary").click();
            await page.keyboard.press("Escape");
            expect(await page.locator(".gridbar details.menu").evaluate((d) => d.open)).toBe(false);
            expect(await page.locator(".component").count()).toBeGreaterThan(0);
            await page.keyboard.press("Escape");
            await page.locator(".card").first().waitFor();
            expect(await shown("crumbs")).toBe(false);
            expect([...hash().keys()]).toEqual(["token"]);
            // Back returns to the grid.
            await page.goBack();
            await page.locator(".component").first().waitFor();
            expect(hash().get("project")).toBe("compact-mantine");
            // Every crumb is inside the window and tall enough for a finger.
            const bad = await page.evaluate(() =>
                [...globalThis.document.querySelectorAll("#crumbs > *")]
                    .filter((e) => e.getClientRects().length > 0)
                    .map((e) => [e.id || e.className, e.getBoundingClientRect()])
                    .filter(
                        ([name, r]) =>
                            r.right > globalThis.innerWidth + 0.5 ||
                            r.height < 44 ||
                            (/-project$/.test(name) && r.width < 44),
                    )
                    .map(([name]) => name),
            );
            expect(bad).toEqual([]);
        });
    }

    it("steps to the next and previous project with undecided items with ] and [, skipping the rest", async () => {
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 1024, height: 1366 }, touch: true });
        await page.locator(".component").first().waitFor();
        expect(await project()).toBe("compact-mantine");
        // From the grid, the next project's grid; it wraps.
        await page.keyboard.press("]");
        await expect.poll(project).toBe("graphty-element");
        expect(hash().has("item")).toBe(false);
        await page.keyboard.press("]");
        await expect.poll(project).toBe("compact-mantine");
        await page.locator("#prev-project").click();
        await expect.poll(project).toBe("graphty-element");
        await page.keyboard.press("[");
        await expect.poll(project).toBe("compact-mantine");
        await page.locator("#review-undecided").click();
        await expect.poll(position).toMatch(/^1 of 6 /);
        await page.keyboard.press("]");
        await expect.poll(project).toBe("graphty-element");
        await expect.poll(position).toMatch(/^1 of 1 /);
        // Decided, graphty-element is skipped: nothing else has undecided items from compact-mantine.
        await ready();
        await page.keyboard.press("a");
        await page.locator("#endcard").waitFor();
        await page.keyboard.press("]");
        await expect.poll(project).toBe("compact-mantine");
        await expect.poll(position).toMatch(/^1 of 6 /);
        expect(await page.locator("#next-project").getAttribute("aria-disabled")).toBe("true");
        await page.keyboard.press("]");
        await expect.poll(status).toBe("No other project of #123 has undecided items.");
        expect(await project()).toBe("compact-mantine");
    });
});

describe("review page: links and the frozen pass", () => {
    beforeEach(async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator(".component").first().waitFor();
    });

    const hash = () => new URLSearchParams(new URL(page.url()).hash.slice(1));
    // A link opened afresh, as when pasted into another tab or device.
    async function visit(url) {
        await page.goto("about:blank");
        await page.goto(url);
    }

    it("puts every screen in the address and opens it again from a copied link", async () => {
        expect(Object.fromEntries(hash())).toMatchObject({ token: TOKEN, target: "123", filter: "undecided" });
        // The grid, with its filters.
        await page.getByRole("button", { name: /^All/ }).click();
        await page.locator("#find").fill("slider");
        await expect.poll(() => hash().get("q")).toBe("slider");
        const grid = page.url();
        await visit(grid);
        await expect.poll(visibleTiles).toBe(1);
        expect(await page.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
        expect(await page.locator("#find").inputValue()).toBe("slider");
        // A story, with its pass, view and zoom.
        await page.locator("#find").fill("");
        await expect.poll(() => hash().has("q")).toBe(false);
        await openStory(2);
        await page.keyboard.press("s");
        await page.getByRole("button", { name: "2x", exact: true }).click();
        await expect.poll(() => hash().get("zoom")).toBe("2");
        expect(Object.fromEntries(hash())).toMatchObject({
            item: "button--primary.dark.png",
            pass: "all",
            view: "spotlight",
        });
        const story = page.url();
        await visit(story);
        await expect.poll(position).toMatch(/^2 of 6 /);
        expect(await page.locator("h2").textContent()).toContain("button--primary (dark)");
        await expect.poll(stageClass).toBe("stage spotlight zoom-2");
        // The outline and blink choices ride along, and a link's choice wins over this browser's.
        expect(Object.fromEntries(hash())).toMatchObject({ box: "on", blink: "off" });
        const boxed = new URL(page.url());
        const p = new URLSearchParams(boxed.hash.slice(1));
        p.set("box", "off");
        p.set("blink", "on");
        p.set("view", "highlight");
        boxed.hash = String(p);
        await visit(boxed.href);
        await expect.poll(position).toMatch(/^2 of 6 /);
        const box = page.locator("#opt-showBox");
        await expect.poll(() => box.getAttribute("aria-pressed")).toBe("false");
        expect(await page.locator("#opt-blink").getAttribute("aria-pressed")).toBe("true");
        // The targets screen.
        await page.locator("#home").click();
        await expect.poll(() => [...hash().keys()]).toEqual(["token"]);
        await visit(page.url());
        await expect.poll(() => page.getByRole("button", { name: "Review", exact: true }).count()).toBeGreaterThan(0);
    });

    it("reopens the same pass at the same place after a reload", async () => {
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await expect.poll(position).toMatch(/^2 of 6 /);
        await ready();
        await page.keyboard.press("a");
        await expect.poll(position).toMatch(/^3 of 6 /);
        await page.reload();
        await expect.poll(position).toBe("3 of 6 -- 5 left");
        // The decided item is still in the pass.
        await page.keyboard.press("k");
        await expect.poll(position).toMatch(/^2 of 6 /);
        expect(await page.locator("#accept").getAttribute("aria-pressed")).toBe("true");
    });

    it("goes Back and Forward between the screens without asking GitHub", async () => {
        await openStory(3);
        const calls = [];
        page.on("request", (req) => calls.push(req.url()));
        await page.goBack();
        await page.locator(".component").first().waitFor();
        await expect.poll(() => page.locator(".tile.current").getAttribute("data-file")).toBe("slider--sizes.png");
        await page.goForward();
        await expect.poll(position).toMatch(/^3 of 6 /);
        await page.locator("#home").click();
        await page.locator(".card").first().waitFor();
        await page.goBack();
        await expect.poll(position).toMatch(/^3 of 6 /);
        // Only the cached list was read: no request that refreshes from GitHub.
        expect(calls.filter((u) => u.includes("/api/prs") && !u.includes("cached=1"))).toEqual([]);
    });

    it("lands on the nearest screen, saying why, when a link names what is gone", async () => {
        const link = new URL(page.url());
        link.hash = `token=${TOKEN}&target=123&project=${hash().get("project")}&filter=all&item=gone--story.png`;
        await visit(link.href);
        await expect.poll(status).toBe("gone--story.png is not in this CI run any more: showing the grid.");
        expect(hash().has("item")).toBe(false);
        expect(await page.locator(".component").count()).toBeGreaterThan(0);
        link.hash = `token=${TOKEN}&target=999&project=x`;
        await visit(link.href);
        await expect.poll(status).toBe("999 is no longer listed: showing every target.");
        expect([...hash().keys()]).toEqual(["token"]);
    });

    it("copies the link to the screen", async () => {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
        // The header keeps Copy link from 1050 px; narrower, it is in the Options and More menus.
        await page.setViewportSize({ width: 1280, height: 800 });
        await openStory(2);
        await page.locator("#copy-link").click();
        await expect.poll(status).toContain("Link copied");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
    });

    it("lists every key, and the recent messages, in the Keys overlay", async () => {
        await page.locator("#find").fill("99999");
        await page.locator("#find").press("Enter");
        await page.locator("#find").blur();
        await page.keyboard.press("?");
        const keys = page.locator("dialog.keys");
        await keys.waitFor();
        expect(await keys.textContent()).toContain("No item 99999: items are numbered 1 to 6 in All.");
        expect(await keys.textContent()).toContain("Single-key shortcuts: on");
        await page.keyboard.press("?");
        await expect.poll(() => keys.count()).toBe(0);
        await page.locator("#keys-button").click();
        await keys.waitFor();
        // Off, a letter no longer opens Find story or accepts.
        await keys.getByRole("button", { name: "Single-key shortcuts: on" }).click();
        await keys.getByRole("button", { name: "Close" }).click();
        await page.keyboard.press("/");
        expect(await page.locator("#find:focus").count()).toBe(0);
    });

    it("keeps decided items in the pass: Previous goes back to one, and U undoes it", async () => {
        await openStory(2);
        await ready();
        await page.keyboard.press("a");
        await expect.poll(position).toMatch(/^3 of 6 /);
        await ready();
        await page.getByRole("button", { name: "Accept", exact: true }).click();
        await expect.poll(position).toMatch(/^4 of 6 /);
        await page.getByRole("button", { name: "Prev", exact: true }).click();
        await expect.poll(position).toMatch(/^3 of 6 /);
        expect(await page.locator("#accept").getAttribute("aria-pressed")).toBe("true");
        await page.keyboard.press("u");
        await expect.poll(status).toBe("Undid #3: undecided again.");
        expect(await position()).toMatch(/^3 of 6 /);
        await page.keyboard.press("k");
        await expect.poll(position).toMatch(/^2 of 6 /);
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await expect.poll(status).toBe("Undid #2: undecided again.");
        await ready();
        await page.keyboard.press("a");
        await expect.poll(position).toMatch(/^3 of 6 /);
        // The grid drops what was decided once the owner goes back to it.
        await page.keyboard.press("Escape");
        await expect
            .poll(() => page.getByRole("button", { name: /^Needs a decision/ }).textContent())
            .toBe("Needs a decision (5)");
        expect(await page.locator('.tile[data-file="button--primary.dark.png"]').count()).toBe(0);
    });
});

describe("review page: Finish", () => {
    it("states the accept notes and rejects it will publish, and refuses when they changed since", async () => {
        const r = await open((x) => ({ gh: onePr()(x) }));
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await ready();
        await page.locator("#note").fill("new spacing is intended");
        await page.locator("#note").press("Escape");
        await page.keyboard.press("a");
        await expect.poll(status).toMatch(/^Accepted #2\./);
        await ready();
        await page.keyboard.press("r");
        await page.keyboard.type("too tall");
        await page.keyboard.press("Enter");
        await expect.poll(status).toMatch(/^Rejected #3\./);
        expect(await page.getByRole("button", { name: /^Finish/ }).textContent()).toBe("Finish #123 (2)");
        // A decision taken elsewhere (another tab) after the sheet opened.
        let changed = false;
        await page.route("**/api/finish", async (route) => {
            if (!changed) {
                changed = true;
                // The sheet that comes back is cancelled.
                confirmFinish = false;
                await fetch(`${origin}/api/decide`, {
                    method: "POST",
                    headers: { "x-review-token": TOKEN, origin, "content-type": "application/json" },
                    body: JSON.stringify({
                        id: "123",
                        project: "compact-mantine",
                        file: "card--legacy.png",
                        decision: "accept",
                    }),
                });
            }
            await route.continue();
        });
        confirmFinish = true;
        await page.getByRole("button", { name: /^Finish/ }).click();
        await expect.poll(() => dialogs.length).toBe(2);
        expect(dialogs[0].split("\n").filter(Boolean).slice(0, 7)).toEqual([
            "Finish #123, every project:",
            "Commit 1 accept to feature.",
            "Post 1 reject and 1 accept note as a comment on #123.",
            "Then set the commit status 'Visual review' to failure (1 rejected).",
            "Still undecided, left for a later round: compact-mantine 4, graphty-element 1.",
            "Not loaded, so not reviewed: layout, algorithms, graphty.",
            "Notes to publish:",
        ]);
        expect(dialogs[0]).toContain("Rejected compact-mantine/slider--sizes.png: too tall");
        expect(dialogs[0]).toContain("Accepted compact-mantine/button--primary.dark.png: new spacing is intended");
        // The sheet comes back with the new summary, saying why.
        expect(dialogs[1]).toContain("Decisions changed since this sheet opened: check the summary again.");
        expect(dialogs[1]).toContain("Commit 2 accepts to feature.");
        expect(r.repo).toBeTruthy();
    });

    it("shows each step, survives a reload without offering a second Finish, then shows the result", async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        // The commit status waits until the test releases it, so the Finish is caught running.
        await open((r) => {
            const gh = twoPrs(r);
            return {
                gh: async (args, input) => {
                    if (args[1]?.includes("/statuses/")) {
                        await gate;
                    }
                    return gh(args, input);
                },
            };
        });
        await page.locator(".component").first().waitFor();
        confirmFinish = true;
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("4 of 6 decided");
        await page.getByRole("button", { name: /^Finish/ }).click();
        // The commit, the LFS upload and the push come first: seconds on a busy runner.
        const slow = { timeout: 30000 };
        await expect.poll(status, slow).toBe("Finishing #123: posting the status...");
        // The wait box follows it step by step, over the page.
        await expect.poll(() => box("title")).toBe("Finishing #123");
        await expect
            .poll(() => page.locator("#wait #finish-panel li.now").textContent())
            .toBe("Posting the status: in progress");
        expect(await box("detail")).toBe("5 of 6 steps done");
        expect(await page.locator("#finish-panel li.done").allTextContents()).toEqual([
            "Checking: done",
            "Writing the files: done",
            "Committing: done",
            "Uploading images to LFS: done",
            "Pushing: done",
        ]);

        await page.reload();
        await expect.poll(status).toBe("Finishing #123: posting the status...");
        await expect
            .poll(() => page.locator(".finish-running").textContent())
            .toBe("Finish is running: posting the status...");
        expect(await page.getByRole("button", { name: /^Finish #123/ }).count()).toBe(0);
        // A reload finds the running Finish and blocks the page again, with no Cancel: closing the
        // page never stops a Finish.
        await expect.poll(() => box("title")).toBe("Finishing #123");
        expect(await page.locator("#wait-cancel").isVisible()).toBe(false);

        release();
        await expect
            .poll(() => page.locator(".finish-outcome").textContent(), slow)
            .toMatch(
                /^Finished #123\.Committed \w{10} to feature\.Commit status: pending -- 4 accepted, 0 rejected, 0 excluded, 3 undecided, not loaded: layout, algorithms, graphty\./,
            );
        expect(await page.locator(".finish-running").count()).toBe(0);
        expect(await box()).toBeNull();
        // Focus is on the result, so a screen reader reads it.
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement.id)).toBe("outcome-heading");
        expect(await page.locator(".finish-outcome .offers button").allTextContents()).toEqual([
            "Next: #124 (7 undecided)",
            "Back to #123",
            "Dismiss",
        ]);
        // What it pushed stays decided, said to be waiting for the next CI run, not undecided again.
        await expect
            .poll(() => page.locator('.card[data-target="123"]').textContent())
            .toContain("Finished: 4 decisions already on the branch, waiting for the next CI run");
        expect(
            await page
                .locator('.card[data-target="123"]')
                .getByRole("button", { name: /^Finish #123/ })
                .getAttribute("aria-disabled"),
        ).toBe("true");
    }, 60000);
});

// The passkeys file on the default branch, as merging a registration pull request leaves it.
function passkeysOnMaster(r, keys) {
    mkdirSync(join(r.repo, "visual-review"), { recursive: true });
    writeFileSync(join(r.repo, "visual-review/passkeys.json"), `${JSON.stringify({ version: 1, keys })}\n`);
    git(r.repo, "add", "visual-review/passkeys.json");
    git(r.repo, "commit", "-q", "-m", "register a passkey");
    git(r.repo, "push", "-q", "origin", "master");
}

describe("review page: update from master", () => {
    it("warns on opening a project master has newer baselines for, and updates the branch from the warning", async () => {
        const r = await open((repo) => {
            pushCommit(repo.remote, "master", "visual-baselines/compact-mantine/other.png");
            return { gh: onePr()(repo) };
        });
        const stale = page.locator("#stale");
        await stale.waitFor();
        expect(await stale.locator(".warning").textContent()).toBe(
            "master has 1 newer compact-mantine baseline since this capture; this review is out of date. " +
                "Finish refuses it until the branch has them.",
        );
        await stale.locator("summary").click();
        expect(await stale.locator("li").allTextContents()).toEqual(["other.png"]);
        await page.locator("#update-from-master").click();
        await expect.poll(() => page.locator("#outcome-heading").textContent()).toBe("Updated #123 from master.");
        expect(dialogs[0]).toMatch(/^Update #123 from master\? This merges master into feature/);
        expect(git(r.remote, "rev-parse", "feature^1")).toBe(r.head);
        expect(await page.locator(".finish-outcome li").allTextContents()).toEqual([
            "visual-baselines/compact-mantine/other.png",
        ]);
    });

    it("shows no warning when the branch has master's baselines", async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator(".component").first().waitFor();
        expect(await page.locator("#stale").count()).toBe(0);
    });
});

describe("review page: the passkey", () => {
    // Chromium's virtual authenticator (CDP) stands in for Face ID: a real browser makes the
    // registration and the approval, and the server's own checks verify them.
    it("registers a passkey, then Finish asks for it; a refused approval changes nothing", async () => {
        const opened = [];
        const r = await open(
            (repo) => {
                const gh = onePr()(repo);
                return {
                    gh: async (args, input) => {
                        if (args[1] === "repos/{owner}/{repo}/pulls") {
                            opened.push(JSON.parse(input));
                            return JSON.stringify({ html_url: "https://gh/pull/500" });
                        }
                        return gh(args, input);
                    },
                };
            },
            { review: false, host: "localhost" },
        );
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("WebAuthn.enable");
        const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
            options: {
                protocol: "ctap2",
                transport: "internal",
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
            },
        });
        // Safari starts WebAuthn only from the press itself: each prompt must begin while the
        // dialog is still open, inside the yes button's click, not after its close event.
        await page.evaluate(() => {
            const { document, navigator } = globalThis;
            globalThis.whileAsking = [];
            for (const name of ["create", "get"]) {
                const real = navigator.credentials[name].bind(navigator.credentials);
                navigator.credentials[name] = (o) => {
                    globalThis.whileAsking.push(document.querySelector("dialog.ask[open]") !== null);
                    return real(o);
                };
            }
        });

        await page.getByRole("button", { name: "Register passkey" }).click();
        await expect.poll(status, { timeout: 30000 }).toMatch(/^Passkey registered \((Linux|Mac|Windows) passkey, /);
        const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
        expect(credentials).toHaveLength(1);
        const id = Buffer.from(credentials[0].credentialId, "base64").toString("base64url");
        expect(await status()).toContain(`credential id ${id}. Opened https://gh/pull/500: check it names this id`);
        const [entry] = parsePasskeys(git(r.remote, "show", `${opened[0].head}:visual-review/passkeys.json`));
        expect(entry).toMatchObject({ id, rpId: "localhost" });
        // Not merged yet: Finish asks for it already, and the line says the gate does not check yet.
        await expect
            .poll(() => page.locator(".passkey-line").textContent())
            .toBe(
                "Passkey waiting for #500 to merge: Finish asks for it already, but the CI gate checks approvals only once it is merged.",
            );

        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await page.locator(".component").first().waitFor();
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("4 of 6 decided");
        confirmFinish = true;
        const finish = page.getByRole("button", { name: /^Finish #123/ });

        // Face ID refused: nothing is pushed, and the sheet stays to try again.
        await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
        const asked = dialogs.length;
        await finish.click();
        await expect.poll(() => dialogs.length, { timeout: 30000 }).toBeGreaterThan(asked + 1);
        expect(dialogs[asked]).toContain("Your passkey confirms this Finish (Face ID or a security key).");
        expect(dialogs.at(-1)).toContain("Passkey cancelled: nothing was changed.");
        expect(git(r.remote, "rev-parse", "feature")).toBe(r.head);

        // The retry, with Face ID passing, signs and finishes.
        await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
        await expect
            .poll(() => page.locator(".finish-outcome h2").textContent(), { timeout: 30000 })
            .toBe("Finished #123.");
        const files = git(r.remote, "show", "--name-only", "--format=", "feature").split("\n");
        const record = JSON.parse(git(r.remote, "show", `feature:${files.find((f) => f.includes("reviews/"))}`));
        expect(record).toMatchObject({ version: 2, pr: 123 });
        expect(verifyApproval(record, [entry], { origin })).toBeNull();
        expect(new Set(await page.evaluate(() => globalThis.whileAsking))).toEqual(new Set([true]));
    }, 90000);

    it("says plainly that accepts are not yet protected while no passkey is registered", async () => {
        const r = await open((repo) => ({ gh: onePr()(repo) }), { review: false });
        await expect
            .poll(() => page.locator(".passkey-line").textContent())
            .toBe(
                "No passkey registered: accepts are not yet protected. Finish commits them without your approval, and the CI gate does not check who accepted them until a passkey is on master. Register passkey",
            );
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await page.locator(".component").first().waitFor();
        await page.keyboard.press("Shift+A");
        await expect.poll(progress).toBe("4 of 6 decided");
        confirmFinish = true;
        await page.getByRole("button", { name: /^Finish #123/ }).click();
        await expect
            .poll(() => page.locator(".finish-outcome h2").textContent(), { timeout: 30000 })
            .toBe("Finished #123.");
        expect(dialogs.at(-1)).toContain(
            "Not yet protected: no passkey is registered, so this Finish is not approved by you and the CI gate does not check who accepted.",
        );
        const files = git(r.remote, "show", "--name-only", "--format=", "feature").split("\n");
        const record = JSON.parse(git(r.remote, "show", `feature:${files.find((f) => f.includes("reviews/"))}`));
        expect(record).toMatchObject({ version: 1, unproven: true });
    }, 60000);

    it("finishes rejects alone without asking for a passkey to be registered first", async () => {
        // The passkeys file is on the default branch with no key yet: what master holds once this
        // tool's passkey support merges, before the owner registers one.
        await open(
            (r) => {
                passkeysOnMaster(r, []);
                return { gh: onePr()(r) };
            },
            { review: true },
        );
        await page.locator("#review-undecided").click();
        await page.keyboard.press("j");
        await ready();
        await page.keyboard.press("r");
        await page.keyboard.type("text is clipped");
        await page.keyboard.press("Enter");
        await expect.poll(status).toMatch(/^Rejected #2\./);
        const header = page.locator("header");
        expect(await header.textContent()).not.toContain("Passkey");
        confirmFinish = true;
        await page.getByRole("button", { name: /^Finish #123/ }).click();
        await expect
            .poll(() => page.locator(".finish-outcome h2").textContent(), { timeout: 30000 })
            .toBe("Finished #123.");
        expect(dialogs.at(-1)).not.toContain("passkey");
    }, 60000);
});

describe("review page: narrow windows, touch and wording", () => {
    // Every control a box of, for checking nothing runs past the window's edge.
    const outside = () =>
        page.evaluate(() => {
            const { document, innerWidth } = globalThis;
            return [...document.querySelectorAll("header > *, .decisionbar > *, #note, .viewbar > *")]
                .filter((e) => e.getClientRects().length > 0)
                .map((e) => [e.id || e.className || e.tagName, e.getBoundingClientRect()])
                .filter(([, r]) => r.left < 0 || r.right > innerWidth + 0.5)
                .map(([name]) => name);
        });
    // Whether a text, set in an element's font, fits inside its content box.
    const fits = (selector, text) =>
        page.evaluate(
            ([sel, t]) => {
                const e = globalThis.document.querySelector(sel);
                const css = globalThis.getComputedStyle(e);
                const ctx = globalThis.document.createElement("canvas").getContext("2d");
                ctx.font = css.font;
                const room = e.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
                return { need: Math.ceil(ctx.measureText(t ?? e.placeholder).width), room };
            },
            [selector, text],
        );

    it("keeps the decision bar and the header on screen at every width, the note's hint whole", async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator(".component").first().waitFor();
        await openStory(2);
        await ready();
        // A wide desktop, an iPad on its side and upright, a zoomed page and iPad Split View.
        for (const width of [1280, 1180, 1024, 820, 600, 375, 320]) {
            await page.setViewportSize({ width, height: 900 });
            // Crossing 1100 px moves the note box between the decision row and the item row.
            await expect
                .poll(async () => {
                    const hint = await fits("#note");
                    return hint.need <= hint.room;
                }, `the note's hint at ${width} px`)
                .toBe(true);
            expect({ width, outside: await outside() }).toEqual({ width, outside: [] });
        }
    });

    it("gives the project menu room on an iPad held upright", async () => {
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 820, height: 1180 } });
        await page.locator(".component").first().waitFor();
        const name = await page.locator("#pick-project option:checked").textContent();
        expect(name).toBe("compact-mantine (6)");
        // The menu's arrow takes about 24 px of its content box.
        const shown = await fits("#pick-project", name);
        expect(shown.need + 24).toBeLessThanOrEqual(shown.room);
    });

    // Text cut short in a label: the menus' chosen names (their arrow takes about 24 px) and the
    // position, each measured in its own font.
    const cut = (selectors) =>
        page.evaluate((sels) => {
            const { document, getComputedStyle } = globalThis;
            const ctx = document.createElement("canvas").getContext("2d");
            return sels.flatMap((sel) => {
                const e = document.querySelector(sel);
                const css = getComputedStyle(e);
                ctx.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
                const text = e.tagName === "SELECT" ? e.selectedOptions[0].textContent : e.textContent;
                const need = Math.ceil(ctx.measureText(text).width) + (e.tagName === "SELECT" ? 24 : 0);
                const room = e.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
                return need > room ? [`${sel} "${text}" needs ${need}, has ${room}`] : [];
            });
        }, selectors);

    for (const [held, viewport] of [
        ["upright", { width: 1024, height: 1366 }],
        ["sideways", { width: 1366, height: 1024 }],
    ]) {
        it(`held ${held} with hundreds of items: whole menu names, a whole position, and a tile's Undo a finger can press`, async () => {
            await open((r) => ({ gh: withMoved(r, MANY) }), { viewport, touch: true });
            await page.locator(".component").first().waitFor();
            expect(await page.locator("#pick-project option:checked").textContent()).toBe("compact-mantine (186)");
            expect(await cut(["#pick-target", "#pick-project"])).toEqual([]);
            await page.locator("#review-undecided").click();
            await page.keyboard.press("j");
            await expect.poll(position).toMatch(/^2 of \d{3} -- \d{3} left$/);
            expect(await cut(["#pick-target", "#pick-project", "#position"])).toEqual([]);
            // Back on the grid under All, a decided tile's Undo is as tall as any other control.
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: /^All/ }).click();
            await page.locator('.component[data-component="comp00"] h3 .accept').click();
            await expect.poll(status).toBe("Accepted 6 items in comp00.");
            const undo = page.locator('.component[data-component="comp00"] .decision button').first();
            expect((await undo.boundingBox()).height).toBeGreaterThanOrEqual(44);
        });
    }

    it("makes every control at least 44 px tall on a touch screen", async () => {
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 820, height: 1180 }, touch: true });
        await page.locator(".component").first().waitFor();
        const short = () =>
            page.evaluate(() =>
                [...globalThis.document.querySelectorAll("button, select, input, summary")]
                    .filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().height < 44)
                    .map((e) => e.id || e.textContent.trim()),
            );
        expect(await short()).toEqual([]);
        await openStory(2);
        await ready();
        expect(await short()).toEqual([]);
    });

    it("keeps Accept's label and key whole while the images load", async () => {
        await open((r) => ({ gh: onePr()(r) }), { viewport: { width: 1280, height: 800 } });
        await page.locator(".component").first().waitFor();
        let release;
        const held = new Promise((resolve) => (release = resolve));
        await page.route("**/api/img/123/compact-mantine/capture/button--primary.dark.png", async (route) => {
            await held;
            await route.continue();
        });
        await openStory(2);
        await page.locator("#accept .spinner").waitFor();
        const parts = await page.evaluate(() => {
            const accept = globalThis.document.getElementById("accept");
            const text = [...accept.childNodes].find((n) => n.nodeType === 3 && n.textContent === "Accept");
            const range = globalThis.document.createRange();
            range.selectNodeContents(text);
            const box = (r) => ({ left: r.left, right: r.right });
            // The spinner turns, and a turned square's bounding box is up to 1.41 times as wide as
            // the round spinner drawn in it: measured unturned, its box is the circle's extent.
            const spinner = accept.querySelector(".spinner");
            spinner.style.animation = "none";
            return {
                button: box(accept.getBoundingClientRect()),
                spinner: box(spinner.getBoundingClientRect()),
                label: box(range.getBoundingClientRect()),
                kbd: box(accept.querySelector("kbd").getBoundingClientRect()),
                clipped: accept.scrollWidth > accept.clientWidth,
            };
        });
        expect(parts.clipped).toBe(false);
        expect(parts.spinner.right).toBeLessThanOrEqual(parts.label.left);
        expect(parts.label.left).toBeGreaterThanOrEqual(parts.button.left);
        expect(parts.kbd.right).toBeLessThanOrEqual(parts.button.right);
        release();
    });

    it("never takes a stray key in the Keys overlay, says when shortcuts are off, and counts Z presses right", async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator(".component").first().waitFor();
        await page.keyboard.press("?");
        const keys = page.locator("dialog.keys");
        await keys.waitFor();
        // Focus is on the dialog box, so a Space typed as it opens switches nothing.
        expect(await page.evaluate(() => globalThis.document.activeElement.tagName)).toBe("DIALOG");
        await page.keyboard.press(" ");
        const toggle = keys.getByRole("button", { name: /^Single-key shortcuts/ });
        expect(await toggle.getAttribute("aria-pressed")).toBe("true");
        expect(await keys.textContent()).toContain("from Fit, 2x is two presses");
        await page.keyboard.press("?");

        // Two Z presses from Fit reach 2x, as the overlay says.
        await openStory(2);
        await page.keyboard.press("z");
        await page.keyboard.press("z");
        expect(await page.getByRole("button", { name: "2x", exact: true }).getAttribute("aria-pressed")).toBe("true");

        // Turning them off says so, and so does every letter typed while they are off, after a reload too.
        const off = "Single-key shortcuts are off: letters do nothing until you turn them on again in Keys (?).";
        await page.locator("#keys-button").click();
        await toggle.click();
        await expect.poll(status).toBe(off);
        await keys.getByRole("button", { name: "Close" }).click();
        await page.reload();
        await page.locator("#stage").waitFor();
        await page.locator("#app").focus();
        await page.keyboard.press("j");
        await expect.poll(status).toBe(off);
    });

    it("says 1 pixel and 1 line, not 1 pixels and 1 lines", async () => {
        await open((r) => ({ gh: onePr()(r) }), { review: false });
        await page.route("**/api/pr/123/compact-mantine", async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            for (const item of body.results?.items ?? body.items ?? []) {
                if (item.file === "button--primary.dark.png") {
                    item.changedPixels = 1;
                }
                if (item.file === "menu--open.png") {
                    item.console = ["Error: render timed out"];
                }
            }
            await route.fulfill({ response: res, json: body });
        });
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await page.locator(".component").first().waitFor();
        expect(await page.locator(".errors li").first().textContent()).toContain("console and stack (1 line)");
        await openStory(2);
        await expect.poll(() => page.locator(".itemline").textContent()).toContain("1 pixel changed");
    });
});

describe("review page: renamed stories", () => {
    const REASON =
        "renames.json renames old-menu--gone to menu--gone, but the Storybook has no story menu--gone: fix renames.json";
    beforeEach(async () => {
        const broken = {
            id: "menu--gone",
            mode: null,
            file: "menu--gone.png",
            from: "old-menu--gone",
            status: "failed",
            flaky: false,
            baseline: null,
            capture: null,
            size: null,
            baselineSize: null,
            changedPixels: null,
            bbox: null,
            threshold: 0.063,
            includeAA: false,
            reason: REASON,
            console: [],
        };
        await open((r) => ({ gh: withMoved(r, [broken]) }));
        await page.locator(".component").first().waitFor();
    });

    it("shows a moved story as a pair labeled with its old id, and a broken rename as an error", async () => {
        expect(await option("moved")).toBe("Moved (1)");
        const tile = page.locator('.tile[data-file="slider--sizes.png"]');
        expect(await tile.locator(".badge.moved").textContent()).toBe("moved");
        expect(await tile.locator(".moved-from").textContent()).toBe("moved from old-slider--sizes");
        expect(await page.locator(".errors").textContent()).toContain(REASON);

        await tile.click();
        expect(await page.locator("h2").first().textContent()).toContain("moved from old-slider--sizes");
        await expect
            .poll(() => page.locator("#stage .label").allTextContents())
            .toEqual(["Baseline of old-slider--sizes", "New"]);
        await ready();
        await page.keyboard.press("a");
        await expect.poll(() => page.locator("h2").first().textContent()).not.toContain("slider--sizes");
        const { decisions } = await page.evaluate(
            async (token) =>
                (await fetch("/api/pr/123/compact-mantine", { headers: { "x-review-token": token } })).json(),
            TOKEN,
        );
        expect(decisions["slider--sizes.png"]).toMatchObject({ decision: "accept" });
    });
});

describe("review page: a local preview", () => {
    beforeEach(async () => {
        await open(() => ({ gh: async () => "", results: FIXTURE }));
        await page.locator(".component").first().waitFor();
    });

    it("is never a seed and offers no decision and no Finish", async () => {
        await page.locator("#home").click();
        await expect.poll(() => page.locator("h2").first().textContent()).toMatch(/^Local preview /);
        expect(await page.locator("body").textContent()).not.toContain("master seed");
        expect(await page.getByRole("button", { name: /^Finish/ }).count()).toBe(0);
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await openStory(2);
        for (const id of ["accept", "reject", "exclude", "undo"]) {
            expect(await page.locator(`#${id}`).getAttribute("aria-disabled")).toBe("true");
        }
        expect(await page.locator("#explain").textContent()).toContain("Local preview: look only");
        await page.keyboard.press("a");
        await expect.poll(status).toBe("Local preview: look only. Nothing is decided on it.");
    });
});

// An option in the story's Options menu, the menu opened first when it is closed.
async function menuOption(name) {
    if (!(await page.locator("#options").evaluate((d) => d.open))) {
        await page.locator("#options > summary").click();
    }
    return page.getByRole("button", { name, exact: true });
}

// From a story view, back to the grid and into another story.
async function openStoryFromGrid(number) {
    // Escape goes up one level: from a story to the grid, but from the grid to the targets.
    if ((await page.locator(".decisionbar").count()) > 0) {
        await page.keyboard.press("Escape");
    }
    await page.locator(".component").first().waitFor();
    await openStory(number);
}
