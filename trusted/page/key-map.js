/*
 * The Keys sheet's key map (design 8.1.4), as data: its own module, so a test in Node reads it.
 */

/** The groups of the key map, in the sheet's order: by what the reader is doing. */
export const GROUPS = ["Decide", "Move", "Look", "Panes", "Select"];

/** Every row of the key map: its printed keys, what they do in one short line, the actions they press, and its group. */
export const MAP = [
    ["A", "Accept (or the selection)", ["accept"], "Decide"],
    ["Shift+A", "Accept the current group", ["gaccept"], "Decide"],
    ["R", "Reject...", ["reject"], "Decide"],
    ["E", "Exclude...", ["exclude"], "Decide"],
    ["U", "Undo the last decision", ["undo"], "Decide"],
    ["Left / J", "Previous snapshot", ["prev"], "Move"],
    ["Right / K", "Next snapshot", ["next"], "Move"],
    ["Up / Down", "Previous / next row of the list you are in", ["rowup", "rowdown"], "Move"],
    ["Enter", "Open, or press the button that shows Enter", ["openchg", "openrow", "finishchg"], "Move"],
    ["Esc", "Close or clear; again to go back", ["back", "closebox"], "Move"],
    ["N", "Next area", ["nextarea"], "Move"],
    ["Shift+N", "Next change that needs you", ["nextchange"], "Move"],
    ["/", "Find in the focused pane", ["find"], "Move"],
    ["V", "Side by side", ["view-side"], "Look"],
    ["F", "Flash; from Spotlight, the spotlit pair flashes", ["view-flash"], "Look"],
    ["hold Space", "Flash the current view while held", [], "Look"],
    ["H", "Highlight; again: Side by side", ["view-highlight"], "Look"],
    ["L", "Blink (in Highlight)", ["blink"], "Look"],
    ["S", "Spotlight; again: Side by side", ["view-spotlight"], "Look"],
    ["Z", "Next zoom step: Fit, 1x, 2x, 4x, 8x", ["zoomcycle"], "Look"],
    ["0", "Fit", ["zoom-fit"], "Look"],
    ["1 / 2 / 4 / 8", "Zoom 1x (actual size), 2x, 4x, 8x", ["zoom-1", "zoom-2", "zoom-4", "zoom-8"], "Look"],
    ["P", "Show or hide the baseline", ["baseline"], "Look"],
    ["Y", "Next layout: Auto, side by side, over and under", ["layoutmenu"], "Look"],
    ["B", "Outline changed areas", ["outline"], "Look"],
    ["O", "Start zoomed on the change", ["centerarea"], "Look"],
    ["Shift+1", "Show or hide Changes", ["pane1"], "Panes"],
    ["Shift+2", "Show or hide Snapshots", ["pane2"], "Panes"],
    ["Shift+3", "Image only", ["imageonly"], "Panes"],
    ["?", "This sheet", ["keys"], "Panes"],
    ["X", "Select or unselect the row", ["select"], "Select"],
    ["Shift+Up / Shift+Down", "Extend the selection", ["extendup", "extenddown"], "Select"],
];
