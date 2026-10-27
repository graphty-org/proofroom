/*
 * The Keys sheet [?] (design 8.1.4): the key map, the letter keys switch and the last 20 messages.
 * A key's row is shown only when the action table has an action it presses (its `acts`), so the
 * map never lists a key the page does not have yet; the rows with no `acts` are the key handler's
 * own (the arrows, and holding Space).
 */

import { ACTIONS } from "./actions.js";
import { MAP } from "./key-map.js";
import { history } from "./messages.js";
import { letterSwitch } from "./settings.js";
import { el, kbClass } from "./ui.js";

/**
 * The key map's rows the page has now.
 * @returns {[string, string][]} each row's printed keys and what they do
 */
export const keyMap = () =>
    MAP.filter(([, , acts]) => acts.length === 0 || acts.some((id) => Object.hasOwn(ACTIONS, id))).map(
        ([keys, does]) => [keys, does],
    );

/**
 * Opens the Keys sheet.
 * @param {any} app the page
 */
export function keysSheet(app) {
    const kept = history();
    app.openSheet(
        "keys-sheet",
        "Keys",
        el("p", { class: "small muted" }, "Every key is also printed on its button."),
        el(
            "div",
            { class: "keys" },
            keyMap().flatMap(([keys, does]) => [
                // Classed as every key hint is, so letter keys off hides these too; read aloud, as
                // the map is the sheet's content.
                el(
                    "span",
                    {},
                    keys.split(" / ").map((k) => el("kbd", { class: kbClass(k) }, k)),
                ),
                el("span", {}, does),
            ]),
        ),
        letterSwitch(
            app,
            "Letter, digit and symbol keys on (off: only arrows, Enter, Esc, Tab and Space act, and the key hints are hidden)",
        ),
        el(
            "details",
            {},
            el("summary", { class: "small" }, "The last 20 messages"),
            el(
                "ul",
                { class: "small" },
                kept.map((m) => el("li", { class: m.kind === "err" ? "c-failed" : null }, `${m.at} ${m.text}`)),
            ),
        ),
    );
}
