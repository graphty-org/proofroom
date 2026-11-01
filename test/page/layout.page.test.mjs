/*
 * The new page's layout in Chromium at 1280 x 800, 1440 x 900 and an iPad-like 1180 x 820: the
 * viewer is never narrower than 800 px while it shows a snapshot, in every level and after every
 * pane key, with 3 and 300 snapshots; the levels move by clicks on the rows, Open, Back and the
 * viewer as they do by keys; and the top bar's 36 px, the message line's 24 px and the rails' 56 px.
 * The Baselines screen too: its viewer at 800 px or more after every pane key, and its toolbar in
 * one row with its seven controls showing. At 1024 x 768, with a change open and with three rows
 * selected, every keyed control is wholly inside the window and the decision bar is one line.
 */

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { COVERS } from "./covers.mjs";
import { fiftyChanges, message, openNext, routeBaselines } from "./page-kit.mjs";

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

const SIZES = [
    [1280, 800],
    [1440, 900],
    [1180, 820],
];
const box = (page, sel) => page.locator(sel).evaluate((n) => n.getBoundingClientRect().toJSON());
// The item line's control `act` a reader sees: on the item line, or in the toolbar's middle where
// Image only merges the item line into it at 1300 px and wider.
const itemControl = (page, act) => page.locator(`:is(.iline, .itemsum) [data-act="${act}"] >> visible=true`);
// The viewer's width while it shows a snapshot (null while it shows none).
const viewerWidth = async (page) =>
    (await page.locator(".iline").count()) > 0 ? (await box(page, "#viewer")).width : null;

describe.each(SIZES)("at %i x %i", (width, height) => {
    const open = async () => {
        t = await openNext(browser, { targets: fiftyChanges(), viewport: { width, height } });
        await t.page.locator(".chg").first().waitFor();
        return t.page;
    };

    it.each([
        ["3484", 3],
        ["3486", 300],
    ])("keeps the viewer at 800 px or more for change %s (%i snapshots) in every level and pane choice", async (id) => {
        const page = await open();
        const widths = [];
        const look = async (what) => {
            const w = await viewerWidth(page);
            if (w !== null) {
                widths.push([what, w]);
                expect(w, what).toBeGreaterThanOrEqual(800);
            }
        };
        await page.locator(`.chg[data-chg="${id}"]`).click();
        await page.locator(".iline").waitFor({ state: "attached" });
        await look("opened");
        for (const key of ["Shift+Digit1", "Shift+Digit2", "Shift+Digit1", "Shift+Digit2"]) {
            await page.keyboard.press(key);
            await look(`after ${key}`);
        }
        if ((await itemControl(page, "openrow").count()) > 0) {
            await itemControl(page, "openrow").click();
            await look("viewing");
            await page.keyboard.press("Shift+Digit2");
            await look("viewing, Shift+2");
            // A viewing level only under 1400 px; at one level Open only folded the list.
            if ((await itemControl(page, "back").getAttribute("title")) === "Back to the list (Esc)") {
                await itemControl(page, "back").click();
                await look("back to the list");
            }
        }
        await itemControl(page, "back").click();
        await expect.poll(() => message(page)).toMatch(/^Back to the changes\./);
        await look("back to the changes");
        for (const key of ["Shift+Digit2", "Shift+Digit1", "Shift+Digit2"]) {
            await page.keyboard.press(key);
            await look(`changes level, after ${key}`);
        }
        expect(widths.length).toBeGreaterThan(4);
    });

    it("fits every group header of change 3486 on one line, its name cut only in the middle and Accept whole", async () => {
        const page = await open();
        await page.locator('.chg[data-chg="3486"]').click();
        await page.locator("#snap-list .srow.cur").waitFor();
        const heads = await page.locator("#snap-list .ghead").evaluateAll((hs) =>
            hs.map((h) => {
                const name = h.querySelector(".gname .gn");
                const hb = h.getBoundingClientRect();
                const nb = name.getBoundingClientRect();
                const acc = h.querySelector('[data-act="gaccept"], [data-act="gundo"]')?.getBoundingClientRect();
                return {
                    group: h.dataset.group,
                    height: hb.height,
                    overflow: h.scrollHeight - h.clientHeight,
                    nameInside: nb.top >= hb.top && nb.bottom <= hb.bottom,
                    nameCut: name.scrollWidth - name.clientWidth,
                    accInside: !acc || (acc.left >= hb.left && acc.right <= hb.right + 0.5),
                };
            }),
        );
        expect(heads.length).toBeGreaterThan(0);
        for (const h of heads) {
            expect(h, h.group).toMatchObject({
                height: 32,
                overflow: 0,
                nameInside: true,
                nameCut: 0,
                accInside: true,
            });
        }
    });

    it("holds the frame's fixed sizes", async () => {
        const page = await open();
        expect((await box(page, "#top")).height).toBe(36);
        expect((await box(page, "#msgline")).height).toBe(24);
        // No change open: Changes is 480 px wide, no Snapshots pane, and the viewer holds the
        // current change's summary.
        expect((await box(page, "#changes")).width).toBe(480);
        expect(await page.locator("#snaps").evaluate((n) => n.getClientRects().length)).toBe(0);
        expect((await box(page, "#viewer")).width).toBe(width - 480);
        await page.locator('.chg[data-chg="3484"]').click();
        await page.locator(".iline").waitFor({ state: "attached" });
        expect((await box(page, "#changes")).width).toBe(56);
        expect((await box(page, "#snaps")).width).toBe(56);
    });

    it("draws a focused button's Enter hint outside it: the button and its neighbors keep their place", async () => {
        const page = await open();
        const keys = page.locator('#top [data-act="keys"]');
        const before = await box(page, '#top [data-act="keys"]');
        const settings = await box(page, '#top [data-act="settings"]');
        // Focused from the keyboard, as the hint is drawn only for a focus the reader can see.
        await page.locator('#top [data-act="nextchange"]').focus();
        await page.keyboard.press("Tab");
        await expect.poll(() => keys.evaluate((n) => n === globalThis.document.activeElement)).toBe(true);
        expect(await keys.evaluate((n) => globalThis.getComputedStyle(n, "::after").content)).toBe('"Enter"');
        expect(await box(page, '#top [data-act="keys"]')).toEqual(before);
        expect(await box(page, '#top [data-act="settings"]')).toEqual(settings);
    });
});

describe.each(SIZES)("the Baselines screen at %i x %i", (width, height) => {
    it("keeps its viewer at 800 px or more after every pane key, its toolbar in one row with each zoom segment", async () => {
        t = await openNext(browser, { targets: fiftyChanges(), viewport: { width, height } });
        const page = t.page;
        await routeBaselines(page);
        await page.locator(".chg").first().waitFor();
        await page.locator('#tabs [data-act="screen-baselines"]').click();
        await page.locator("#bl-vtb").waitFor();
        const look = async (what) => {
            expect((await box(page, "#bl-viewer")).width, what).toBeGreaterThanOrEqual(800);
            const bad = await page.evaluate(() => {
                const bar = globalThis.document.getElementById("bl-vtb").getBoundingClientRect();
                const out = [];
                for (const b of globalThis.document.querySelectorAll("#bl-vtb button")) {
                    const r = b.getBoundingClientRect();
                    if (r.width === 0) {
                        continue;
                    }
                    if (r.left < bar.left - 0.5 || r.right > bar.right + 0.5) {
                        out.push(`${b.dataset.act} outside the row`);
                    }
                    if (r.top < bar.top || r.bottom > bar.bottom || r.height > 30) {
                        out.push(`${b.dataset.act} in a second row or wrapped`);
                    }
                    if (b.scrollWidth > b.clientWidth + 1) {
                        out.push(`${b.dataset.act} cut`);
                    }
                }
                return out;
            });
            expect(bad, what).toEqual([]);
            // The same controls as Review's toolbar, every one showing (Blink only in Highlight).
            for (const act of [
                "view-side",
                "view-flash",
                "view-highlight",
                "view-spotlight",
                "zoomcycle",
                "displaymenu",
            ]) {
                expect(await page.locator(`#bl-vtb [data-act="${act}"]`).isVisible(), `${what}: ${act}`).toBe(true);
            }
        };
        await look("opened");
        for (const key of [
            "Shift+Digit1",
            "Shift+Digit2",
            "Shift+Digit1",
            "Shift+Digit2",
            "Shift+Digit3",
            "Shift+Digit3",
        ]) {
            await page.keyboard.press(key);
            await look(`after ${key}`);
        }
        await page.keyboard.press("Digit4");
        await expect.poll(() => page.locator('#bl-vtb [data-act="zoomcycle"]').innerText()).toMatch(/^Zoom: 4x/);
        await look("at 4x");
    });
});

describe("at 1024 x 768", () => {
    // Every visible control that prints a key (or opens a menu whose items print keys) wholly inside
    // the window, and the decision bar one 52 px line with every button inside it.
    const check = async (page, what) => {
        const outside = await page.evaluate(() =>
            [...globalThis.document.querySelectorAll("[data-key], [data-menukeys]")]
                .filter((n) => n.getClientRects().length > 0 && !n.closest("dialog"))
                .filter((n) => {
                    const r = n.getBoundingClientRect();
                    return (
                        r.left < 0 ||
                        r.top < 0 ||
                        r.right > globalThis.innerWidth + 0.5 ||
                        r.bottom > globalThis.innerHeight + 0.5
                    );
                })
                .map((n) => n.dataset.act),
        );
        expect(outside, what).toEqual([]);
        const bar = await box(page, "#viewer .decide");
        expect(bar.height, what).toBe(52);
        const buttons = await page
            .locator("#viewer .decide button")
            .evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().toJSON()));
        for (const b of buttons) {
            expect(b.top >= bar.top && b.bottom <= bar.bottom && b.right <= bar.right + 0.5, what).toBe(true);
        }
    };
    it("keeps every keyed control in the window with a change open, and with three rows selected", async () => {
        t = await openNext(browser, { targets: fiftyChanges(), viewport: { width: 1024, height: 768 } });
        const page = t.page;
        await page.locator('.chg[data-chg="3486"]').click();
        await page.locator(".iline").waitFor({ state: "attached" });
        await check(page, "change open");
        // The decision words never drop: Previous and Next show their keys, named for a screen reader.
        expect(await page.locator('.decide [data-act="accept"]').innerText()).toMatch(/^Accept/);
        expect(await page.locator('.decide [data-act="prev"]').getAttribute("aria-label")).toBe("Previous");
        await page.keyboard.press("KeyX");
        await page.keyboard.press("Shift+ArrowDown");
        await page.keyboard.press("Shift+ArrowDown");
        await expect.poll(() => page.locator("#snaps-head .lselbar .selcount").innerText()).toBe("3 selected");
        await expect.poll(() => page.locator('.decide [data-act="accept"]').innerText()).toMatch(/^Accept 3/);
        expect(await page.locator('.decide [data-act="reject"]').innerText()).toMatch(/^Reject 3\.\.\./);
        expect(await page.locator('.decide [data-act="exclude"]').innerText()).toMatch(/^Exclude 3\.\.\./);
        await check(page, "three selected");
    });
});

describe("levels by pointer", () => {
    it("moves to viewing with Open or a click in the viewer, and back with Back; a row click picks a snapshot", async () => {
        t = await openNext(browser, { targets: fiftyChanges(), viewport: { width: 1280, height: 800 } });
        const page = t.page;
        await page.locator('.chg[data-chg="3486"]').click();
        await page.locator(".iline").waitFor({ state: "attached" });
        // The list level: Snapshots shown, Open [Enter] on the item line.
        expect(await page.locator('.iline [data-act="openrow"]').innerText()).toBe("OpenEnter");
        await page.locator('.srow[data-snap="graphty-element/component-1--story-7.dark.png"]').click();
        await expect.poll(() => page.locator(".iline").innerText()).toContain("#8");
        expect(await page.evaluate(() => globalThis.location.hash)).toContain(
            "snap=graphty-element%2Fcomponent-1--story-7.dark.png",
        );
        await page.locator("#stage").click();
        await expect
            .poll(() => page.locator('.iline [data-act="back"]').getAttribute("title"))
            .toBe("Back to the list (Esc)");
        expect(await page.locator('.iline [data-act="openrow"]').count()).toBe(0);
        expect(await page.locator("#snaps").getAttribute("class")).toContain("rail");
        await page.locator('.iline [data-act="back"]').click();
        await expect.poll(() => message(page)).toBe("Back to the list.");
        await page.locator('.iline [data-act="openrow"]').click();
        await expect
            .poll(() => page.locator('.iline [data-act="back"]').getAttribute("title"))
            .toBe("Back to the list (Esc)");
        // The rails show the panes again, and a row click from a shown list returns to the list level.
        await page.locator("#rail-s").click();
        await expect.poll(() => page.locator("#snaps").getAttribute("class")).not.toContain("rail");
        await page.locator('.srow[data-snap="graphty-element/component-0--story-2.light.png"]').click();
        await expect
            .poll(() => page.locator('.iline [data-act="back"]').getAttribute("title"))
            .toBe("Back to the changes (Esc)");
        await page.locator("#rail-c").click();
        await expect.poll(() => page.locator("#changes").getAttribute("class")).not.toContain("rail");
    });

    it("drops a viewing level that a wider window no longer has", async () => {
        t = await openNext(browser, { targets: fiftyChanges(), viewport: { width: 1280, height: 800 } });
        const page = t.page;
        await page.locator('.chg[data-chg="3486"]').click();
        await page.locator('.iline [data-act="openrow"]').click();
        await expect
            .poll(() => page.locator('.iline [data-act="back"]').getAttribute("title"))
            .toBe("Back to the list (Esc)");
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect
            .poll(() => message(page))
            .toBe("The window is 1400 px or wider: the list is shown beside the viewer.");
        expect(await page.locator('.iline [data-act="back"]').getAttribute("title")).toBe("Back to the changes (Esc)");
        expect(await page.locator("#snaps").getAttribute("class")).not.toContain("rail");
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["layout.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
