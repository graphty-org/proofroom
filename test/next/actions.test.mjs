/*
 * Every action in the new page's action table is pressed by at least one real-input page test
 * (covers.mjs lists them; each page test file checks it pressed its own), and every action with a
 * key prints it: the table is where both the buttons and the key handler come from.
 */

import { describe, expect, it } from "vitest";

import { ACTIONS, ZONES } from "../../trusted/page/next/actions.js";
import { isLetterKey, matches } from "../../trusted/page/next/keys.js";
import { COVERS } from "./covers.mjs";

describe("the action table", () => {
    it("has a real-input test for every action, and lists no action it does not have", () => {
        const covered = new Set(Object.values(COVERS).flat());
        const ids = Object.keys(ACTIONS);
        expect(
            ids.filter((id) => !covered.has(id)),
            "actions no test presses",
        ).toEqual([]);
        expect(
            [...covered].filter((id) => !ids.includes(id)),
            "listed actions the table lacks",
        ).toEqual([]);
    });

    it("gives each key one meaning", () => {
        const byKey = new Map();
        for (const [id, a] of Object.entries(ACTIONS)) {
            if (a.key) {
                byKey.set(a.key, [...(byKey.get(a.key) ?? []), id]);
            }
        }
        // Enter and Esc are each one meaning, carried by whichever control the level shows
        // (Open, Back, a box's default button or Close); the rest are one action each.
        for (const [key, ids] of byKey) {
            if (key !== "Enter" && key !== "Esc") {
                expect(ids, key).toHaveLength(1);
            }
        }
        expect(ZONES[0]).toBe("box");
    });
});

describe("keys", () => {
    const ev = (key, code, shiftKey = false) => ({ key, code, shiftKey });

    it("reads digits by physical key, so AZERTY's Shift+1 is Shift+1 and its 1 is no pane key", () => {
        expect(matches("Shift+1", ev("!", "Digit1", true))).toBe(true); // US
        expect(matches("Shift+1", ev("1", "Digit1", true))).toBe(true); // AZERTY
        expect(matches("Shift+1", ev("&", "Digit1", false))).toBe(false); // AZERTY's unshifted 1
        expect(matches("Shift+2", ev("@", "Numpad2", true))).toBe(true);
    });

    it("reads letters by character, with Shift as printed", () => {
        expect(matches("Shift+N", ev("N", "KeyN", true))).toBe(true);
        expect(matches("Shift+N", ev("n", "KeyN", false))).toBe(false);
        expect(matches("Shift+N", ev("N", "KeySemicolon", true))).toBe(true); // a layout that moves N
        expect(matches("/", ev("/", "Slash"))).toBe(true);
        expect(matches("/", ev("/", "Digit7", true))).toBe(true); // German: Shift+7 types /
        expect(matches("Enter", ev("Enter", "Enter"))).toBe(true);
        expect(matches("Esc", ev("Escape", "Escape"))).toBe(true);
    });

    it("counts letters, digits and symbols as letter keys, and arrows, Enter and Esc not", () => {
        expect(["Shift+1", "Shift+N", "/", "?"].every(isLetterKey)).toBe(true);
        expect(["Enter", "Esc"].some(isLetterKey)).toBe(false);
    });
});
