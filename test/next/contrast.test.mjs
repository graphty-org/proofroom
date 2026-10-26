/*
 * The contrast of every token pair the new page uses for text, in both themes, read from its
 * stylesheet: 4.5:1 for text (design 13.2). Status colors are for shapes and fills only, so none
 * appears here as a text color.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../trusted/page/next/next.css", import.meta.url), "utf8");

// The token values of one block of the stylesheet.
const tokensIn = (block) =>
    Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
const LIGHT = tokensIn(CSS.slice(CSS.indexOf(":root {"), CSS.indexOf("@media")));
const DARK = tokensIn(CSS.slice(CSS.indexOf(':root[data-theme="dark"]')));

const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

// [text token, background token]: every pair a rule of next.css draws text with.
const TEXT_PAIRS = [
    ["ink", "bg"],
    ["ink", "surface"],
    ["ink", "rail"],
    ["ink", "sel"],
    ["ink", "hover"],
    ["ink-2", "surface"],
    ["ink-2", "rail"],
    ["ink-2", "bg"],
    ["ink-2", "sel"],
    ["ink-2", "hover"],
    ["on-ink", "ink"],
    ["on-ink", "focus"],
    ["st-failed", "surface"],
];

describe("text contrast", () => {
    it("reads the same tokens for both themes, and the dark block twice the same", () => {
        expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
        const media = tokensIn(CSS.slice(CSS.indexOf("@media"), CSS.indexOf(':root[data-theme="dark"]')));
        expect(media).toEqual(DARK);
    });

    for (const [theme, tokens] of [
        ["light", LIGHT],
        ["dark", DARK],
    ]) {
        it.each(TEXT_PAIRS)(`${theme}: --%s on --%s is 4.5:1 or more`, (fg, bg) => {
            expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(4.5);
        });
    }

    it("draws no text in a status color other than an error's", () => {
        const colors = [...CSS.matchAll(/(?<![-\w])color:\s*var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
        const status = colors.filter((c) => c.startsWith("st-") && c !== "st-failed");
        // .c-changed and its kin color the marks (SVG in currentColor), never words: each wraps a mark.
        const marks = [...CSS.matchAll(/\.c-[a-z0-9]+\s*\{\s*color:\s*var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
        expect(status.sort()).toEqual(marks.filter((c) => c.startsWith("st-") && c !== "st-failed").sort());
    });
});
