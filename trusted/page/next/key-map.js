/*
 * The Keys sheet's key map (design 8.1.4), as data: its own module, so a test in Node reads it.
 */

/** Every row of the key map: its printed keys, what they do, and the actions they press. */
export const MAP = [
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
