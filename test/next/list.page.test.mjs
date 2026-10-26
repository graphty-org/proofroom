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

import { SHAPES, STATUS, decisionsFor } from "../../trusted/page/next/marks.js";
import { COVERS } from "./covers.mjs";
import { fiftyChanges, listAnswer, message, openNext, project, richRows, row, rowsAnswer, target } from "./page-kit.mjs";

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
const rows = (id, name) => {
    if (id === RICH) {
        return richRows(name);
    }
    const n = targets()
        .find((x) => x.id === id)
        .projects.find((p) => p.project === name).reviewable;
    return rowsAnswer(name, n);
};

// A page with the changes above, the change `id` opened by a click (and, unless `rowsFirst` is
// false, its first row drawn), and the page's errors kept.
async function openChange(id, options = {}) {
    t = await openNext(browser, { targets: targets(), rows, ...options });
    const page = t.page;
    t.errors = [];
    page.on("pageerror", (err) => t.errors.push(err.message));
    await page.locator(`.chg[data-chg="${id}"]`).click();
    await page.locator(".iline").waitFor();
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
    expect(await page.locator(".iline .num").innerText()).toBe(cur.n);
}
// A shape as the page's DOM serializes it, to compare with a mark's innerHTML.
const serialized = (page, shape) =>
    page.evaluate((svg) => {
        const n = globalThis.document.createElementNS("http://www.w3.org/2000/svg", "svg");
        n.innerHTML = svg;
        return n.innerHTML;
    }, shape);
const menuItem = (page, name) => page.getByRole("menu").getByText(name, { exact: true });

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
            expect(head.bottom, "the header ends at most 176 px from the top").toBeLessThanOrEqual(176);
            // Each header line keeps its height: nothing wraps.
            for (const [cls, h] of count <= 10
                ? [
                      ["h1", 28],
                      ["h2", 24],
                      ["h4", 32],
                      ["h5", 31],
                  ]
                : [
                      ["h1", 28],
                      ["h2", 24],
                      ["h3", 24],
                      ["h4", 32],
                      ["h5", 31],
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
            // Every status split entry carries its word.
            // As text: a header off screen is not painted (content-visibility), so innerText skips it.
            for (const entry of await page.locator("#snap-list .ghead .sent").allTextContents()) {
                expect(entry).toMatch(/^[\d,]+ [a-z]/);
            }
            expect(t.errors).toEqual([]);
        });
    }

    it("folds the progress and the summary into one line, and the controls into View options, at 10 or fewer", async () => {
        const page = await openChange("3484");
        expect(await page.locator("#snaps-head > .h3").count()).toBe(0);
        expect(await page.locator("#snaps-head > .h2").innerText()).toMatch(/^0 of 3 decided:/);
        await page.getByRole("button", { name: "View options" }).click();
        const menu = page.getByRole("menu");
        for (const head of ["Show", "Group", "Pictures"]) {
            expect(await menu.locator(".mh", { hasText: head }).count()).toBe(1);
        }
        await menuItem(page, "Status").click();
        await expect.poll(() => page.locator("#snap-list .ghead").count()).toBe(0); // groups of one are no groups
        expect(await message(page)).toBe("Grouped by status.");
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
        await menuItem(page, "All (180)").click();
        await page.locator(WIDGETS).getByRole("button", { name: /^Show all \d+ in this group$/ }).click();
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

describe("Show, Find and the status summary", () => {
    it("filters by Show and by a summary entry, and keeps the current snapshot a drawn row", async () => {
        const page = await openChange("3486");
        await currentIsShown(page);
        expect(await page.getByRole("button", { name: /^Show:/ }).innerText()).toBe("Undecided (300)");
        await page.getByRole("button", { name: /^Show:/ }).click();
        await menuItem(page, "removed (50)").click();
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBe(50);
        await currentIsShown(page);
        expect(await message(page)).toBe("Show: removed.");
        // A click makes a row current.
        const second = page.locator("#snap-list .srow").nth(1);
        await second.click();
        await expect.poll(() => current(page)).toBe(await second.getAttribute("data-snap"));
        await currentIsShown(page);
        // A summary entry sets Show; pressed again, Undecided.
        const failed = page.locator('#snaps-head [data-status="failed"]');
        await failed.click();
        await expect.poll(() => failed.getAttribute("aria-pressed")).toBe("true");
        expect(await page.getByRole("button", { name: /^Show:/ }).innerText()).toBe("failed (50)");
        await currentIsShown(page);
        await failed.click();
        await expect.poll(() => page.getByRole("button", { name: /^Show:/ }).innerText()).toBe("Undecided (300)");
        await currentIsShown(page);
    });

    it("folds the status entries that do not fit into +N more, never failed, new or removed", async () => {
        const page = await openChange(RICH, { viewport: { width: 1280, height: 800 } });
        const more = page.locator("#snaps-head [data-more]");
        await more.waitFor();
        for (const st of ["failed", "new", "removed"]) {
            expect(await page.locator(`#snaps-head > .h3 [data-status="${st}"]`).count(), st).toBe(1);
        }
        await more.click();
        const items = await page.getByRole("menu").locator(".mi").allInnerTexts();
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((x) => /moved|no baseline yet|changed/.test(x))).toBe(true);
        await page.getByRole("menu").locator(".mi").first().click();
        await currentIsShown(page);
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
        expect(await find.getAttribute("placeholder")).toBe("Find a story, or jump to a number  [/]");
        // Text filters across every group; the big group, collapsed, opens while Find holds text.
        await page.keyboard.type("story-1");
        await expect.poll(() => page.locator("#snaps-head > .h2").innerText()).toMatch(/\d+ of 180 shown/);
        expect(await big.getAttribute("aria-expanded")).toBe("true");
        expect((await rowTexts(page)).length).toBeGreaterThan(5);
        await currentIsShown(page);
        // Esc: the first clears and stays; the second leaves for the list. The level never changes.
        await page.keyboard.press("Escape");
        expect(await find.inputValue()).toBe("");
        expect(await page.evaluate(() => globalThis.document.activeElement?.id)).toBe("snap-find");
        await page.keyboard.press("Escape");
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("snap-list");
        expect(await page.locator('.iline [data-act="back"]').innerText()).toBe("Back to changesEsc");
        expect(await big.getAttribute("aria-expanded")).toBe("false");
        await currentIsShown(page);
        // No match: the list and the message line say so, with Clear.
        await find.click();
        await page.keyboard.type("zzzz");
        await expect.poll(() => message(page)).toBe('No story matches "zzzz".');
        expect(await page.locator("#snap-list").innerText()).toContain('No story matches "zzzz".');
        expect(await page.locator(".emptyv").innerText()).toBe("Nothing shown here.");
        await page.locator("#find-clear").click();
        await expect.poll(() => find.inputValue()).toBe("");
        await currentIsShown(page);
        // Clear in the list says the same.
        await page.keyboard.type("zzzz");
        await page.locator("#snap-list").getByRole("button", { name: "Clear" }).click();
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBeGreaterThan(0);
        await currentIsShown(page);
        // A number is a jump: no "N of M shown", the row (in the collapsed group) current at once,
        // Enter opens it and empties the box.
        await find.click();
        await page.keyboard.type("#47");
        await expect.poll(() => page.locator(".iline .num").innerText()).toBe("#47");
        expect(await page.locator("#snaps-head > .h2").innerText()).not.toContain("shown");
        expect(await big.getAttribute("aria-expanded")).toBe("true");
        await currentIsShown(page);
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Opened #47.");
        expect(await find.inputValue()).toBe("");
        await expect.poll(() => page.locator(".iline").innerText()).toContain("Back to list");
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
        expect(await message(page)).toBe("Show: All.");
    });
});

describe("groups", () => {
    it("draws each of the five groupings, Identical change and Look alike labeled apart", async () => {
        const page = await openChange(RICH);
        const heads = () => page.locator("#snap-list .ghead").evaluateAll((n) => n.map((h) => h.getAttribute("title")));
        const pick = async (label) => {
            await page.getByRole("button", { name: /^Group:/ }).click();
            await menuItem(page, label).click();
            await expect.poll(() => page.getByRole("button", { name: /^Group:/ }).innerText()).toBe(label);
            await currentIsShown(page);
        };
        // Component, the default above 10; Approved before first, collapsed, with no row.
        let h = await heads();
        expect(h[0]).toBe("Approved before");
        expect(h).toContain("graphty-element > widgets");
        expect(await page.locator('.ghead[data-group="!before"]').innerText()).toMatch(
            /Approved before\s*2\s*\(already accepted\)/,
        );
        expect(await page.locator('.grp[data-group="!before"] .srow').count()).toBe(0);
        await pick("Same change");
        h = await heads();
        expect(h.slice(0, 2)).toEqual(["Approved before", "Identical change"]);
        expect(h).toContain("Look alike: small changes, top left, 5,428 to 6,538 px");
        expect(h.at(-1)).toBe("Different from the rest");
        const look = page.locator('.grp[data-group^="l:"] .srow');
        // The representative, the most changed pixels of the six, first.
        expect(await look.count()).toBeGreaterThan(1);
        await pick("Project");
        expect(await heads()).toEqual(["Approved before", "graphty-element"]);
        await pick("Status");
        h = await heads();
        expect(h.slice(1)).toEqual([
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
        // Identical changes carry "same as N others" in every grouping but Same change.
        await pick("Component");
        // The badge, or the "+N" chip it folds into when it does not fit, whose tooltip names it.
        const same = await page
            .locator("#snap-list .badge")
            .evaluateAll((n) => n.filter((b) => `${b.textContent} ${b.title}`.includes("same as 7 others")).length);
        expect(same).toBe(8);
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
        // The Approved before line opens by its Show.
        await p2.locator('.ghead[data-group="!before"]').getByRole("button", { name: "Show" }).click();
        await expect.poll(() => p2.locator('.grp[data-group="!before"] .srow').count()).toBe(2);
        expect(await p2.locator('.grp[data-group="!before"] .srow').first().innerText()).toContain(
            "Accepted (approved before #1356)",
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

    it("asks for the picture the Row pictures choices name, with its corner tags", async () => {
        const page = await openChange(RICH);
        // A changed row: spotlit, zoom auto, so the server's auto picture.
        const r = page.locator('#snap-list .srow[data-snap="graphty-element/component-22--story-114.light.png"]');
        await page.locator("#snap-find").click();
        await page.keyboard.type("115");
        await r.waitFor();
        await expect.poll(() => r.locator("img").getAttribute("src")).toMatch(/-auto$/);
        expect(await page.getByRole("button", { name: /^Pictures:/ }).innerText()).toBe("Spotlit, zoom auto");
        await expect.poll(() => r.locator(".ztag").allInnerTexts()).toEqual(["zoomed 7x", "+2 areas"]);
        // A choice: the row asks for its picture of that kind (the request is made).
        const pics = async (label, kind) => {
            const from = t.requests.length;
            await page.getByRole("button", { name: /^Pictures:/ }).click();
            await menuItem(page, label).click();
            await expect.poll(() => asked(t, from)).toContain(kind);
            expect(await r.locator("img").getAttribute("src")).toMatch(new RegExp(`-${kind}$`));
        };
        await pics("Always", "row-spot");
        await expect.poll(() => r.locator(".ztag").allInnerTexts()).toEqual(["zoomed 7x", "+2 areas"]);
        await pics("Never", "spot");
        expect(await r.locator(".ztag").count()).toBe(0);
        expect(await page.getByRole("button", { name: /^Pictures:/ }).innerText()).toBe("Not zoomed"); // "Spotlit, zoom never" does not fit
        await pics("Spotlight rows (switch)", "plain");
        await pics("Always", "row-plain");
        await expect.poll(() => r.locator(".ztag").allInnerTexts()).toEqual(["zoomed 7x", "+2 areas"]);
        // No pictures: 28 px text rows that ask for none.
        const from = t.requests.length;
        await page.getByRole("button", { name: /^Pictures:/ }).click();
        await menuItem(page, "No pictures (text rows)").click();
        await expect.poll(() => page.locator("#snap-list .srow img").count()).toBe(0);
        expect((await box(page, "#snap-list .srow")).height).toBe(28);
        expect(asked(t, from)).toEqual([]);
        expect(await page.getByRole("button", { name: /^Pictures:/ }).innerText()).toBe("No pictures");
    });

    it("says what a row's decision is, and Undo changes exactly that row element", async () => {
        const page = await openChange(RICH);
        await page.getByRole("button", { name: /^Show:/ }).click();
        await menuItem(page, "All (180)").click();
        await page.locator(WIDGETS).getByRole("button", { name: /^Show all \d+ in this group$/ }).click();
        await expect.poll(() => page.locator("#snap-list .srow").count()).toBeGreaterThan(100);
        // textContent: rows off screen are not rendered (content-visibility), so innerText skips them.
        const text = await page.locator("#snap-list").textContent();
        for (const words of [
            "Accepted",
            "Accepted (not opened)",
            "Accepted (approved before #1356)",
            "Rejected: Legend overlaps the minimap at the right edge",
            "Rejected before (#5000): The label wraps under the icon",
            "Excluded: Animated: never stable",
            "Finished: it is on the branch",
            "re-review",
            "size changed",
            "image identical",
        ]) {
            expect(text, words).toContain(words);
        }
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
        await expect.poll(() => message(page)).toMatch(/^Undone: the reject of #\d+\.$/);
        const changedRows = await page.evaluate(() => globalThis.changedRows);
        expect(changedRows).toEqual([key, key]); // one row element out, its replacement in
        expect(await page.locator(`#snap-list .srow[data-snap="${key}"]`).getAttribute("class")).not.toContain(
            "decided",
        );
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
        await page.getByRole("button", { name: /^Group:/ }).click();
        await menuItem(page, "Project").click();
        expect(await page.locator("#snap-list .ghead").evaluateAll((n) => n.map((h) => h.title))).toEqual([
            "graphty",
            "graphty-element",
        ]);
        await page.getByRole("button", { name: /^Group:/ }).click();
        await menuItem(page, "None").click();
        expect((await rowTexts(page)).length).toBe(24);
        expect(await page.locator("#snap-list .srow").nth(1).textContent()).toContain("graphty-element > component-0");
    });

    it("copies a link to the current snapshot from the list menu", async () => {
        const page = await openChange("3486");
        await page.getByRole("button", { name: "...", exact: true }).first().click();
        await menuItem(page, "Copy link").click();
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
            rows: (id, name) => {
                const a = rowsAnswer(name, 300);
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
        const list = targets();
        const newer = list.find((x) => x.id === "3486");
        newer.runId += 1;
        newer.headSha = "7abc1234ff";
        newer.projects = [project("graphty-element", { reviewable: 299 })];
        t.setList(listAnswer(list));
        await page.clock.fastForward(16000);
        await page.locator("#snap-banner").waitFor();
        expect(await page.locator("#snap-banner").innerText()).toContain(
            "A newer capture of this change is ready (7abc123).",
        );
        expect(await rowTexts(page)).toEqual(before);
        await page.getByRole("button", { name: "Load it" }).click();
        await expect
            .poll(() => message(page))
            .toBe(
                "Loaded the capture at 7abc123: 41 decisions kept (their images are unchanged), 3 no longer apply and are undecided again.",
            );
        expect(since).toBe("4486-1");
        expect(await page.locator("#snap-banner").isVisible()).toBe(false);
        await currentIsShown(page);
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
