/*
 * Two things a reader does with the panes and the lists, by real key presses and clicks in
 * Chromium: a pane key (or its Hide button, or its rail) pressed again after it moved the other
 * pane to its rail takes that back, so the panes are as they were before the first press; and every
 * list where Up and Down move the current row has Previous [Up] and Next [Down] buttons that move
 * it exactly as the keys do, with their key boxes on the pair the keys move.
 */

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { COVERS } from "./covers.mjs";
import { fiftyChanges, message, openNext, routeBaselines, target, visibleKeys } from "./page-kit.mjs";

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

const open = async (viewport = { width: 1280, height: 800 }) => {
    t = await openNext(browser, { targets: fiftyChanges(), viewport });
    await t.page.locator(".chg").first().waitFor();
    return t.page;
};
// Whether Changes and Snapshots are shown (not rails).
const shown = (page) =>
    page.evaluate(() =>
        ["changes", "snaps"].map((id) => !globalThis.document.getElementById(id).classList.contains("rail")),
    );
// Change 3486 open at 1280 px, at its list level: Changes a rail, Snapshots shown.
async function openLarge() {
    const page = await open();
    await page.locator('.chg[data-chg="3486"]').click();
    await page.locator('.iline [data-act="openrow"]').waitFor();
    await expect.poll(() => shown(page)).toEqual([false, true]);
    return page;
}
const current = (page, sel, attr) => page.locator(`${sel}.cur`).first().getAttribute(attr);

describe("a pane key pressed again", () => {
    it("Shift+1 twice brings Snapshots back out of its rail", async () => {
        const page = await openLarge();
        await page.keyboard.press("Shift+Digit1");
        await expect.poll(() => shown(page)).toEqual([true, false]);
        expect(await message(page)).toBe("Changes shown. Snapshots moved to its rail so the viewer keeps 800 px.");
        await page.keyboard.press("Shift+Digit1");
        await expect.poll(() => shown(page)).toEqual([false, true]);
        expect(await message(page)).toBe("Changes hidden: its rail or Shift+1 brings it back. Snapshots shown again.");
    });

    it("the Changes rail, then its Hide button, do the same", async () => {
        const page = await openLarge();
        await page.locator("#rail-c").click();
        await expect.poll(() => shown(page)).toEqual([true, false]);
        await page.locator('#hide-c [data-act="pane1"]').click();
        await expect.poll(() => shown(page)).toEqual([false, true]);
        expect(await message(page)).toBe("Changes hidden: its rail or Shift+1 brings it back. Snapshots shown again.");
    });

    it("Shift+2 twice brings Changes back the same way", async () => {
        const page = await openLarge();
        await page.keyboard.press("Shift+Digit1");
        await page.keyboard.press("Shift+Digit1");
        await page.keyboard.press("Shift+Digit2");
        await expect.poll(() => shown(page)).toEqual([false, false]);
        await page.keyboard.press("Shift+Digit1");
        await expect.poll(() => shown(page)).toEqual([true, false]);
        // Snapshots shown moves Changes to its rail; Shift+2 again takes that back.
        await page.keyboard.press("Shift+Digit2");
        await expect.poll(() => shown(page)).toEqual([false, true]);
        expect(await message(page)).toBe("Snapshots shown. Changes moved to its rail so the viewer keeps 800 px.");
        await page.keyboard.press("Shift+Digit2");
        await expect.poll(() => shown(page)).toEqual([true, false]);
        expect(await message(page)).toBe("Snapshots hidden: its rail or Shift+2 brings it back. Changes shown again.");
    });

    it("hiding a pane that moved nothing stays a plain hide", async () => {
        const page = await openLarge();
        await page.keyboard.press("Shift+Digit2");
        await expect.poll(() => shown(page)).toEqual([false, false]);
        expect(await message(page)).toBe("Snapshots hidden: its rail or Shift+2 brings it back.");
    });
});

describe("Previous [Up] and Next [Down]", () => {
    it("are in the Changes pane header, show their keys, and move the current change as Up and Down do", async () => {
        const page = await open();
        const up = page.locator('#chg-rows [data-act="rowup"]');
        const down = page.locator('#chg-rows [data-act="rowdown"]');
        expect(await up.innerText()).toBe("Up");
        expect(await down.innerText()).toBe("Down");
        expect(await up.getAttribute("aria-label")).toBe("Previous");
        expect(await down.getAttribute("title")).toBe("Next row (Down)");
        const seen = [];
        await page.locator("#chg-list").focus();
        for (const k of ["ArrowDown", "ArrowDown", "ArrowUp"]) {
            await page.keyboard.press(k);
            seen.push(await current(page, ".chg", "data-chg"));
        }
        await page.keyboard.press("ArrowUp");
        const clicked = [];
        for (const b of [down, down, up]) {
            await b.click();
            clicked.push(await current(page, ".chg", "data-chg"));
        }
        expect(clicked).toEqual(seen);
        expect(new Set(seen).size).toBe(2);
        expect(t.actions.filter((a) => a.a === "rowdown").map((a) => a.via)).toEqual([
            "key",
            "key",
            "pointer",
            "pointer",
        ]);
    });

    it("are in the Snapshots pane header and move the current snapshot as Up and Down do", async () => {
        const page = await openLarge();
        const up = page.locator('#snaps-head [data-act="rowup"]');
        const down = page.locator('#snaps-head [data-act="rowdown"]');
        // The keys move the snapshot list here, so its pair carries the key boxes.
        const keys = await visibleKeys(page);
        expect(keys).toContainEqual({ act: "rowup", key: "Up" });
        expect(keys).toContainEqual({ act: "rowdown", key: "Down" });
        const first = await current(page, ".srow", "data-snap");
        const seen = [];
        await page.locator("#snap-list").focus();
        for (const k of ["ArrowDown", "ArrowDown", "ArrowUp"]) {
            await page.keyboard.press(k);
            await expect.poll(() => current(page, ".srow", "data-snap")).not.toBe(seen.at(-1) ?? first);
            seen.push(await current(page, ".srow", "data-snap"));
        }
        await page.keyboard.press("ArrowUp");
        await expect.poll(() => current(page, ".srow", "data-snap")).toBe(first);
        const clicked = [];
        for (const b of [down, down, up]) {
            await b.click();
            clicked.push(await current(page, ".srow", "data-snap"));
        }
        expect(clicked).toEqual(seen);
    });

    it("print their keys on one pair only while both panes show them, the pair the keys move", async () => {
        const page = await open({ width: 1600, height: 900 });
        await page.locator('.chg[data-chg="3486"]').click();
        await page.locator(".iline").waitFor({ state: "attached" });
        await page.keyboard.press("Shift+Digit1");
        await expect.poll(() => shown(page)).toEqual([true, true]);
        const boxesIn = (sel) =>
            page.locator(`${sel} [data-act^="row"] > kbd`).evaluateAll((ks) => ks.filter((k) => !k.hidden).length);
        await page.locator("#snap-list").focus();
        await expect.poll(() => boxesIn("#snaps-head")).toBe(2);
        expect(await boxesIn("#chg-rows")).toBe(0);
        // A pair is its key boxes alone while it has them...
        const snapUp = page.locator('#snaps-head [data-act="rowup"]');
        expect(await snapUp.innerText()).toBe("Up");
        expect(await page.locator('#chg-rows [data-act="rowup"]').innerText()).toBe("Previous");
        await page.locator("#chg-list").focus();
        await expect.poll(() => boxesIn("#chg-rows")).toBe(2);
        expect(await boxesIn("#snaps-head")).toBe(0);
        // ...and its words while the Changes pane's pair has them: never an empty button.
        expect(await snapUp.innerText()).toBe("Previous");
        const before = await current(page, ".chg", "data-chg");
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => current(page, ".chg", "data-chg")).not.toBe(before);
    });

    it("are in the Baselines list header and move the current baseline as Up and Down do", async () => {
        t = await openNext(browser, { targets: [target(3486), target(3471)], viewport: { width: 1600, height: 900 } });
        await routeBaselines(t.page);
        const page = t.page;
        await page.locator(".chg").first().waitFor();
        await page.locator('#tabs [data-act="screen-baselines"]').click();
        await page.locator("#bl-list .blrow.cur").waitFor();
        const up = page.locator('#bl-ctrl [data-act="rowup"]');
        const down = page.locator('#bl-ctrl [data-act="rowdown"]');
        expect(await up.innerText()).toBe("Up");
        expect(await down.innerText()).toBe("Down");
        expect(await up.getAttribute("aria-label")).toBe("Previous");
        expect(await down.getAttribute("title")).toBe("Next row (Down)");
        const cur = () => page.locator("#bl-list .blrow.cur").textContent();
        const seen = [];
        await page.locator("#bl-list").focus();
        for (const k of ["ArrowDown", "ArrowDown", "ArrowUp"]) {
            await page.keyboard.press(k);
            seen.push(await cur());
        }
        await page.keyboard.press("ArrowUp");
        const clicked = [];
        for (const b of [down, down, up]) {
            await b.click();
            clicked.push(await cur());
        }
        expect(clicked).toEqual(seen);
        expect(new Set(seen).size).toBe(2);
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["rows-and-panes.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
