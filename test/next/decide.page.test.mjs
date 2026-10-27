/*
 * Decisions on the new page (design section 6, 4.5 and 4.6), by real input: Accept, Reject...,
 * Exclude... and Undo on the decision bar, by key and by click, with auto-advance and the end
 * card; the reason box (a reason required, recent reasons, Esc keeping the text, Undo putting it
 * back) and Exclude's second step; the error prevention kept from today's page, as counted checks:
 * a held key decides once, and a key within a quarter second of the draw sends nothing and says
 * why; the selection (checkbox, shift-click ranges across groups and over collapsed sections,
 * Ctrl/Cmd-click, Select [X], Extend up and down by menu and by Shift+Up / Shift+Down) and its bar
 * in place of the controls line; what A acts on, with its key printed only where it acts; group
 * header actions and the focus after a group accept; Approved before and Rejected before; the list
 * menu's Accept all shown and Undo all; the stale capture and Update from the default branch; and
 * the counted work: one request per project for every bulk action, and for its Undo.
 *
 * The decision keys run in Chromium and in WebKit (half of the owner's reviews are in iPad Safari
 * with a keyboard); the rest in Chromium. One test runs on the review server itself and reads the
 * decisions file back.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startApp } from "../faults.mjs";
import { isolateGit, makeRepo, onePr } from "../helpers.mjs";
import { COVERS } from "./covers.mjs";
import {
    BROWSERS,
    TOKEN,
    listAnswer,
    message,
    openNext,
    project,
    richRows,
    row,
    rowsAnswer,
    target,
    visibleKeys,
    webkitRuns,
} from "./page-kit.mjs";

const browsers = {};
let t = null;
const pressed = new Set();

beforeAll(async () => {
    process.env.FC_FONTATIONS = "1";
    browsers.chromium = await BROWSERS.chromium.launch();
    if (await webkitRuns()) {
        browsers.webkit = await BROWSERS.webkit.launch();
    }
});
afterEach(async () => {
    for (const a of t?.actions ?? []) {
        pressed.add(a.a);
    }
    await t?.close();
    t = null;
});
afterAll(async () => {
    await browsers.chromium?.close();
    await browsers.webkit?.close();
});

// A small picture for every image: what is drawn does not matter here, only that it is drawn.
const IMAGE = (() => {
    const png = new PNG({ width: 80, height: 60 });
    png.data.fill(200);
    return PNG.sync.write(png);
})();

// Thirty changed snapshots in six components of five; three (a small change, one level); two
// projects of twelve; a thousand in one component; one of every kind of row; a component of 25;
// and a capture the default branch has three newer baselines since.
const MAIN = "8100";
const SMALL = "8200";
const TWO = "8300";
const BIG = "8400";
const RICH = "5000";
const WIDE = "8600";
const STALE = "8500";
const NEWER = ["legend--default.light.png", "legend--default.dark.png", "minimap--zoom.light.png"];
const targets = () => [
    target(Number(MAIN), { title: "Thirty", projects: [project("graphty-element", { reviewable: 30 })] }),
    target(Number(SMALL), { title: "Three", projects: [project("graphty-element", { reviewable: 3 })] }),
    target(Number(TWO), {
        title: "Two projects",
        projects: [project("graphty-element", { reviewable: 12 }), project("graphty", { reviewable: 12 })],
    }),
    target(Number(BIG), { title: "A thousand", projects: [project("graphty-element", { reviewable: 1000 })] }),
    target(Number(RICH), { title: "Every kind", projects: [project("graphty-element", { reviewable: 180 })] }),
    target(Number(WIDE), { title: "Twenty-five", projects: [project("graphty-element", { reviewable: 25 })] }),
    target(Number(STALE), {
        title: "Behind master",
        stale: 3,
        projects: [project("graphty-element", { reviewable: 12, newer: NEWER })],
    }),
];
const rows = (id, name) => {
    if (id === RICH) {
        return richRows(name);
    }
    if (id === BIG) {
        return {
            project: name,
            items: Array.from({ length: 1000 }, (_, i) => row(i, "changed", { component: "widgets" })),
            decisions: {},
            clusters: [],
        };
    }
    if (id === WIDE) {
        return {
            project: name,
            items: Array.from({ length: 25 }, (_, i) => row(i, "changed", { component: "widgets" })),
            decisions: {},
            clusters: [],
        };
    }
    const n = targets()
        .find((x) => x.id === id)
        .projects.find((p) => p.project === name).reviewable;
    return rowsAnswer(name, n, id === SMALL ? undefined : () => "changed");
};

/**
 * A tab with the changes above, change `id` opened by a click, and its first snapshot drawn.
 * @param {string} id the change
 * @param {object} [options] openNext's options, and `browser`
 * @returns {Promise<import("playwright").Page>} the tab
 */
async function openChange(id, options = {}) {
    t = await openNext(options.browser ?? browsers.chromium, { targets: targets(), rows, ...options });
    const page = t.page;
    t.errors = [];
    page.on("pageerror", (err) => t.errors.push(err.message));
    await page.route("**/api/blob/**", (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: IMAGE }),
    );
    await page.locator(`.chg[data-chg="${id}"]`).click();
    await showList(page);
    await ready(page);
    return page;
}

// The Snapshots pane shown, as a small change opens with it as a rail.
async function showList(page) {
    await page.locator("#snap-list .srow.cur").waitFor({ state: "attached" });
    if ((await page.locator("#snaps").getAttribute("class")).includes("rail")) {
        await page.keyboard.press("Shift+Digit2");
    }
    await page.locator("#snap-list .srow.cur").waitFor();
}
const current = (page) => page.locator("#snap-list .srow.cur").getAttribute("data-snap");
const currentN = (page) => page.locator(".iline b.num").innerText();
// Waits until the current snapshot's images are drawn and a quarter second has passed since: a
// decision key counts from then on. The stage says so on itself (data-ready names the snapshot).
async function ready(page) {
    await expect
        .poll(async () => {
            const key = await current(page);
            // A failed snapshot has no images to wait for.
            const stage = page.locator("#stage");
            return (
                key !== null &&
                ((await stage.getAttribute("data-status")) === "failed" ||
                    (await stage.getAttribute("data-ready")) === key)
            );
        })
        .toBe(true);
}
const posts = (path) => t.posts.filter((p) => p.path === path);
const row$ = (page, n) => page.locator("#snap-list .srow", { has: page.locator(`.nmb:text-is("#${n}")`) });
const bar = (page, act) => page.locator(`.decide [data-act="${act}"]`);
/**
 * A control's label and the key box it shows ("" when none), each as one line of text.
 * @param {import("playwright").Locator} loc the control
 * @returns {Promise<string>} "Accept 5 [Shift+A]", or the label alone
 */
const shows = (loc) =>
    loc.evaluate((n) => {
        const keys = [...n.querySelectorAll(":scope > kbd")].filter((k) => k.getClientRects().length > 0);
        const copy = /** @type {HTMLElement} */ (n.cloneNode(true));
        for (const k of copy.querySelectorAll(":scope > kbd")) {
            k.remove();
        }
        const label = copy.textContent.replace(/\s+/g, " ").trim();
        return keys.length ? `${label} [${keys.map((k) => k.textContent).join(" / ")}]` : label;
    });
const barText = (page, act) => shows(bar(page, act));

describe.each(["chromium", "webkit"])("the decision keys in %s", (name) => {
    const open = async (id, options = {}) => {
        if (!browsers[name]) {
            return null;
        }
        return openChange(id, { ...options, browser: browsers[name] });
    };

    it("A accepts the snapshot in front of you, saves it once, and moves on to the next undecided", async () => {
        const page = await open(MAIN);
        if (!page) {
            return;
        }
        expect(await currentN(page)).toBe("#1");
        await page.keyboard.press("KeyA");
        await expect.poll(() => message(page)).toBe("Accepted #1.");
        expect(posts("/api/decide").map((p) => [p.body.file, p.body.decision])).toEqual([
            [rows(MAIN, "graphty-element").items[0].file, "accept"],
        ]);
        await expect.poll(() => currentN(page)).toBe("#2");
        expect(await row$(page, 1).getAttribute("class")).toContain("decided");
        // textContent: a row just changed may not be painted yet (content-visibility).
        expect(await row$(page, 1).textContent()).toContain("Accepted");
        // The message line's Undo has no key box: the decision bar's Undo [U] carries it.
        expect(await shows(page.locator("#msg-x").getByRole("button", { name: "Undo" }))).toBe("Undo");
        expect(await barText(page, "undo")).toBe("Undo [U]");
    });

    it("decides once for a key held down through its repeats", async () => {
        const page = await open(MAIN);
        if (!page) {
            return;
        }
        await page.keyboard.down("KeyA");
        await expect.poll(() => message(page)).toBe("Accepted #1.");
        await ready(page);
        // The key is still down: these are its repeats, on the next snapshot, drawn and ready.
        await page.keyboard.down("KeyA");
        await page.keyboard.down("KeyA");
        await page.keyboard.up("KeyA");
        // A press after them: had a repeat decided, its request would be before this one.
        await page.keyboard.press("KeyU");
        await expect.poll(() => posts("/api/decide").length).toBe(2);
        expect(posts("/api/decide").map((p) => p.body.decision)).toEqual(["accept", null]);
    });

    it("ignores a decision key within a quarter second of the draw, says why, and sends nothing", async () => {
        const page = await open(MAIN, { clock: true });
        if (!page) {
            return;
        }
        // Time stops: the next snapshot's images are drawn, but no frame has been painted since.
        await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
        await page.keyboard.press("ArrowRight");
        await expect
            .poll(() => page.evaluate(() => globalThis.document.querySelector("#stage .sheet") !== null))
            .toBe(true);
        await expect.poll(async () => (await current(page)).endsWith("story-1.dark.png")).toBe(true);
        await page.keyboard.press("KeyA");
        await expect
            .poll(() => message(page))
            .toMatch(
                /^(Ignored: this image appeared less than a quarter second ago\.|Loading images: Accept waits for them\.)$/,
            );
        // Painted now, but less than a quarter second ago.
        await page.clock.runFor(50);
        await page.keyboard.press("KeyR");
        await expect.poll(() => message(page)).toBe("Ignored: this image appeared less than a quarter second ago.");
        expect(await page.locator("#popbox").count()).toBe(0);
        await page.clock.runFor(300);
        await page.keyboard.press("KeyA");
        await expect.poll(() => message(page)).toBe("Accepted #2.");
        // The two presses before it sent nothing: this accept is the only request.
        expect(posts("/api/decide")).toHaveLength(1);
    });

    it("Reject needs a reason, reuses a recent one by click and by Down then Enter, keeps the text on Esc, and Undo puts it back", async () => {
        const page = await open(MAIN);
        if (!page) {
            return;
        }
        await page.keyboard.press("KeyR");
        const box = page.locator("#popbox");
        await box.waitFor();
        expect(await box.locator("b").first().innerText()).toBe("Reject #1 component-0 / story-0");
        expect(await box.innerText()).toContain("The author sees this reason.");
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("reason");
        // While the field has focus no letter key acts.
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Type a reason first: the author sees it.");
        expect(await box.locator(".perr").innerText()).toBe("Type a reason first: the author sees it.");
        await page.keyboard.type("Text is clipped");
        await page.keyboard.press("Escape");
        expect(await box.count()).toBe(0);
        expect(posts("/api/decide")).toHaveLength(0);
        // Esc kept the text for this snapshot.
        await page.keyboard.press("KeyR");
        expect(await page.locator("#reason").inputValue()).toBe("Text is clipped");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Rejected #1.");
        await expect.poll(() => currentN(page)).toBe("#2");
        await ready(page);
        // A recent reason, by Down then Enter.
        await page.keyboard.press("KeyR");
        expect(await page.locator("#reason").inputValue()).toBe("");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        expect(await page.locator("#reason").inputValue()).toBe("Text is clipped");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Rejected #2.");
        await ready(page);
        // And by click.
        await page.keyboard.press("KeyR");
        await page.locator("#popbox").getByRole("button", { name: "Text is clipped" }).click();
        expect(await page.locator("#reason").inputValue()).toBe("Text is clipped");
        await page
            .locator("#popbox")
            .getByRole("button", { name: /^Reject/ })
            .click();
        await expect.poll(() => message(page)).toBe("Rejected #3.");
        expect(posts("/api/decide").map((p) => [p.body.decision, p.body.reason])).toEqual([
            ["reject", "Text is clipped"],
            ["reject", "Text is clipped"],
            ["reject", "Text is clipped"],
        ]);
        // Undo goes back to #3 and puts its reason back in the box.
        await page.keyboard.press("KeyU");
        await expect.poll(() => message(page)).toBe("Undone: the reject of #3.");
        expect(await currentN(page)).toBe("#3");
        await ready(page);
        await page.keyboard.press("KeyR");
        expect(await page.locator("#reason").inputValue()).toBe("Text is clipped");
        await page
            .locator("#popbox")
            .getByRole("button", { name: /^Cancel/ })
            .click();
        expect(await page.locator("#popbox").count()).toBe(0);
    });

    it("Exclude asks a reason, then states its scope: Exclude [Enter] / Back [Esc]", async () => {
        const page = await open(MAIN);
        if (!page) {
            return;
        }
        await page.keyboard.press("KeyE");
        expect(await page.locator("#popbox").innerText()).toContain("The reason is kept in the story settings file.");
        await page.keyboard.type("Animated: never stable");
        await page.keyboard.press("Enter");
        const box = page.locator("#popbox");
        expect(await box.innerText()).toContain(
            "Exclude stops capturing every mode of this story on every later change, until its settings file is removed.",
        );
        // Back [Esc]: nothing excluded.
        await page.keyboard.press("Escape");
        expect(await box.count()).toBe(0);
        expect(posts("/api/decide")).toHaveLength(0);
        await page.keyboard.press("KeyE");
        await page.keyboard.type("Animated: never stable");
        await page.keyboard.press("Enter");
        expect(await page.evaluate(() => globalThis.document.activeElement?.id)).toBe("popok2");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Excluded #1.");
        expect(posts("/api/decide").map((p) => [p.body.decision, p.body.reason])).toEqual([
            ["exclude", "Animated: never stable"],
        ]);
    });
});

const head = (page, comp) => page.locator(`.ghead[data-group="c:graphty-element > ${comp}"]`);
const selBar = (page) => page.locator("#snaps-head > .h5.lselbar");
const menuItem = (page, name) => page.locator(".menu .mi", { hasText: name });
const dialog = (page) => page.locator("dialog[open]");
const activeId = (page) => page.evaluate(() => globalThis.document.activeElement?.id ?? "");
const fileOf = (id, n, project = "graphty-element") => rows(id, project).items[n - 1].file;
// The visible key boxes of one key, by the action each is on.
const keyOwners = async (page, key) => (await visibleKeys(page)).filter((k) => k.key === key).map((k) => k.act);

describe("what A acts on, and the selection", () => {
    it("A decides the row in front of you when it is not selected, and the selection when it is; the key hint is only on the button A triggers", async () => {
        const page = await openChange(MAIN);
        await page.keyboard.press("KeyX");
        await expect.poll(() => selBar(page).innerText()).toMatch(/^1 selected/);
        expect(await shows(page.locator('.iline [data-act="select"]'))).toBe("Unselect [X]");
        expect(await barText(page, "accept")).toBe("Accept 1 selected [A]");
        expect(await barText(page, "reject")).toBe("Reject 1 selected... [R]");
        expect(await barText(page, "exclude")).toBe("Exclude 1 selected... [E]");
        // The selection bar's Accept 1 shows no key: A acts through the decision bar's.
        expect(await shows(selBar(page).locator('[data-act="accsel"]'))).toBe("Accept 1");
        expect(await keyOwners(page, "A")).toEqual(["accept"]);
        // On a row that is not selected, A decides that row: the plain Accept [A].
        await page.keyboard.press("ArrowRight");
        await ready(page);
        expect(await barText(page, "accept")).toBe("Accept [A]");
        expect(await keyOwners(page, "A")).toEqual(["accept"]);
        await page.keyboard.press("KeyA");
        await expect.poll(() => message(page)).toBe("Accepted #2.");
        expect(posts("/api/decide").map((p) => p.body.file)).toEqual([fileOf(MAIN, 2)]);
        expect(await selBar(page).innerText()).toMatch(/^1 selected/);
        // Back on the selected row, A decides the selection: one bulk request.
        await row$(page, 1).click();
        await ready(page);
        await page.keyboard.press("KeyA");
        await expect.poll(() => message(page)).toBe("Accepted #1.");
        expect(posts("/api/accept-all").map((p) => p.body.files)).toEqual([[fileOf(MAIN, 1)]]);
        // The selection is cleared once decided: Show, Group and Pictures are back.
        await expect.poll(() => selBar(page).count()).toBe(0);
        expect(await page.locator('#snaps-head > .h5 [data-act="showmenu"]').count()).toBe(1);
    });

    it("selects by checkbox, shift-click ranges across groups and over a collapsed one, Ctrl/Cmd-click, Extend up and down by menu and key; the bar replaces line 5 and no row moves", async () => {
        const page = await openChange(MAIN);
        await head(page, "component-1").locator(".caret").click();
        await expect.poll(() => row$(page, 6).count()).toBe(0);
        // Where row #20 sits in the list's content: a click scrolls the list, a moved row would not.
        const rowTop = () =>
            row$(page, 20).evaluate((n) => {
                const list = globalThis.document.getElementById("snap-list");
                return n.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
            });
        const before = await rowTop();
        const h5 = await page.locator("#snaps-head > .h5").boundingBox();
        await row$(page, 2).locator(".rcheck").click();
        await expect.poll(() => selBar(page).innerText()).toMatch(/^1 selected/);
        // The range runs through the collapsed component-1, whose rows are not drawn.
        await row$(page, 13)
            .locator(".rcheck")
            .click({ modifiers: ["Shift"] });
        await expect.poll(() => selBar(page).locator(".selcount").innerText()).toBe("12 selected");
        expect(await shows(selBar(page).locator('[data-act="accsel"]'))).toBe("Accept 12");
        for (const n of [2, 5, 11, 13]) {
            expect(await row$(page, n).getAttribute("class"), `#${n}`).toContain("selx");
            expect(await row$(page, n).locator(".rcheck").getAttribute("aria-checked")).toBe("true");
        }
        expect(await row$(page, 14).getAttribute("class")).not.toContain("selx");
        // Same height, same place: the bar took line 5's place and no row moved.
        const sb = await selBar(page).boundingBox();
        expect([sb.y, sb.height]).toEqual([h5.y, h5.height]);
        expect(await rowTop()).toBe(before);
        // Ctrl/Cmd-click toggles a row without making it current.
        await row$(page, 20).click({ modifiers: ["ControlOrMeta"] });
        await expect.poll(() => selBar(page).locator(".selcount").innerText()).toBe("13 selected");
        expect(await currentN(page)).toBe("#1");
        // Clear [Esc]: the selection takes Esc before Back, and Back shows its label alone.
        expect(await keyOwners(page, "Esc")).toEqual(["clearsel"]);
        await page.keyboard.press("Escape");
        await expect.poll(() => selBar(page).count()).toBe(0);
        expect(await page.locator(".iline").count()).toBe(1);
        // Shift+Down: the current row and the next, the current row moving with it.
        await page.locator("#snap-list").focus();
        await page.keyboard.press("Shift+ArrowDown");
        await expect.poll(() => selBar(page).locator(".selcount").innerText()).toBe("2 selected");
        expect(await currentN(page)).toBe("#2");
        // Extend down and Extend up, from the bar's menu, do what the keys do.
        await selBar(page).locator('[data-act="selmenu"]').click();
        expect(await menuItem(page, "Extend down").innerText()).toMatch(/^Extend down\s*Shift\+Down$/);
        await menuItem(page, "Extend down").click();
        await expect.poll(() => selBar(page).locator(".selcount").innerText()).toBe("3 selected");
        expect(await currentN(page)).toBe("#3");
        await selBar(page).locator('[data-act="selmenu"]').click();
        await menuItem(page, "Extend up").click();
        await expect.poll(() => currentN(page)).toBe("#2");
        await page.keyboard.press("Shift+ArrowUp");
        await expect.poll(() => currentN(page)).toBe("#1");
        expect(await selBar(page).locator(".selcount").innerText()).toBe("3 selected");
        // With a selection, no two visible controls show the same key.
        const boxes = (await visibleKeys(page)).map((k) => k.key);
        expect(boxes.filter((k, i) => boxes.indexOf(k) !== i)).toEqual([]);
        // Select all shown, from the same menu, and Select [X] by click.
        await selBar(page).locator('[data-act="selmenu"]').click();
        await menuItem(page, "Select all shown (30)").click();
        await expect.poll(() => selBar(page).locator(".selcount").innerText()).toBe("30 selected");
        await page.locator('.iline [data-act="select"]').click();
        await expect.poll(() => selBar(page).locator(".selcount").innerText()).toBe("29 selected");
        expect(t.errors).toEqual([]);
    });

    it("decides a selection over two projects with one request per project, by Accept, Reject and Exclude, and Undo is one request per project too", async () => {
        let failGraphty = false;
        const page = await openChange(TWO, {
            acceptAll: (b) =>
                failGraphty && b.project === "graphty"
                    ? { status: 500, json: { error: "the disk is full" } }
                    : { accepted: b.files.length, files: b.files, undone: b.files.length, unpublished: 0 },
        });
        const selectAll = async () => {
            await page.keyboard.press("KeyX");
            await selBar(page).locator('[data-act="selmenu"]').click();
            await menuItem(page, "Select all shown (24)").click();
            await expect.poll(() => selBar(page).locator(".selcount").innerText()).toBe("24 selected");
        };
        const byProject = (list) => list.map((p) => [p.body.project, p.body.decision, p.body.files.length]).sort();
        await selectAll();
        await selBar(page).locator('[data-act="accsel"]').click();
        // Over 20: it asks first, and its default button has focus.
        expect(await dialog(page).locator("h3").innerText()).toBe("Accept 24 snapshots without opening them?");
        expect(await dialog(page).innerText()).toContain("they will be marked Accepted (not opened).");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Accepted 24 snapshots.");
        expect(byProject(posts("/api/accept-all"))).toEqual([
            ["graphty", "accept", 12],
            ["graphty-element", "accept", 12],
        ]);
        // Undo after a bulk accept restores every row: one request per project.
        await page.keyboard.press("KeyU");
        await expect.poll(() => message(page)).toBe("Undone: 24 decisions.");
        expect(byProject(posts("/api/accept-all").slice(2))).toEqual([
            ["graphty", null, 12],
            ["graphty-element", null, 12],
        ]);
        expect(await page.locator("#snap-list .srow.decided").count()).toBe(0);
        // Bulk Reject, with one reason.
        await selectAll();
        await selBar(page).locator('[data-act="rejsel"]').click();
        expect(await page.locator("#popbox").innerText()).toContain("One reason for 24 snapshots.");
        await page.keyboard.type("Text is clipped");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Rejected 24 snapshots.");
        expect(
            posts("/api/accept-all")
                .slice(4)
                .map((p) => [p.body.project, p.body.decision, p.body.reason]),
        ).toEqual([
            ["graphty-element", "reject", "Text is clipped"],
            ["graphty", "reject", "Text is clipped"],
        ]);
        await page.keyboard.press("KeyU");
        await expect.poll(() => posts("/api/accept-all").length).toBe(8);
        // Bulk Exclude, with its second step; one project fails, is named, and Retry sends it alone.
        failGraphty = true;
        await selectAll();
        await selBar(page).locator('[data-act="excsel"]').click();
        await page.keyboard.type("Animated");
        await page.keyboard.press("Enter");
        expect(await page.locator("#popbox b").innerText()).toBe("Exclude 24 snapshots");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Not saved: the disk is full. graphty left as it was.");
        expect(byProject(posts("/api/accept-all").slice(8))).toEqual([
            ["graphty", "exclude", 12],
            ["graphty-element", "exclude", 12],
        ]);
        failGraphty = false;
        await page.locator("#msg-x").getByRole("button", { name: "Retry" }).click();
        await expect.poll(() => posts("/api/accept-all").length).toBe(11);
        expect(byProject(posts("/api/accept-all").slice(10))).toEqual([["graphty", "exclude", 12]]);
        await expect.poll(() => page.locator("#snaps-head > .h2").innerText()).toMatch(/^24 of 24 decided/);
    });
});

describe("group headers and the list menu", () => {
    it("labels its scope Accept 1 shown (4 hidden) under Find and never sends a hidden row", async () => {
        const page = await openChange(MAIN);
        await page.keyboard.press("Slash");
        await page.keyboard.type("story-1");
        // The current snapshot is the first one shown, #2, so this group's Accept prints Shift+A.
        await expect
            .poll(() => shows(head(page, "component-0").locator('[data-act="gaccept"]')))
            .toBe("Accept 1 shown (4 hidden) [Shift+A]");
        expect(await shows(head(page, "component-2").locator('[data-act="gaccept"]'))).toBe("Accept 5");
        await head(page, "component-0").locator('[data-act="gaccept"]').click();
        await expect.poll(() => posts("/api/accept-all").length).toBe(1);
        expect(posts("/api/accept-all")[0].body.files).toEqual([fileOf(MAIN, 2)]);
    });

    it("Accept all shown... and Undo all decisions... from the list menu ask first, one request each", async () => {
        const page = await openChange(MAIN);
        await page.locator('#snaps-head [data-act="listmenu"]').click();
        await menuItem(page, "Accept all shown (30)...").click();
        expect(await dialog(page).locator("h3").innerText()).toBe("Accept 30 matching?");
        expect(await dialog(page).innerText()).toContain("Every undecided row the filter and Find show.");
        await dialog(page)
            .getByRole("button", { name: /^Accept/ })
            .click();
        await expect.poll(() => posts("/api/accept-all").length).toBe(1);
        expect(posts("/api/accept-all")[0].body.files).toHaveLength(30);
        await page.locator('#snaps-head [data-act="listmenu"]').click();
        await menuItem(page, "Undo all decisions...").click();
        expect(await dialog(page).locator("h3").innerText()).toBe("Undo all decisions?");
        expect(await dialog(page).innerText()).toContain("30 decisions go back to undecided.");
        await dialog(page)
            .getByRole("button", { name: /^Cancel/ })
            .click();
        expect(await dialog(page).count()).toBe(0);
        expect(posts("/api/accept-all")).toHaveLength(1);
        await page.locator('#snaps-head [data-act="listmenu"]').click();
        await menuItem(page, "Undo all decisions...").click();
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Undone: 30 decisions.");
        expect(posts("/api/accept-all").map((p) => [p.body.decision, p.body.files.length])).toEqual([
            ["accept", 30],
            [null, 30],
        ]);
    });

    it("a group's Undo N asks first and is one step for Undo [U]; its menu rejects, excludes and selects the group", async () => {
        const page = await openChange(MAIN);
        await head(page, "component-0").locator('[data-act="gaccept"]').click();
        await expect.poll(() => shows(head(page, "component-0").locator('[data-act="gundo"]'))).toBe("Undo 5");
        await head(page, "component-0").locator('[data-act="gundo"]').click();
        expect(await dialog(page).locator("h3").innerText()).toBe("Undo 5 decisions in graphty-element > component-0?");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Undone: 5 decisions in graphty-element > component-0.");
        // Undo [U] takes the group's Undo back: the five accepted again, in one request.
        await page.keyboard.press("KeyU");
        await expect.poll(() => posts("/api/accept-all").length).toBe(3);
        expect(posts("/api/accept-all").map((p) => [p.body.decision, p.body.files.length])).toEqual([
            ["accept", 5],
            [null, 5],
            ["accept", 5],
        ]);
        // The group menu: Reject 5..., Exclude 5... and Select all 5.
        await head(page, "component-1").locator('[data-act="gmenu"]').click();
        await menuItem(page, "Reject 5...").click();
        expect(await page.locator("#popbox").innerText()).toContain("One reason for 5 snapshots.");
        await page.keyboard.type("Wrong padding");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Rejected 5 snapshots.");
        await head(page, "component-2").locator('[data-act="gmenu"]').click();
        await menuItem(page, "Exclude 5...").click();
        await page.keyboard.type("Animated");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Excluded 5 snapshots.");
        expect(
            posts("/api/accept-all")
                .slice(3)
                .map((p) => [p.body.decision, p.body.files.length]),
        ).toEqual([
            ["reject", 5],
            ["exclude", 5],
        ]);
        await head(page, "component-3").locator('[data-act="gmenu"]').click();
        await menuItem(page, "Select all 5").click();
        await expect.poll(() => selBar(page).locator(".selcount").innerText()).toBe("5 selected");
    });

    it("after a group accept the focus is on the new current row and Enter does what the printed [Enter] says", async () => {
        // Two levels at 1280: the item line prints Open [Enter].
        const page = await openChange(MAIN, { viewport: { width: 1280, height: 800 } });
        expect(await shows(head(page, "component-0").locator('[data-act="gaccept"]'))).toBe("Accept 5 [Shift+A]");
        expect(await shows(head(page, "component-1").locator('[data-act="gaccept"]'))).toBe("Accept 5");
        await page.keyboard.press("Shift+KeyA");
        await expect
            .poll(() => message(page))
            .toBe("Accepted 5 in graphty-element > component-0. Next: graphty-element > component-1 (5).");
        expect(posts("/api/accept-all").map((p) => p.body.files.length)).toEqual([5]);
        expect(await currentN(page)).toBe("#6");
        expect(await activeId(page)).toBe("snap-list");
        // The rows stay, dimmed; the next group now prints Shift+A.
        expect(await page.locator("#snap-list .srow.decided").count()).toBe(5);
        await expect
            .poll(() => shows(head(page, "component-1").locator('[data-act="gaccept"]')))
            .toBe("Accept 5 [Shift+A]");
        expect(await keyOwners(page, "Enter")).toEqual(["openrow"]);
        await page.keyboard.press("Enter");
        await expect.poll(() => shows(page.locator('.iline [data-act="back"]'))).toBe("Back to list [Esc]");
        expect(posts("/api/accept-all")).toHaveLength(1);
        await page.keyboard.press("Escape");
        // On a group with nothing left, Shift+A says so.
        await page.keyboard.press("ArrowLeft");
        await expect.poll(() => currentN(page)).toBe("#5");
        await page.keyboard.press("Shift+KeyA");
        await expect.poll(() => message(page)).toBe("Nothing left to accept in graphty-element > component-0");
        expect(posts("/api/accept-all")).toHaveLength(1);
    });

    it("asks before accepting over 20 in a group, naming it; Esc sends nothing and Enter then does what [Enter] says", async () => {
        const page = await openChange(WIDE);
        await page.keyboard.press("Shift+KeyA");
        expect(await dialog(page).locator("h3").innerText()).toBe(
            "Accept 25 in graphty-element > widgets without opening them?",
        );
        expect(await dialog(page).innerText()).toContain(
            "They will be marked Accepted (not opened). 24 of them were never opened.",
        );
        await page.keyboard.press("Escape");
        await expect.poll(() => dialog(page).count()).toBe(0);
        // One level at 1440: no Open is printed, so Enter does nothing.
        expect(await keyOwners(page, "Enter")).toEqual([]);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Shift+KeyA");
        await page.keyboard.press("Enter");
        await expect.poll(() => posts("/api/accept-all").length).toBe(1);
        expect(posts("/api/accept-all")[0].body.files).toHaveLength(25);
    });

    it("Approved before has Reject and Exclude but no Undo; Rejected before is replaced by Accept", async () => {
        const page = await openChange(RICH);
        const before = page.locator(`.ghead[data-group="!before"]`);
        expect(await before.innerText()).toMatch(/^Approved before\s+2\s+\(already accepted\)/);
        expect(await before.locator('[data-act="gundo"]').count()).toBe(0);
        await before.getByRole("button", { name: "Show", exact: true }).click();
        const approved = page.locator("#snap-list .srow", { hasText: "Accepted (approved before #1356)" });
        await expect.poll(() => approved.count()).toBe(2);
        expect(await approved.getByRole("button", { name: "Undo" }).count()).toBe(0);
        await before.getByRole("button", { name: "Reject 2..." }).click();
        await page.keyboard.type("Not the right theme");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Rejected 2 snapshots.");
        expect(posts("/api/accept-all").map((p) => [p.body.decision, p.body.files.length])).toEqual([["reject", 2]]);
        await page.keyboard.press("KeyU");
        await expect.poll(() => posts("/api/accept-all").length).toBe(2);
        await expect.poll(() => approved.count()).toBe(2);
        await before.locator('[data-act="gmenu"]').click();
        await menuItem(page, "Exclude 2...").click();
        await page
            .locator("#popbox")
            .getByRole("button", { name: /^Cancel/ })
            .click();
        // Rejected before: no Undo; Reject says why not, Accept replaces it.
        await page.getByRole("button", { name: /^Group:/ }).click();
        await menuItem(page, "None").click();
        await page.getByRole("button", { name: /^Show:/ }).click();
        await menuItem(page, "Rejected (2)").click();
        const rej = page.locator("#snap-list .srow", { hasText: "Rejected before (#5000)" });
        expect(await rej.getByRole("button", { name: "Undo" }).count()).toBe(0);
        await rej.click();
        await ready(page);
        expect(await bar(page, "reject").getAttribute("title")).toBe(
            "Already rejected by an earlier Finish. Accept or Exclude replaces it",
        );
        expect(await bar(page, "accept").getAttribute("aria-disabled")).toBeNull();
        const file = await current(page);
        await bar(page, "accept").click();
        await expect.poll(() => posts("/api/decide").length).toBe(1);
        expect(`graphty-element/${posts("/api/decide")[0].body.file}`).toBe(file);
        await expect.poll(() => activeId(page)).toBe("snap-list");
    });
});

describe("the decision bar and the end card", () => {
    it("a click on a decision button returns focus to the list; Space never presses a decision button", async () => {
        const page = await openChange(MAIN);
        await bar(page, "accept").click();
        await expect.poll(() => message(page)).toBe("Accepted #1.");
        expect(await activeId(page)).toBe("snap-list");
        await ready(page);
        await page.keyboard.press("Space");
        // Tab to the Accept button: Space on it still decides nothing.
        for (
            let i = 0;
            i < 80 && (await page.evaluate(() => globalThis.document.activeElement?.dataset?.act)) !== "accept";
            i++
        ) {
            await page.keyboard.press("Tab");
        }
        expect(await page.evaluate(() => globalThis.document.activeElement?.dataset?.act)).toBe("accept");
        await page.keyboard.press("Space");
        await page.keyboard.press("KeyA");
        await expect.poll(() => message(page)).toBe("Accepted #2.");
        expect(posts("/api/decide").map((p) => p.body.file)).toEqual([fileOf(MAIN, 1), fileOf(MAIN, 2)]);
    });

    it("says why a button is unavailable, and Undo says there is nothing to undo", async () => {
        const page = await openChange(MAIN);
        expect(await bar(page, "undo").getAttribute("title")).toBe("Nothing to undo");
        // An unavailable control stays in place and says why when pressed.
        await bar(page, "undo").click({ force: true });
        await expect.poll(() => message(page)).toBe("Undo: Nothing to undo.");
        await page.keyboard.press("KeyA");
        await expect.poll(() => currentN(page)).toBe("#2");
        await page.keyboard.press("ArrowLeft");
        await ready(page);
        await page.keyboard.press("KeyA");
        await expect.poll(() => message(page)).toBe("Accept: Already accepted. Undo it to change it.");
        expect(posts("/api/decide")).toHaveLength(1);
    });

    // Decides the small change's three snapshots by key: the end card shows.
    async function toEndCard() {
        const page = await openChange(SMALL);
        for (const n of [1, 2, 3]) {
            await ready(page);
            await page.keyboard.press("KeyA");
            await expect.poll(() => message(page)).toBe(`Accepted #${n}.`);
        }
        await page.locator(".endcard").waitFor();
        return page;
    }

    it("shows the end card after the last undecided snapshot: Finish [Enter] focused, Back [Esc], Next change [Shift+N]", async () => {
        const page = await toEndCard();
        const card = page.locator(".endcard");
        expect(await card.locator("h2").innerText()).toBe("All 3 decided.");
        expect(await activeId(page)).toBe("endfinish");
        expect(await shows(page.locator("#endfinish"))).toBe("Finish #8200 (3) [Enter]");
        expect(await shows(card.locator('[data-act="endback"]'))).toBe("Back to changes [Esc]");
        expect(await shows(card.locator('[data-act="nextchange"]'))).toMatch(
            /^Next change: #\d+ \(\d+ undecided\) \[Shift\+N\]$/,
        );
        expect(await keyOwners(page, "Esc")).toEqual(["endback"]);
        expect(await keyOwners(page, "Shift+N")).toEqual(["nextchange"]);
        expect(await shows(page.locator('.iline [data-act="back"]'))).toBe("Back to changes");
        // Esc: Back, as the card prints it.
        await page.keyboard.press("Escape");
        await expect.poll(() => message(page)).toBe("Back to the changes.");
    });

    it("opens the next change from the end card by Shift+N", async () => {
        const page = await toEndCard();
        const next = await page.locator('.endcard [data-act="nextchange"]').innerText();
        await page.keyboard.press("Shift+KeyN");
        await expect.poll(() => message(page)).toMatch(/^Opened #\d+ /);
        expect(next).toContain((await message(page)).match(/^Opened (#\d+) /)[1]);
    });

    it("finishes on today's page from the end card, with the same decisions", async () => {
        const page = await toEndCard();
        // Enter on the focused Finish: today's page finishes this change, until this page has its own.
        await page.keyboard.press("Enter");
        await expect.poll(() => new URL(page.url()).hash).toBe(`#target=${SMALL}`);
        expect(new URL(page.url()).pathname).toBe("/");
    });
});

describe("the decision bar's layout", () => {
    // Every button wholly inside the bar's one 52 px row, none wrapped, none drawn as its key alone;
    // the position text whole, or gone.
    const fits = (page) =>
        page.evaluate(() => {
            const d = globalThis.document.querySelector(".decide");
            const box = d.getBoundingClientRect();
            const bad = [];
            for (const b of d.querySelectorAll("button")) {
                const r = b.getBoundingClientRect();
                const label = [...b.childNodes]
                    .filter((n) => n.nodeName !== "KBD")
                    .map((n) => n.textContent)
                    .join("")
                    .trim();
                if (r.left < box.left - 1 || r.right > box.right + 1 || r.height > 40 || label === "") {
                    bad.push(b.dataset.act);
                }
            }
            const pos = d.querySelector(".pos")?.textContent ?? "";
            return { bad, pos, row: box.height };
        });

    for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
    ]) {
        it(`keeps every decision button on its one row at ${viewport.width}, at each level and with a selection`, async () => {
            const page = await openChange(MAIN, { viewport });
            const check = async () => {
                const f = await fits(page);
                expect(f.bad).toEqual([]);
                expect(f.row).toBe(52);
                expect(f.pos).toMatch(/^(#\d+(, \d+ left)?)?$/);
            };
            await check();
            await page.keyboard.press("KeyX");
            await expect.poll(() => barText(page, "accept")).toBe("Accept 1 selected [A]");
            await check();
            await page.keyboard.press("Escape");
            if (viewport.width < 1400) {
                await page.keyboard.press("Enter");
                await expect.poll(() => shows(page.locator('.iline [data-act="back"]'))).toBe("Back to list [Esc]");
                await check();
            }
        });
    }
});

describe("a stale capture", () => {
    it("says master has newer baselines, lists them, and Update from master runs the job, shows its steps and reloads the list", async () => {
        let done = false;
        const page = await openChange(STALE, {
            update: (b) => ({ job: { kind: "update", target: b.id, running: true, step: "starting", error: null } }),
            finishStatus: () => ({ kind: "update", target: STALE, running: !done, step: "merging", error: null }),
        });
        const banner = page.locator("#snap-stale");
        expect(await banner.innerText()).toMatch(
            /^master has 3 newer baselines since this capture\.\s*Changed on master\s*Update from master\.\.\.$/,
        );
        await banner.getByRole("button", { name: "Changed on master" }).click();
        expect(await dialog(page).innerText()).toContain("graphty-element/legend--default.light.png");
        await dialog(page)
            .getByRole("button", { name: /^Close/ })
            .click();
        await banner.getByRole("button", { name: "Update from master..." }).click();
        expect(await dialog(page).locator("h3").innerText()).toBe("Update #8500 from master?");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Updating #8500: merging...");
        expect(posts("/api/update").map((p) => p.body)).toEqual([{ id: STALE }]);
        // The job ends; the list the server has then holds no newer baselines.
        t.setList(
            listAnswer(
                targets().map((x) =>
                    x.id === STALE ? { ...x, stale: 0, projects: [project("graphty-element", { reviewable: 12 })] } : x,
                ),
            ),
        );
        done = true;
        await expect.poll(() => message(page)).toBe("Updated #8500 from master: CI captures it again.");
        expect(await banner.isVisible()).toBe(false);
    });

    it("offers Update from master... in the changes row menu, for a pull request", async () => {
        const page = await openChange(STALE);
        if ((await page.locator("#changes").getAttribute("class")).includes("rail")) {
            await page.keyboard.press("Shift+Digit1");
        }
        await page.locator(`.chg[data-chg="${MAIN}"] [data-act="rowmenu"]`).click();
        await menuItem(page, "Update from master...").click();
        expect(await dialog(page).locator("h3").innerText()).toBe("Update #8100 from master?");
        await page.keyboard.press("Escape");
        expect(posts("/api/update")).toHaveLength(0);
    });
});

describe("counted work", () => {
    it("accepts 1,000 shown in one project with one request, and undoes it with one", async () => {
        const page = await openChange(BIG);
        await page.locator('#snaps-head [data-act="listmenu"]').click();
        await menuItem(page, "Accept all shown (1,000)...").click();
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Accepted 1,000 snapshots.");
        await page.keyboard.press("KeyU");
        await expect.poll(() => message(page)).toBe("Undone: 1,000 decisions.");
        expect(posts("/api/accept-all").map((p) => [p.body.decision, p.body.files.length])).toEqual([
            ["accept", 1000],
            [null, 1000],
        ]);
        expect(posts("/api/decide")).toHaveLength(0);
    });
});

describe("on the review server", () => {
    it("never touches a row Find hides: the decisions file is read back", async () => {
        isolateGit();
        const r = makeRepo();
        const s = await startApp(r, { gh: onePr()(r), token: TOKEN });
        const context = await browsers.chromium.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.setDefaultTimeout(0);
        try {
            // The captures downloaded first: a change still downloading opens with nothing to review.
            await expect
                .poll(async () => {
                    const list = (await s.api("GET", "/api/prs")).body;
                    const t123 = list.targets?.find((x) => x.id === "123");
                    return Boolean(t123 && !t123.downloading && t123.projects.every((p) => !p.downloading));
                })
                .toBe(true);
            await page.goto(`${s.origin}/next/#token=${TOKEN}&change=123`);
            await showList(page);
            await page.keyboard.press("Slash");
            await page.keyboard.type("slider");
            await expect.poll(() => page.locator("#snap-list .srow").count()).toBe(1);
            await page.locator('#snaps-head [data-act="viewopts"]').click();
            await menuItem(page, "Accept all shown (1)...").click();
            await page.keyboard.press("Enter");
            await expect.poll(() => message(page)).toMatch(/^Accepted #\d+\.$/);
            const saved = JSON.parse(readFileSync(join(s.tmp, "state", "123.json"), "utf8"));
            expect(Object.keys(saved.decisions ?? saved).filter((k) => !k.startsWith("_"))).toEqual([
                "compact-mantine/slider--sizes.png",
            ]);
        } finally {
            await context.close();
            await s.close();
        }
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["decide.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
