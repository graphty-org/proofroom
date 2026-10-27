/*
 * The selection (design 4.6): kept in the page's model by snapshot key, never in the row elements,
 * so a range works across groups and over collapsed sections and survives a filter change. The
 * current snapshot and the selection are different things: the viewer shows the current one, the
 * selection bar acts on the selection, and A, R and E act on the selection only while the current
 * row is in it.
 */

import { layoutOf, markSelected } from "./list.js";

// Every row Show and Find keep, collapsed groups' too, in list order: what a range and Extend walk.
const walk = (app) => layoutOf(app.lv, app.snaps).groups.flatMap((g) => g.rows);

/**
 * Starts an empty selection on the page, and its actions as page methods.
 * @param {any} app the page
 */
export function installSelect(app) {
    app.sel = new Set();
    app.anchor = null; // the row a shift-click range starts from: the last one toggled

    const changed = (keys) => {
        markSelected(app, keys);
        app.draw();
    };
    app.markSel = (keys) => markSelected(app, keys);

    // Whether the current row is in the selection (then A, R and E act on the selection).
    app.curInSel = () => app.snap !== null && app.sel.has(app.snap);

    // The selected snapshots, in list order (every snapshot of the change, shown or not).
    app.selected = () => app.snaps.filter((s) => app.sel.has(s.key));

    // How many selected snapshots Show and Find hide.
    app.selHidden = () => {
        const shown = new Set(walk(app).map((s) => s.key));
        return [...app.sel].filter((k) => !shown.has(k)).length;
    };

    /**
     * Select [X] and a row's checkbox: one row in or out of the selection.
     * @param {string | null} key the row (the current one by default)
     */
    app.toggleSel = (key = app.snap) => {
        if (key === null) {
            app.say("Nothing shown here.");
            return;
        }
        if (app.sel.has(key)) {
            app.sel.delete(key);
        } else {
            app.sel.add(key);
        }
        app.anchor = key;
        changed([key]);
    };

    /**
     * A shift-click on a checkbox: every row from the last one toggled to this one, in list order,
     * across groups and collapsed sections.
     * @param {string} key the row clicked
     */
    app.rangeSel = (key) => {
        const rows = walk(app);
        const a = rows.findIndex((s) => s.key === app.anchor);
        const b = rows.findIndex((s) => s.key === key);
        if (a < 0 || b < 0) {
            app.toggleSel(key);
            return;
        }
        const keys = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.key);
        for (const k of keys) {
            app.sel.add(k);
        }
        app.anchor = key;
        changed(keys);
    };

    /**
     * Shift+Up and Shift+Down (Extend up, Extend down): the selection grows from the current row by
     * one row, and the current row moves with it. The first press also selects the current row.
     * @param {number} d -1 up, 1 down
     */
    app.extendSel = (d) => {
        const rows = walk(app);
        const at = rows.findIndex((s) => s.key === app.snap);
        if (at < 0) {
            app.say("Nothing shown here.");
            return;
        }
        const next = rows[Math.max(0, Math.min(rows.length - 1, at + d))];
        app.sel.add(app.snap);
        app.sel.add(next.key);
        app.anchor = next.key;
        const keys = [app.snap, next.key];
        app.endCard = false;
        app.stepTo(next.key);
        changed(keys);
    };

    /**
     * Selects a list of rows (Select all shown, a group's Select all N).
     * @param {string[]} keys the rows
     */
    app.selectKeys = (keys) => {
        for (const k of keys) {
            app.sel.add(k);
        }
        changed(keys);
    };

    /** Clear [Esc]: the selection emptied. */
    app.clearSel = () => {
        const keys = [...app.sel];
        app.sel.clear();
        app.anchor = null;
        changed(keys);
    };

    // Select all shown (N), from the selection bar's menu: every row Show and Find keep.
    app.selectShown = () => app.selectKeys(walk(app).map((s) => s.key));
}
