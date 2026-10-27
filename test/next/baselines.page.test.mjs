/*
 * The Baselines screen of the new page (design 9.3), by real input in Chromium: the tab, the
 * projects and their components with counts, the list, the current baseline in the viewer and its
 * history (each version's approval by change statement, by tree, or none), two versions compared
 * in all four views, Shift+1/2/3 and the zoom digits as on Review, Previous and Next, Find and
 * Group, another change's baselines with Git LFS pointers shown as Not downloaded and downloaded
 * only when asked, an old version's own Download, and P saying what it does on Review.
 */

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { COVERS } from "./covers.mjs";
import { BL_THREE, message, openNext, routeBaselines, target } from "./page-kit.mjs";

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

const tool = (page, act) => page.locator(`#bl-vtb [data-act="${act}"]`);
const labels = (page) => page.locator("#bl-stage figure .label").allInnerTexts();

// The page on the Baselines tab, with the first baseline's history in.
// 1600 px wide: both side panes beside the 800 px viewer.
async function open(viewport = { width: 1600, height: 900 }) {
    t = await openNext(browser, { targets: [target(3486), target(3471)], viewport });
    const routes = await routeBaselines(t.page);
    const page = t.page;
    await page.locator(".chg").first().waitFor();
    await page.locator('#tabs [data-act="screen-baselines"]').click();
    await page.locator("#bl-list .blrow.cur").waitFor();
    await page.locator('#bl-hist [data-version="0"]').waitFor();
    return { page, routes };
}

describe("the Baselines screen", () => {
    it("lists the projects and components with counts, the baselines, the current one and its history", async () => {
        const { page, routes } = await open();
        expect(await page.locator('#tabs [data-act="screen-baselines"]').getAttribute("aria-current")).toBe("page");
        expect(await page.locator("#bl-tree .node").allInnerTexts()).toEqual([
            "Every project\n6",
            "compact-mantine\n4",
            "button\n2",
            "card\n1",
            "chip\n1",
            "graphty-element\n2",
            "graph\n2",
        ]);
        expect(await page.locator("#bl-title").innerText()).toContain("6 baselines");
        const first = page.locator("#bl-list .blrow").first();
        expect(await first.innerText()).toContain("#1");
        expect(await first.innerText()).toContain("button / primary");
        expect(await first.innerText()).toContain("Last changed 2026-10-15 in #71");
        await expect.poll(() => first.locator(".pic").getAttribute("class")).toContain("ready");
        expect(await page.locator("#bl-viewer .iline").innerText()).toContain("The current baseline");
        expect(await labels(page)).toEqual(["Current baseline"]);
        expect(await page.locator("#bl-viewer .decide").innerText()).toContain("1 of 6 baselines");
        const hist = await page.locator("#bl-hist .h[data-version]").allInnerTexts();
        expect(hist[0]).toMatch(/current\s+2026-10-15\s+accepted by apowers\s+in #71\s+signed by MacBook Touch ID/);
        // Approved the old way: found by the tree statement of its commit's baselines tree.
        expect(hist[1]).toMatch(/previous\s+2026-09-18\s+accepted by mlin\s+in #60\s+signed by MacBook Touch ID/);
        expect(hist[2]).toMatch(/first\s+2026-08-02\s+accepted by kchen\s+no approval record\s+Not downloaded/);
        // The list is read once, and the history only for the baseline viewed.
        expect(routes.asked).toEqual(["list ", `history ${BL_THREE}`]);
    });

    it("compares two versions in each of the four views, which need two until they are ticked", async () => {
        const { page } = await open();
        await page.keyboard.press("KeyF");
        await expect.poll(() => message(page)).toBe("Flash: Flash needs two versions: tick two in the history below.");
        expect(await tool(page, "view-highlight").getAttribute("aria-disabled")).toBe("true");
        await page.locator('#bl-hist [data-version="0"] input').click();
        await page.locator('#bl-hist [data-version="1"] input').click();
        await expect
            .poll(() => page.locator("#bl-viewer .iline").innerText())
            .toContain("Comparing the previous version (left) with the current version (right)");
        await page.keyboard.press("KeyV");
        await expect.poll(() => labels(page)).toEqual(["previous", "current"]);
        await page.keyboard.press("KeyH");
        await expect.poll(() => tool(page, "view-highlight").getAttribute("aria-checked")).toBe("true");
        await expect.poll(() => page.locator("#bl-stage canvas").count()).toBeGreaterThan(0);
        expect(await labels(page)).toEqual(["previous", "current"]);
        await page.keyboard.press("KeyS");
        await expect.poll(() => labels(page)).toEqual(["previous", "Spotlit current"]);
        await page.keyboard.press("KeyV");
        await page.keyboard.press("KeyF");
        await expect.poll(() => tool(page, "view-flash").getAttribute("aria-checked")).toBe("true");
        await expect.poll(() => page.locator("#bl-stage figure").count()).toBe(1);
        // A version not downloaded cannot be ticked, and says why.
        // Clicked as a reader can, though it is shown unavailable.
        await page.locator('#bl-hist [data-version="2"] input').click({ force: true });
        expect(await page.locator('#bl-hist [data-version="2"] input').isChecked()).toBe(false);
        expect(await message(page)).toBe("Compare: Not downloaded: Download it first.");
        // Its own Download fetches that version alone, at its commit.
        await page.locator('#bl-hist [data-version="2"] [data-act="bldlver"]').click();
        await expect
            .poll(() => page.locator('#bl-hist [data-version="2"]').innerText())
            .not.toContain("Not downloaded");
        expect(t.posts).toEqual([]);
        await page.locator('#bl-hist [data-version="2"] input').click();
        await expect
            .poll(() => page.locator("#bl-viewer .iline").innerText())
            .toContain("Comparing the first version (left) with the previous version (right)");
    });

    it("binds Shift+1, Shift+2, Shift+3 and the zoom digits as Review does, each with its button showing", async () => {
        const { page } = await open();
        await page.keyboard.press("Shift+Digit1");
        await expect.poll(() => page.locator("#bl-proj").getAttribute("class")).toContain("rail");
        expect(await message(page)).toBe("Projects hidden: its rail or Shift+1 brings it back.");
        await page.keyboard.press("Shift+Digit2");
        await expect.poll(() => page.locator("#bl-list-pane").getAttribute("class")).toContain("rail");
        expect(await tool(page, "imageonly").getAttribute("aria-pressed")).toBe("true");
        await page.keyboard.press("Shift+Digit3");
        await expect.poll(() => page.locator("#bl-list-pane").getAttribute("class")).not.toContain("rail");
        await page.locator("#rail-p").click();
        await expect.poll(() => page.locator("#bl-proj").getAttribute("class")).not.toContain("rail");
        await page.keyboard.press("Shift+Digit3");
        await expect.poll(() => tool(page, "imageonly").getAttribute("aria-pressed")).toBe("true");
        await page.keyboard.press("Shift+Digit3");
        for (const [key, zoom] of [
            ["Digit2", "zoom-2"],
            ["Digit4", "zoom-4"],
            ["Digit8", "zoom-8"],
            ["Digit1", "zoom-1"],
            ["Digit0", "zoom-fit"],
        ]) {
            await page.keyboard.press(key);
            await expect.poll(() => tool(page, zoom).getAttribute("class")).toContain("on");
            expect(await tool(page, zoom).isVisible()).toBe(true);
        }
        await page.keyboard.press("KeyZ");
        await expect.poll(() => tool(page, "zoom-1").getAttribute("class")).toContain("on");
        await tool(page, "zoom-fit").click();
        await page.keyboard.press("KeyP");
        expect(await message(page)).toBe(
            "Baseline [P] is for reviews: here, tick two versions in the history to compare them.",
        );
        // In a viewer under 1100 px More holds Image only and Layout, and Y opens it.
        expect(await tool(page, "more").isVisible()).toBe(true);
        expect(await tool(page, "layoutmenu").isVisible()).toBe(false);
        await page.keyboard.press("KeyY");
        expect(await page.getByRole("menu").locator(".mi").allInnerTexts()).toEqual([
            "Image only\nShift+3",
            "Layout: Auto\nY",
            "Layout: Side by side\nY",
            "Layout: Over and under\nY",
        ]);
        await page.getByRole("menuitemradio", { name: "Layout: Over and under" }).click();
        await tool(page, "more").click();
        expect(
            await page.getByRole("menuitemradio", { name: "Layout: Over and under" }).getAttribute("aria-checked"),
        ).toBe("true");
        await page.getByRole("menuitemradio", { name: "Layout: Auto" }).click();
    });

    it("moves through the baselines with Previous and Next, their keys and the rows, and finds and groups them", async () => {
        const { page, routes } = await open();
        await page.keyboard.press("KeyK");
        await expect.poll(() => page.locator("#bl-viewer .decide").innerText()).toContain("2 of 6 baselines");
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => page.locator("#bl-viewer .decide").innerText()).toContain("3 of 6 baselines");
        await page.keyboard.press("KeyJ");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowUp");
        await page.locator('#bl-viewer [data-act="next"]').click();
        await page.locator('#bl-viewer [data-act="prev"]').click();
        await expect.poll(() => page.locator("#bl-viewer .decide").innerText()).toContain("2 of 6 baselines");
        await page.locator('#bl-list .blrow[data-bl="graphty-element/graph--basic.png"]').click();
        await expect.poll(() => page.locator("#bl-viewer .iline").innerText()).toContain("graph / basic");
        expect(routes.asked.filter((a) => a.startsWith("history")).length).toBeGreaterThan(1);
        // A project, then a component, then every project.
        await page.locator("#bl-tree .node", { hasText: "graphty-element" }).click();
        await expect.poll(() => page.locator("#bl-list .blrow").count()).toBe(2);
        await page.locator("#bl-tree .node.sub", { hasText: "chip" }).click();
        await expect.poll(() => page.locator("#bl-title").innerText()).toContain("compact-mantine > chip");
        await page.locator("#bl-tree .node", { hasText: "Every project" }).click();
        await expect.poll(() => page.locator("#bl-list .blrow").count()).toBe(6);
        // Find [/], by name or by number; Esc clears it, then leaves it.
        await page.keyboard.press("Slash");
        await page.keyboard.type("legacy");
        await expect.poll(() => page.locator("#bl-list .blrow").count()).toBe(1);
        await page.keyboard.press("Escape");
        await expect.poll(() => page.locator("#bl-list .blrow").count()).toBe(6);
        await page.keyboard.type("#5");
        await expect.poll(() => page.locator("#bl-list .blrow").count()).toBe(1);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        // Group: Component, Project or None.
        expect(await page.locator("#bl-list .ghead").allInnerTexts()).toEqual([
            "compact-mantine > button",
            "compact-mantine > card",
            "compact-mantine > chip",
            "graphty-element > graph",
        ]);
        await page.locator('[data-act="blgroupmenu"]').click();
        await page.getByRole("menuitemradio", { name: "Project" }).click();
        await expect
            .poll(() => page.locator("#bl-list .ghead").allInnerTexts())
            .toEqual(["compact-mantine", "graphty-element"]);
        await page.locator('[data-act="blgroupmenu"]').click();
        await page.getByRole("menuitemradio", { name: "None" }).click();
        await expect.poll(() => page.locator("#bl-list .ghead").count()).toBe(0);
        // Back to Review, and to Baselines as it was left.
        await page.locator('#tabs [data-act="screen-review"]').click();
        await expect.poll(() => page.locator("#changes").isVisible()).toBe(true);
        expect(await page.locator("#bl-list-pane").isVisible()).toBe(false);
        await page.locator('#tabs [data-act="screen-baselines"]').click();
        await expect.poll(() => page.locator("#bl-list .ghead").count()).toBe(0);
    });

    it("shows a change's Git LFS pointers as Not downloaded, and downloads exactly those when asked", async () => {
        const { page, routes } = await open();
        await page.locator("#bl-ref").selectOption("3486");
        await expect.poll(() => page.locator("#bl-list .blrow").count()).toBe(8);
        expect(await message(page)).toBe("Showing the baselines of #3486 Change 3486.");
        const fresh = page.locator('#bl-list .blrow[data-bl="graphty-element/graph--fresh.png"]');
        expect(await fresh.locator(".pic").innerText()).toBe("Not downloaded");
        const dl = page.locator('#bl-ctrl [data-act="bldl"]');
        expect(await dl.innerText()).toBe("Download 2 images (7.0 MB)");
        // Viewing one not downloaded fetches nothing: it says so in the picture's place.
        await fresh.click();
        await expect.poll(() => page.locator("#bl-viewer").innerText()).toContain("Not downloaded");
        expect(routes.downloads).toEqual([]);
        await dl.click();
        await expect.poll(() => routes.downloads.length).toBe(1);
        expect(routes.downloads[0]).toEqual({
            ref: "3486",
            paths: [
                "visual-baselines/graphty-element/graph--fresh.png",
                "visual-baselines/graphty-element/graph--wide.png",
            ],
        });
        await expect.poll(() => fresh.locator(".pic").getAttribute("class")).toContain("ready");
        expect(await page.locator('#bl-ctrl [data-act="bldl"]').count()).toBe(0);
        await expect.poll(() => labels(page)).toEqual(["Current baseline"]);
        await page.locator("#bl-ref").selectOption("");
        await expect.poll(() => page.locator("#bl-list .blrow").count()).toBe(6);
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["baselines.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
