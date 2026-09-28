/*
 * The review page in Chromium, over the results fixture served as pull request #123 by a fake gh:
 * the grid, the story views, zoom, the keys, decisions, Accept all and what Finish asks before it
 * commits. A last block serves the fixture as a local preview.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../trusted/lib/serve.mjs";
import { FIXTURE, isolateGit, makeRepo, onePr } from "./helpers.mjs";

const PROJECTS = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
const TOKEN = "p".repeat(43);
const START = "cd /repo && PORT=9 node visual-review/trusted/cli.mjs serve";

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

async function open(options) {
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
        startCommand: START,
        ...options(r),
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
}

afterEach(async () => {
    await page?.close();
    server?.close();
});

// In the grid's order: 1 menu--open (failed), 2 button--primary.dark (changed, box [160, 80, 40,
// 40]), 3 slider--sizes (changed), 4 badge--default.light (new), 5 tooltip--hover (unstable),
// 6 card--legacy (removed).
async function openStory(number) {
    await page.locator("#goto").fill(String(number));
    await page.locator("#goto").press("Enter");
    await expect.poll(() => page.locator("#position").textContent()).toMatch(new RegExp(`^${number} of `));
}

const stageClass = () => page.locator("#stage").getAttribute("class");
const status = () => page.locator("#status").textContent();

describe("review page: a pull request", () => {
    beforeEach(async () => {
        await open((r) => ({ gh: onePr()(r) }));
        await page.locator(".component").first().waitFor();
    });

    it("opens on what needs a decision: errors first with their stack, then components, changed first", async () => {
        const needs = page.getByRole("button", { name: /^Needs a decision/ });
        expect(await needs.getAttribute("aria-pressed")).toBe("true");
        // One count everywhere: 6 undecided, of which the failed capture is listed as an error.
        expect(await needs.textContent()).toBe("Needs a decision (6)");
        expect(await page.locator("#shown").textContent()).toBe(
            "Showing 6: 1 error (listed first, never accepted) and 5 images to compare.",
        );
        const error = page.locator(".errors li").first();
        expect(await error.textContent()).toContain("1 menu--open");
        expect(await error.textContent()).toContain("story render errored");
        expect(await error.locator("pre").textContent()).toContain("at play (menu.stories.tsx:12:5)");
        const components = await page.locator(".component").evaluateAll((s) => s.map((c) => c.dataset.component));
        expect(components).toEqual(["button", "slider", "badge", "tooltip", "card"]);
        // Each story's modes are nested under it, numbered in the story page's order.
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

    it("fits an image wider than its pane by default, and shows real size on request", async () => {
        await page.setViewportSize({ width: 500, height: 800 });
        await openStory(2);
        const img = page.locator("#stage img").first();
        await img.waitFor();
        const fitted = await img.evaluate((i) => [i.getBoundingClientRect().width, i.parentElement.clientWidth]);
        expect(fitted[0]).toBeLessThan(320);
        expect(Math.abs(fitted[0] - fitted[1])).toBeLessThanOrEqual(1);
        await page.getByRole("button", { name: "Real size (1x)" }).click();
        await expect.poll(() => img.evaluate((i) => i.getBoundingClientRect().width)).toBe(320);
    });

    it("shows images at real size, zooms at a labelled factor, crisp only from 4x, and jumps to the changed box", async () => {
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
        await expect.poll(() => page.locator("#box-count").textContent()).toBe("box 1 of 1");
        // At 4x the box (smaller than the pane) is out of sight at the top left, so the pane scrolls
        // just far enough to show all of it, outlined.
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

    it("flashes the two images themselves, with F and while Space is held", async () => {
        await openStory(2);
        await page.locator("#stage img").first().waitFor();
        await page.keyboard.press("f");
        await expect.poll(stageClass).toContain("flash");
        await expect.poll(() => page.locator("#stage img").count()).toBe(1);
        const seen = new Set();
        await expect
            .poll(async () => {
                seen.add(await page.locator("#stage img").getAttribute("src"));
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
        // Outside the grown box the new image is darkened to 65/255 of itself; inside it is not.
        expect(far[0]).toBeLessThanOrEqual(Math.ceil(255 * (1 - 190 / 255)));
        expect(near[0] + near[1] + near[2]).toBeGreaterThan(far[0] + far[1] + far[2]);
        expect(await stageClass()).toContain("spotlight");
    });

    it("says why Flash and Highlight are off when there is one image", async () => {
        await openStory(4);
        await expect
            .poll(() => page.locator("#single-note").textContent())
            .toBe("New story, no baseline: there is only the new image.");
        expect(await page.getByRole("button", { name: "Flash" }).isDisabled()).toBe(true);
        expect(await page.getByRole("button", { name: "Highlight" }).getAttribute("title")).toBe(
            "New story, no baseline: there is only the new image.",
        );
        await openStoryFromGrid(6);
        await expect.poll(() => page.locator("#single-note").textContent()).toContain("this story was removed");
    });

    it("goes back to the grid with Escape wherever focus is, and marks the story it came from", async () => {
        await openStory(3);
        await page.locator("#reason").click();
        await page.keyboard.type("half a thought");
        await page.keyboard.press("Escape");
        await page.locator(".component").first().waitFor();
        await expect.poll(() => page.locator(".tile.current").getAttribute("data-file")).toBe("slider--sizes.png");
        await openStoryFromGrid(2);
        await page.getByRole("button", { name: "Next", exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect
            .poll(() => page.locator(".tile.current").getAttribute("data-file"))
            .toBe("button--primary.dark.png");
    });

    it("needs a reason for a reject, and never reverses a decision without Undo", async () => {
        await page.getByRole("button", { name: /^All/ }).click();
        await openStoryFromGrid(2);
        await page.keyboard.press("r");
        await expect.poll(status).toContain("needs a reason");
        await page.locator("#reason").press("Enter");
        await expect.poll(status).toContain("needs a reason");
        await page.keyboard.type("darker than before");
        await page.keyboard.press("Enter");
        await expect.poll(status).toBe("button--primary (dark): reject");
        // Deciding moved on to 3; back on 2, A and R do nothing until Undo.
        await page.keyboard.press("k");
        await expect.poll(() => page.locator("#position").textContent()).toMatch(/^2 of/);
        await page.keyboard.press("a");
        await expect.poll(status).toContain("already rejected. Press U (Undo) first");
        expect(await page.locator("h2").textContent()).toContain("reject: darker than before");
        await page.keyboard.press("u");
        await expect.poll(status).toContain("undone");
        await page.keyboard.press("a");
        await expect.poll(status).toBe("button--primary (dark): accept");
        await page.keyboard.press("k");
        await page.keyboard.press("a");
        await expect.poll(status).toContain("already accepted");
    });

    it("draws all four sides of a changed box at the image's edge", async () => {
        // slider--sizes grew 40 px at the bottom: its changed box runs to the image's edges.
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

    it("clears a go-to error once another story opens", async () => {
        await page.locator("#goto").fill("99999");
        await page.locator("#goto").press("Enter");
        await expect.poll(status).toContain("There is no item 99999");
        await openStory(2);
        expect(await status()).toBe("");
    });

    it("filters by text and goes to a number or a story id", async () => {
        await page.locator("#filter").fill("slider");
        await expect.poll(() => page.locator(".tile").count()).toBe(1);
        await page.locator("#filter").fill("");
        await openStory(5);
        expect(await page.locator("h2").textContent()).toContain("tooltip--hover");
        await page.keyboard.press("Escape");
        await page.locator("#goto").fill("card--");
        await page.locator("#goto").press("Enter");
        await expect.poll(() => page.locator("h2").textContent()).toContain("card--legacy");
    });

    it("accepts one component's undecided items after asking", async () => {
        await page.locator('.component[data-component="badge"] h3 button').click();
        await expect.poll(() => page.locator("#progress").textContent()).toBe("1 / 6 reviewed");
        expect(dialogs[0]).toBe("Accept 1 undecided items of the component badge without opening them?");
    });

    it("Shift+A accepts the project, and Finish names the signing key and how to sign as yourself", async () => {
        await page.keyboard.press("Shift+A");
        await expect.poll(() => page.locator("#progress").textContent()).toBe("4 / 6 reviewed");
        expect(dialogs[0]).toContain("Accept 4 undecided items of compact-mantine");
        await page.getByRole("button", { name: /^Finish/ }).click();
        await expect.poll(() => dialogs.length).toBe(2);
        expect(dialogs[1]).toContain("4 accepted without being opened");
        expect(dialogs[1]).toContain("graphty-element: 1 undecided");
        expect(dialogs[1]).toContain("compact-mantine: 2 undecided");
        expect(dialogs[1]).toMatch(/Finish commits are (signed with|NOT signed)/);
        expect(dialogs[1]).toContain(`start the server from your own shell:\n${START}`);
        await page.locator("#home").click();
        await expect.poll(() => page.locator(".signer pre").textContent()).toBe(START);
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

describe("review page: a local preview", () => {
    beforeEach(async () => {
        await open(() => ({ gh: async () => "", results: FIXTURE }));
        await page.locator(".component").first().waitFor();
    });

    it("is never a seed and offers no decision and no Finish", async () => {
        await page.locator("#home").click();
        await expect.poll(() => page.locator("h2").first().textContent()).toMatch(/^Local preview /);
        expect(await page.locator("body").textContent()).not.toContain("master (seed)");
        expect(await page.getByRole("button", { name: /^Finish/ }).count()).toBe(0);
        await page.getByRole("button", { name: "Review", exact: true }).first().click();
        await openStory(2);
        expect(await page.getByRole("button", { name: /^(Accept|Reject|Exclude)$/ }).count()).toBe(0);
        expect(await page.locator(".actions").textContent()).toContain("Local preview: look only");
    });
});

// From a story view, back to the grid and into another story.
async function openStoryFromGrid(number) {
    await page.keyboard.press("Escape");
    await openStory(number);
}
