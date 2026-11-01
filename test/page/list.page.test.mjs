/*
 * The snapshot list of the new page (design section 4), by real input in Chromium: its header and
 * rows within their budgets at 1280 x 800 and 1440 x 900 with 3, 300 and 3,000 snapshots; every
 * status's own shape; Show, Find and the status summary, with the current snapshot always a drawn
 * row; the five groupings and their sticky, collapsible headers; the Row pictures choices and the
 * picture each row asks for; an old capture's unstable story; a newer capture offered, never
 * swapped in; and the counted work: a decision changes one row element, and the first screen of
 * 3,000 rows asks for at most 30 pictures.
 */

import { PNG } from "pngjs";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SHAPES, STATUS, decisionsFor } from "../../trusted/page/marks.js";
import { COVERS } from "./covers.mjs";
import {
    fiftyChanges,
    listAnswer,
    message,
    openNext,
    project,
    richRows,
    row,
    rowsAnswer,
    target,
} from "./page-kit.mjs";

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

const RICH = "5000";
// The rich change's component of 60, which opens collapsed.
const WIDGETS = '.grp[data-group="c:graphty-element > widgets"]';
const HUGE = "6000";
const TWO = "7000";

// The fifty changes, a change with something of every kind, one of 3,000 snapshots and one of two
// projects.
const targets = () => [
    ...fiftyChanges(),
    target(5000, { title: "Every kind of row", projects: [project("graphty-element", { reviewable: 180 })] }),
    target(6000, { title: "Three thousand", projects: [project("graphty-element", { reviewable: 3000 })] }),
    target(7000, {
        title: "Two projects",
        projects: [project("graphty-element", { reviewable: 12 }), project("graphty", { reviewable: 12 })],
    }),
];
// The rows of a change in `list` (by default the changes above): the route answers every change
// the page is given, a test's own extra ones too.
const rowsOf =
    (list = targets()) =>
    (id, name) => {
        if (id === RICH) {
            return richRows(name);
        }
        const n = list.find((x) => x.id === id).projects.find((p) => p.project === name).reviewable;
        return rowsAnswer(name, n);
    };
const rows = rowsOf();

// A page with the changes above, the change `id` opened by a click (and, unless `rowsFirst` is
// false, its first row drawn), and the page's errors kept.
async function openChange(id, options = {}) {
    t = await openNext(browser, { targets: targets(), rows: rowsOf(options.targets), ...options });
    const page = t.page;
    t.errors = [];
    page.on("pageerror", (err) => t.errors.push(err.message));
    await page.locator(`.chg[data-chg="${id}"]`).click();
    await page.locator(".iline").waitFor({ state: "attached" });
    if ((await page.locator("#snaps").getAttribute("class")).includes("rail")) {
        await page.keyboard.press("Shift+Digit2");
    }
    if (options.rowsFirst !== false) {
        await page.locator("#snap-list .srow").first().waitFor();
    }
    return page;
}

const box = (page, sel) =>
    page
        .locator(sel)
        .first()
        .evaluate((n) => n.getBoundingClientRect().toJSON());
const current = (page) => page.locator("#snap-list .srow.cur").getAttribute("data-snap");
// textContent: rows off screen are not rendered (content-visibility), so innerText skips them.
const rowTexts = (page) => page.locator("#snap-list .srow .nmb").allTextContents();
// The current snapshot is a drawn row, wholly inside the list while the list shows, and the viewer
// shows it. Its number is read as text: a row scrolled in a moment ago may not be painted yet
// (content-visibility), and innerText skips what is not painted.
async function currentIsShown(page) {
    const cur = await page.evaluate(() => {
        const list = globalThis.document.getElementById("snap-list");
        const rows = list.querySelectorAll(".srow.cur");
        if (rows.length !== 1) {
            return null;
        }
        const box = list.getBoundingClientRect();
        const r = rows[0].getBoundingClientRect();
        return {
            n: rows[0].querySelector(".nmb").textContent,
            inside: box.height === 0 || (r.top >= box.top - 1 && r.bottom <= box.bottom + 1),
        };
    });
    expect(cur, "one current row").not.toBeNull();
    expect(cur.inside, "the current row inside the list").toBe(true);
    expect(await page.locator(".iline b.num").innerText()).toBe(cur.n);
}
// A shape as the page's DOM serializes it, to compare with a mark's innerHTML.
const serialized = (page, shape) =>
    page.evaluate((svg) => {
        const n = globalThis.document.createElementNS("http://www.w3.org/2000/svg", "svg");
        n.innerHTML = svg;
        return n.innerHTML;
    }, shape);
const menuItem = (page, name) => page.getByRole("menu").getByText(name, { exact: true });
// The List menu: Group by, Pictures and Select.
const listMenu = (page) => page.getByRole("button", { name: "List", exact: true }).click();
// Picks an item of the List menu.
const listPick = async (page, label) => {
    await listMenu(page);
    await menuItem(page, label).click();
};
// The List menu's checked items and its Group by heading, read with the menu open, then closed.
const listChecked = async (page) => {
    await listMenu(page);
    const m = page.getByRole("menu");
    const out = {
        group: await m.locator(".mh").first().innerText(),
        checked: await m.locator('.mi[aria-checked="true"]').allInnerTexts(),
    };
    await page.keyboard.press("Escape");
    return out;
};

describe("the header and the rows within their budgets", () => {
    const SIZES = [
        [1280, 800, 6],
        [1440, 900, 7],
    ];
    const CHANGES = [
        ["3484", 3],
        ["3486", 300],
        [HUGE, 3000],
    ];
    // Components of 25 stories, as a real library has them: the row budget counts picture rows under
    // one sticky header, which components of 5 stories (a header every 5 rows) could never meet.
    const library = (id, name) => {
        const a = rows(id, name);
        return {
            ...a,
            items: a.items.map((x, i) => row(i, x.status, { component: `component-${Math.floor(i / 25)}` })),
        };
    };
    for (const [width, height, wantRows] of SIZES) {
        it.each(CHANGES)(`at ${width} x ${height}, change %s (%i snapshots)`, async (id, count) => {
            const page = await openChange(id, { viewport: { width, height }, rows: library });
            const head = await box(page, "#snaps-head");
            expect(head.bottom, "the header ends at most 121 px from the top").toBeLessThanOrEqual(121);
            // Three lines, each keeping its height: nothing wraps.
            expect(await page.locator("#snaps-head > .hl").count()).toBe(3);
            for (const [cls, h] of [
                ["h1", 28],
                ["h2", 24],
                ["h3", 31],
            ]) {
                expect((await box(page, `#snaps-head > .${cls}`)).height, cls).toBe(h);
            }
            const shown = await page.evaluate(() => {
                const list = globalThis.document.getElementById("snap-list").getBoundingClientRect();
                const stuck = [...globalThis.document.querySelectorAll("#snap-list .ghead")]
                    .map((h) => h.getBoundingClientRect())
                    .filter((r) => r.top <= list.top + 1 && r.bottom > list.top)
                    .reduce((b, r) => Math.max(b, r.bottom), list.top);
                return [...globalThis.document.querySelectorAll("#snap-list .srow")]
                    .map((r) => r.getBoundingClientRect())
                    .filter((r) => r.top >= stuck - 1 && r.bottom <= list.bottom + 1).length;
            });
            expect(shown, "picture rows wholly visible").toBeGreaterThanOrEqual(Math.min(count, wantRows));
            // No story name cut below 24 characters; no change size or decision word cut at all.
            const cuts = await page.evaluate(() =>
                [...globalThis.document.querySelectorAll("#snap-list .srow")].slice(0, 40).map((r) => {
                    const name = r.querySelector(".nm, .nm1");
                    const keep = r.querySelector(".keep");
                    const info = r.querySelector(".info").getBoundingClientRect();
                    return {
                        snap: r.dataset.snap,
                        name: name.textContent.replace("...", ""),
                        full: r.title
                            .split(" / ")
                            .pop()
                            .replace(/, moved from .*$/, "")
                            .replace(/ \((light|dark)\)$/, ""),
                        nameClipped: name.scrollHeight > name.clientHeight + 1,
                        keepCut: keep
                            ? keep.scrollWidth > keep.clientWidth + 1 ||
                              keep.getBoundingClientRect().right > info.right + 1
                            : false,
                    };
                }),
            );
            for (const c of cuts) {
                expect(c.name.length, c.snap).toBeGreaterThanOrEqual(Math.min(24, c.full.length));
                expect(c.nameClipped, c.snap).toBe(false);
                expect(c.keepCut, c.snap).toBe(false);
            }
            // Every group header is one line: the chevron, the name button (no count: it is said
            // once, in Accept N), and Accept N.
            // As text: a header off screen is not painted (content-visibility), so innerText skips it.
            for (const entry of await page.locator("#snap-list .ghead .gname").allTextContents()) {
                expect(entry).toMatch(/^\S/);
                expect(entry).not.toMatch(/\(\d[\d,]*\)$/);
            }
            for (const h of await page
                .locator("#snap-list .ghead")
                .evaluateAll((n) => n.map((x) => x.getBoundingClientRect().height))) {
                expect(h).toBe(32);
            }
            expect(t.errors).toEqual([]);
        });
    }

    it("says only what is left at 10 or fewer until something is decided, with the same three lines", async () => {
        const page = await openChange("3484");
        const progress = async () => (await page.locator("#snaps-head > .h2").innerText()).replaceAll(/\s+/g, " ");
        expect(await progress()).toBe("3 left");
        const line3 = page.locator("#snaps-head > .h3");
        expect(await line3.getByRole("button", { name: "Show: Undecided" }).count()).toBe(1);
        await listMenu(page);
        const menu = page.getByRole("menu");
        for (const head of ["Group by: None", "Pictures"]) {
            expect(await menu.locator(".mh", { hasText: head }).count()).toBe(1);
        }
        await menuItem(page, "Status").click();
        await expect.poll(() => page.locator("#snap-list .ghead").count()).toBe(0); // groups of one are no groups
    });

    it("prints the header's keys quiet, the decision bar's boxed, and names each key to a screen reader", async () => {
        const page = await openChange("3486");
        const keyOf = (sel) =>
            page.locator(sel).evaluate((n) => ({
                aria: n.getAttribute("aria-keyshortcuts"),
                quiet: [...n.querySelectorAll(":scope > kbd")].map((k) => k.classList.contains("quiet")),
            }));
        expect(await keyOf('#snaps-head [data-act="rowup"]')).toEqual({ aria: "ArrowUp", quiet: [true] });
        expect(await keyOf('#snaps-head [data-act="rowdown"]')).toEqual({ aria: "ArrowDown", quiet: [true] });
        expect(await keyOf('#snaps-head > .h1 [data-act="pane2"]')).toEqual({ aria: "Shift+2", quiet: [true] });
        expect(await page.locator('#snaps-head > .h1 [data-act="pane2"]').getAttribute("aria-label")).toBe(
            "Hide Snapshots",
        );
        // The fold button reads "Hide  Shift+2" after a drawn caret pointing left.
        const fold = page.locator('#snaps-head > .h1 [data-act="pane2"]');
        expect((await fold.innerText()).replace(/\s+/g, " ").trim()).toBe("Hide Shift+2");
        expect(await fold.locator(".lcaret").evaluate((n) => globalThis.getComputedStyle(n).borderRightStyle)).toBe(
            "solid",
        );
        // The number of the change is on line 1, apart from its title.
        expect(await page.locator("#snaps-head > .h1 .cnum").innerText()).toBe("#3486");
        expect(await keyOf('.decide [data-act="accept"]')).toEqual({ aria: "A", quiet: [false] });
    });

    it("says the reader's own decisions after what is left once one is decided, at 10 or fewer", async () => {
        const page = await openChange("3484", {
            rows: (id, name) => {
                const a = rowsAnswer(name, 3);
                return { ...a, decisions: { [a.items[0].file]: { decision: "accept", reason: null } } };
            },
        });
        await expect
            .poll(async () => (await page.locator("#snaps-head > .h2").innerText()).replaceAll(/\s+/g, " "))
            .toBe("2 left 1 decided");
    });
});

describe("marks", () => {
    // Each shape drawn black on white at 96 px, as a mask of its ink, and its silhouette (everything
    // the white outside cannot reach).
    async function masks() {
        const page = await browser.newPage({ viewport: { width: 120, height: 120 } });
        const out = {};
        for (const [st, s] of Object.entries(STATUS)) {
            await page.setContent(
                `<body style="margin:0;background:#fff"><svg viewBox="0 0 12 12" width="96" height="96" style="color:#000;margin:12px">${SHAPES[s.shape]}</svg></body>`,
            );
            const png = PNG.sync.read(await page.screenshot());
            const w = png.width;
            const ink = new Uint8Array(w * png.height);
            for (let i = 0; i < ink.length; i++) {
                ink[i] = png.data[i * 4] < 128 ? 1 : 0;
            }
            const outside = new Uint8Array(ink.length);
            const stack = [0];
            while (stack.length > 0) {
                const p = stack.pop();
                if (p < 0 || p >= ink.length || outside[p] || ink[p]) {
                    continue;
                }
                outside[p] = 1;
                const x = p % w;
                stack.push(p - w, p + w, ...(x > 0 ? [p - 1] : []), ...(x < w - 1 ? [p + 1] : []));
            }
            out[st] = { ink, silhouette: outside.map((o) => 1 - o) };
        }
        await page.close();
        return out;
    }
    const differ = (a, b) => {
        let xor = 0;
        let union = 0;
        for (let i = 0; i < a.length; i++) {
            xor += a[i] ^ b[i];
            union += a[i] | b[i];
        }
        return xor / union;
    };

    it("gives every status its own shape, told apart in grayscale, and each family its own silhouette", async () => {
        const m = await masks();
        const family = (st) => STATUS[st].shape.replace("moved", "changed").replace("unseeded", "new");
        const names = Object.keys(STATUS);
        for (const a of names) {
            for (const b of names.filter((x) => x > a)) {
                expect(differ(m[a].ink, m[b].ink), `${a} and ${b}`).toBeGreaterThan(0.15);
                // The closest outlines are new's circle and removed's rounded square, whose corners
                // differ in 13.5% of their area at 96 px.
                if (family(a) !== family(b)) {
                    expect(differ(m[a].silhouette, m[b].silhouette), `${a} and ${b} silhouettes`).toBeGreaterThan(0.1);
                }
            }
        }
    });

    it("draws each status's own shape, with its word, in the rows and the summary", async () => {
        const page = await openChange(RICH);
        await page.getByRole("button", { name: /^Show:/ }).click();
        await menuItem(page, "All").click();
        await page
            .locator(WIDGETS)
            .getByRole("button", { name: /^Show all \d+ in this group$/ })
            .click();
        const seen = await page.evaluate(() =>
            [...globalThis.document.querySelectorAll("#snap-list .srow .info .l:first-child .st")].map((n) => [
                n.textContent,
                n.querySelector("svg").innerHTML,
            ]),
        );
        for (const [st, s] of Object.entries(STATUS)) {
            const found = seen.find(([text]) => text.startsWith(s.word));
            expect(found, st).toBeTruthy();
            expect(found[1]).toBe(await serialized(page, SHAPES[s.shape]));
        }
    });

    it("shows an old capture's unstable story with the wavy mark, and only Exclude is allowed", async () => {
        const page = await openChange(RICH);
        const r = page.locator('.srow[data-snap="graphty-element/widgets--story-3.dark.png"]');
        await page.locator("#snap-find").click();
        await page.keyboard.type("4");
        await page.keyboard.press("Enter");
        expect(await r.locator(".l .st").first().innerText()).toBe("unstable (old capture)");
        expect(await r.locator(".l .st svg").first().innerHTML()).toBe(await serialized(page, SHAPES.wavy));
        expect(decisionsFor("unstable")).toEqual(["exclude"]);
        expect(decisionsFor("failed")).toEqual(["exclude"]);
        expect(decisionsFor("changed")).toEqual(["accept", "reject", "exclude"]);
    });
});

describe("Show, Find and the progress line", () => {
    it("filters by Show, its count only while filtered, and keeps the current snapshot a drawn row", async () => {
        const page = await openChange("3486");
        await currentIsShown(page);
        const show = page.getByRole("button", { name: /^Show:/ });
        expect(await show.innerText()).toBe("Show: Undecided");
        await show.click();
        // Each choice with its count right-aligned; statuses the change has, then the decisions,
        // a choice of 0 greyed, never hidden (Accept all N shown... follows them, tested apart).
        const items = await page
            .getByRole("menu")
            .locator('.mi[data-act="show"]')
            .evaluateAll((ns) =>
                ns.map((n) => [
                    n.querySelector(".ml").textContent,
                    n.querySelector(".mc").textContent,
                    n.classList.contains("dim"),
                ]),
            );
        expect(items).toEqual([
            ["Undecided", "300", false],
            ["All", "300", false],
            ["Failed", "50", false],
            ["Changed", "50", false],
            ["Moved", "50", false],
            ["New", "50", false],
            ["No baseline yet", "50", false],
            ["Removed", "50", false],
            ["Accepted earlier", "0", true],
            ["Accepted", "0", true],
            ["Rejected", "0", true],
            ["Excluded", "0", true],
        ]);
        await menuItem(page, "Removed").click();
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBe(50);
        expect(await show.innerText()).toBe("Show: Removed (50)");
        await currentIsShown(page);
        // A click makes a row current.
        const second = page.locator("#snap-list .srow").nth(1);
        await second.click();
        await expect.poll(() => current(page)).toBe(await second.getAttribute("data-snap"));
        await currentIsShown(page);
        await show.click();
        await menuItem(page, "Undecided").click();
        await expect.poll(() => show.innerText()).toBe("Show: Undecided");
        await currentIsShown(page);
    });

    it("heads the Show menu's two breakdowns, By kind and By decision, headings the arrow keys skip", async () => {
        const page = await openChange("3486");
        await page.getByRole("button", { name: /^Show:/ }).click();
        const menu = page.getByRole("menu");
        const order = await menu
            .locator(":scope > *")
            .evaluateAll((ns) =>
                ns.map((n) =>
                    n.classList.contains("mh")
                        ? `[${n.textContent}]`
                        : n.classList.contains("sep")
                          ? "---"
                          : n.querySelector(".ml").textContent,
                ),
            );
        expect(order).toEqual([
            "Undecided",
            "All",
            "[By kind]",
            "Failed",
            "Changed",
            "Moved",
            "New",
            "No baseline yet",
            "Removed",
            "[By decision]",
            "Accepted earlier",
            "Accepted",
            "Rejected",
            "Excluded",
            "---",
            "Accept all 250 shown...", // 300 shown less 50 failed, which only Exclude takes
        ]);
        // Muted, never focusable: Down from All goes straight to the first kind.
        const head = menu.locator(".mh").first();
        expect(await head.getAttribute("tabindex")).toBeNull();
        const ink = await page.evaluate(() => globalThis.getComputedStyle(globalThis.document.body).color);
        expect(await head.evaluate((n) => globalThis.getComputedStyle(n).color)).not.toBe(ink);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        expect(await page.evaluate(() => globalThis.document.activeElement.querySelector(".ml")?.textContent)).toBe(
            "Failed",
        );
    });

    it("says what is left first, then the reader's decisions, then what was accepted earlier, dropping those when tight", async () => {
        // The rich change holds 2 snapshots accepted before this capture.
        const page = await openChange(RICH, { viewport: { width: 1440, height: 900 } });
        const h2 = page.locator("#snaps-head > .h2");
        const progress = async () => (await h2.innerText()).replaceAll(/\s+/g, " ");
        expect(await h2.locator("b").innerText()).toMatch(/^[\d,]+ left$/);
        expect(await progress()).toMatch(/^[\d,]+ left 6 decided, 2 accepted earlier$/);
        // Show: Accepted earlier lists them, apart from Accepted (the reader's own).
        await page.getByRole("button", { name: /^Show:/ }).click();
        await menuItem(page, "Accepted earlier").click();
        await expect
            .poll(() => page.getByRole("button", { name: /^Show:/ }).innerText())
            .toBe("Show: Accepted earlier (2)");
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBe(2);
        await page.getByRole("button", { name: /^Show:/ }).click();
        await menuItem(page, "Undecided").click();
        const left = Number((await h2.locator("b").innerText()).replace(/\D/g, ""));
        // A narrow header: "accepted earlier" goes first, then "decided"; "N left" never goes.
        const narrow = async (px) => {
            await page.evaluate((w) => {
                globalThis.document.querySelector("#snaps-head > .h2").style.maxWidth = `${w}px`;
            }, px);
            // Show set again draws the header again.
            await page.getByRole("button", { name: /^Show:/ }).click();
            await menuItem(page, "Undecided").click();
        };
        await narrow(170);
        await expect.poll(progress).toBe(`${left} left 6 decided`);
        await narrow(60);
        await expect.poll(progress).toBe(`${left} left`);
    });

    it("filters by text, takes two steps for Esc, opens a collapsed group holding a match, and jumps to a number", async () => {
        const page = await openChange(RICH, { viewport: { width: 1280, height: 800 } });
        const find = page.locator("#snap-find");
        const big = page.locator('.ghead[data-group="c:graphty-element > widgets"] .caret');
        expect(await big.getAttribute("aria-expanded")).toBe("false");
        // "/" goes to the list's Find: the list is the pane the reader is in.
        await page.locator("#snap-list").focus();
        await page.keyboard.press("Slash");
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("snap-find");
        // "Find  /" at every width; the tooltip says what it finds.
        expect(await find.getAttribute("placeholder")).toBe("Find  /");
        expect(await find.getAttribute("title")).toBe("Find a story, or #number");
        // Text filters across every group; the big group, collapsed, opens while Find holds text.
        await page.keyboard.type("story-1");
        await expect
            .poll(() => page.getByRole("button", { name: /^Show:/ }).innerText())
            .toMatch(/^Show: Undecided \(\d+\)$/);
        expect(await big.getAttribute("aria-expanded")).toBe("true");
        expect((await rowTexts(page)).length).toBeGreaterThan(5);
        await currentIsShown(page);
        // Esc: the first clears and stays; the second leaves for the list. The level never changes.
        await page.keyboard.press("Escape");
        expect(await find.inputValue()).toBe("");
        expect(await page.evaluate(() => globalThis.document.activeElement?.id)).toBe("snap-find");
        await page.keyboard.press("Escape");
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("snap-list");
        expect(await page.locator('.iline [data-act="back"]').getAttribute("title")).toBe("Back to the changes (Esc)");
        expect(await big.getAttribute("aria-expanded")).toBe("false");
        await currentIsShown(page);
        // No match: the list and the message line say so, and the box's Clear [Esc] empties it.
        await find.click();
        await page.keyboard.type("zzzz");
        await expect.poll(() => message(page)).toBe('No story matches "zzzz".');
        expect(await page.locator("#snap-list").innerText()).toBe('No story matches "zzzz".');
        expect(await page.locator(".emptyv").innerText()).toBe("Nothing shown here.");
        await page.locator("#find-clear").click();
        await expect.poll(() => find.inputValue()).toBe("");
        await currentIsShown(page);
        // A number that is no snapshot says nothing while typed; Enter says so.
        const said = await message(page);
        await page.keyboard.type("999");
        await expect.poll(() => find.inputValue()).toBe("999");
        expect(await message(page)).toBe(said);
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("There is no snapshot #999 in this change.");
        await page.keyboard.press("Escape");
        await expect.poll(() => find.inputValue()).toBe("");
        // A number is a jump: no "N of M shown", the row (in the collapsed group) current at once,
        // Enter opens it and empties the box.
        await find.click();
        await page.keyboard.type("#47");
        await expect.poll(() => page.locator(".iline b.num").innerText()).toBe("#47");
        expect(await page.getByRole("button", { name: /^Show:/ }).innerText()).toBe("Show: Undecided");
        expect(await big.getAttribute("aria-expanded")).toBe("true");
        await currentIsShown(page);
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Opened #47.");
        expect(await find.inputValue()).toBe("");
        await expect
            .poll(() => page.locator('.iline [data-act="back"]').getAttribute("title"))
            .toBe("Back to the list (Esc)");
        await page.keyboard.press("Escape");
        await expect.poll(() => message(page)).toBe("Back to the list.");
        await currentIsShown(page);
    });

    it("says Nothing undecided here, with Show: All, when Show empties the list", async () => {
        // A change whose three snapshots are all decided: Show: Undecided alone empties the list.
        const page = await openChange("3484", {
            rows: (id, name) => {
                const a = rowsAnswer(name, 3);
                return {
                    ...a,
                    decisions: Object.fromEntries(a.items.map((x) => [x.file, { decision: "accept", reason: null }])),
                };
            },
            rowsFirst: false,
        });
        const list = page.locator("#snap-list");
        await expect.poll(() => list.innerText()).toMatch(/^Nothing undecided here\.\s+Show: All \(3\)$/);
        expect(await page.locator("#snap-list .srow").count()).toBe(0);
        await list.getByRole("button", { name: "Show: All (3)" }).click();
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBe(3);
        await currentIsShown(page);
    });
});

describe("projects with no capture", () => {
    it("shows the snapshots of the one project captured when the config's other projects have none", async () => {
        const others = ["graphty", "layout", "algorithms", "compact-mantine", "cytoscape", "docs"];
        const partial = target(8000, {
            title: "One project captured",
            projects: [
                project("graphty-element", { reviewable: 2 }),
                ...others.map((n) => project(n, { problem: n === "docs" ? "not affected" : "no capture" })),
            ],
        });
        const page = await openChange("8000", {
            targets: [...targets(), partial],
            rows: (id, name) => rowsAnswer(name, 2),
        });
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBe(2);
        expect(await page.locator('.chg[data-chg="8000"]').innerText()).toContain("2 left");
        expect(await message(page)).not.toMatch(/Nothing to review yet/);
        await currentIsShown(page);
    });
});

describe("groups", () => {
    it("draws each of the five groupings, Identical change and Look alike labeled apart", async () => {
        const page = await openChange(RICH);
        const heads = () => page.locator("#snap-list .ghead").evaluateAll((n) => n.map((h) => h.getAttribute("title")));
        const pick = async (label) => {
            await listPick(page, label);
            expect((await listChecked(page)).group).toBe(`Group by: ${label}`);
            await currentIsShown(page);
        };
        // Component, the default above 10; Accepted earlier last, collapsed, with no row: one quiet line.
        let h = await heads();
        expect(h.at(-1)).toBe("Accepted earlier");
        expect(h).toContain("graphty-element > widgets");
        // As text: the line is off screen at the list's end (content-visibility), so innerText skips it.
        expect((await page.locator('.ghead[data-group="!before"]').textContent()).trim()).toBe("Accepted earlier");
        expect(await page.locator('.grp[data-group="!before"] .srow').count()).toBe(0);
        await pick("Same change");
        h = await heads();
        expect(h[0]).toBe("Identical change");
        expect(h).toContain("Look alike: small changes, top left, 5,428 to 6,538 px");
        expect(h.slice(-2)).toEqual(["Different from the rest", "Accepted earlier"]);
        const look = page.locator('.grp[data-group^="l:"] .srow');
        // The representative, the most changed pixels of the six, first.
        expect(await look.count()).toBeGreaterThan(1);
        await pick("Project");
        expect(await heads()).toEqual(["graphty-element", "Accepted earlier"]);
        await pick("Status");
        h = await heads();
        expect(h.slice(0, -1)).toEqual([
            "failed",
            "changed",
            "moved",
            "new",
            "no baseline yet",
            "removed",
            "unstable (old capture)",
        ]);
        await pick("None");
        expect(await heads()).toEqual([]);
        const numbers = (await rowTexts(page)).map((x) => Number(x.slice(1)));
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
        // Identical changes carry "+7 identical" in every grouping but Same change: the badge's word,
        // never folded into a bare count (one badge left over shows its own word).
        await pick("Component");
        const same = await page
            .locator("#snap-list .badge")
            .evaluateAll((n) => n.filter((b) => b.textContent === "+7 identical").length);
        expect(same).toBe(8);
        expect(
            await page
                .locator("#snap-list .badge")
                .evaluateAll((n) => n.filter((b) => /^\+1( more)?$/.test(b.textContent)).length),
        ).toBe(0);
    });

    it("opens a group over 50 collapsed but shows its first undecided row; the chevron opens and closes", async () => {
        const p2 = await openChange(RICH);
        const caret = p2.locator('.ghead[data-group="c:graphty-element > widgets"] .caret');
        // The big group is not the first group, so it opens collapsed, showing one undecided row.
        expect(await caret.getAttribute("aria-expanded")).toBe("false");
        const big = p2.locator('.grp[data-group="c:graphty-element > widgets"]');
        expect(await big.locator(".srow").count()).toBe(1);
        expect(await big.locator(".srow.decided").count()).toBe(0);
        await big.getByRole("button", { name: /^Show all \d+ in this group$/ }).click();
        await expect.poll(() => caret.getAttribute("aria-expanded")).toBe("true");
        expect(await big.locator(".srow").count()).toBeGreaterThan(40);
        await caret.click();
        await expect.poll(() => big.locator(".srow").count()).toBe(1);
        await currentIsShown(p2);
        await caret.click();
        await expect.poll(() => caret.getAttribute("aria-expanded")).toBe("true");
        // The Accepted earlier line has no Show: its chevron opens it, and so does its menu's Expand.
        const earlier = p2.locator('.ghead[data-group="!before"]');
        expect(await earlier.getByRole("button", { name: "Show" }).count()).toBe(0);
        await earlier.locator(".gname").click();
        await menuItem(p2, "Expand").click();
        await expect.poll(() => p2.locator('.grp[data-group="!before"] .srow').count()).toBe(2);
        expect(await p2.locator('.grp[data-group="!before"] .srow').first().textContent()).toContain(
            "Accepted earlier (#1356)",
        );
        await earlier.locator(".caret").click();
        await expect.poll(() => p2.locator('.grp[data-group="!before"] .srow').count()).toBe(0);
    });

    it("draws a header as a chevron, a name button with a caret that opens the group's actions, and Accept N", async () => {
        const page = await openChange("3486");
        const key = await page
            .locator("#snap-list .srow.cur")
            .locator("xpath=ancestor::section[1]")
            .getAttribute("data-group");
        const mine = page.locator(`.ghead[data-group="${key}"]`);
        const other = page
            .locator("#snap-list .ghead")
            .filter({ has: page.locator('[data-act="gaccept"]:not(.mine)') })
            .first();
        // Three controls, nothing else that takes a click.
        expect(await mine.locator("button").evaluateAll((n) => n.map((b) => b.dataset.act))).toEqual([
            "gtoggle",
            "gmenu",
            "gaccept",
        ]);
        // The name alone, no count (Accept N says it), then a drawn caret: a bordered triangle,
        // no glyph. The name underlines on hover; its tooltip says what it opens.
        expect(await mine.locator(".gname").textContent()).not.toMatch(/\(\d+\)/);
        const caretLook = await mine.locator(".gname .gcaret").evaluate((n) => {
            const cs = globalThis.getComputedStyle(n);
            return { text: n.textContent, top: cs.borderTopStyle, left: cs.borderLeftColor };
        });
        expect(caretLook).toEqual({ text: "", top: "solid", left: "rgba(0, 0, 0, 0)" });
        expect(await mine.locator(".gname").getAttribute("title")).toMatch(/^Group actions: /);
        await mine.locator(".gname").hover();
        expect(
            await mine.locator(".gname .gn").evaluate((n) => globalThis.getComputedStyle(n).textDecorationLine),
        ).toBe("underline");
        // Every Accept N is outlined; the current group's is green and prints a quiet Shift+A.
        const look = (h) =>
            h.locator('[data-act="gaccept"]').evaluate((n) => ({
                mine: n.classList.contains("mine"),
                key: n.querySelector("kbd")?.textContent ?? null,
                quiet: n.querySelector("kbd")?.classList.contains("quiet") ?? null,
                border: globalThis.getComputedStyle(n).borderTopColor,
                line: globalThis.getComputedStyle(globalThis.document.documentElement).getPropertyValue("--line"),
            }));
        const a = await look(mine);
        expect([a.mine, a.key, a.quiet]).toEqual([true, "Shift+A", true]);
        const b = await look(other);
        expect([b.mine, b.key]).toEqual([false, null]);
        expect(b.border).not.toBe(a.border);
        expect(b.border).not.toBe("rgba(0, 0, 0, 0)");
        // Another group's Accept N shows only while its header is hovered or focused.
        const shown = (h) =>
            h.locator('[data-act="gaccept"]').evaluate((n) => {
                const cs = globalThis.getComputedStyle(n);
                return cs.opacity === "1" && cs.pointerEvents !== "none";
            });
        expect(await shown(mine)).toBe(true);
        await mine.locator(".gname").hover();
        expect(await shown(other)).toBe(false);
        await other.hover();
        expect(await shown(other)).toBe(true);
        await other.locator(".gname").focus();
        await page.mouse.move(0, 0);
        expect(await shown(other)).toBe(true);
        // The name opens the group's actions: Accept N (Shift+A on the current group only),
        // Collapse, then the group's former [...] items.
        await other.locator(".gname").click();
        expect(await page.locator(".menu .mi").first().innerText()).toMatch(/^Accept \d+$/);
        await page.keyboard.press("Escape");
        await mine.locator(".gname").click();
        expect((await page.locator(".menu .mi").first().innerText()).replaceAll(/\s+/g, " ")).toMatch(
            /^Accept \d+ Shift\+A$/,
        );
        expect(await page.locator(".menu .mi .ml").allInnerTexts()).toEqual([
            expect.stringMatching(/^Accept \d+$/),
            "Collapse",
            expect.stringMatching(/^Reject \d+\.\.\.$/),
            expect.stringMatching(/^Exclude \d+\.\.\.$/),
            expect.stringMatching(/^Select all \d+$/),
        ]);
        // Collapse folds the group (the current row is kept shown, so it may open again with it).
        await menuItem(page, "Collapse").click();
        await expect.poll(() => page.locator(".menu").count()).toBe(0);
        expect(t.errors).toEqual([]);
        const other2 = page
            .locator(".ghead")
            .filter({ has: page.locator('[data-act="gaccept"]:not(.mine)') })
            .last();
        const otherKey = await other2.getAttribute("data-group");
        await other2.locator(".gname").click();
        await menuItem(page, "Collapse").click();
        await expect
            .poll(() => page.locator(`.ghead[data-group="${otherKey}"] .caret`).getAttribute("aria-expanded"))
            .toBe("false");
        expect(t.errors).toEqual([]);
    });

    it("keeps a row's checkbox in place, muted until the row is hovered or a selection exists", async () => {
        const page = await openChange("3486");
        const rows = page.locator("#snap-list .srow");
        const boxOf = (i) =>
            rows
                .nth(i)
                .locator(".rcheck span")
                .evaluate((n) => ({
                    color: globalThis.getComputedStyle(n).borderTopColor,
                    x: n.getBoundingClientRect().x,
                }));
        const colors = await page.evaluate(() => {
            const probe = globalThis.document.createElement("i");
            globalThis.document.body.append(probe);
            const of = (v) => {
                probe.style.color = `var(${v})`;
                return globalThis.getComputedStyle(probe).color;
            };
            const out = { line: of("--line"), muted: of("--ink-2") };
            probe.remove();
            return out;
        });
        const rest = await boxOf(2);
        expect(rest.color).toBe(colors.line);
        await rows.nth(2).hover();
        expect((await boxOf(2)).color).toBe(colors.muted);
        expect((await boxOf(2)).x).toBe(rest.x);
        await rows.nth(1).locator(".rcheck").click();
        await page.mouse.move(0, 0);
        await expect.poll(async () => (await boxOf(2)).color).toBe(colors.muted);
        expect((await boxOf(2)).x).toBe(rest.x);
    });

    it("says a row's mode as muted words after the story's name, the name the one bold thing", async () => {
        const page = await openChange(RICH);
        const r = page.locator("#snap-list .srow", { has: page.locator(".mode") }).first();
        expect(await r.locator(".mode").innerText()).toMatch(/^, (light|dark)$/);
        expect(await r.locator(".tag").count()).toBe(0);
        // Every piece of text on the row drawn bold: the story's name alone.
        const bold = await r.evaluate((n) =>
            [...n.querySelectorAll(".info *")]
                .filter(
                    (x) =>
                        [...x.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) &&
                        Number(globalThis.getComputedStyle(x).fontWeight) >= 600,
                )
                .map((x) => x.className),
        );
        expect(bold).toEqual([expect.stringMatching(/^nm1?$/)]);
        // Mark the change, one name, with a tooltip saying what it does and when.
        await listMenu(page);
        expect(await page.locator('.menu .mi[data-act="picspot"]').getAttribute("title")).toBe(
            "Tints the changed pixels red",
        );
    });

    it("keeps the headers sticky, and the current row wholly below the sticky header", async () => {
        const page = await openChange("3486", { viewport: { width: 1440, height: 900 } });
        await page.locator("#snap-list").focus();
        for (let i = 0; i < 12; i++) {
            await page.keyboard.press("ArrowDown");
        }
        const geometry = () =>
            page.evaluate(() => {
                const list = globalThis.document.getElementById("snap-list").getBoundingClientRect();
                const cur = globalThis.document.querySelector("#snap-list .srow.cur").getBoundingClientRect();
                const stuck = [...globalThis.document.querySelectorAll("#snap-list .ghead")]
                    .map((h) => h.getBoundingClientRect())
                    .filter((r) => r.top <= list.top + 1 && r.bottom > list.top);
                return { list, cur, stuck: stuck.map((r) => r.toJSON()) };
            });
        let g = await geometry();
        for (let i = 0; i < 40; i++) {
            await page.keyboard.press("ArrowUp");
            g = await geometry();
            expect(g.cur.top).toBeGreaterThanOrEqual(Math.max(g.list.top, ...g.stuck.map((r) => r.bottom)) - 1);
        }
        // A header sticks at the top while its rows scroll under it.
        await page.locator("#snap-list").evaluate((n) => {
            n.scrollTop = 1000;
        });
        g = await geometry();
        expect(g.stuck.length).toBe(1);
        expect(g.stuck[0].top).toBeCloseTo(g.list.top, 0);
        // Scrolling by hand never changes the current row.
        expect(await page.locator("#snap-list .srow.cur").count()).toBe(1);
    });
});

describe("rows", () => {
    // The kinds of picture the drawn rows asked for, from the requests the page made.
    const asked = (t2, from) =>
        t2.requests
            .slice(from)
            .filter((p) => p.startsWith("/api/pic/"))
            .map((p) => p.split("-").slice(4).join("-").split("?")[0]);

    it("tints every changed row picture, whatever share of its crop changed, and says so in its tooltip and alt", async () => {
        const page = await openChange(RICH);
        // The fixture's rows 10-19, 30-39 and so on cover half their crop, the others less than a
        // third: every one is asked for tinted, none spotlit.
        const rows = () =>
            page
                .locator("#snap-list .pic img")
                .evaluateAll((imgs) =>
                    imgs.map((i) => [i.closest(".srow").dataset.snap, i.dataset.kind, i.closest(".pic").title, i.alt]),
                );
        await expect.poll(async () => (await rows()).length).toBeGreaterThan(4);
        const seen = new Set();
        for (const [snap, kind, title, alt] of await rows()) {
            const n = /story-(\d+)\./.exec(snap);
            if (!n || kind === "plain") {
                continue;
            }
            seen.add(Math.floor(Number(n[1]) / 10) % 2 === 1);
            expect([snap, kind, alt, title.endsWith(", changed pixels tinted")]).toEqual([snap, "row-tint", title, true]);
        }
        // Rows on both sides of a third were seen.
        expect([...seen].sort()).toEqual([false, true]);
    });

    it("asks for the picture the Row pictures choices name, says its crop only in its tooltip, and its areas under the name", async () => {
        const page = await openChange(RICH);
        // A changed row: Crop to the change and Mark the change, so the row's marked crop.
        // Its crop frames one of its three areas (the fixture's largest cluster).
        const r = page.locator('#snap-list .srow[data-snap="graphty-element/component-22--story-114.light.png"]');
        await page.locator("#snap-find").click();
        await page.keyboard.type("115");
        await r.waitFor();
        await expect.poll(() => r.locator("img").getAttribute("src")).toMatch(/-row-tint\?v=6$/);
        expect((await listChecked(page)).checked).toEqual(["Component", "Crop to the change", "Mark the change"]);
        // The Pictures section: three choices, then the Mark the change toggle with its rule in its tooltip.
        await listMenu(page);
        const items = await page.getByRole("menu").locator(".mi").allInnerTexts();
        const at = items.indexOf("Crop to the change");
        expect(items.slice(at, at + 4)).toEqual([
            "Crop to the change",
            "Whole image",
            "Text only, no pictures",
            "Mark the change",
        ]);
        expect(await page.locator('.menu .mi[data-act="picspot"]').getAttribute("title")).toBe(
            "Tints the changed pixels red",
        );
        await page.keyboard.press("Escape");
        // The row says how many areas changed, right under the story's name (grouped by component,
        // the row has no component line); no zoom and no pixel size on the row, and no crop bar.
        const line4 = r.locator(".x4 .keep");
        expect(await r.locator(".x3").count()).toBe(0);
        expect(await r.locator(".info > .nm1 + .x4").count()).toBe(1);
        const cropped = async (tint = "") => {
            await expect
                .poll(() => r.locator(".pic").getAttribute("title"))
                .toBe(`Cropped to 1 of the 3 changed areas${tint}`);
            expect(await line4.innerText()).toBe("3 changed areas");
            expect(await r.locator(".pic").evaluate((p) => globalThis.getComputedStyle(p).boxShadow)).toBe("none");
        };
        const whole = async () => {
            await expect.poll(() => r.locator(".pic").getAttribute("title")).toBe("Whole image, changed pixels tinted");
            expect(await line4.innerText()).toBe("3 changed areas");
        };
        // Nothing is drawn over any row picture: a loaded picture shows only its image (the
        // placeholder hides; a removed row's even hatching is its status, not a label).
        const over = () =>
            page.evaluate(() =>
                [...globalThis.document.querySelectorAll("#snap-list .pic.ready")].flatMap((p) =>
                    [...p.children]
                        .filter((c) => c.tagName !== "IMG" && c.className !== "rm")
                        .filter((c) => globalThis.getComputedStyle(c).display !== "none")
                        .map((c) => c.className),
                ),
            );
        await cropped(", changed pixels tinted");
        await expect.poll(() => r.locator(".pic.ready").count()).toBe(1);
        expect(await over()).toEqual([]);
        // A row whose crop frames every area says so.
        const titles = await page.locator("#snap-list .pic").evaluateAll((ps) => ps.map((p) => p.title));
        expect(titles).toContain("Cropped to the changed areas, changed pixels tinted");
        // A picture narrower than the row's shape is centered on the row's own background, never
        // on the stage grey.
        expect(await r.locator(".pic").evaluate((p) => globalThis.getComputedStyle(p).backgroundColor)).toBe(
            "rgba(0, 0, 0, 0)",
        );
        // A choice: the row asks for its picture of that kind (the request is made).
        const pics = async (label, kind) => {
            const from = t.requests.length;
            await listPick(page, label);
            await expect.poll(() => asked(t, from)).toContain(kind);
            expect(await r.locator("img").getAttribute("src")).toMatch(new RegExp(`-${kind}\\?v=\\d+$`));
        };
        await pics("Whole image", "tint");
        await whole();
        expect((await listChecked(page)).checked).toContain("Whole image");
        await pics("Mark the change", "plain");
        await pics("Crop to the change", "row-plain");
        await cropped();
        expect(await over()).toEqual([]);
        // No pictures: 28 px text rows that ask for none.
        const from = t.requests.length;
        await listPick(page, "Text only, no pictures");
        await expect.poll(() => page.locator("#snap-list .srow img").count()).toBe(0);
        expect((await box(page, "#snap-list .srow")).height).toBe(28);
        expect(asked(t, from)).toEqual([]);
        expect((await listChecked(page)).checked).toEqual(["Component", "Text only, no pictures"]);
    });

    it.each([
        ["auto", "Crop to the change"],
        ["always", "Crop to the change"],
        ["never", "Whole image"],
    ])("reads an older page's stored Zoom rows %s as %s", async (zoom, choice) => {
        const page = await openChange(RICH, {
            storage: { "proofroom:pictures": JSON.stringify({ spot: true, zoom, none: false }) },
        });
        expect((await listChecked(page)).checked).toContain(choice);
    });

    it("says what a row's decision is, and Undo changes exactly that row element", async () => {
        const page = await openChange(RICH);
        await page.getByRole("button", { name: /^Show:/ }).click();
        await menuItem(page, "All").click();
        await page
            .locator(WIDGETS)
            .getByRole("button", { name: /^Show all \d+ in this group$/ })
            .click();
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBeGreaterThan(100);
        // textContent: rows off screen are not rendered (content-visibility), so innerText skips them.
        const text = await page.locator("#snap-list").textContent();
        for (const words of [
            "Accepted",
            "Accepted (not opened)",
            "Accepted earlier (#1356)",
            "Rejected: Legend overlaps the minimap at the right edge",
            "Rejected before (#5000, 2026-10-20): The label wraps under the icon",
            "Excluded: Animated: never stable",
            "Finished: it is on the branch",
            "re-review",
            "resized",
            "image identical",
        ]) {
            expect(text, words).toContain(words);
        }
        // A moved row says "moved"; where from is in its tooltip.
        expect(text).not.toContain("moved from");
        const moved = page.locator("#snap-list .srow", { hasText: "image identical" }).first();
        expect(await moved.getAttribute("title")).toMatch(/, moved from /);
        const rejected = page.locator("#snap-list .srow", { hasText: "Rejected: Legend overlaps" });
        await page.evaluate(() => {
            globalThis.changedRows = [];
            new globalThis.MutationObserver((records) => {
                for (const r of records) {
                    for (const n of [...r.addedNodes, ...r.removedNodes]) {
                        if (n.classList?.contains("srow")) {
                            globalThis.changedRows.push(n.dataset.snap);
                        }
                        for (const inner of n.querySelectorAll?.(".srow") ?? []) {
                            globalThis.changedRows.push(inner.dataset.snap);
                        }
                    }
                }
            }).observe(globalThis.document.getElementById("snap-list"), { childList: true, subtree: true });
        });
        const key = await rejected.getAttribute("data-snap");
        await rejected.getByRole("button", { name: "Undo" }).click();
        await expect.poll(() => message(page)).toMatch(/^Undone: #\d+\.$/);
        const changedRows = await page.evaluate(() => globalThis.changedRows);
        expect(changedRows).toEqual([key, key]); // one row element out, its replacement in
        expect(await page.locator(`#snap-list .srow[data-snap="${key}"]`).getAttribute("class")).not.toContain(
            "decided",
        );
    });

    it("undoes a row under Show: Rejected by changing that row element alone, and keeps it shown", async () => {
        const page = await openChange(RICH);
        await listPick(page, "None");
        await page.getByRole("button", { name: /^Show:/ }).click();
        await menuItem(page, "Rejected").click();
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBe(2);
        await page.evaluate(() => {
            globalThis.changedRows = [];
            new globalThis.MutationObserver((records) => {
                for (const r of records) {
                    for (const n of [...r.addedNodes, ...r.removedNodes]) {
                        if (n.classList?.contains("srow")) {
                            globalThis.changedRows.push(n.dataset.snap);
                        }
                    }
                }
            }).observe(globalThis.document.getElementById("snap-list"), { childList: true, subtree: true });
        });
        const rejected = page.locator("#snap-list .srow", { hasText: "Rejected: Legend overlaps" });
        const key = await rejected.getAttribute("data-snap");
        await rejected.getByRole("button", { name: "Undo" }).click();
        await expect.poll(() => message(page)).toMatch(/^Undone: #\d+\.$/);
        expect(await page.evaluate(() => globalThis.changedRows)).toEqual([key, key]);
        expect(await page.locator("#snap-list .srow").count()).toBe(2);
    });

    it("walks Down into a collapsed group row by row, opening it", async () => {
        const page = await openChange(RICH);
        const caret = page.locator('.ghead[data-group="c:graphty-element > widgets"] .caret');
        expect(await caret.getAttribute("aria-expanded")).toBe("false");
        const all = await page.evaluate(
            (sel) => globalThis.document.querySelector(sel).previousElementSibling.querySelectorAll(".srow").length,
            WIDGETS,
        );
        await page
            .locator(WIDGETS)
            .locator("xpath=preceding-sibling::section[1]")
            .locator(".srow")
            .nth(all - 1)
            .click();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => caret.getAttribute("aria-expanded")).toBe("true");
        await expect
            .poll(() => current(page))
            .toBe(await page.locator(`${WIDGETS} .srow`).nth(1).getAttribute("data-snap"));
        await currentIsShown(page);
    });

    it("draws a placeholder for a picture that failed, and Retry asks again", async () => {
        let fail = true;
        const page = await openChange("3484", { pictures: () => !fail });
        const chip = page.locator("#snap-list .srow").first().locator(".ph");
        await expect.poll(async () => (await chip.innerText()).replace(/\s+/g, " ")).toBe("Picture failed. Retry");
        fail = false;
        await chip.getByRole("button", { name: "Retry" }).click();
        await expect
            .poll(() => page.locator("#snap-list .srow").first().locator(".pic").getAttribute("class"))
            .toContain("ready");
    });

    it("merges the projects' lists of a change, numbered in order, with each project named", async () => {
        const page = await openChange(TWO);
        await listPick(page, "Project");
        expect(await page.locator("#snap-list .ghead").evaluateAll((n) => n.map((h) => h.title))).toEqual([
            "graphty",
            "graphty-element",
        ]);
        await listPick(page, "None");
        expect((await rowTexts(page)).length).toBe(24);
        expect(await page.locator("#snap-list .srow").nth(1).textContent()).toContain("graphty-element > component-0");
    });

    it("copies a link to the current snapshot from the change's own menu", async () => {
        const page = await openChange("3486");
        await page.locator('#snaps-head [data-act="chgmenu"]').click();
        await menuItem(page, "Copy link to this list").click();
        await expect.poll(() => message(page)).toMatch(/^Link copied/);
        const link = await page.evaluate(() => globalThis.navigator.clipboard.readText());
        expect(link).toContain(`snap=${encodeURIComponent(await current(page))}`);
    });
});

describe("a newer capture", () => {
    it("never changes the rows when a newer run lands; Load it shows it and says how many decisions no longer apply", async () => {
        let since = null;
        const page = await openChange("3486", {
            clock: true,
            // The newer run (4487, attempt 1) holds one snapshot fewer.
            rows: (id, name, q) => {
                const a = rowsAnswer(name, q.get("run") === "4487-1" ? 299 : 300);
                return {
                    ...a,
                    carried: {
                        kept: 41,
                        lost: [
                            { file: "x.png", decision: "accept" },
                            { file: "y.png", decision: "reject" },
                            { file: "z.png", decision: "accept" },
                        ],
                    },
                };
            },
        });
        t.page.on("request", (r) => {
            const u = new URL(r.url());
            if (u.pathname.startsWith("/api/pr/")) {
                since = u.searchParams.get("since") ?? since;
            }
        });
        const before = await rowTexts(page);
        const head = page.locator("#snaps-head > .h2");
        expect(await head.innerText()).toMatch(/^300 left\b/);
        const list = targets();
        const newer = list.find((x) => x.id === "3486");
        newer.runId += 1;
        newer.headSha = "7abc1234ff";
        newer.projects = [project("graphty-element", { reviewable: 299 })];
        t.setList(listAnswer(list));
        await page.clock.fastForward(16000);
        // A chip on line 2, and said once in the message line with its own Load it.
        const chip = page.locator('#snaps-head > .h2 [data-act="stalechip"]');
        await chip.waitFor();
        expect((await chip.innerText()).trim()).toBe("Newer capture");
        await expect
            .poll(() => message(page))
            .toMatch(/^A newer capture of .+ is ready\. Your decisions on unchanged images are kept\.$/);
        expect(await page.locator('#msg-x [data-act="loadnewer"]').innerText()).toBe("Load it");
        expect(await rowTexts(page)).toEqual(before);
        expect(await head.innerText()).toMatch(/^300 left\b/);
        await chip.click();
        expect(await page.locator(".menu").innerText()).toContain(
            "A newer capture (7abc123) is ready. Your decisions on unchanged images are kept.",
        );
        await menuItem(page, "Load it").click();
        await expect
            .poll(() => message(page))
            .toBe(
                "Loaded the capture at 7abc123: 41 decisions kept (their images are unchanged), 3 no longer apply and are undecided again.",
            );
        expect(since).toBe("4486-1");
        await expect.poll(() => head.innerText()).toMatch(/^299 left\b/);
        expect(await chip.count()).toBe(0);
        await currentIsShown(page);
    });
});

describe("the notice chips", () => {
    it("fold Behind master and Newer capture into one 2 notices chip on a tight line 2, its menu holding both", async () => {
        const page = await openChange("3486", { clock: true });
        const list = targets();
        const t3486 = list.find((x) => x.id === "3486");
        t3486.runId += 1;
        t3486.headSha = "7abc1234ff";
        t3486.stale = 5;
        t.setList(listAnswer(list));
        await page.clock.fastForward(16000);
        const chips = page.locator('#snaps-head > .h2 [data-act="stalechip"]');
        await expect.poll(() => chips.count()).toBeGreaterThan(0);
        const names = await chips.evaluateAll((ns) => ns.map((n) => n.getAttribute("aria-label")));
        // Two chips fit only with room to spare for the title; otherwise one.
        expect([["Behind master: 5", "Newer capture"], ["2 notices"]]).toContainEqual(names);
        // Line 2 never wraps, its chips sit wholly in it at its right end, and "N left" stays.
        const h2 = page.locator("#snaps-head > .h2");
        expect((await h2.boundingBox()).height).toBe(24);
        const line = await h2.boundingBox();
        const end = await chips.last().boundingBox();
        expect(end.x + end.width).toBeLessThanOrEqual(line.x + line.width + 0.5);
        expect(line.x + line.width - (end.x + end.width)).toBeLessThan(12);
        expect(await h2.locator(".left").innerText()).toMatch(/ left$/);
        // Line 1 holds only the change's title menu and the fold button.
        expect(
            await page.locator("#snaps-head > .h1 [data-act]").evaluateAll((ns) => ns.map((n) => n.dataset.act)),
        ).toEqual(["chgmenu", "pane2"]);
        await chips.last().click();
        const menu = await page.locator(".menu").innerText();
        if (names.length === 1) {
            expect(menu).toContain("Master accepted 5 newer baselines after this capture.");
        }
        expect(menu).toContain("A newer capture (7abc123) is ready.");
    });
});

describe("the title and the progress line (design 9.4)", () => {
    const LONG = "ci: run the full style fidelity gate in the 6-hour full run, in four slices";
    const withLong = {
        targets: [
            ...targets(),
            target(8002, { title: LONG, projects: [project("graphty-element", { reviewable: 30 })] }),
        ],
    };

    it("wraps a long title to at most two lines, never cutting it to a stub, at 1440 and 1024", async () => {
        for (const width of [1440, 1024]) {
            const page = await openChange("8002", { ...withLong, viewport: { width, height: 800 } });
            // The number and the title are one run of text (.tt), clamped to two lines: the title
            // flows on under the number, so it keeps both lines' width.
            const look = await page.locator("#snaps-head > .h1 .ctl .tt").evaluate((n) => {
                const line = parseFloat(globalThis.getComputedStyle(n).lineHeight);
                const r = n.getBoundingClientRect();
                return {
                    lines: Math.round(r.height / line),
                    width: r.width,
                    text: n.querySelector(".ell").textContent,
                };
            });
            expect(look.text).toBe(LONG);
            expect(look.lines, `${width}`).toBe(2);
            // At least the first five words are drawn: the lines are wide enough for them.
            expect(look.width, `${width}`).toBeGreaterThan(150);
            await t.close();
            t = null;
        }
    });

    it("puts Behind master at line 2's right end, drops accepted earlier first, then shortens the chip, never N left", async () => {
        // The rich change holds 6 of the reader's decisions and 2 snapshots accepted earlier.
        const page = await openChange(RICH, { clock: true, viewport: { width: 1440, height: 900 } });
        const list = targets();
        list.find((x) => x.id === RICH).stale = 1243;
        t.setList(listAnswer(list));
        await page.clock.fastForward(16000);
        await page.locator('#snaps-head > .h2 [data-act="stalechip"]').waitFor();
        const read = () =>
            page.evaluate(() => {
                const h2 = globalThis.document.querySelector("#snaps-head > .h2");
                const chip = h2.querySelector('[data-act="stalechip"]');
                return {
                    left: h2.querySelector(".left").textContent,
                    rest: h2.querySelector(".rest").textContent,
                    chip: chip.querySelector(".cl").textContent,
                    over: h2.scrollWidth > h2.clientWidth + 1,
                };
            });
        // Snapshots widened as a reader's resize would: at its 420 px line 2 is already tight, and
        // the first state has room for everything.
        await page.evaluate(() => {
            globalThis.document.getElementById("snaps").style.width = "700px";
        });
        const states = [];
        for (const px of [600, 420, 330, 290, 250, 200]) {
            await page.evaluate((w) => {
                globalThis.document.querySelector("#snaps-head > .h2").style.maxWidth = `${w}px`;
            }, px);
            // Show set again draws the header again.
            await page.getByRole("button", { name: /^Show:/ }).click();
            await menuItem(page, "Undecided").click();
            await expect.poll(() => read().then((r) => r.over)).toBe(false);
            states.push(await read());
        }
        for (const st of states) {
            expect(st.left).toMatch(/^[\d,]+ left$/);
            // The chip is shortened only once "accepted earlier" is gone.
            if (st.chip.startsWith("Behind:")) {
                expect(st.rest).not.toContain("accepted earlier");
            }
            // "decided" goes only after the chip is short.
            if (!st.rest.includes("decided")) {
                expect(st.chip).toBe("Behind: 1,243");
            }
        }
        expect(states[0]).toMatchObject({ rest: "6 decided, 2 accepted earlier", chip: "Behind master: 1,243" });
        expect(states.some((st) => st.rest === "6 decided" && st.chip === "Behind master: 1,243")).toBe(true);
        expect(states.at(-1).chip).toBe("Behind: 1,243");
    });
});

describe("at 1024 x 768", () => {
    const LAPTOP = { viewport: { width: 1024, height: 768 } };
    // Every visible control outside the scrolled lists (whose rows scroll out of view by design)
    // wholly inside the window.
    const outside = (page) =>
        page.evaluate(() =>
            [...globalThis.document.querySelectorAll("[data-act]")]
                .filter((n) => n.getClientRects().length > 0 && !n.closest(".list, dialog, .menu"))
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

    it("keeps every visible control inside the window with three rows selected, Find keeping its word", async () => {
        const page = await openChange("3486", LAPTOP);
        expect(await outside(page)).toEqual([]);
        expect(await page.locator("#snap-find").getAttribute("data-find")).toBe("Find");
        expect(await page.locator("#snap-find").getAttribute("placeholder")).toBe("Find  /");
        await page.locator("#snap-list").focus();
        await page.keyboard.press("KeyX");
        await page.keyboard.press("Shift+ArrowDown");
        await page.keyboard.press("Shift+ArrowDown");
        await expect.poll(() => page.locator("#snaps-head .lselbar .selcount").innerText()).toBe("3 selected");
        expect(await outside(page)).toEqual([]);
        // The selection bar's menu button says what it is.
        expect((await page.locator('#snaps-head .lselbar [data-act="selmenu"]').innerText()).trim()).toBe("More");
        // Shift+Up and Shift+Down are printed in the List menu, which stays on line 3.
        const keys = JSON.parse(
            await page.locator('#snaps-head > .h3 [data-act="listmenu"]').getAttribute("data-menukeys"),
        );
        expect(keys).toEqual({ "Shift+Up": "extendup", "Shift+Down": "extenddown" });
        expect(t.errors).toEqual([]);
    });

    it("keeps every visible control inside the window with both notice chips", async () => {
        const page = await openChange("3486", { ...LAPTOP, clock: true });
        const list = targets();
        const t3486 = list.find((x) => x.id === "3486");
        t3486.runId += 1;
        t3486.headSha = "7abc1234ff";
        t3486.stale = 1242;
        t.setList(listAnswer(list));
        await page.clock.fastForward(16000);
        await expect.poll(() => page.locator('#snaps-head > .h2 [data-act="stalechip"]').count()).toBeGreaterThan(0);
        expect(await outside(page)).toEqual([]);
        expect((await page.locator("#snaps-head > .h2").boundingBox()).height).toBe(24);
    });

    it("cuts group names at their start, keeping the end, so no two visible headers read the same", async () => {
        const comps = ["high-fidelity-cx-specimens", "high-fidelity-cy-specimens", "high-fidelity-cz-specimens"].map(
            (x) => `graphty-element-very-long-shared-prefix-for-${x}`,
        );
        const page = await openChange("8000", {
            ...LAPTOP,
            targets: [
                ...targets(),
                target(8000, { title: "Long names", projects: [project("graphty-element", { reviewable: 15 })] }),
            ],
            rows: (id, name) =>
                id === "8000"
                    ? {
                          project: name,
                          items: Array.from({ length: 15 }, (_, i) =>
                              row(i, "changed", { component: comps[Math.floor(i / 5)] }),
                          ),
                          decisions: {},
                          clusters: [],
                      }
                    : rows(id, name),
        });
        const names = await page.locator("#snap-list .ghead .gname .gn").allTextContents();
        expect(names).toHaveLength(3);
        expect(new Set(names).size).toBe(3);
        for (const [i, n] of names.entries()) {
            expect(n.startsWith("...") ? comps[i].endsWith(n.slice(3)) : n === comps[i]).toBe(true);
            // The end that tells siblings apart is always whole.
            expect(n.endsWith(comps[i].slice(-"cx-specimens".length))).toBe(true);
        }
        expect(names.some((n) => n.startsWith("..."))).toBe(true);
        // No name is clipped by its box: what the cut leaves is all drawn.
        expect(
            await page
                .locator("#snap-list .ghead .gname .gn")
                .evaluateAll((ns) => ns.filter((n) => n.scrollWidth > n.clientWidth).length),
        ).toBe(0);
        expect(await page.locator("#snap-list .ghead").first().getAttribute("title")).toBe(
            `graphty-element > ${comps[0]}`,
        );
    });

    it("prints a resized row's word after its name, not as a pill, and pills never shrink", async () => {
        const page = await openChange("8001", {
            ...LAPTOP,
            targets: [
                ...targets(),
                target(8001, { title: "Resized", projects: [project("graphty-element", { reviewable: 3 })] }),
            ],
            rows: (id, name) =>
                id === "8001"
                    ? {
                          project: name,
                          items: [0, 1, 2].map((i) => {
                              if (i === 2) {
                                  // Only the size changed: 2 px shorter, its only area the strip.
                                  const areas = { ...row(i, "changed").areas, how: "size", count: 1, shown: 0 };
                                  return row(i, "changed", { size: [800, 598], areas });
                              }
                              return row(i, "changed", i === 1 ? { size: [1000, 760], disagree: true } : {});
                          }),
                          decisions: {},
                          clusters: [],
                      }
                    : rows(id, name),
        });
        const r = page.locator('#snap-list .srow[data-snap$="story-1.dark.png"]');
        expect(await r.locator(".mode").textContent()).toBe(", dark, resized");
        // Its tooltip gives both sizes.
        expect(await r.locator(".mode").getAttribute("title")).toBe("Resized: 800 x 600 to 1,000 x 760");
        expect(await r.locator(".badge").allTextContents()).toEqual(["unstable"]);
        expect(await r.locator(".badge").evaluate((n) => globalThis.getComputedStyle(n).flexShrink)).toBe("0");
        // A size-only change says so in words, and its picture is centered on the image.
        const only = page.locator('#snap-list .srow[data-snap$="story-2.light.png"]');
        expect(await only.locator(".x4 .keep").innerText()).toBe("Only the size changed: 2 px shorter");
        expect(await only.locator(".pic").getAttribute("title")).toBe("Centered: only the size changed");
    });
});

describe("a calmer list pane", () => {
    it("opens the change's own menu from its number and title: the whole title, Open on GitHub as a link, Copy link, the report, then Undo all apart", async () => {
        const page = await openChange("3486");
        const button = page.locator('#snaps-head > .h1 [data-act="chgmenu"]');
        const title = await button.getAttribute("title");
        expect(title).toMatch(/^#3486 /);
        // Its number is never cut, and it carries the group names' drawn caret.
        expect(await button.locator(".cnum").innerText()).toBe("#3486");
        expect(await button.locator(".gcaret").count()).toBe(1);
        await button.click();
        const menu = page.getByRole("menu");
        expect(await menu.locator(".mtitle").innerText()).toBe(title);
        expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual([
            "Open on GitHub",
            "Copy link to this list",
            "Download the comparison report (JUnit)",
            "Undo all decisions...",
        ]);
        // Undo all sits apart, after a separator; Open on GitHub keeps its address for copying.
        expect(await menu.locator('.sep + [data-act="undoall"]').count()).toBe(1);
        const onhost = menu.locator('[data-act="onhost"]');
        expect(await onhost.evaluate((n) => n.tagName)).toBe("A");
        expect(await onhost.getAttribute("href")).toBe("https://gh/pull/3486");
        const [popup] = await Promise.all([page.waitForEvent("popup"), onhost.click()]);
        await popup.waitForLoadState();
        expect(popup.url()).toBe("https://gh/pull/3486");
        await popup.close();
        expect(t.errors).toEqual([]);
    });

    it("keeps the List menu about the list, under 460 px, over the list pane; Accept all shown is the Show menu's last item", async () => {
        const page = await openChange("3486", { viewport: { width: 1440, height: 900 } });
        await listMenu(page);
        const menu = page.getByRole("menu");
        expect(await menu.locator(".mh").allInnerTexts()).toEqual(["Group by: Component", "Pictures", "Select"]);
        for (const gone of ["Accept all", "Undo all", "JUnit", "Copy link"]) {
            expect(await menu.innerText()).not.toContain(gone);
        }
        const m = await menu.boundingBox();
        const pane = await page.locator("#snaps").boundingBox();
        expect(m.height).toBeLessThanOrEqual(460);
        expect(m.x).toBeGreaterThanOrEqual(pane.x);
        expect(m.x + m.width).toBeLessThanOrEqual(pane.x + pane.width);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: /^Show:/ }).click();
        const items = await menu
            .locator(".mi, .sep")
            .evaluateAll((ns) => ns.map((n) => (n.classList.contains("sep") ? "---" : n.textContent.trim())));
        expect(items.at(-2)).toBe("---");
        expect(items.at(-1)).toMatch(/^Accept all \d[\d,]* shown\.\.\.$/);
        await page.keyboard.press("Escape");
    });

    it("prints Up and Down in the text size of Show and List, at their height", async () => {
        const page = await openChange("3486");
        const look = (sel) =>
            page.locator(`#snaps-head > .h3 ${sel}`).evaluate((n) => {
                const k = n.querySelector(":scope > kbd:not([hidden])") ?? n;
                return [globalThis.getComputedStyle(k).fontSize, n.getBoundingClientRect().height];
            });
        const show = await look('[data-act="showmenu"]');
        expect(await look('[data-act="listmenu"]')).toEqual(show);
        expect(await look('[data-act="rowup"]')).toEqual(show);
        expect(await look('[data-act="rowdown"]')).toEqual(show);
    });

    it("draws a notice chip as an outlined menu button with a caret, its words in the ordinary ink", async () => {
        const page = await openChange("3486", { clock: true });
        const list = targets();
        list.find((x) => x.id === "3486").stale = 5;
        t.setList(listAnswer(list));
        await page.clock.fastForward(16000);
        const chip = page.locator('#snaps-head > .h2 [data-act="stalechip"]').first();
        await chip.waitFor();
        const look = await chip.evaluate((n) => ({
            caret: n.querySelectorAll(".gcaret").length,
            ink: globalThis.getComputedStyle(n.querySelector(".cl")).color,
            body: globalThis.getComputedStyle(globalThis.document.body).color,
            border: globalThis.getComputedStyle(n).borderTopStyle,
        }));
        expect(look.caret).toBe(1);
        expect(look.ink).toBe(look.body);
        expect(look.border).toBe("solid");
    });

    it("draws no group Accept N while rows are selected; the name menu still lists it and Shift+A still accepts", async () => {
        const page = await openChange(RICH);
        const accepts = () =>
            page
                .locator("#snap-list .ghead .acc")
                .evaluateAll((ns) => ns.filter((n) => n.getClientRects().length > 0).length);
        expect(await accepts()).toBeGreaterThan(0);
        await page.locator("#snap-list").focus();
        await page.keyboard.press("KeyX");
        await expect.poll(() => page.locator("#snaps-head .lselbar .selcount").count()).toBe(1);
        expect(await accepts()).toBe(0);
        const mine = page.locator("#snap-list .ghead.mine");
        await mine.locator('[data-act="gmenu"]').click();
        const item = page.getByRole("menu").locator('[data-act="gaccept"]');
        expect(await item.innerText()).toMatch(/^Accept \d+\s+Shift\+A$/);
        await page.keyboard.press("Escape");
        await page.locator("#snap-list").focus();
        await page.keyboard.press("Shift+KeyA");
        await expect.poll(() => message(page)).toMatch(/^Accepted /);
    });
});

describe("counted work", () => {
    it("asks for at most 30 pictures for the first screen of 3,000 rows", async () => {
        const page = await openChange(HUGE);
        await currentIsShown(page);
        await expect.poll(() => page.locator("#snap-list .pic.ready").count()).toBeGreaterThan(5);
        const pics = t.requests.filter((p) => p.startsWith("/api/pic/"));
        expect(pics.length).toBeLessThanOrEqual(30);
        expect(new Set(pics).size).toBe(pics.length);
        expect(await page.locator("#snap-list .srow").count()).toBeGreaterThan(100);
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["list.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
