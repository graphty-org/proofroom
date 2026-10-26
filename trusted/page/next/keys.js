/*
 * The key handler, built from the action table: a key acts only through a visible control that
 * prints it, so every binding has a label by construction. Digits are read by physical key
 * (`event.code`), so Shift+1 works on AZERTY and other layouts; letters by character. When two
 * visible controls carry the same key, the one in the earliest zone (actions.js ZONES) takes it and
 * alone shows its key box. No key acts while a text field, box or menu has focus. Letter keys can
 * be switched off (WCAG 2.1.4): every key made of a letter, digit or symbol then does nothing and
 * its hints are hidden; arrows, Enter, Esc, Tab and Space stay.
 */

import { ZONES, contextOf, runAction } from "./actions.js";

const LETTERS_KEY = "proofroom:letter-keys";
const NONLETTER = new Set(["Enter", "Esc", "Up", "Down", "Left", "Right", "Tab", "Space"]);

/**
 * Whether letter, digit and symbol keys are on (the reader's choice, kept in this browser).
 * @returns {boolean} on
 */
export function letterKeysOn() {
    try {
        return localStorage.getItem(LETTERS_KEY) !== "off";
    } catch {
        return true;
    }
}

/**
 * Whether a key event is the key printed as `printed` ("Shift+1", "Shift+N", "Enter", "Esc", "/").
 * @param {string} printed the printed key
 * @param {{ key: string, code: string, shiftKey: boolean }} e the event
 * @returns {boolean} it is
 */
export function matches(printed, e) {
    if (printed === "Enter" || printed === "Esc") {
        return e.key === (printed === "Esc" ? "Escape" : "Enter") && !e.shiftKey;
    }
    const shifted = printed.startsWith("Shift+");
    const k = shifted ? printed.slice(6) : printed;
    if (/^\d$/.test(k)) {
        // By physical key: on AZERTY Shift+1 types "1" and 1 types "&".
        return (e.code === `Digit${k}` || e.code === `Numpad${k}`) && e.shiftKey === shifted;
    }
    if (/^[A-Z]$/.test(k)) {
        return e.key.toLowerCase() === k.toLowerCase() && e.shiftKey === shifted;
    }
    // A symbol: by the character typed, whatever Shift took to type it.
    return e.key === k;
}

/**
 * Whether a printed key is a letter, digit or symbol key (off while letter keys are off).
 * @param {string} printed the printed key
 * @returns {boolean} it is
 */
export const isLetterKey = (printed) => !NONLETTER.has(printed);

const visible = (node) => node.getClientRects().length > 0;
const rank = (node) => {
    const i = ZONES.indexOf(node.dataset.zone);
    return i < 0 ? ZONES.length : i;
};

/**
 * The control a key acts on now: of the visible controls printing it, the one in the earliest zone.
 * While a menu, box or field holds the page, Back and Open take no key.
 * @param {string} printed the printed key
 * @returns {HTMLElement | null} the control
 */
export function ownerOf(printed) {
    const held = document.body.classList.contains("held");
    let best = null;
    for (const node of document.querySelectorAll("[data-key]")) {
        if (
            node.dataset.key === printed &&
            visible(node) &&
            !(held && ["back", "openrow", "openchg"].includes(node.dataset.act)) &&
            (best === null || rank(node) < rank(best))
        ) {
            best = node;
        }
    }
    return best;
}

/**
 * Shows each key's box only on the control that key acts on now, and hides every letter key hint
 * while letter keys are off; also marks the page "held" while a menu, box or field takes Esc.
 * Run after every redraw.
 */
export function syncHints() {
    const ae = document.activeElement;
    const field = ae?.matches?.("input[type=search], input[type=text], input[type=password]") === true;
    const held = field || document.querySelector(".menu") !== null || document.querySelector("dialog[open]") !== null;
    document.body.classList.toggle("held", held);
    document.body.classList.toggle("nokeys", !letterKeysOn());
    const owners = new Map();
    for (const node of document.querySelectorAll("[data-key]")) {
        const k = node.dataset.key;
        if (!owners.has(k)) {
            owners.set(k, ownerOf(k));
        }
        const mine = owners.get(k) === node;
        for (const box of node.querySelectorAll(":scope > kbd")) {
            box.hidden = !mine;
        }
    }
    // The Find boxes print their key in the placeholder.
    for (const f of document.querySelectorAll("input[data-find]")) {
        f.placeholder = `${f.dataset.find}${letterKeysOn() ? "  [/]" : ""}`;
    }
}

/**
 * Starts the key handler.
 * @param {any} app the page: `arrow(dir)` moves the current row, `escapeField(field)` handles Esc
 *     in a field, `closeMenu()` closes the open menu, `say(text)` writes the message line
 */
export function startKeys(app) {
    document.addEventListener("keydown", (e) => {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) {
            return;
        }
        if (document.querySelector("dialog[open]")) {
            return; // the box's own keys: Esc closes it, Tab moves in it
        }
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.matches?.("input, textarea, select")) {
            if (e.key === "Escape") {
                e.preventDefault();
                app.escapeField(t);
            }
            return;
        }
        if (document.querySelector(".menu")) {
            // The menu's own keys stop at the menu; a key from outside it (focus moved on with
            // Tab) still closes it with Esc, so Esc keeps its order: the menu, then Back.
            if (e.key === "Escape") {
                e.preventDefault();
                app.closeMenu();
            }
            return;
        }
        // A button or link the reader focused with Tab takes Enter, as it shows.
        if (e.key === "Enter" && t.matches?.("button, a")) {
            return;
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            if (!e.shiftKey && app.arrow(e.key === "ArrowUp" ? -1 : 1)) {
                e.preventDefault();
            }
            return;
        }
        for (const printed of new Set([...document.querySelectorAll("[data-key]")].map((n) => n.dataset.key))) {
            if (!matches(printed, e)) {
                continue;
            }
            if (isLetterKey(printed) && !letterKeysOn()) {
                return;
            }
            const node = ownerOf(printed);
            if (!node) {
                continue;
            }
            e.preventDefault();
            runAction(app, node.dataset.act, { ...contextOf(node), el: node }, "key");
            return;
        }
    });
}
