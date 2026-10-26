/*
 * The Review screen's panes and levels. The rules are pure functions of the window width, the
 * open change's snapshot count and the reader's pane choices, so they are tested as a table before
 * any DOM exists; `applyPanes` puts the answer on the page.
 *
 * Levels: 0 the changes, 1 the list (or the one level of a small change), 2 viewing (only in the
 * two-level case). The viewer is never narrower than 800 px while it shows a snapshot.
 */

export const FLOOR = 800;
export const RAIL = 44;
export const SMALL = 10; // a change of this many snapshots or fewer is small
export const ONE_LEVEL_WIDTH = 1400; // a large change in a window this wide or wider has one level

/**
 * A side pane's width when shown.
 * @param {"changes" | "snaps"} id the pane
 * @param {boolean} open whether a change is open (Changes is 480 px while none is)
 * @returns {number} its width in CSS px
 */
export const paneWidth = (id, open) => (id === "changes" ? (open ? 320 : 480) : 420);

/**
 * Whether the open change has a separate viewing level: more than 10 snapshots in a window under
 * 1400 px.
 * @param {number} count the open change's snapshots
 * @param {number} width the window's width
 * @returns {boolean} two levels
 */
export const twoLevels = (count, width) => count > SMALL && width < ONE_LEVEL_WIDTH;

/**
 * The size class choices are remembered under.
 * @param {number} count the open change's snapshots
 * @returns {"small" | "large"} the class
 */
export const sizeClass = (count) => (count <= SMALL ? "small" : "large");

/**
 * The layout a level opens with, before the reader's own choices.
 * @param {number} level 0, 1 or 2
 * @param {number} count the open change's snapshots
 * @returns {[boolean, boolean]} whether Changes and Snapshots are shown
 */
export function defaultPanes(level, count) {
    if (level === 0) {
        return [true, true];
    }
    if (level === 2) {
        return [false, false];
    }
    return [false, count > SMALL];
}

/**
 * Keeps the viewer at 800 px or more while it holds a snapshot: when both side panes would not
 * leave it that, the one not preferred becomes a rail.
 * @param {[boolean, boolean]} shown whether Changes and Snapshots are shown
 * @param {{ width: number, open: boolean, holds: boolean, prefer: "changes" | "snaps" }} at the
 *     window's width, whether a change is open, whether the viewer holds a snapshot, and the pane
 *     to keep
 * @returns {[boolean, boolean]} the panes after the floor
 */
export function keepFloor([changes, snaps], { width, open, holds, prefer }) {
    if (!holds || !changes || !snaps) {
        return [changes, snaps];
    }
    if (width - paneWidth("changes", open) - paneWidth("snaps", open) >= FLOOR) {
        return [changes, snaps];
    }
    return prefer === "changes" ? [true, false] : [false, true];
}

/** The narrowest each side pane gets, as the reader's resizing would stop it. */
export const MIN_WIDTH = { changes: 240, snaps: 320 };

/**
 * The widths of the side panes as shown: each at its own width, or narrower, down to its minimum,
 * where that keeps the viewer at 800 px (a 1180 px window with one pane shown).
 * @param {[boolean, boolean]} shown whether Changes and Snapshots are shown
 * @param {{ width: number, open: boolean, holds: boolean }} at the window and viewer
 * @returns {[number, number]} their widths in CSS px, a rail's for a hidden one
 */
export function paneWidths([changes, snaps], { width, open, holds }) {
    let wc = changes ? paneWidth("changes", open) : RAIL;
    let ws = snaps ? paneWidth("snaps", open) : RAIL;
    let over = holds ? wc + ws + FLOOR - width : 0;
    if (over > 0 && snaps) {
        const cut = Math.min(over, ws - MIN_WIDTH.snaps);
        ws -= cut;
        over -= cut;
    }
    if (over > 0 && changes) {
        wc -= Math.min(over, wc - MIN_WIDTH.changes);
    }
    return [wc, ws];
}

/**
 * The layout of a level: the reader's remembered choice for it (else its default), then the floor.
 * @param {{ level: number, count: number, width: number, open: boolean, holds: boolean,
 *     remembered?: [boolean, boolean] | null, prefer?: "changes" | "snaps" }} at the state
 * @returns {[boolean, boolean]} whether Changes and Snapshots are shown
 */
export function layoutFor({ level, count, width, open, holds, remembered = null, prefer }) {
    const want = remembered ?? defaultPanes(level, count);
    return keepFloor(want, {
        width,
        open,
        holds,
        prefer: prefer ?? (level === 0 ? "changes" : want[1] ? "snaps" : "changes"),
    });
}

/**
 * Showing or hiding one pane: hiding never moves the other; showing one that would break the
 * floor turns the other into its rail.
 * @param {[boolean, boolean]} shown the panes now
 * @param {"changes" | "snaps"} id the pane pressed
 * @param {{ width: number, open: boolean, holds: boolean }} at the window and viewer
 * @returns {{ shown: [boolean, boolean], moved: boolean }} the panes after, and whether the other
 *     pane moved to its rail
 */
export function togglePane(shown, id, at) {
    const i = id === "changes" ? 0 : 1;
    const next = /** @type {[boolean, boolean]} */ ([...shown]);
    next[i] = !next[i];
    const after = next[i] ? keepFloor(next, { ...at, prefer: id }) : next;
    return { shown: after, moved: shown[1 - i] && !after[1 - i] };
}

/**
 * Image only: pressed whenever both side panes are rails, whatever made them rails.
 * @param {[boolean, boolean]} shown the panes
 * @returns {boolean} pressed
 */
export const imageOnlyPressed = ([changes, snaps]) => !changes && !snaps;

/**
 * Pressing Image only: hides both panes (never making the viewer narrower), or, when pressed,
 * brings back the layout it hid (else the list), within the floor.
 * @param {[boolean, boolean]} shown the panes now
 * @param {[boolean, boolean] | null} before the panes it hid, if it did
 * @param {{ width: number, open: boolean, holds: boolean }} at the window and viewer
 * @returns {{ shown: [boolean, boolean], before: [boolean, boolean] | null }} the panes after, and
 *     what to bring back on the next press
 */
export function pressImageOnly(shown, before, at) {
    if (!imageOnlyPressed(shown)) {
        return { shown: [false, false], before: shown };
    }
    return { shown: keepFloor(before ?? [false, true], { ...at, prefer: "snaps" }), before: null };
}

// ---------------------------------------------------------------- on the page

const memKey = (level, count) => `proofroom:panes:review:${level}:${sizeClass(count)}`;

/**
 * The reader's last pane choice for a level and size class, kept in this browser.
 * @param {number} level the level
 * @param {number} count the open change's snapshots
 * @returns {[boolean, boolean] | null} the choice, or null
 */
export function remembered(level, count) {
    try {
        const v = JSON.parse(localStorage.getItem(memKey(level, count)) ?? "null");
        return Array.isArray(v) && v.length === 2 ? /** @type {[boolean, boolean]} */ (v) : null;
    } catch {
        return null; // a private window: the defaults only
    }
}

/**
 * Keeps the reader's pane choice for a level and size class.
 * @param {number} level the level
 * @param {number} count the open change's snapshots
 * @param {[boolean, boolean]} shown the choice
 */
export function remember(level, count, shown) {
    try {
        localStorage.setItem(memKey(level, count), JSON.stringify(shown));
    } catch {
        // Not kept; the defaults apply next time.
    }
}

/**
 * Whether each side pane is shown on the page now.
 * @returns {[boolean, boolean]} Changes, Snapshots
 */
export const shownNow = () => [
    !document.getElementById("changes").classList.contains("rail"),
    !document.getElementById("snaps").classList.contains("rail"),
];

/**
 * Shows the side panes as given, the rest becoming rails, at the widths that keep the viewer at
 * 800 px or more.
 * @param {[boolean, boolean]} shown Changes, Snapshots
 * @param {{ width: number, open: boolean, holds: boolean }} at the window and viewer
 */
export function applyPanes(shown, at) {
    const [wc, ws] = paneWidths(shown, at);
    const c = document.getElementById("changes");
    const sn = document.getElementById("snaps");
    c.classList.toggle("rail", !shown[0]);
    sn.classList.toggle("rail", !shown[1]);
    c.style.width = shown[0] ? `${wc}px` : "";
    sn.style.width = shown[1] ? `${ws}px` : "";
}
