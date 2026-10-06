/*
 * The review page's confirmed failure scenarios, in Chromium against a server on a temporary
 * repository and the fake GitHub of faults.mjs, one test per scenario, named after it. A scenario
 * the page still gets wrong is `it.fails`; its fix flips the test to a plain it().
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { withRetries } from "../trusted/lib/github.mjs";
import { startApp, world } from "./faults.mjs";
import { FIXTURE, interceptedPage, isolateGit, job, makeRepo } from "./helpers.mjs";

const TOKEN = "t".repeat(43);
const OTHER = "4".repeat(40);
const CM_ITEMS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items;
const BUTTON = "button--primary.dark.png";
const BUTTON_BASELINE = join(FIXTURE, "compact-mantine/baselines", BUTTON);
const BUTTON_BASELINE_HASH = CM_ITEMS.find((i) => i.file === BUTTON).baseline;

// Each scenario starts a server on a new repository, opens a Chromium tab and walks the page to
// the screen it tests: about 0.5 to 1 s unloaded and 1.5 s on a CI runner before the scenario's
// own steps, some of which wait on purpose (3.5 s for a late render, 60 items for the image
// cache). Measured on one CPU shared with a busy loop, the scenarios take 3 to 6 s; Vitest's
// default 5 s is sized for unit tests.
vi.setConfig({ testTimeout: 20000 });

let browser;
let s;
let pages = [];
let page;
let dialogs;

beforeAll(async () => {
    isolateGit();
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterAll(() => browser?.close());
afterEach(async () => {
    await Promise.all(pages.map((p) => p.close()));
    pages = [];
    await s?.close();
    s = null;
});

/**
 * A new tab on the page, with every question the page asks (ask in review.js) recorded and
 * confirmed except Finish's. A browser dialog is recorded and never answered: one a browser
 * blocks returns at once as if refused.
 * @param {string} [hash] more of the address after the token
 * @returns {Promise<import("playwright").Page>} the tab
 */
async function tab(hash = "") {
    const p = await interceptedPage(browser, { viewport: { width: 1000, height: 800 } });
    pages.push(p);
    await p.exposeFunction("asked", (message) => {
        dialogs.push(message);
        return !message.startsWith("Finish");
    });
    await p.addInitScript(() => {
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
    p.on("dialog", (d) => {
        dialogs.push(`browser dialog: ${d.message()}`);
        return d.dismiss();
    });
    await p.goto(`${s.origin}/#token=${TOKEN}${hash}`);
    return p;
}

/**
 * Serves `w` and opens the page on the targets screen.
 * @param {{ repo: string }} r the repository
 * @param {{ gh: Function }} w the fake GitHub
 * @param {{ gh?: Function, hash?: string }} [options] another gh runner, more of the address
 */
async function open(r, w, { gh = w.gh, hash = "" } = {}) {
    s = await startApp(r, { gh, token: TOKEN });
    dialogs = [];
    page = await tab(hash);
}

/**
 * Opens the `n`th project with something to review, from the targets screen.
 * @param {number} [n] which Review button
 * @param {import("playwright").Page} [p] the tab
 */
async function review(n = 0, p = page) {
    await p.getByRole("button", { name: "Review", exact: true }).nth(n).click();
    await p.locator(".component").first().waitFor();
}

// Item numbers: 1 menu--open (failed), 2 button--primary.dark (changed), 3 slider--sizes
// (changed), 4 badge--default.light (new), 5 tooltip--hover (unstable), 6 card--legacy (removed).
async function openStory(number, p = page) {
    await p.locator("#find").fill(String(number));
    await p.locator("#find").press("Enter");
    await expect.poll(() => p.locator(".itemline .number").textContent()).toBe(`#${number}`);
}

// The item's images have been on screen long enough for a decision to count.
const ready = (p = page) => p.locator("#stage[data-ready]").waitFor();

const decisions = async (project = "compact-mantine", id = "123") =>
    (await s.api("GET", `/api/pr/${id}/${project}`)).body.decisions;
const boxCount = () => page.locator("#box-count").textContent();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run 1001 on `head`, whose capture of the button is its baseline's bytes: no changed box.
 * @param {object} w the fake GitHub
 * @param {string} head the head the run captured
 */
function runWithoutButtonChange(w, head) {
    w.data.runs[head] = { id: 1001, attempt: 1 };
    w.data.jobs[1001] = [job("compact-mantine"), job("graphty-element")];
    w.data.artifacts[1001] = ["visual-compact-mantine-1", "visual-graphty-element-1"];
    w.data.results["1001/visual-compact-mantine-1"] = {
        items: CM_ITEMS.map((i) => (i.file === BUTTON ? { ...i, capture: BUTTON_BASELINE_HASH } : i)),
    };
    w.data.files["1001/visual-compact-mantine-1"] = { [BUTTON]: BUTTON_BASELINE };
}

describe("review page: stale caches", () => {
    // Images are cached by their hash too, so the newer run's image is fetched.
    it("The page shows an earlier run's cached images while decisions are recorded against the server's current run", async () => {
        const r = makeRepo();
        const w = world(r);
        await open(r, w);
        await review();
        await openStory(2);
        await page.locator('#stage img[alt^="new image of"]').waitFor();
        const fetched = [];
        page.on(
            "request",
            (req) =>
                req.url().includes(`/api/img/`) && req.url().includes(`/capture/${BUTTON}`) && fetched.push(req.url()),
        );
        // Another tab (or the iPad) refreshes the list: the server moves to run 1001.
        runWithoutButtonChange(w, r.head);
        await s.api("GET", "/api/prs");
        await page.locator("#home").click();
        await page.locator(".card").first().waitFor();
        await review();
        await openStory(2);
        await page.locator('#stage img[alt^="new image of"]').waitFor();
        expect(fetched.length).toBeGreaterThan(0);
    });

    // Diffs are cached by target, project and both images' hashes.
    it("The diff cache is keyed by file name only, so Highlight, Spotlight and the box count show another pull request's or another run's diff", async () => {
        const r = makeRepo();
        const w = world(r);
        w.data.prs.push({ number: 124, head: OTHER, branch: "other" });
        runWithoutButtonChange(w, OTHER);
        await open(r, w);
        await review(0);
        await openStory(2);
        await page.keyboard.press("s");
        await expect.poll(boxCount).toMatch(/^1 of/);
        await page.locator("#home").click();
        await page.locator(".card").first().waitFor();
        // #124's first Review: its compact-mantine.
        await review(2);
        await openStory(2);
        await expect.poll(boxCount).not.toBe("");
        expect(await boxCount()).toBe("No changed area at this threshold");
    });

    // A failed image load is dropped from the cache, so the next visit retries it.
    it("One failed image load is cached for the whole session, an undecodable image shows an empty error, and Accept stays enabled", async () => {
        const r = makeRepo();
        await open(r, world(r));
        let aborted = false;
        // The baseline: only the story loads it (the grid's tile shows the capture).
        await page.route(`**/baseline/${BUTTON}`, (route) => {
            if (aborted) {
                return route.continue();
            }
            aborted = true;
            return route.abort();
        });
        await review();
        await openStory(2);
        // The failure reads as text with a Retry, and Accept waits for both images.
        await expect.poll(() => page.locator("#stage p.error").textContent()).toMatch(/\S.*Retry$/);
        expect(await page.locator("#accept").getAttribute("class")).toContain("loading");
        await page.keyboard.press("k");
        await page.keyboard.press("j");
        await expect.poll(() => page.locator('#stage img[alt^="baseline of"]').count(), { timeout: 3000 }).toBe(1);
    });

    // Only the most recently used images and diffs are kept; older object URLs are revoked.
    it("Page memory grows without bound over a review session until the tab is killed", async () => {
        const r = makeRepo();
        const w = world(r);
        const button = CM_ITEMS.find((i) => i.file === BUTTON);
        const items = Array.from({ length: 60 }, (_, n) => ({
            ...button,
            id: `big--s${n}`,
            mode: null,
            file: `big--s${n}.png`,
        }));
        w.data.results["visual-compact-mantine-1"] = { items, expected: items.length };
        w.data.files["visual-compact-mantine-1"] = Object.fromEntries(
            items.flatMap((i) => [
                [i.file, join(FIXTURE, "compact-mantine", BUTTON)],
                [`baselines/${i.file}`, BUTTON_BASELINE],
            ]),
        );
        s = await startApp(r, { gh: w.gh, token: TOKEN });
        dialogs = [];
        page = await interceptedPage(browser, { viewport: { width: 1000, height: 800 } });
        pages.push(page);
        // Counts the object URLs the page holds: created and not yet revoked.
        await page.addInitScript(() => {
            const live = new Set();
            const create = URL.createObjectURL.bind(URL);
            const revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = (b) => {
                const u = create(b);
                live.add(u);
                return u;
            };
            URL.revokeObjectURL = (u) => {
                live.delete(u);
                revoke(u);
            };
            globalThis.liveUrls = () => live.size;
        });
        await page.goto(`${s.origin}/#token=${TOKEN}`);
        await review();
        await openStory(1);
        // Each step waits for the page to show item n with its box count, checked every frame:
        // expect.poll's 50 ms interval alone would make the 59 steps take about 3 s.
        for (let n = 2; n <= items.length; n++) {
            await page.keyboard.press("k");
            await page.waitForFunction((n) => {
                const { document } = globalThis;
                return (
                    document.getElementById("position").textContent.startsWith(`${n} of `) &&
                    /^\d+ of/.test(document.getElementById("box-count").textContent)
                );
            }, n);
        }
        // At most the 50 images kept, plus the grid's thumbnails (one per tile it loaded), plus the
        // tab's icon with the count of pull requests waiting (one, replaced in place).
        const thumbs = await page.evaluate(
            () =>
                globalThis.performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/thumb/"))
                    .length,
        );
        expect(await page.evaluate(() => globalThis.liveUrls())).toBeLessThanOrEqual(50 + thumbs + 1);
    });
});

describe("review page: decisions", () => {
    // A double click's second click, landing on the next item's Accept, is ignored.
    it("A double click on Accept, or a held A key, accepts the next items without showing them", async () => {
        const r = makeRepo();
        await open(r, world(r));
        await review();
        await openStory(2);
        // Accept waits for both images.
        await page.locator('#stage img[alt^="new image of"]').waitFor();
        await ready();
        const box = await page.locator("#accept").boundingBox();
        const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
        await page.mouse.click(x, y);
        await sleep(150);
        await page.mouse.click(x, y);
        await sleep(500);
        expect(await decisions()).not.toHaveProperty("slider--sizes.png");
    });

    // A held decision key decides once.
    it("A double click on Accept, or a held A key, accepts the next items without showing them (a held A key)", async () => {
        const r = makeRepo();
        await open(r, world(r));
        await review();
        await openStory(2);
        await ready();
        await page.keyboard.down("a");
        await expect.poll(() => page.locator("#position").textContent()).toMatch(/^3 of /);
        // The key is still held: the browser repeats it.
        await page.keyboard.down("a");
        await sleep(500);
        await page.keyboard.up("a");
        expect(Object.keys(await decisions())).toEqual([BUTTON]);
    });

    // Opening a stale "not opened" tile only marks it opened; it never re-creates the accept.
    it("A stale grid re-creates an accept that was undone in another tab or already committed by Finish", async () => {
        const r = makeRepo();
        await open(r, world(r));
        await review();
        await page.keyboard.press("Shift+A");
        await expect.poll(async () => Object.keys(await decisions()).length).toBe(4);
        const other = await tab();
        await review(0, other);
        await other.getByRole("button", { name: /^All/ }).click();
        await other.locator(`.decision[data-file="${BUTTON}"]`).waitFor();
        await page.locator("details.menu > summary").click();
        await page.getByRole("button", { name: "Undo all decisions..." }).click();
        await expect.poll(async () => Object.keys(await decisions()).length).toBe(0);
        await other.locator(`.tile[data-file="${BUTTON}"]`).click();
        await other.locator("#position").waitFor();
        await sleep(300);
        expect(await decisions()).toEqual({});
    });

    // The reason box holds the keys while it is open, and a cancelled Exclude is gone: nothing
    // typed after it decides anything.
    it("Enter in the reason box can run an earlier, abandoned Exclude", async () => {
        const r = makeRepo();
        await open(r, world(r));
        await review();
        await openStory(2);
        await ready();
        await page.keyboard.press("e");
        await page.locator("#reason:focus").waitFor();
        await page.keyboard.press("k");
        expect(await page.locator("#position").textContent()).toMatch(/^2 of /);
        await page.keyboard.press("Escape");
        await expect
            .poll(() => page.locator("#status").textContent())
            .toBe("Exclude cancelled: #2 is still undecided.");
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect.poll(() => page.locator("#position").textContent()).toMatch(/^3 of /);
        await page.keyboard.type("too tall");
        await page.keyboard.press("Enter");
        await sleep(300);
        expect(dialogs.filter((d) => d.startsWith("Exclude"))).toEqual([]);
        expect(await decisions()).toEqual({});
    });

    // The confirm says how many of the items are removals.
    it("Accept all accepts removals without saying so", async () => {
        const r = makeRepo();
        await open(r, world(r));
        await review();
        await page.keyboard.press("Shift+A");
        await expect.poll(() => dialogs.length).toBe(1);
        expect(dialogs[0]).toMatch(/1 (removal|removed)/);
    });
});

describe("review page: rendering and routing", () => {
    // A render finishing after another item is shown writes nothing.
    it("A slow earlier render writes its box count and boxes onto the item now shown", async () => {
        const r = makeRepo();
        const w = world(r);
        // Item 2 at the highest threshold has no changed box; item 3 has one.
        w.data.results["visual-compact-mantine-1"] = {
            items: CM_ITEMS.map((i) => (i.file === BUTTON ? { ...i, threshold: 1 } : i)),
        };
        await open(r, w);
        await page.route("**/slider--sizes.png", async (route) => {
            await sleep(1000);
            return route.continue().catch(() => {});
        });
        await review();
        await openStory(2);
        await expect.poll(boxCount).toBe("No changed area at this threshold");
        await page.keyboard.press("k");
        await page.keyboard.press("j");
        await expect.poll(() => page.locator("#position").textContent()).toMatch(/^2 of /);
        // Item 3's two images arrive one after the other, a second each.
        await sleep(3500);
        expect(await boxCount()).toBe("No changed area at this threshold");
    });

    // A superseded route stops after its wait, and no route pushes a history entry.
    it("Fast Back/Forward presses race on the shared `routing` flag and can leave the address and the screen out of step", async () => {
        const r = makeRepo();
        const w = world(r);
        await open(r, w);
        await review();
        await openStory(2);
        const before = await page.evaluate(() => globalThis.history.length);
        // The targets screen waits on the page's own read of the target list (the server answers it
        // from its cache, never asking GitHub), so that read is the one slowed. A decision from
        // another tab lands during the wait, so the answer differs from the list the page holds and
        // a route that went on would redraw the targets. Counted asked and answered, to know when
        // the superseded route has had its answer.
        let asked = 0;
        let answered = 0;
        await page.route("**/api/prs?*", async (route) => {
            asked++;
            await sleep(700);
            const decided = await s.api("POST", "/api/decide", {
                id: "123",
                project: "compact-mantine",
                file: BUTTON,
                decision: "reject",
                reason: "from another tab",
            });
            expect(decided.status).toBe(200);
            await route.continue().catch(() => {});
            answered++;
        });
        // Back twice and Forward once, without waiting for any to land: story -> grid -> targets,
        // whose route waits, -> grid again before that wait ends.
        await page.evaluate(() => {
            globalThis.history.back();
            setTimeout(() => globalThis.history.back(), 50);
            setTimeout(() => globalThis.history.forward(), 150);
        });
        // The grid is shown and the targets route has its answer; a superseded route that went on
        // would now draw the targets or push an entry, within a moment of its answer. The wait is
        // counted from the answer, not from the presses, so a slow machine waits longer instead of
        // running out of the test's time.
        await expect
            .poll(async () => asked >= 1 && answered === asked && (await page.locator(".component").count()) > 0, {
                timeout: 8000,
            })
            .toBe(true);
        await sleep(500);
        const after = await page.evaluate(() => ({
            length: globalThis.history.length,
            hash: globalThis.location.hash,
        }));
        expect(after.length).toBe(before);
        const address = new URLSearchParams(after.hash.slice(1));
        expect(address.get("target")).toBe("123");
        expect(address.has("item")).toBe(false);
        expect(await page.locator(".component").count()).toBeGreaterThan(0);
        expect(await page.locator(".card[data-target]").count()).toBe(0);
    });

    // The targets screen, with the project's problem, instead of an empty page.
    it("A deep link or reload into a project that failed to load shows an empty page with 'no such capture'", async () => {
        const r = makeRepo();
        const w = world(r);
        const gh = withRetries(
            async (args, input) => {
                if (args[0] === "run" && args[4] === "visual-compact-mantine-1") {
                    throw new Error("error connecting to productionresultssa0.blob.core.windows.net");
                }
                return w.gh(args, input);
            },
            [0, 0, 0],
        );
        await open(r, w, { gh, hash: "&target=123&project=compact-mantine" });
        await expect.poll(() => page.locator("body").textContent()).toContain("download failed");
        expect(await page.locator(".card").count()).toBeGreaterThan(0);
    });

    // A job that vanishes is shown as interrupted, not as no Finish at all.
    it("A restart during Finish loses the job: the page shows the plain target list and the server log says nothing", async () => {
        const r = makeRepo();
        const w = world(r);
        s = await startApp(r, { gh: w.gh, token: TOKEN });
        dialogs = [];
        page = await interceptedPage(browser, { viewport: { width: 1000, height: 800 } });
        pages.push(page);
        let calls = 0;
        const running = {
            id: 1,
            target: "123",
            pr: 123,
            running: true,
            step: "pushing",
            result: null,
            error: null,
        };
        // The server answers a running Finish, then restarts and knows of none.
        await page.route("**/api/finish-status", (route) =>
            route.fulfill({
                contentType: "application/json",
                body: JSON.stringify({ job: calls++ < 2 ? running : null }),
            }),
        );
        await page.goto(`${s.origin}/#token=${TOKEN}`);
        await expect.poll(() => calls, { timeout: 5000 }).toBeGreaterThan(2);
        await expect.poll(() => page.locator("body").textContent()).toMatch(/interrupted|restarted/i);
    });
});
