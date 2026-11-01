/*
 * The Keys sheet [?] (design 8.1.4): the key map grouped by task (Decide, Move, Look, Panes,
 * Select), one short line a key, and the single-letter keys switch. A key's row is shown only when
 * the action table has an action it presses (its `acts`), so the map never lists a key the page
 * does not have yet; the rows with no `acts` are the key handler's own (holding Space). The
 * message history is behind the message line's Messages button, not here.
 */

import { ACTIONS } from "./actions.js";
import { GROUPS, MAP } from "./key-map.js";
import { letterSwitch } from "./settings.js";
import { el, kbClass } from "./ui.js";

/**
 * The key map's rows the page has now.
 * @returns {[string, string, string][]} each row's printed keys, what they do, and its group
 */
export const keyMap = () =>
    MAP.filter(([, , acts]) => acts.length === 0 || acts.some((id) => Object.hasOwn(ACTIONS, id))).map(
        ([keys, does, , group]) => [keys, does, group],
    );

/**
 * Opens the Keys sheet.
 * @param {any} app the page
 */
export function keysSheet(app) {
    const rows = keyMap();
    app.openSheet(
        "keys-sheet",
        "Keys",
        el("p", { class: "small muted" }, "Every key is also printed on its button."),
        ...GROUPS.flatMap((g) => [
            el("h4", { class: "kgroup" }, g),
            el(
                "div",
                { class: "keys" },
                rows
                    .filter(([, , group]) => group === g)
                    .flatMap(([keys, does]) => [
                        // Classed as every key hint is, so letter keys off hides these too; read
                        // aloud, as the map is the sheet's content.
                        el(
                            "span",
                            {},
                            keys.split(" / ").map((k) => el("kbd", { class: kbClass(k) }, k)),
                        ),
                        el("span", {}, does),
                    ]),
            ),
        ]),
        letterSwitch(app, "Single-letter keys"),
        el("p", { class: "small muted" }, "Off: only arrows, Enter, Esc, Tab and Space work."),
    );
}
