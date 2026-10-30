/*
 * The new page's level and pane rules (design 2.3 and 2.4), as a table: pure functions of the
 * window width, the open change's snapshot count and the reader's pane choices, before any DOM.
 */

import { describe, expect, it } from "vitest";

import {
    FLOOR,
    imageOnlyPressed,
    keepFloor,
    layoutFor,
    paneWidths,
    pressImageOnly,
    sizeClass,
    togglePane,
    twoLevels,
} from "../../trusted/page/panes.js";

// The viewer's width for a layout: the window less each pane, or its rail.
const viewerWidth = (shown, width, open) =>
    width - paneWidths(shown, { width, open, holds: open }).reduce((a, b) => a + b, 0);

describe("the levels table", () => {
    // [state, level, snapshots, window width, Changes shown, Snapshots shown]
    const TABLE = [
        ["no change open", 0, 0, 1440, true, true],
        ["open, 10 or fewer (one level)", 1, 3, 1440, false, false],
        ["open, 10 or fewer, narrow window (one level)", 1, 10, 1280, false, false],
        ["open, more than 10, window 1400 or wider (one level)", 1, 300, 1440, false, true],
        ["open, more than 10, window under 1400: list level", 1, 300, 1280, false, true],
        ["open, more than 10, window under 1400: viewing", 2, 300, 1280, false, false],
        ["Back to changes, window under 1540", 0, 300, 1440, true, false],
        ["Back to changes, window 1540 or wider", 0, 300, 1540, true, true],
    ];
    it.each(TABLE)("%s", (_, level, count, width, changes, snaps) => {
        const open = level > 0 || count > 0;
        const shown = layoutFor({ level, count, width, open, holds: open });
        expect(shown).toEqual([changes, snaps]);
        if (open) {
            expect(viewerWidth(shown, width, open)).toBeGreaterThanOrEqual(FLOOR);
        }
    });

    it("has a separate viewing level only for more than 10 snapshots in a window under 1400 px", () => {
        expect(twoLevels(10, 1280)).toBe(false);
        expect(twoLevels(11, 1280)).toBe(true);
        expect(twoLevels(11, 1399)).toBe(true);
        expect(twoLevels(11, 1400)).toBe(false);
        expect(twoLevels(3000, 1180)).toBe(true);
    });

    it("remembers choices per size class: 10 or fewer, more than 10", () => {
        expect(sizeClass(10)).toBe("small");
        expect(sizeClass(11)).toBe("large");
    });

    it("applies a remembered choice, within the floor", () => {
        expect(
            layoutFor({ level: 1, count: 3, width: 1440, open: true, holds: true, remembered: [false, true] }),
        ).toEqual([false, true]);
        // Both remembered shown, at 1440: one becomes a rail so the viewer keeps 800 px.
        const both = layoutFor({
            level: 1,
            count: 300,
            width: 1440,
            open: true,
            holds: true,
            remembered: [true, true],
        });
        expect(viewerWidth(both, 1440, true)).toBeGreaterThanOrEqual(FLOOR);
        expect(both).toEqual([false, true]);
    });
});

describe("the 800 px floor", () => {
    it("holds at 1280, 1440 and 1180 in every level and every pane choice", () => {
        for (const width of [1180, 1280, 1440]) {
            for (const level of [0, 1, 2]) {
                for (const count of [3, 300]) {
                    for (const remembered of [null, [true, true], [true, false], [false, true], [false, false]]) {
                        const shown = layoutFor({ level, count, width, open: true, holds: true, remembered });
                        expect(
                            viewerWidth(shown, width, true),
                            `${width} ${level} ${count} ${remembered}`,
                        ).toBeGreaterThanOrEqual(FLOOR);
                    }
                }
            }
        }
    });

    it("narrows a lone pane toward its minimum in a 1180 px window", () => {
        expect(paneWidths([false, true], { width: 1180, open: true, holds: true })).toEqual([44, 336]);
        expect(paneWidths([true, false], { width: 1180, open: true, holds: true })).toEqual([320, 44]);
        expect(paneWidths([false, true], { width: 1280, open: true, holds: true })).toEqual([44, 420]);
        // With no snapshot in the viewer, nothing narrows: Changes is 480 while no change is open.
        expect(paneWidths([true, true], { width: 1180, open: false, holds: false })).toEqual([480, 420]);
    });

    it("does not apply while the viewer holds no snapshot", () => {
        expect(keepFloor([true, true], { width: 1280, open: false, holds: false, prefer: "changes" })).toEqual([
            true,
            true,
        ]);
    });

    it("showing a pane that would break it turns the other into its rail", () => {
        const at = { width: 1440, open: true, holds: true };
        expect(togglePane([false, true], "changes", at)).toMatchObject({ shown: [true, false], moved: true });
        expect(togglePane([true, false], "snaps", at)).toMatchObject({ shown: [false, true], moved: true });
        expect(togglePane([true, true], "snaps", { width: 1600, open: true, holds: true })).toMatchObject({
            shown: [true, false],
            moved: false,
        });
        // Hiding never moves the other.
        expect(togglePane([false, true], "snaps", at)).toMatchObject({ shown: [false, false], moved: false });
    });

    it("takes back a press that moved the other pane when the same pane is pressed again", () => {
        const at = { width: 1440, open: true, holds: true };
        for (const [shown, id] of /** @type {[[boolean, boolean], "changes" | "snaps"][]} */ ([
            [[false, true], "changes"],
            [[true, false], "snaps"],
        ])) {
            const once = togglePane(shown, id, at, null);
            expect(once.moved).toBe(true);
            const twice = togglePane(once.shown, id, at, once.last);
            expect(twice).toMatchObject({ shown, restored: true, last: null });
            expect(viewerWidth(twice.shown, 1440, true)).toBeGreaterThanOrEqual(800);
        }
        // A press that moved nothing keeps nothing: hiding stays a plain hide.
        const plain = togglePane([false, true], "changes", { width: 1600, open: true, holds: true }, null);
        expect(plain.last).toBeNull();
        // Kept from a layout the panes have since left, it takes nothing back.
        const once = togglePane([false, true], "changes", at, null);
        expect(togglePane([false, false], "changes", at, once.last)).toMatchObject({
            shown: [true, false],
            restored: false,
        });
    });
});

describe("Image only", () => {
    it("is pressed whenever both side panes are rails, whatever made them rails", () => {
        expect(imageOnlyPressed([false, false])).toBe(true);
        expect(imageOnlyPressed([false, true])).toBe(false);
    });

    it("never makes the viewer narrower, and brings back what it hid", () => {
        const at = { width: 1440, open: true, holds: true };
        for (const shown of /** @type {[boolean, boolean][]} */ ([
            [false, true],
            [true, false],
        ])) {
            const once = pressImageOnly(shown, null, at);
            expect(once.shown).toEqual([false, false]);
            expect(viewerWidth(once.shown, 1440, true)).toBeGreaterThan(viewerWidth(shown, 1440, true));
            expect(pressImageOnly(once.shown, once.before, at).shown).toEqual(shown);
        }
        // Pressed with nothing it hid (the level made both rails): the list comes back.
        expect(pressImageOnly([false, false], null, at).shown).toEqual([false, true]);
    });
});
