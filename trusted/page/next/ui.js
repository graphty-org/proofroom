/*
 * Small DOM helpers the new page's modules share: el() (as today's page has it), the 12 px marks,
 * key hint boxes, and number and age formatting. Text from a pull request is always set as text.
 */

/**
 * An element with attributes and children; `on<event>` attributes become listeners, and a null,
 * undefined or false child or attribute is left out.
 * @param {string} tag the tag
 * @param {Record<string, any>} [attrs] its attributes
 * @param {...any} children its children (nodes or text)
 * @returns {HTMLElement} the element
 */
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("on")) {
            node.addEventListener(key.slice(2), value);
        } else if (value !== false && value !== null && value !== undefined) {
            node.setAttribute(key, value === true ? "" : value);
        }
    }
    node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return node;
}

// One silhouette per meaning, 12 px, drawn in currentColor.
const MARKS = {
    changed: '<path d="M6 .8 11.2 6 6 11.2.8 6Z" fill="currentColor"/>',
    moved: '<path d="M6 1.3 10.7 6 6 10.7 1.3 6Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="6" r="1.6" fill="currentColor"/>',
    new: '<circle cx="6" cy="6" r="5.5" fill="currentColor"/><path d="M6 3v6M3 6h6" stroke="#fff" stroke-width="1.6"/>',
    unseeded:
        '<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.6"/><path d="M6 3.4v5.2M3.4 6h5.2" stroke="currentColor" stroke-width="1.5"/>',
    removed:
        '<rect x=".7" y=".7" width="10.6" height="10.6" rx="2.6" fill="currentColor"/><path d="M3 6h6" stroke="#fff" stroke-width="1.8"/>',
    failed: '<path d="M6 .8 11.5 10.8H.5Z" fill="currentColor"/><path d="M6 4.2v3.4" stroke="#fff" stroke-width="1.4"/><circle cx="6" cy="9.1" r=".8" fill="#fff"/>',
    wavy: '<path d="M.8 7c1.3-3 2.7-3 4 0s2.7 3 4 0 1.8-2.4 2.4-2.4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    accept: '<path d="M1.8 6.3 4.7 9.1 10.3 3" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    open: '<circle cx="6" cy="6" r="4.8" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    half: '<circle cx="6" cy="6" r="4.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 1.2a4.8 4.8 0 0 1 0 9.6Z" fill="currentColor"/>',
    full: '<circle cx="6" cy="6" r="5.3" fill="currentColor"/>',
    eye: '<path d="M.6 6C2 3.3 3.8 2.2 6 2.2S10 3.3 11.4 6C10 8.7 8.2 9.8 6 9.8S2 8.7.6 6Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6" r="1.8" fill="currentColor"/>',
    spin: '<circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="20 9"/>',
    down: '<path d="M6 1.2v6.6M3 5.3 6 8.3 9 5.3M1.8 10.6h8.4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    clock: '<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 3v3.3l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.3"/>',
    offline:
        '<path d="M1 4.5a7.5 7.5 0 0 1 10 0M2.8 6.6a5 5 0 0 1 6.4 0M4.6 8.6a2.4 2.4 0 0 1 2.8 0" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 1.5l9 9" stroke="currentColor" stroke-width="1.4"/>',
    chevOpen: '<path d="M2.5 4.2 6 7.8 9.5 4.2" fill="none" stroke="currentColor" stroke-width="1.7"/>',
    chevClosed: '<path d="M4.2 2.5 7.8 6 4.2 9.5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
};

/**
 * A mark, as an inline SVG in a span.
 * @param {keyof typeof MARKS} name the mark
 * @param {string} [cls] classes for its color
 * @returns {HTMLElement} the mark
 */
export function ic(name, cls = "") {
    const span = el("span", { class: `ic ${name === "spin" ? "spin" : ""} ${cls}`, "aria-hidden": "true" });
    // The markup is this module's own constants, never text from a pull request.
    span.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12">${MARKS[name]}</svg>`;
    return span;
}

// Keys that are not letters, digits or symbols: they stay when letter keys are off.
const NONLETTER = /^(Left|Right|Up|Down|Enter|Esc|Tab|Space|hold Space|Shift\+Up|Shift\+Down)$/;

/**
 * The key hint boxes for a key's printed name ("Shift+1", "Enter", "Left / J"): a box per key,
 * with class `lk` on a letter, digit or symbol key (hidden while letter keys are off) and `ek` on
 * Enter (hidden while a focused button takes Enter).
 * @param {string} keys the printed keys, " / " between two
 * @returns {HTMLElement[]} the boxes
 */
export const kb = (keys) =>
    keys
        .split(" / ")
        .map((k) =>
            el("kbd", { class: NONLETTER.test(k) ? (k === "Enter" ? "ek" : null) : "lk", "aria-hidden": "true" }, k),
        );

/**
 * A number with thousands separators.
 * @param {number} n the number
 * @returns {string} the text
 */
export const fmt = (n) => Number(n).toLocaleString("en-US");

/**
 * How long ago, in minutes under an hour, then hours, then days.
 * @param {number} ms milliseconds since
 * @returns {string} "4 min ago", "6 h ago", "3 d ago"
 */
export function ageText(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
}

/**
 * Megabytes, one decimal under 10 MB.
 * @param {number} b bytes
 * @returns {string} "6.8 MB", "68 MB"
 */
export const megabytes = (b) => `${b < 1e7 ? (b / 1e6).toFixed(1) : Math.round(b / 1e6)} MB`;
