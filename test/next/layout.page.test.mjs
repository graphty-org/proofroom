/*
 * The new page's layout in Chromium at 1280 x 800, 1440 x 900 and an iPad-like 1180 x 820: the
 * viewer is never narrower than 800 px while it shows a snapshot, in every level and after every
 * pane key, with 3 and 300 snapshots; the levels move by clicks on the rows, Open, Back and the
 * viewer as they do by keys; and the top bar's 36 px, the message line's 24 px and the rails' 44 px.
 */

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { COVERS } from "./covers.mjs";
import { fiftyChanges, message, openNext } from "./page-kit.mjs";

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
        await page.locator(".iline").waitFor();
        await look("opened");
        for (const key of ["Shift+Digit1", "Shift+Digit2", "Shift+Digit1", "Shift+Digit2"]) {
            await page.keyboard.press(key);
            await look(`after ${key}`);
        }
        if ((await page.locator('.iline [data-act="openrow"]').count()) > 0) {
            await page.locator('.iline [data-act="openrow"]').click();
            await look("viewing");
            await page.keyboard.press("Shift+Digit2");
            await look("viewing, Shift+2");
            await page.locator('.iline [data-act="back"]').click();
            await look("back to the list");
        }
        await page.locator('.iline [data-act="back"]').click();
        await expect.poll(() => message(page)).toBe("Back to the changes.");
        await look("back to the changes");
        for (const key of ["Shift+Digit2", "Shift+Digit1", "Shift+Digit2"]) {
            await page.keyboard.press(key);
            await look(`changes level, after ${key}`);
        }
        expect(widths.length).toBeGreaterThan(4);
    });

    it("holds the frame's fixed sizes", async () => {
        const page = await open();
        expect((await box(page, "#top")).height).toBe(36);
        expect((await box(page, "#msgline")).height).toBe(24);
        // No change open: Changes is 480 px wide, the Snapshots pane 420 px.
        expect((await box(page, "#changes")).width).toBe(480);
        expect((await box(page, "#snaps")).width).toBe(420);
        await page.locator('.chg[data-chg="3484"]').click();
        await page.locator(".iline").waitFor();
        expect((await box(page, "#changes")).width).toBe(44);
        expect((await box(page, "#snaps")).width).toBe(44);
    });
});

describe("levels by pointer", () => {
    it("moves to viewing with Open or a click in the viewer, and back with Back; a row click picks a snapshot", async () => {
        t = await openNext(browser, { targets: fiftyChanges(), viewport: { width: 1280, height: 800 } });
        const page = t.page;
        await page.locator('.chg[data-chg="3486"]').click();
        await page.locator(".iline").waitFor();
        // The list level: Snapshots shown, Open [Enter] on the item line.
        expect(await page.locator('.iline [data-act="openrow"]').innerText()).toBe("OpenEnter");
        await page.locator('.srow[data-snap="graphty-element/component-1--story-7.dark.png"]').click();
        await expect.poll(() => page.locator(".iline").innerText()).toContain("#8");
        expect(await page.evaluate(() => globalThis.location.hash)).toContain(
            "snap=graphty-element%2Fcomponent-1--story-7.dark.png",
        );
        await page.locator("#stage").click();
        await expect.poll(() => page.locator(".iline").innerText()).toContain("Back to list");
        expect(await page.locator('.iline [data-act="openrow"]').count()).toBe(0);
        expect(await page.locator("#snaps").getAttribute("class")).toContain("rail");
        await page.locator('.iline [data-act="back"]').click();
        await expect.poll(() => message(page)).toBe("Back to the list.");
        await page.locator('.iline [data-act="openrow"]').click();
        await expect.poll(() => page.locator(".iline").innerText()).toContain("Back to list");
        // The rails show the panes again, and a row click from a shown list returns to the list level.
        await page.locator("#rail-s").click();
        await expect.poll(() => page.locator("#snaps").getAttribute("class")).not.toContain("rail");
        await page.locator('.srow[data-snap="graphty-element/component-0--story-2.light.png"]').click();
        await expect.poll(() => page.locator(".iline").innerText()).toContain("Back to changes");
        await page.locator("#rail-c").click();
        await expect.poll(() => page.locator("#changes").getAttribute("class")).not.toContain("rail");
    });

    it("drops a viewing level that a wider window no longer has", async () => {
        t = await openNext(browser, { targets: fiftyChanges(), viewport: { width: 1280, height: 800 } });
        const page = t.page;
        await page.locator('.chg[data-chg="3486"]').click();
        await page.locator('.iline [data-act="openrow"]').click();
        await expect.poll(() => page.locator(".iline").innerText()).toContain("Back to list");
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect
            .poll(() => message(page))
            .toBe("The window is 1400 px or wider: the list is shown beside the viewer.");
        expect(await page.locator(".iline").innerText()).toContain("Back to changes");
        expect(await page.locator("#snaps").getAttribute("class")).not.toContain("rail");
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["layout.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
