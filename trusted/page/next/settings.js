/*
 * Settings (design 2.2): the passkeys registered for Finish and Register passkey..., letter keys
 * on or off, the Highlight color and the theme. The reader's choices are kept in this browser; the
 * passkeys are the server's (GET /api/passkeys), and registering one goes through today's flow in
 * passkey.js: the challenge is fetched first, so the button that creates the passkey can start
 * Face ID inside its own press, as iPad Safari requires.
 */

import { passkeyName, passkeyWrongHost, prepareRegistration, registerPasskey } from "../passkey.js";
import { control, runAction } from "./actions.js";
import { api } from "./api.js";
import { letterKeysOn, setLetterKeys, syncHints } from "./keys.js";
import { el } from "./ui.js";

const HIGHLIGHT_KEY = "proofroom:highlight";
const THEME_KEY = "proofroom:theme";

/** The Highlight colors, as the changed pixels are painted: red by default (design 5.2). */
export const HIGHLIGHTS = { red: [255, 0, 0], magenta: [255, 0, 255], cyan: [0, 229, 255] };

/** The themes, by the value kept, with their names. */
export const THEMES = { light: "Light", dark: "Dark", system: "Match the system" };

const read = (key) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};
const kept = new Map(); // the choices of this visit, for a browser that keeps none
const choice = (key, all, fallback) => {
    const v = kept.get(key) ?? read(key);
    return v !== null && Object.hasOwn(all, v) ? v : fallback;
};
const keep = (key, value) => {
    kept.set(key, value);
    try {
        localStorage.setItem(key, value);
    } catch {
        // Kept for this visit only.
    }
};

/**
 * The Highlight color chosen.
 * @returns {keyof typeof HIGHLIGHTS} its name
 */
export const highlight = () => /** @type {keyof typeof HIGHLIGHTS} */ (choice(HIGHLIGHT_KEY, HIGHLIGHTS, "red"));

/**
 * The theme chosen.
 * @returns {keyof typeof THEMES} it
 */
export const theme = () => /** @type {keyof typeof THEMES} */ (choice(THEME_KEY, THEMES, "system"));

/** Applies the theme chosen: Light or Dark set on the page, Match the system leaves it to the system. */
export function applyTheme() {
    const t = theme();
    if (t === "system") {
        delete document.documentElement.dataset.theme;
    } else {
        document.documentElement.dataset.theme = t;
    }
}

/**
 * Sets the Highlight color and draws the page again.
 * @param {any} app the page
 * @param {keyof typeof HIGHLIGHTS} color the color
 */
export function setHighlight(app, color) {
    keep(HIGHLIGHT_KEY, color);
    app.draw();
    app.say(`Highlight color: ${color}.`);
}

/**
 * Sets the theme.
 * @param {any} app the page
 * @param {keyof typeof THEMES} t the theme
 */
export function setTheme(app, t) {
    keep(THEME_KEY, t);
    applyTheme();
    app.say(`Theme: ${THEMES[t]}.`);
}

/**
 * Turns letter keys on or off, as the switch pressed now shows.
 * @param {any} app the page
 * @param {boolean} on on
 */
export function setLetters(app, on) {
    setLetterKeys(on);
    syncHints();
    app.say(
        on
            ? "Letter, digit and symbol keys on."
            : "Letter, digit and symbol keys off: only arrows, Enter, Esc, Tab and Space act.",
    );
}

/**
 * The letter keys switch, a checkbox in a label.
 * @param {any} app the page
 * @param {string} text its label
 * @returns {HTMLElement} the label
 */
export function letterSwitch(app, text) {
    return el(
        "label",
        {},
        control(app, "letterkeys", {
            zone: "box",
            tag: "input",
            attrs: { type: "checkbox", checked: letterKeysOn() },
            children: [],
        }),
        ` ${text}`,
    );
}

// A radio button of the action `id`. The arrow keys move the choice within its group too: a
// browser that does not report that as a press still reports the change.
function radio(app, id, { name, value, label, current, ctx }) {
    const input = /** @type {HTMLInputElement} */ (
        control(app, id, {
            zone: "box",
            tag: "input",
            ctx,
            attrs: { type: "radio", name, value, checked: current() === value },
            children: [],
        })
    );
    input.addEventListener("change", () => {
        if (input.checked && current() !== value) {
            runAction(app, id, { ...ctx, el: input }, "key");
        }
    });
    return el("label", {}, input, ` ${label}`);
}

// The browser's refusal of a passkey, said with its likely cause.
const passkeyFailure = (err, keys) =>
    passkeyWrongHost(keys) ?? `Passkey not created: ${err?.message ?? err}. Nothing was changed.`;

let shown = { rpId: "", keys: [] }; // the last GET /api/passkeys answer

// The Passkeys row: each registered key, and Register passkey....
function passkeyRow(app, row) {
    const keys = shown.keys.map((k) =>
        el("div", {}, k.label ?? "passkey", ` (${k.rpId})`, k.pending ? ", waiting for its pull request to merge" : ""),
    );
    row.replaceChildren(
        el("b", {}, "Passkeys"),
        ...(keys.length > 0 ? keys : ["None. "]),
        control(app, "register", { zone: "box", ctx: { row } }),
    );
    app.settle();
}

async function readPasskeys(app, row) {
    try {
        shown = await api("/api/passkeys");
    } catch (err) {
        row.replaceChildren(el("b", {}, "Passkeys"), `Not read: ${err.message}.`);
        return;
    }
    passkeyRow(app, row);
}

/**
 * Register passkey...: the challenge, then the box's own Create the passkey and Cancel.
 * @param {any} app the page
 * @param {HTMLElement} row the Passkeys row
 */
export async function startRegistration(app, row) {
    let prepared;
    try {
        prepared = await prepareRegistration(api);
    } catch (err) {
        app.say(`Passkey not created: ${err.message}`, "err");
        return;
    }
    row.replaceChildren(
        el("b", {}, `Register a passkey for ${prepared.rpId}`),
        el(
            "p",
            { class: "small" },
            "Face ID (or a security key) makes the passkey; then a pull request adds it to " +
                "visual-review/passkeys.json on the default branch. Merge it only if it names the credential " +
                "id this page shows next.",
        ),
        el(
            "div",
            {},
            control(app, "cancelpasskey", { zone: "box", ctx: { row } }),
            " ",
            control(app, "createpasskey", { zone: "box", ctx: { row, prepared }, attrs: { class: "primary" } }),
        ),
    );
    app.settle();
    /** @type {HTMLElement} */ (row.querySelector('[data-act="createpasskey"]')).focus();
}

/**
 * Create the passkey: called straight from its press, so the browser's prompt starts inside it.
 * @param {any} app the page
 * @param {{ row: HTMLElement, prepared: any }} ctx the row and the challenge
 */
export function createPasskey(app, { row, prepared }) {
    const making = registerPasskey(api, prepared, (made) => passkeyName(made.authenticatorAttachment === "platform"));
    app.say("Creating the passkey and opening its pull request...");
    making.then(
        (r) => {
            app.say(
                `Passkey registered (${r.entry.label}), credential id ${r.entry.id}. Opened ${r.pullRequest}: check it ` +
                    (r.gated
                        ? "names this id. A passkey is already on the default branch, so the gate fails that pull request: it takes an administrator's merge."
                        : "names this id, then merge it to make the CI gate require your approval."),
            );
            readPasskeys(app, row);
        },
        (err) => {
            app.say(passkeyFailure(err, shown.keys), "err");
            passkeyRow(app, row);
        },
    );
}

/**
 * Cancel: the Passkeys row as it was, nothing created.
 * @param {any} app the page
 * @param {{ row: HTMLElement }} ctx the row
 */
export function cancelPasskey(app, { row }) {
    passkeyRow(app, row);
    app.say("Passkey not created: nothing was changed.");
}

/**
 * Opens Settings.
 * @param {any} app the page
 */
export function settingsSheet(app) {
    const row = el("div", { class: "q", id: "set-passkeys" }, el("b", {}, "Passkeys"), "Reading...");
    app.openSheet(
        "settings",
        "Settings",
        row,
        el("div", { class: "q" }, el("b", {}, "Keys"), letterSwitch(app, "Letter, digit and symbol keys on")),
        el(
            "div",
            { class: "q" },
            el("b", {}, "Highlight color"),
            Object.keys(HIGHLIGHTS).map((c) =>
                radio(app, "hlcolor", { name: "hlc", value: c, label: c, current: highlight, ctx: { color: c } }),
            ),
        ),
        el(
            "div",
            { class: "q" },
            el("b", {}, "Theme"),
            Object.entries(THEMES).map(([v, l]) =>
                radio(app, "theme", { name: "theme", value: v, label: l, current: theme, ctx: { theme: v } }),
            ),
        ),
    );
    readPasskeys(app, row);
}
