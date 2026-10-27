/*
 * The Keys sheet [?] (design 8.1.4): the key map, the letter keys switch and the last 20 messages.
 * A key's row is shown only when the action table has an action it presses (its `acts`), so the
 * map never lists a key the page does not have yet; the rows with no `acts` are the key handler's
 * own (the arrows, and holding Space).
 */

import { ACTIONS } from "./actions.js";
import { history } from "./messages.js";
import { letterSwitch } from "./settings.js";
import { el } from "./ui.js";

const MAP = [
    ["Left / J", "Previous snapshot", ["prev"]],
    ["Right / K", "Next snapshot", ["next"]],
    ["Up / Down", "Move the current row (in the list: Previous / Next)", []],
    ["Shift+Up / Shift+Down", "Extend the selection", ["extendup", "extenddown"]],
    [
        "Enter",
        "Open the current change or snapshot; the default button of a box or the end card; a button you focused with Tab",
        ["openchg", "openrow"],
    ],
    ["Esc", "Close a menu, box or selection; else what the Back button says", ["back", "closebox"]],
    ["A", "Accept (or the selection)", ["accept"]],
    ["Shift+A", "Accept the current group", ["acceptgroup"]],
    ["R", "Reject...", ["reject"]],
    ["E", "Exclude...", ["exclude"]],
    ["U", "Undo the last decision", ["undo"]],
    ["X", "Select or unselect the row", ["select"]],
    ["V", "Side by side", ["view-side"]],
    ["F", "Flash; again: Side by side (in Spotlight: Spotlight flash)", ["view-flash"]],
    ["hold Space", "Flash the current view while held", []],
    ["H", "Highlight; again: Side by side", ["view-highlight"]],
    ["L", "Blink (in Highlight)", ["blink"]],
    ["S", "Spotlight; again: Side by side", ["view-spotlight"]],
    ["P", "Baseline shown / hidden", ["baseline"]],
    ["Y", "Layout menu", ["layoutmenu"]],
    ["B", "Outline", ["outline"]],
    ["O", "Open centered on the area", ["centerarea"]],
    ["N", "Next area", ["nextarea"]],
    ["0", "Fit", ["zoom-fit"]],
    ["1 / 2 / 4 / 8", "Zoom 1x, 2x, 4x, 8x", ["zoom-1", "zoom-2", "zoom-4", "zoom-8"]],
    ["Z", "Cycle zoom", ["zoomcycle"]],
    ["Shift+1", "Show / hide Changes", ["pane1"]],
    ["Shift+2", "Show / hide Snapshots", ["pane2"]],
    ["Shift+3", "Image only", ["imageonly"]],
    ["Shift+N", "Next change that needs you", ["nextchange"]],
    ["/", "Find in the focused pane", ["find"]],
    ["?", "This sheet", ["keys"]],
];

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
    app.openBox(
        "Keys",
        el("p", { class: "small muted" }, "Every key is also printed on its button."),
        el(
            "div",
            { class: "keys" },
            keyMap().flatMap(([keys, does]) => [
                // The map's own boxes: shown whether letter keys are on or off.
                el(
                    "span",
                    {},
                    keys.split(" / ").map((k) => el("kbd", {}, k)),
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
