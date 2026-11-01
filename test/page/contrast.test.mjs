/*
 * The contrast of every token pair the new page uses for text, in both themes, read from its
 * stylesheet: 4.5:1 for text (design 13.2). Status colors are for shapes and fills only, so none
 * appears here as a text color.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../trusted/page/page.css", import.meta.url), "utf8");

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

// [text token, background token]: every pair a rule of page.css draws text with.
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
    ["on-ink", "accept"],
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

// One color laid over another at a share, as color-mix(in srgb, a p%, b) and opacity draw it.
const mix = (a, b, p) =>
    `#${[1, 3, 5]
        .map((i) =>
            Math.round(parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p))
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")}`;

describe("text on every tint, and the keys", () => {
    // The share of each tint, read from the rule that draws it.
    const share = (rule, token) => {
        const m = CSS.slice(CSS.indexOf(rule)).match(new RegExp(`color-mix\\(in srgb, var\\(--${token}\\) (\\d+)%`));
        return Number(m[1]) / 100;
    };
    const boxed = Number(CSS.slice(CSS.indexOf("\nkbd {")).match(/opacity:\s*([\d.]+)/)[1]);
    const tints = (t) => ({
        surface: t.surface,
        bg: t.bg,
        rail: t.rail,
        ghead: t.ghead,
        hover: t.hover,
        current: t.sel,
        selected: mix(t.sel, t.surface, share(".srow.selx:not(.cur)", "sel")),
        warn: mix(t.warn, t.surface, share(".warnbox", "warn")),
    });
    for (const [theme, tokens] of [
        ["light", LIGHT],
        ["dark", DARK],
    ]) {
        it.each(Object.keys(tints(tokens)))(`${theme}: ink, muted ink and both keys on %s are 4.5:1 or more`, (k) => {
            const bg = tints(tokens)[k];
            expect(contrast(tokens.ink, bg)).toBeGreaterThanOrEqual(4.5);
            // Muted words and a quiet key (kbd.quiet: --ink-2, no box).
            expect(contrast(tokens["ink-2"], bg)).toBeGreaterThanOrEqual(4.5);
            // A boxed key: the ink at its opacity.
            expect(contrast(mix(tokens.ink, bg, boxed), bg)).toBeGreaterThanOrEqual(4.5);
        });
    }

    it("draws a quiet key in the muted ink, at full strength", () => {
        const rule = CSS.slice(CSS.indexOf("kbd.quiet {"), CSS.indexOf("}", CSS.indexOf("kbd.quiet {")));
        expect(rule).toMatch(/color:\s*var\(--ink-2\)/);
        expect(rule).toMatch(/opacity:\s*1;/);
    });

    it("draws a key on a filled button (a filled view, the primary button, Accept) at full strength", () => {
        const rule = CSS.slice(CSS.indexOf("button.on kbd,"), CSS.indexOf("}", CSS.indexOf("button.on kbd,")));
        expect(rule).toContain("button.primary kbd");
        expect(rule).toContain(".decide .acc kbd");
        expect(rule).toMatch(/opacity:\s*1;/);
        expect(CSS.slice(CSS.indexOf(".decide .acc {"))).toMatch(/^[^}]*color:\s*var\(--on-ink\)/);
    });
});

describe("the row checkbox (non-text, 3:1)", () => {
    // Its border on the current row, in the muted ink; on a selected row, the focus color it is
    // filled with.
    it("draws the current row's checkbox in the muted ink", () => {
        const at = CSS.indexOf(".srow.cur .rcheck span");
        expect(at).toBeGreaterThan(0);
        expect(CSS.slice(at, CSS.indexOf("}", at))).toMatch(/border-color:\s*var\(--ink-2\)/);
    });
    for (const [theme, t] of [
        ["light", LIGHT],
        ["dark", DARK],
    ]) {
        const p = CSS.slice(CSS.indexOf(".srow.selx:not(.cur)")).match(/var\(--sel\) (\d+)%/)[1] / 100;
        const selected = mix(t.sel, t.surface, p);
        it(`${theme}: its border is 3:1 or more on the current and the selected row`, () => {
            expect(contrast(t["ink-2"], t.sel)).toBeGreaterThanOrEqual(3);
            expect(contrast(t["ink-2"], selected)).toBeGreaterThanOrEqual(3);
            expect(contrast(t.focus, t.sel)).toBeGreaterThanOrEqual(3);
            expect(contrast(t.focus, selected)).toBeGreaterThanOrEqual(3);
        });
    }
});
