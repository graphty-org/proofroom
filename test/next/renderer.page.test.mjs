/*
 * What a capture says about how it was made, on the new page, by real input in Chromium: the
 * renderer banner in place of the rows when the capture's renderer is not the baselines' (and never
 * when either is not recorded), with Show the changes anyway and Capture the baselines again...;
 * the "attempts disagree" badge; and the list menu's Download the comparison report (JUnit).
 */

import { readFileSync } from "node:fs";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { COVERS } from "./covers.mjs";
import { message, openNext, project, rowsAnswer, target } from "./page-kit.mjs";

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

const ID = "4100";
const CHROMIUM_131 = { name: "Chromium", version: "131.0.6778.33" };
const CHROMIUM_128 = { name: "Chromium", version: "128.0.6613.18" };

/**
 * A page with a change of 12 changed snapshots and one other change, whose rows' answer carries these capture fields,
 * opened by a click on the change.
 * @param {object} results the capture's fields the rows' answer carries (`renderer`, `baselineRenderer`)
 * @param {(items: object[]) => void} [edit] changes the rows
 * @returns {Promise<import("playwright").Page>} the tab
 */
async function open(results, edit = () => {}) {
    t = await openNext(browser, {
        // Two changes: with one alone, the page opens it at once and folds the list of changes away.
        targets: [target(Number(ID), { projects: [project("graphty-element", { reviewable: 12 })] }), target(4101)],
        rows: (id, name) => {
            const answer = rowsAnswer(name, 12, () => "changed");
            edit(answer.items);
            return { ...answer, results: { scale: 2, ...results } };
        },
    });
    const page = t.page;
    await page.locator(`.chg[data-chg="${ID}"]`).click();
    // Opened: the snapshot pane's header names the change's count.
    await page.locator("#snaps-head .h2").waitFor();
    if ((await page.locator("#snaps").getAttribute("class")).includes("rail")) {
        await page.keyboard.press("Shift+Digit2");
    }
    return page;
}

const banner = (page) => page.locator("#snap-renderer");

describe("the renderer banner", () => {
    it("stands in for the rows when the capture's renderer is not the baselines', and Show the changes anyway shows them", async () => {
        const page = await open({ renderer: CHROMIUM_131, baselineRenderer: CHROMIUM_128 });
        await expect
            .poll(() => banner(page).innerText())
            .toContain("These captures used Chromium 131; the baselines used Chromium 128. Every image may differ.");
        expect(await page.locator("#snap-list").isHidden()).toBe(true);
        expect(await page.locator("#viewer .emptyv").innerText()).toContain("Renderer changed");
        // Nothing in the viewer to decide with while the banner stands in for the rows.
        expect(await page.locator('#viewer [data-act="accept"]').count()).toBe(0);

        await banner(page).getByRole("button", { name: "Show the changes anyway" }).click();
        await expect.poll(() => banner(page).isHidden()).toBe(true);
        await page.locator("#snap-list .srow").first().waitFor();
        expect(await page.locator("#snap-list .srow").count()).toBe(12);
        expect(await message(page)).toBe(
            "Showing the changes made under a different renderer. Every image may differ.",
        );
        await page.locator(".iline").waitFor();
    });

    it("names the whole versions when only a later part differs", async () => {
        const page = await open({
            renderer: { name: "Chromium", version: "131.0.6778.33" },
            baselineRenderer: { name: "Chromium", version: "131.0.6778.20" },
        });
        await expect
            .poll(() => banner(page).innerText())
            .toContain("These captures used Chromium 131.0.6778.33; the baselines used Chromium 131.0.6778.20.");
    });

    it("Capture the baselines again... opens New capture", async () => {
        const page = await open({ renderer: CHROMIUM_131, baselineRenderer: CHROMIUM_128 });
        await page.route("**/api/captures**", (route) =>
            route.fulfill({
                json: {
                    captures: [],
                    sources: { branch: "master", changed: 0, branches: ["master"] },
                },
            }),
        );
        await banner(page).getByRole("button", { name: "Capture the baselines again..." }).click();
        await expect.poll(() => page.locator("dialog[open] h3").innerText()).toBe("New capture");
    });

    it.each([
        ["the baselines' renderer is not recorded", { renderer: CHROMIUM_131 }],
        ["the capture's renderer is not recorded", { baselineRenderer: CHROMIUM_128 }],
        ["they are the same", { renderer: CHROMIUM_131, baselineRenderer: { ...CHROMIUM_131 } }],
    ])("is not shown when %s", async (_, results) => {
        const page = await open(results);
        await page.locator("#snap-list .srow").first().waitFor();
        expect(await banner(page).isHidden()).toBe(true);
        expect(await page.locator("#snap-list .srow").count()).toBe(12);
    });
});

describe("a snapshot's attempts", () => {
    it('show "attempts disagree" as a badge, never as a status', async () => {
        const page = await open({}, (items) => {
            items[0].disagree = true;
        });
        const first = page.locator("#snap-list .srow").first();
        await first.waitFor();
        // The row's line 4 has no room for it after the change size, so it folds into the "+1" chip,
        // whose tip names it, as the mockup folds a badge that does not fit.
        const chip = first.locator(".x4 .badge");
        expect(await chip.innerText()).toBe("+1");
        expect(await chip.getAttribute("title")).toBe(
            "Its attempts in this run did not agree: Attempts in the details lists each",
        );
        expect(await first.locator(".st").first().innerText()).toBe("changed");
        await first.click();
        expect(await page.locator(".iline .badge.other").innerText()).toBe("attempts disagree");
        // One snapshot's attempts disagree, so one row carries a badge.
        expect(await page.locator("#snap-list .srow .x4 .badge").count()).toBe(1);
    });
});

describe("the list menu", () => {
    it("Download the comparison report (JUnit) saves the open run's report", async () => {
        const page = await open({});
        await page.locator("#snap-list .srow").first().waitFor();
        const asked = [];
        const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="proofroom"></testsuites>\n';
        await page.route("**/api/junit/**", (route) => {
            asked.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search);
            return route.fulfill({
                status: 200,
                contentType: "application/xml",
                headers: { "content-disposition": `attachment; filename="proofroom-${ID}.junit.xml"` },
                body: xml,
            });
        });
        await page.locator('#snaps-head [data-act="listmenu"]').click();
        const saved = page.waitForEvent("download");
        await page.getByRole("menu").getByText("Download the comparison report (JUnit)", { exact: true }).click();
        const download = await saved;
        expect(download.suggestedFilename()).toBe(`proofroom-${ID}.junit.xml`);
        expect(readFileSync(await download.path(), "utf8")).toBe(xml);
        expect(asked).toEqual([`/api/junit/${ID}?run=${1000 + Number(ID)}-1`]);
        await expect.poll(() => message(page)).toBe(`Downloaded the comparison report of #${ID}: proofroom-${ID}.junit.xml.`);
    });

    it("says why when the server has no report", async () => {
        const page = await open({});
        await page.locator("#snap-list .srow").first().waitFor();
        await page.route("**/api/junit/**", (route) =>
            route.fulfill({ status: 404, json: { error: "this change has no comparison results yet" } }),
        );
        await page.locator('#snaps-head [data-act="listmenu"]').click();
        await page.getByRole("menu").getByText("Download the comparison report (JUnit)", { exact: true }).click();
        await expect
            .poll(() => message(page))
            .toBe("The comparison report could not be downloaded: this change has no comparison results yet");
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["renderer.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
