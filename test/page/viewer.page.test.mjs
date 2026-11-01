/*
 * The viewer of the new page (design section 5), by real input in Chromium: the four views by key
 * and by click, the active view's key back to Side by side, holding Space, zoom by Z, digits and
 * its menu (each step centered on the area), Baseline [P] in every view, new, removed, moved and
 * failed snapshots, Blink, Outline changed areas, Start zoomed on the change, Next area, Layout (Y
 * cycles) and what Auto chose, Image only with the item line in the toolbar, the locator, Details
 * on the item line, the Display menu and its keys acting closed, the item line's drop order,
 * Previous and Next; the toolbar of seven controls within its one row at 1280 and 1440 in every
 * view and level; the frames scrolling together at every zoom; and
 * the counted work: a cold open waits for one worker diff, and Right to a snapshot worked out ahead
 * waits for none.
 */

import { PNG } from "pngjs";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { COVERS } from "./covers.mjs";
import { message, openNext, project, rowsAnswer, target, visibleKeys } from "./page-kit.mjs";

let browser;
let t = null;
const pressed = new Set();

beforeAll(async () => {
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterEach(async () => {
    for (const a of t?.actions ?? []) {
        pressed.add(a.a);
    }
    await t?.close();
    t = null;
});
afterAll(async () => {
    await browser?.close();
});

// The images: an 800 x 600 baseline, and a new image with three changed areas apart from each
// other, the largest at (500, 400).
const W = 800;
const H = 600;
const AREAS = [
    [500, 400, 120, 80],
    [40, 40, 60, 30],
    [650, 80, 40, 40],
];
function picture(changed) {
    const png = new PNG({ width: W, height: H });
    png.data.fill(255);
    const rect = (x0, y0, w, h, [r, g, b]) => {
        for (let y = y0; y < y0 + h; y++) {
            for (let x = x0; x < x0 + w; x++) {
                const i = (y * W + x) * 4;
                [png.data[i], png.data[i + 1], png.data[i + 2]] = [r, g, b];
            }
        }
    };
    rect(100, 100, 300, 200, [80, 90, 200]);
    if (changed) {
        for (const [x, y, w, h] of AREAS) {
            rect(x, y, w, h, [220, 30, 30]);
        }
    }
    return PNG.sync.write(png);
}
const BASELINE = picture(false);
const CAPTURE = picture(true);
// The fixture's hashes start with "a" for a baseline and "b" for a new image.
const blob = (hash) => (hash.startsWith("b") ? CAPTURE : BASELINE);

// Six snapshots, one of each status (a small change: one level), and forty changed ones.
const SMALL = "9100";
const LARGE = "9200";
// At 1280 the small change's Image only row keeps its own item line and Options: the viewer is
// under 1300 px and over 1100.
const NARROW = { width: 1280, height: 800 };
const SMALL_STATUSES = ["changed", "moved", "new", "unseeded", "removed", "failed"];
const targets = () => [
    target(Number(SMALL), { projects: [project("graphty-element", { reviewable: 6 })] }),
    target(Number(LARGE), { projects: [project("graphty-element", { reviewable: 40 })] }),
];
// The rows, and with no ?rows=1 the whole items: their console and earlier attempts.
const rows = (id, name, query) => {
    const a = id === SMALL ? rowsAnswer(name, 6, (i) => SMALL_STATUSES[i]) : rowsAnswer(name, 40, () => "changed");
    if (query?.get("rows") === "1") {
        return a;
    }
    return {
        ...a,
        items: a.items.map((x) =>
            x.status === "failed"
                ? {
                      ...x,
                      reason: "Timed out after 30 s",
                      console: ["[error] TypeError: nodes is undefined", "    at GraphView.render (graph-view.ts:212)"],
                      attempts: [
                          {
                              status: "failed",
                              capture: null,
                              changedPixels: null,
                              reason: "Timed out after 30 s",
                              console: [],
                          },
                      ],
                  }
                : { ...x, console: ["[log] story ready"], threshold: 0.1, includeAA: false },
        ),
    };
};

async function open(id, viewport = { width: 1440, height: 900 }) {
    t = await openNext(browser, { targets: targets(), rows: (i, n, q) => rows(i, n, q), viewport });
    t.errors = [];
    t.page.on("pageerror", (err) => t.errors.push(err.message));
    await t.page.route("**/api/blob/**", (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: blob(route.request().url().split("/").pop()) }),
    );
    await t.page.locator(`.chg[data-chg="${id}"]`).click();
    await drawn(t.page, 1);
    return t.page;
}

// The frames on the stage: each label's text (its own span, without the note) and whether its
// pictures are in.
const frames = (page) =>
    page.evaluate(() =>
        [...globalThis.document.querySelectorAll("#stage figure")].map((f) => ({
            label: (f.querySelector(".label .lt") ?? f.querySelector(".label")).textContent,
            drawn: f.querySelector(".sheet") !== null,
        })),
    );
// Waits until snapshot #n is drawn: the item line names it and every frame has its pictures.
async function drawn(page, n) {
    await expect.poll(() => page.locator(".iline .num").first().textContent()).toBe(`#${n}`);
    await expect
        .poll(async () => {
            const f = await frames(page);
            return f.length > 0 && f.every((x) => x.drawn);
        })
        .toBe(true);
}
const labels = async (page) => (await frames(page)).map((f) => f.label);
const tool = (page, act) => page.locator(`#vtb [data-act="${act}"]:visible`).first();
const counts = (page) => page.evaluate('import("/viewer/stage.js").then((m) => ({ ...m.diffCounts }))');
const scrolls = (page) =>
    page.evaluate(() =>
        [...globalThis.document.querySelectorAll("#stage .frame")].map((f) => [f.scrollLeft, f.scrollTop]),
    );
const menuItem = (page, name) => page.getByRole("menu").getByText(name, { exact: true });
// A Display menu item's state: opens the menu, reads the item, closes the menu again.
async function displayItem(page, act) {
    await tool(page, "displaymenu").click();
    const item = page.getByRole("menu").locator(`[data-act="${act}"]`);
    const out = {
        text: (await item.innerText()).replace(/\s+/g, " ").trim(),
        checked: await item.getAttribute("aria-checked"),
        disabled: await item.getAttribute("aria-disabled"),
        title: await item.getAttribute("title"),
    };
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByRole("menu").count()).toBe(0);
    return out;
}
const zoomShown = (page) => tool(page, "zoomcycle").evaluate((n) => n.firstChild.textContent);

describe("the four views", () => {
    it("draws each view by key and by click, and the active view's key returns to Side by side", async () => {
        const page = await open(SMALL);
        // A new reader starts in Spotlight: the plain baseline and the spotlit new image.
        expect(await tool(page, "view-spotlight").getAttribute("aria-checked")).toBe("true");
        expect(await labels(page)).toEqual(["Baseline", "Spotlit new"]);
        expect(await page.locator("#stage figure:nth-child(2) canvas").count()).toBe(1);
        // V: Side by side, the two images.
        await page.keyboard.press("KeyV");
        await expect.poll(() => labels(page)).toEqual(["Baseline", "New"]);
        await drawn(page, 1);
        expect(await page.locator("#stage figure img").count()).toBe(2);
        // H: Highlight, the changed pixels over both images.
        await page.keyboard.press("KeyH");
        await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(2);
        expect(await tool(page, "view-highlight").getAttribute("title")).toBe("Highlight. H again: Side by side [V]");
        // H again: Side by side.
        await page.keyboard.press("KeyH");
        await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(0);
        expect(await tool(page, "view-side").getAttribute("aria-checked")).toBe("true");
        // F: Flash, one frame taking turns between the baseline and the new image.
        // The label strip names the image showing, with each flash; nothing is written on the image.
        await page.keyboard.press("KeyF");
        await expect.poll(() => labels(page)).toEqual(["Baseline (flashing)"]);
        await expect.poll(() => labels(page)).toEqual(["New (flashing)"]);
        expect(await page.locator("#stage figure img").count()).toBe(2);
        expect(await page.locator("#stage .note, .stagewrap > .note").count()).toBe(0);
        await page.keyboard.press("KeyF");
        await expect.poll(() => labels(page)).toEqual(["Baseline", "New"]);
        // S, then S again.
        await page.keyboard.press("KeyS");
        await expect.poll(() => labels(page)).toEqual(["Baseline", "Spotlit new"]);
        await page.keyboard.press("KeyS");
        await expect.poll(() => labels(page)).toEqual(["Baseline", "New"]);
        // By click, the same.
        await tool(page, "view-highlight").click();
        await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(2);
        await tool(page, "view-flash").click();
        await expect.poll(async () => (await labels(page)).length).toBe(1);
        await tool(page, "view-spotlight").click();
        await expect.poll(() => labels(page)).toEqual(["Baseline", "Spotlit new"]);
        // In Spotlight the one Flash segment is a toggle: the spotlit pair, in one frame.
        expect(await tool(page, "view-flash").getAttribute("aria-pressed")).toBe("false");
        await page.keyboard.press("KeyF");
        await expect.poll(() => labels(page)).toEqual(["New (flashing)"]);
        expect(await tool(page, "view-flash").getAttribute("aria-pressed")).toBe("true");
        expect(await tool(page, "view-spotlight").getAttribute("aria-checked")).toBe("true");
        await tool(page, "view-flash").click();
        await expect.poll(() => labels(page)).toEqual(["Baseline", "Spotlit new"]);
        await tool(page, "view-side").click();
        await expect.poll(() => labels(page)).toEqual(["Baseline", "New"]);
        expect(t.errors).toEqual([]);
    });

    it("flashes while Space is held, and Space never presses the focused button", async () => {
        const page = await open(SMALL);
        // Every press so far logged: the page sends its events in order.
        await page.locator('#tabs [data-act="screen-review"]').click();
        await expect.poll(() => t.actions.at(-1)?.a).toBe("screen-review");
        const before = t.actions.length;
        // The reader's click leaves the focus on Highlight.
        await tool(page, "view-highlight").click();
        await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(2);
        expect(await page.evaluate(() => globalThis.document.activeElement.dataset.act)).toBe("view-highlight");
        await page.keyboard.down("Space");
        await expect.poll(async () => (await labels(page)).length).toBe(1);
        expect(await page.locator("#stage figure .label .note").count()).toBe(0);
        await expect.poll(() => labels(page)).toEqual(["New (flashing)"]);
        await page.keyboard.up("Space");
        await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(2);
        // The highlight is back, and Space never pressed the focused button: the presses logged are
        // the click on Highlight and the click below.
        await page.locator('#tabs [data-act="screen-review"]').click();
        await expect.poll(() => t.actions.slice(before).map((a) => a.a)).toEqual(["view-highlight", "screen-review"]);
        expect(await tool(page, "view-highlight").getAttribute("aria-checked")).toBe("true");
    });
});

describe("zoom", () => {
    it("zooms by the digits, by Z and by click, and keeps the frames registered at every level", async () => {
        const page = await open(SMALL);
        await page.keyboard.press("KeyV");
        await drawn(page, 1);
        const width = () =>
            page
                .locator("#stage figure img")
                .first()
                .evaluate((n) => n.getBoundingClientRect().width);
        expect(await width()).toBeLessThan(W);
        for (const [key, zoom] of [
            ["Digit1", 1],
            ["Digit2", 2],
            ["Digit4", 4],
            ["Digit8", 8],
        ]) {
            await page.keyboard.press(key);
            await expect.poll(width).toBe(W * zoom);
            expect(await zoomShown(page)).toBe(`Zoom: ${zoom}x`);
            // Scrolled in one frame, the other follows to the same place.
            const frame = await page.locator("#stage .frame").first().boundingBox();
            await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
            const was = (await scrolls(page))[0];
            await page.mouse.wheel(-150, -200);
            await expect.poll(async () => String((await scrolls(page))[0])).not.toBe(String(was));
            await expect.poll(async () => new Set((await scrolls(page)).map(String)).size).toBe(1);
        }
        await page.keyboard.press("Digit0");
        await expect.poll(width).toBeLessThan(W);
        expect(await zoomShown(page)).toBe("Zoom: Fit");
        // Z cycles Fit, 1x, 2x, 4x, 8x in one press each.
        await page.keyboard.press("KeyZ");
        await expect.poll(width).toBe(W);
        await page.keyboard.press("KeyZ");
        await expect.poll(width).toBe(2 * W);
        // A click opens the Zoom menu, its items printing their digits; the current step ticked.
        await tool(page, "zoomcycle").click();
        expect(
            await page
                .getByRole("menu")
                .locator(".mi")
                .evaluateAll((ns) => ns.map((n) => n.innerText.replace(/\s+/g, " ").trim())),
        ).toEqual(["Fit 0", "Actual size 1", "2x 2", "4x 4", "8x 8"]);
        expect(await page.getByRole("menu").locator('[data-act="zoom-2"]').getAttribute("aria-checked")).toBe("true");
        await page.keyboard.press("Escape");
        for (const [zoom, name] of [
            [4, "4x"],
            [8, "8x"],
            [1, "Actual size"],
            [2, "2x"],
        ]) {
            await tool(page, "zoomcycle").click();
            await menuItem(page, name).click();
            await expect.poll(width).toBe(W * zoom);
        }
        await tool(page, "zoomcycle").click();
        await menuItem(page, "Fit").click();
        await expect.poll(width).toBeLessThan(W);
        // Enter on the focused Zoom button opens its menu too.
        await tool(page, "zoomcycle").focus();
        await page.keyboard.press("Enter");
        await page.getByRole("menu").waitFor();
        await page.keyboard.press("Escape");
        // From 4x, pixels are hard squares.
        await page.keyboard.press("Digit4");
        await expect.poll(() => page.locator("#stage figure img.crisp").count()).toBe(2);
    });

    it("shows the locator from 2x, and a click on it moves both frames there", async () => {
        const page = await open(SMALL);
        expect(await page.locator(".locator").count()).toBe(0);
        await page.keyboard.press("Digit4");
        await page.locator(".locator").waitFor();
        // A dot for each changed area.
        expect(await page.locator(".locator .ld").count()).toBe(3);
        const loc = await page.locator(".locator").boundingBox();
        // In the New panel's label strip, at its right end, within 60 x 16 at the image's shape,
        // and over no frame.
        expect(await page.locator("#stage figure:last-child .label .locator").count()).toBe(1);
        expect(loc.width).toBeLessThanOrEqual(60);
        expect(loc.height).toBeLessThanOrEqual(16);
        expect(loc.width / loc.height).toBeCloseTo(W / H, 0);
        const strip = await page.locator("#stage figure:last-child .label").boundingBox();
        expect(strip.x + strip.width - (loc.x + loc.width)).toBeLessThan(12);
        for (const f of await page.locator("#stage .frame").all()) {
            const b = await f.boundingBox();
            expect(loc.y + loc.height <= b.y || loc.y >= b.y + b.height).toBe(true);
        }
        // Its corners: the strip map is small, so the clicks land half a pixel in.
        await page.mouse.click(loc.x + 0.5, loc.y + 0.5);
        await expect.poll(async () => (await scrolls(page))[0]).toEqual([0, 0]);
        await expect
            .poll(() => page.locator(".locator .lr").evaluate((n) => [n.style.left, n.style.top]))
            .toEqual(["0%", "0%"]);
        await page.mouse.click(loc.x + loc.width - 0.5, loc.y + loc.height - 0.5);
        await expect.poll(async () => (await scrolls(page))[0][0]).toBeGreaterThan(1000);
        const [a, b] = await scrolls(page);
        expect(a).toEqual(b);
        await page.keyboard.press("Digit1");
        await expect.poll(() => page.locator(".locator").count()).toBe(0);
    });
});

describe("Baseline [P] in every view", () => {
    // What each view draws with the baseline shown and hidden (design 5.5).
    const TABLE = [
        ["KeyV", "side", ["Baseline", "New"], ["New"]],
        ["KeyH", "highlight", ["Baseline", "New"], ["New"]],
        ["KeyS", "spotlight", ["Baseline", "Spotlit new"], ["Spotlit new"]],
    ];
    it("hides the baseline in Side by side, Highlight and Spotlight, and Flash keeps its one frame", async () => {
        const page = await open(SMALL);
        await page.keyboard.press("KeyV");
        for (const [key, view, shown, hidden] of TABLE) {
            if ((await tool(page, `view-${view}`).getAttribute("aria-checked")) !== "true") {
                await page.keyboard.press(key);
            }
            await expect.poll(() => labels(page)).toEqual(shown);
            expect(await displayItem(page, "baseline")).toMatchObject({ checked: "true", title: "Baseline shown" });
            await page.keyboard.press("KeyP");
            await expect.poll(() => labels(page)).toEqual(hidden);
            expect(await displayItem(page, "baseline")).toMatchObject({ checked: "false", title: "Baseline hidden" });
            if (key === "KeyH") {
                await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(1);
            }
            await tool(page, "displaymenu").click();
            await menuItem(page, "Show baseline").click();
            await expect.poll(() => labels(page)).toEqual(shown);
        }
        // Spotlight flash: one frame, baseline shown or hidden.
        await page.keyboard.press("KeyF");
        await expect.poll(async () => (await labels(page)).length).toBe(1);
        await page.keyboard.press("KeyP");
        await expect.poll(async () => (await labels(page)).length).toBe(1);
        await page.keyboard.press("KeyF");
        await expect.poll(() => labels(page)).toEqual(["Spotlit new"]);
        // Flash: one frame either way, and the toggle is kept for when the reader leaves it.
        await page.keyboard.press("KeyV");
        await page.keyboard.press("KeyF");
        await expect.poll(async () => (await labels(page)).length).toBe(1);
        await page.keyboard.press("KeyP");
        expect((await displayItem(page, "baseline")).title).toBe("Baseline shown");
        await expect.poll(async () => (await labels(page)).length).toBe(1);
        await page.keyboard.press("KeyV");
        await expect.poll(() => labels(page)).toEqual(["Baseline", "New"]);
    });
});

describe("one-sided snapshots and failures", () => {
    it("shows new, no baseline yet, removed, moved and failed snapshots as design 5.6 says", async () => {
        const page = await open(SMALL);
        const unavailable = async (act) => [
            await tool(page, act).getAttribute("aria-disabled"),
            await tool(page, act).getAttribute("title"),
        ];
        // #2 moved: both images; Highlight says no pixels changed.
        await page.keyboard.press("ArrowRight");
        await drawn(page, 2);
        await page.keyboard.press("KeyH");
        const said = page.locator("#stage figure:last-child .label .note");
        await expect.poll(() => said.textContent()).toBe("no pixels changed");
        expect(await labels(page)).toEqual(["Baseline", "New"]);
        await page.keyboard.press("KeyS");
        await expect.poll(() => said.count()).toBe(1);
        // #3 new: the new image alone, the sentence in its label strip; the compared views and the
        // Baseline toggle unavailable with their reasons, never hidden.
        await page.keyboard.press("KeyK");
        await drawn(page, 3);
        expect(await labels(page)).toEqual(["New: no baseline yet. Accept makes this the first baseline."]);
        for (const act of ["view-flash", "view-highlight", "view-spotlight"]) {
            expect(await unavailable(act)).toEqual(["true", "Needs a baseline: this snapshot is new."]);
        }
        expect(await tool(page, "view-side").getAttribute("aria-checked")).toBe("true");
        expect(await displayItem(page, "baseline")).toMatchObject({
            text: "Show baseline (none) P",
            disabled: "true",
            title: "This snapshot has only one image",
        });
        await page.keyboard.press("KeyH");
        await expect.poll(() => message(page)).toBe("Highlight: Needs a baseline: this snapshot is new.");
        // #4 no baseline yet.
        await page.keyboard.press("ArrowRight");
        await drawn(page, 4);
        expect(await labels(page)).toEqual(["No baseline yet: never approved. Accept makes this the first baseline."]);
        // #5 removed: the baseline alone in the hatched frame.
        await page.keyboard.press("ArrowRight");
        await drawn(page, 5);
        expect(await labels(page)).toEqual(["Removed: accepting deletes this baseline."]);
        expect(
            await page.locator("#stage .frame").evaluate((n) => globalThis.getComputedStyle(n).backgroundImage),
        ).toContain("repeating-linear-gradient");
        expect(await unavailable("view-spotlight")).toEqual(["true", "Needs a new image: this snapshot was removed."]);
        // #6 failed: the error panel, no view available.
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => page.locator(".iline .num").textContent()).toBe("#6");
        const panel = page.locator("#stage .errpanel");
        await expect.poll(() => panel.innerText()).toContain("TypeError: nodes is undefined");
        await expect.poll(() => panel.innerText()).toContain("Reason: Timed out after 30 s");
        expect(await panel.innerText()).toContain(
            "2 attempts: failed (Timed out after 30 s), failed (Timed out after 30 s).",
        );
        for (const act of ["view-side", "view-flash", "view-highlight", "view-spotlight"]) {
            expect(await unavailable(act)).toEqual(["true", "The story did not render: there is no image to compare."]);
        }
        // The remembered view is unchanged: the changed snapshot opens in Spotlight again.
        await page.keyboard.press("KeyJ");
        await page.keyboard.press("KeyJ");
        await page.keyboard.press("KeyJ");
        await page.keyboard.press("KeyJ");
        await page.keyboard.press("ArrowLeft");
        await drawn(page, 1);
        expect(await labels(page)).toEqual(["Baseline", "Spotlit new"]);
    });
});

describe("the label strips", () => {
    it("say a panel is loading, and that an image is blank, in the strip and never on the image", async () => {
        const page = await open(LARGE);
        await page.keyboard.press("KeyV");
        await drawn(page, 1);
        // Snapshot #5's new image is held back (#2's is fetched ahead): its strip says so until it
        // arrives.
        let release;
        const held = new Promise((r) => {
            release = r;
        });
        const blank = new PNG({ width: W, height: H });
        blank.data.fill(255);
        await page.route("**/api/blob/b4b*", async (route) => {
            await held;
            await route.fulfill({ status: 200, contentType: "image/png", body: PNG.sync.write(blank) });
        });
        await page.locator('#snap-list .srow[data-snap="graphty-element/component-0--story-4.light.png"]').click();
        // (The baseline waits too: it is placed only once the change it centers on is known.)
        await expect.poll(() => labels(page)).toEqual(["Baseline (loading)", "New (loading)"]);
        release();
        // It arrives all white: a story that drew nothing.
        await drawn(page, 5);
        await expect.poll(() => labels(page)).toEqual(["Baseline", "New (blank image)"]);
        // The compared views say it too.
        await page.keyboard.press("KeyH");
        await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(2);
        await expect.poll(() => labels(page)).toEqual(["Baseline", "New (blank image)"]);
    });
});

describe("the item line", () => {
    it("reads Back Esc, the number and status, the name, the size, Next area, Select X Shift+Up/Down and Details", async () => {
        const page = await open(SMALL);
        await expect.poll(() => page.locator("#area-at").count()).toBe(0);
        const parts = await page
            .locator(".iline")
            .evaluate((n) =>
                [...n.children].map((c) => c.innerText.replace(/\s+/g, " ").trim()).filter((x) => x !== ""),
            );
        expect(parts[0]).toBe("BackEsc");
        expect(parts.slice(1, 4)).toEqual(["#1", "changed", "story-0, light"]);
        expect(parts).toContain("Next areaN");
        expect(parts.at(-2)).toBe("SelectXShift+Up/Down");
        expect(parts.at(-1)).toBe("Details");
        // Back, Next area, Select and Details print their keys quiet: no box.
        for (const act of ["back", "nextarea", "select"]) {
            expect(await page.locator(`.iline [data-act="${act}"] kbd`).first().getAttribute("class")).toContain(
                "quiet",
            );
        }
        // Above Fit the area counter joins Next area.
        await page.keyboard.press("Digit2");
        await expect.poll(() => page.locator("#area-at").textContent()).toBe("Area 1 of 3");
        await page.keyboard.press("Digit0");
        await expect.poll(() => page.locator("#area-at").count()).toBe(0);
    });

    it("drops other badges first, then the size, then cuts the name, never below 24 characters", async () => {
        const page = await open(SMALL);
        const line = () =>
            page.evaluate(() => {
                const l = globalThis.document.querySelector(".iline");
                return {
                    over: l.scrollWidth > l.clientWidth + 1,
                    name: l.querySelector(".name").textContent,
                    size: l.querySelector(".size")?.textContent ?? null,
                };
            });
        expect((await line()).size).not.toBeNull();
        // Narrow the viewer by showing both side panes: the line still fits, nothing cut below 24.
        await page.setViewportSize({ width: 1180, height: 820 });
        await page.keyboard.press("Shift+Digit1");
        await expect.poll(async () => (await line()).over).toBe(false);
        const l = await line();
        expect(l.name.length).toBeGreaterThanOrEqual(Math.min(24, "story-0".length));
    });
});

describe("one test per toolbar control", () => {
    it("Blink [L] blinks the highlight, and elsewhere is unavailable with its reason", async () => {
        const page = await open(SMALL);
        expect(await tool(page, "blink").getAttribute("aria-disabled")).toBe("true");
        expect(await tool(page, "blink").getAttribute("title")).toBe("Blink works in Highlight [H]");
        await page.keyboard.press("KeyL");
        await expect.poll(() => message(page)).toBe("Blink: Blink works in Highlight [H].");
        await page.keyboard.press("KeyH");
        await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(2);
        await page.keyboard.press("KeyL");
        await expect.poll(() => tool(page, "blink").getAttribute("aria-pressed")).toBe("true");
        const shown = (v) =>
            page.evaluate(
                (want) =>
                    [...globalThis.document.querySelectorAll("#stage canvas.diffmark")].every(
                        (n) => n.style.visibility === want,
                    ),
                v,
            );
        await expect.poll(() => shown("hidden")).toBe(true);
        await expect.poll(() => shown("visible")).toBe(true);
        await tool(page, "blink").click();
        await expect.poll(() => tool(page, "blink").getAttribute("aria-pressed")).toBe("false");
    });

    it("Outline changed areas [B] and Start zoomed on the change [O], from Display, and every zoom step centers", async () => {
        const page = await open(SMALL, NARROW);
        await page.keyboard.press("KeyV");
        await drawn(page, 1);
        expect(await page.locator("#stage .boxmark").count()).toBe(0);
        await page.keyboard.press("KeyB");
        await expect.poll(() => page.locator("#stage .boxmark").count()).toBe(2);
        await tool(page, "displaymenu").click();
        expect(await menuItem(page, "Outline changed areas").locator("..").getAttribute("aria-checked")).toBe("true");
        expect(await page.getByRole("menu").locator('[data-act="outline"] kbd').textContent()).toBe("B");
        await menuItem(page, "Outline changed areas").click();
        await expect.poll(() => page.locator("#stage .boxmark").count()).toBe(0);
        // Start zoomed on the change is on for a new reader: at 4x the largest area is in the middle.
        await page.keyboard.press("Digit4");
        const [x, y, w, h] = AREAS[0];
        const frame = await page
            .locator("#stage .frame")
            .first()
            .evaluate((n) => [n.clientWidth, n.clientHeight]);
        const middle = [(x + w / 2) * 4 - frame[0] / 2, (y + h / 2) * 4 - frame[1] / 2].map(Math.round);
        const near = async () => {
            const [sx, sy] = (await scrolls(page))[0];
            return Math.abs(sx - middle[0]) <= 12 && Math.abs(sy - middle[1]) <= 12;
        };
        await expect.poll(near).toBe(true);
        await tool(page, "displaymenu").click();
        await menuItem(page, "Start zoomed on the change").click();
        await expect.poll(() => message(page)).toBe("Start zoomed on the change: off.");
        await page.keyboard.press("ArrowRight");
        await drawn(page, 2);
        await page.keyboard.press("ArrowLeft");
        await drawn(page, 1);
        expect(await near()).toBe(false);
        // Off, a zoom step still centers on the area: it governs only the first open.
        await page.keyboard.press("Digit0");
        await page.keyboard.press("Digit4");
        await expect.poll(near).toBe(true);
        await page.keyboard.press("KeyO");
        await expect.poll(() => message(page)).toBe("Start zoomed on the change: on.");
        await page.keyboard.press("ArrowRight");
        await drawn(page, 2);
        await page.keyboard.press("ArrowLeft");
        await drawn(page, 1);
        await expect.poll(near).toBe(true);
    });

    it("Next area [N] steps through the changed areas, 1 of 3 to 3 of 3", async () => {
        const page = await open(SMALL, NARROW);
        await page.keyboard.press("Digit2");
        await expect.poll(() => page.locator("#area-at:visible").textContent()).toBe("Area 1 of 3");
        await page.keyboard.press("KeyN");
        await expect.poll(() => page.locator("#area-at:visible").textContent()).toBe("Area 2 of 3");
        await page.locator('[data-act="nextarea"]:visible').click();
        await expect.poll(() => page.locator("#area-at:visible").textContent()).toBe("Area 3 of 3");
        // A snapshot with one image has no areas to step through: Next area is absent.
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await drawn(page, 3);
        expect(await page.locator('[data-act="nextarea"]').count()).toBe(0);
    });

    it("Layout [Y]: Y cycles in one press, the Display item opens the three, and what Auto chose", async () => {
        const page = await open(SMALL, NARROW);
        const layout = async () => (await displayItem(page, "layoutmenu")).text;
        expect(await layout()).toBe("Layout: Auto Y");
        expect((await displayItem(page, "layoutmenu")).title).toBe("Auto chose side by side for this window");
        // Y: Side by side, Over and under, Auto, each one press, with the menu closed.
        await page.keyboard.press("KeyY");
        await expect.poll(() => message(page)).toBe("Layout: Side by side.");
        expect(await page.getByRole("menu").count()).toBe(0);
        await page.keyboard.press("KeyY");
        await expect.poll(() => page.locator("#stage").getAttribute("class")).toContain("stacked");
        const [a, b] = await page
            .locator("#stage figure")
            .evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().toJSON()));
        expect(b.top).toBeGreaterThanOrEqual(a.bottom);
        await page.keyboard.press("KeyY");
        await expect.poll(() => page.locator("#stage").getAttribute("class")).not.toContain("stacked");
        expect(await layout()).toBe("Layout: Auto Y");
        // A click on the Display item opens the three layouts.
        await tool(page, "displaymenu").click();
        await menuItem(page, "Layout: Auto").click();
        expect(await page.getByRole("menu").locator(".mi").allInnerTexts()).toEqual([
            "Auto (side by side now)",
            "Side by side",
            "Over and under",
        ]);
        await menuItem(page, "Side by side").click();
        await expect.poll(async () => (await displayItem(page, "layoutmenu")).text).toBe("Layout: Side by side Y");
        await tool(page, "displaymenu").click();
        await menuItem(page, "Layout: Side by side").click();
        await menuItem(page, "Over and under").click();
        await expect.poll(() => page.locator("#stage").getAttribute("class")).toContain("stacked");
        await tool(page, "displaymenu").click();
        await menuItem(page, "Layout: Over and under").click();
        await page.getByRole("menuitemradio", { name: /^Auto/ }).click();
        await expect.poll(() => page.locator("#stage").getAttribute("class")).not.toContain("stacked");
        // A tall window: each image is drawn larger over and under, and Auto says so.
        await page.setViewportSize({ width: 1280, height: 1500 });
        await expect.poll(() => page.locator("#stage").getAttribute("class")).toContain("stacked");
        await expect
            .poll(async () => (await displayItem(page, "layoutmenu")).title)
            .toBe("Auto chose over and under for this window");
        await page.setViewportSize(NARROW);
        await expect.poll(() => page.locator("#stage").getAttribute("class")).not.toContain("stacked");
    });

    it("Image only [Shift+3] merges the item line into the toolbar, and brings the panes back", async () => {
        const page = await open(LARGE);
        expect(await page.locator("#snaps").getAttribute("class")).not.toContain("rail");
        expect(await page.locator(".vtb .itemsum").isVisible()).toBe(false);
        await page.keyboard.press("Shift+Digit3");
        await expect.poll(() => page.locator("#snaps").getAttribute("class")).toContain("rail");
        expect(await page.locator("#changes").getAttribute("class")).toContain("rail");
        await expect.poll(() => page.locator(".vtb .itemsum").isVisible()).toBe(true);
        expect(await page.locator(".vtb .itemsum").innerText()).toContain("#1");
        expect(await page.locator(".vtb .itemsum .name").innerText()).toBe("component-0 / story-0");
        expect(await page.locator(".iline").isVisible()).toBe(false);
        await expect.poll(() => message(page)).toBe("Image only: Shift+3 brings the panes back.");
        // Image only sits in Display, ticked.
        expect((await displayItem(page, "imageonly")).checked).toBe("true");
        await tool(page, "displaymenu").click();
        await menuItem(page, "Image only").click();
        await expect.poll(() => page.locator("#snaps").getAttribute("class")).not.toContain("rail");
        await expect.poll(() => message(page)).toBe("Image only off: Snapshots shown again.");
        await page.keyboard.press("Shift+Digit3");
        await expect.poll(() => page.locator("#snaps").getAttribute("class")).toContain("rail");
        await page.keyboard.press("Shift+Digit3");
        await expect.poll(() => page.locator("#snaps").getAttribute("class")).not.toContain("rail");
    });

    it("Details, at the item line's end, opens under it with Copy link to this image, and closes again", async () => {
        const page = await open(SMALL, NARROW);
        expect(await page.locator("#details").isVisible()).toBe(false);
        await page.locator('.iline [data-act="details"]').click();
        await expect.poll(() => page.locator("#det-console").textContent()).toBe("[log] story ready");
        const text = await page.locator("#details").innerText();
        for (const part of [
            "Threshold",
            "0.1",
            "Anti-aliasing",
            "ignored",
            "Capture scale",
            "Baseline hash",
            "a0aaaaaa",
        ]) {
            expect(text).toContain(part);
        }
        expect(text).toContain("graphty-element/component-0--story-0.json");
        const line = await page.locator(".iline").boundingBox();
        const details = await page.locator("#details").boundingBox();
        expect(details.y).toBeGreaterThanOrEqual(line.y + line.height - 1);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.locator('#details [data-act="imagelink"]').click();
        await expect
            .poll(() => message(page))
            .toBe("Link copied: it opens this snapshot of this change, and carries your session token.");
        await page.locator('.iline [data-act="details"]').click();
        await expect.poll(() => page.locator("#details").isVisible()).toBe(false);
    });

    it("Display holds the once-a-session settings, each printing its key, and their keys act with it closed", async () => {
        const page = await open(LARGE, { width: 1280, height: 800 });
        // Seven controls: the four views, Blink, Zoom and Display; no More, no Options.
        expect(await page.locator("#vtb [data-act]:visible").evaluateAll((ns) => ns.map((n) => n.dataset.act))).toEqual(
            ["view-side", "view-flash", "view-highlight", "view-spotlight", "blink", "zoomcycle", "displaymenu"],
        );
        await tool(page, "displaymenu").click();
        const keys = await page
            .getByRole("menu")
            .locator("[data-act]")
            .evaluateAll((ns) => ns.map((n) => [n.dataset.act, n.querySelector("kbd")?.textContent ?? null]));
        expect(keys).toEqual([
            ["baseline", "P"],
            ["imageonly", "Shift+3"],
            ["layoutmenu", "Y"],
            ["outline", "B"],
            ["centerarea", "O"],
        ]);
        await page.keyboard.press("Escape");
        // Each key acts in one press with the menu closed.
        await page.keyboard.press("KeyV");
        await page.keyboard.press("KeyB");
        await expect.poll(() => page.locator("#stage .boxmark").count()).toBe(2);
        await page.keyboard.press("KeyP");
        await expect.poll(() => message(page)).toBe("Baseline hidden.");
        await page.keyboard.press("KeyP");
        await page.keyboard.press("KeyO");
        await expect.poll(() => message(page)).toBe("Start zoomed on the change: off.");
        await page.keyboard.press("Shift+Digit3");
        await expect.poll(() => message(page)).toBe("Image only: Shift+3 brings the panes back.");
        expect(await page.getByRole("menu").count()).toBe(0);
        // The pressed style is gone: a toggle shows a check mark, never an inset ring.
        await page.keyboard.press("KeyH");
        await page.keyboard.press("KeyL");
        await expect.poll(() => tool(page, "blink").getAttribute("aria-pressed")).toBe("true");
        expect(await tool(page, "blink").evaluate((n) => globalThis.getComputedStyle(n).boxShadow)).toBe("none");
        expect(await tool(page, "blink").locator(".chk").isVisible()).toBe(true);
        // Exactly one filled view.
        expect(await page.locator("#vtb .seg button.on").count()).toBe(1);
    });

    it("Previous [J] Left and Next [K] Right by key and by click", async () => {
        const page = await open(LARGE);
        await page.keyboard.press("ArrowRight");
        await drawn(page, 2);
        await page.keyboard.press("KeyK");
        await drawn(page, 3);
        await page.keyboard.press("KeyJ");
        await drawn(page, 2);
        await page.keyboard.press("ArrowLeft");
        await drawn(page, 1);
        await page.locator('.decide [data-act="next"]').click();
        await drawn(page, 2);
        await page.locator('.decide [data-act="prev"]').click();
        await drawn(page, 1);
        // J and K boxed, the arrows quiet; no position text on the bar.
        for (const [act, word, letter, arrow] of [
            ["prev", "Previous", "J", "Left"],
            ["next", "Next", "K", "Right"],
        ]) {
            const kbds = await page
                .locator(`.decide [data-act="${act}"] kbd`)
                .evaluateAll((ns) => ns.map((n) => [n.textContent, n.classList.contains("quiet")]));
            expect(kbds).toEqual([
                [letter, false],
                [arrow, true],
            ]);
            expect(await page.locator(`.decide [data-act="${act}"]`).getAttribute("aria-label")).toBe(word);
        }
        expect(await page.locator(".decide .pos").count()).toBe(0);
    });
});

describe("the toolbar's one row", () => {
    // Every button in the toolbar wholly inside its one 44 px row, none cut or wrapped; every key
    // the page binds now printed on a visible box.
    async function oneRow(page, what) {
        const bad = await page.evaluate(() => {
            const bar = globalThis.document.getElementById("vtb").getBoundingClientRect();
            const out = [];
            for (const b of globalThis.document.querySelectorAll("#vtb button")) {
                const r = b.getBoundingClientRect();
                if (r.width === 0) {
                    continue;
                }
                const name = b.dataset.act;
                if (r.left < bar.left - 0.5 || r.right > bar.right + 0.5) {
                    out.push(`${name} outside the row`);
                }
                if (r.top < bar.top || r.bottom > bar.bottom || r.height > 30) {
                    out.push(`${name} in a second row or wrapped`);
                }
                if (b.scrollWidth > b.clientWidth + 1) {
                    out.push(`${name} cut`);
                }
            }
            return out;
        });
        expect(bad, what).toEqual([]);
        expect((await page.locator("#vtb").boundingBox()).height, what).toBe(44);
        // Every key a visible control carries shows on one box.
        const shown = (await visibleKeys(page)).map((k) => k.key);
        const bound = await page.evaluate(() =>
            [...globalThis.document.querySelectorAll("[data-key]")]
                .filter((n) => n.getClientRects().length > 0 && n.getAttribute("aria-disabled") !== "true")
                .map((n) => n.dataset.key),
        );
        for (const key of bound) {
            const one = key === "F" ? "F / hold Space" : key;
            for (const part of one === "F / hold Space" ? [one] : one.split(" / ")) {
                expect(shown, `${what}: ${key}`).toContain(part);
            }
        }
    }
    const VIEWS = [
        ["side", "KeyV", null],
        ["flash", "KeyF", null],
        ["highlight", "KeyH", null],
        ["spotlight", "KeyS", null],
        ["spotlight", "KeyS", "KeyF"],
    ];
    const LEVELS = {
        "one level (a small change)": async (size) => open(SMALL, size),
        "the list level": async (size) => open(LARGE, size),
        viewing: async (size) => {
            const page = await open(LARGE, size);
            if ((await page.locator('.iline [data-act="openrow"]').count()) > 0) {
                await page.locator('.iline [data-act="openrow"]').click();
                await expect
                    .poll(() => page.locator('.iline [data-act="back"]').getAttribute("title"))
                    .toBe("Back to the list (Esc)");
            }
            return page;
        },
        "Image only": async (size) => {
            const page = await open(LARGE, size);
            await page.keyboard.press("Shift+Digit3");
            await expect.poll(() => page.locator("#snaps").getAttribute("class")).toContain("rail");
            return page;
        },
    };
    for (const [width, height] of [
        [1280, 800],
        [1440, 900],
    ]) {
        it.each(Object.keys(LEVELS))(`at ${width} x ${height}, %s, in every view`, async (level) => {
            const page = await LEVELS[level]({ width, height });
            for (const [view, key, then] of VIEWS) {
                const name = `${view}${then ? " flash" : ""}`;
                if ((await tool(page, `view-${view}`).getAttribute("aria-checked")) !== "true") {
                    await page.keyboard.press(key);
                }
                if (then) {
                    await page.keyboard.press(then);
                    await expect.poll(() => tool(page, "view-flash").getAttribute("aria-pressed")).toBe("true");
                }
                await oneRow(page, `${level}, ${name}`);
                if (then) {
                    await page.keyboard.press(then);
                }
            }
            // The keys printed only in a closed menu are printed there, on the item they act through.
            for (const opener of await page.locator("#vtb [data-menukeys]:visible").all()) {
                const keys = Object.keys(JSON.parse(await opener.getAttribute("data-menukeys")));
                await opener.click();
                const printed = await page.getByRole("menu").locator("kbd").allTextContents();
                expect(printed).toEqual(expect.arrayContaining(keys));
                await page.keyboard.press("Escape");
                await expect.poll(() => page.getByRole("menu").count()).toBe(0);
            }
            expect(t.errors).toEqual([]);
        });
    }
});

describe("counted work", () => {
    it("a cold open waits for one worker diff, and Right to a snapshot worked out ahead waits for none", async () => {
        const page = await open(LARGE);
        const cold = await counts(page);
        expect(cold.waited).toBe(1);
        // The diffs of the keys' targets, worked out ahead in the worker.
        await expect
            .poll(async () => {
                const c = await counts(page);
                return c.worker >= 3 && c.done === c.worker;
            })
            .toBe(true);
        for (const n of [2, 3, 4]) {
            await page.keyboard.press("ArrowRight");
            await drawn(page, n);
            expect((await counts(page)).waited, `#${n}`).toBe(1);
            await expect
                .poll(async () => {
                    const c = await counts(page);
                    return c.done === c.worker;
                })
                .toBe(true);
        }
    });
});

describe("the diff worker", () => {
    it("shows the error when the worker cannot start, and starts it again for Retry", async () => {
        t = await openNext(browser, { targets: targets(), rows: (i, n, q) => rows(i, n, q) });
        await t.page.route("**/api/blob/**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "image/png",
                body: blob(route.request().url().split("/").pop()),
            }),
        );
        await t.page.route("**/viewer/diff-worker.js", (route) => route.fulfill({ status: 500, body: "" }));
        await t.page.locator(`.chg[data-chg="${SMALL}"]`).click();
        // Spotlight, the first view, needs the diff: both panes say why it is missing.
        const failed = t.page.locator("#stage .failed");
        await expect.poll(() => failed.first().textContent()).toContain("the changed pixels could not be worked out");
        await t.page.unroute("**/viewer/diff-worker.js");
        await failed.first().getByRole("button", { name: "Retry" }).click();
        await drawn(t.page, 1);
        expect(await failed.count()).toBe(0);
        expect(await labels(t.page)).toEqual(["Baseline", "Spotlit new"]);
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["viewer.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
