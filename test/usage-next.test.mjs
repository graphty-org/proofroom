/*
 * The `usage` command reads both pages' events: today's page names a press by its control
 * ("press", keys as "key-J"), the new page by its action id ("action", by pointer or by key), so
 * the summary counts both, and a control the new page showed is "never used" only when no press
 * of its action came by either way.
 */

import { describe, expect, it } from "vitest";

import { formatUsage, summarize } from "../trusted/lib/usage.mjs";

const at = (n) => 1_700_000_000_000 + n * 1000;

describe("usage: old and new event names", () => {
    const events = [
        { type: "load", at: at(0), s: "old", w: 1440, h: 900, dpr: 2 },
        { type: "controls", at: at(1), s: "old", c: ["Accept", "Reject"] },
        { type: "press", at: at(2), s: "old", c: "Accept" },
        { type: "press", at: at(3), s: "old", c: "key-J" },
        { type: "load", at: at(10), s: "new", w: 1440, h: 900, dpr: 2, page: "next" },
        { type: "controls", at: at(11), s: "new", c: ["openchg", "nextchange", "pane1", "rowmenu"] },
        { type: "action", at: at(12), s: "new", a: "openchg", via: "pointer" },
        { type: "action", at: at(13), s: "new", a: "openchg", via: "key" },
        { type: "action", at: at(14), s: "new", a: "pane1", via: "key" },
        { type: "action", at: at(15), s: "new", a: "nextchange", via: "pointer" },
    ];

    it("counts presses of both pages, by control and by key", () => {
        const s = summarize(events);
        expect(s.controls.pressed).toEqual([
            { name: "Accept", n: 1 },
            { name: "nextchange", n: 1 },
            { name: "openchg", n: 1 },
        ]);
        expect(s.controls.keys).toEqual([
            { name: "key-J", n: 1 },
            { name: "key-openchg", n: 1 },
            { name: "key-pane1", n: 1 },
        ]);
        expect(s.sessions.n).toBe(2);
    });

    it("calls a control never used only when no press of it came, by pointer or by key", () => {
        // pane1 was pressed only by key; rowmenu and Reject never.
        expect(summarize(events).controls.neverUsed).toEqual(["Reject", "rowmenu"]);
        expect(formatUsage(summarize(events))).toContain("Controls shown but never used: Reject, rowmenu");
    });

    it("leaves out an action event without an action id", () => {
        const s = summarize([{ type: "action", at: at(1), s: "x", via: "key" }]);
        expect(s.controls.pressed).toEqual([]);
        expect(s.controls.keys).toEqual([]);
    });
});
