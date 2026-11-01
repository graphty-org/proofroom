/*
 * The snapshot list (design section 4): the three header lines, the groups with their sticky
 * headers, and the rows with their pictures, marks, badges and decisions. The rows are real elements with `content-visibility: auto` and a fixed intrinsic size,
 * and their pictures load lazily from the server's content-addressed picture names, one request per
 * row. The list is built again only when what it shows changes (Show, Group, Pictures, Find, a
 * group opened or closed, a newer capture loaded); moving the current row moves one class, and a
 * decision replaces its one row element in place.
 *
 * The model (`snapsOf`, `layoutOf`, `pictureKind`) is pure; the rest builds the pane from it.
 */

import { control, rowButtons } from "./actions.js";
import { filterOf, jumpOf } from "./find.js";
import { wordsOf } from "./messages.js";
import {
    BEFORE,
    BIG,
    GROUPINGS,
    collapsedAtStart,
    componentOf,
    groupsOf,
    lookAlikeName,
    pairCounts,
    pairOf,
    splitOf,
    splitWords,
    storyOf,
    undecided,
} from "./groups.js";
import { DECISION, ORDER, STATUS, mark } from "./marks.js";
import { el, fmt, fmtShort, ic, kb } from "./ui.js";

const $ = (id) => document.getElementById(id);
const PICTURES_KEY = "proofroom:pictures";

/**
 * The Show menu's choices after Undecided and All: each status, then what was accepted before this
 * capture, then each decision (Accepted is the reader's own, never the carry-over).
 */
export const SHOWS = [
    ["undecided", "Undecided"],
    ["all", "All"],
    ...ORDER.map((s) => [s, STATUS[s].word.charAt(0).toUpperCase() + STATUS[s].word.slice(1)]),
    ["before", "Accepted earlier"],
    ["accept", "Accepted"],
    ["reject", "Rejected"],
    ["exclude", "Excluded"],
];
export const SHOW_LABEL = Object.fromEntries(SHOWS);

/** The row picture choices besides Text only: a crop onto the change, or the whole image. */
export const ZOOMS = {
    crop: "Crop to the change",
    whole: "Whole image",
};
// The choices of an older page: When small and Always both became the crop, Never the whole image.
const OLD_ZOOMS = { auto: "crop", always: "crop", never: "whole" };

// ---------------------------------------------------------------- the model

/**
 * The open change's snapshots, from each project's GET /api/pr answer (`rows=1`), numbered in the
 * order the server lists them (their place under All).
 * @param {{ project: string, items: object[], decisions: Record<string, any>, clusters?: object[] }[]} answers
 *     each project's answer, in project order
 * @param {string[]} reviewable the statuses the list shows
 * @returns {{ snaps: object[], clusters: Map<string, { name: string, representative: string }> }}
 *     the snapshots, and the look-alike clusters by id
 */
export function snapsOf(answers, reviewable) {
    const snaps = [];
    const clusters = new Map();
    for (const a of answers) {
        const look = new Map();
        (a.clusters ?? []).forEach((c, i) => {
            const id = `${a.project}:${i}`;
            clusters.set(id, { name: lookAlikeName(c), representative: c.representative });
            for (const f of c.files) {
                look.set(f, id);
            }
        });
        for (const i of a.items.filter((x) => reviewable.includes(x.status))) {
            snaps.push({
                key: `${a.project}/${i.file}`,
                project: a.project,
                file: i.file,
                id: String(i.id),
                name: storyOf(i.id),
                component: componentOf(i.id),
                mode: i.mode ?? null,
                status: i.status,
                from: i.from ?? null,
                baseline: i.baseline ?? null,
                capture: i.capture ?? null,
                size: i.size ?? null,
                baselineSize: i.baselineSize ?? null,
                changedPixels: i.changedPixels ?? null,
                reReview: i.reReview === true,
                pic: i.pic ?? null,
                areas: i.areas ?? null,
                reason: i.reason ?? null,
                // The capture's scale (CSS pixels per image pixel), for the viewer's real size.
                scale: a.results?.scale ?? 1,
                renderer: a.results?.renderer ?? null,
                baselineRenderer: a.results?.baselineRenderer ?? null,
                disagree: i.disagree === true,
                look: look.get(i.file) ?? null,
                decision: null,
                before: false,
            });
            setDecision(snaps.at(-1), a.decisions?.[i.file] ?? null);
            snaps.at(-1).beforeGroup = snaps.at(-1).before;
        }
    }
    snaps.forEach((s, i) => {
        s.n = i + 1;
    });
    return { snaps, clusters };
}

/**
 * Sets a snapshot's decision, as the server gave it (or null), with what it means: approved before,
 * rejected before (an earlier Finish's reject still waiting for a fix), finished (an earlier
 * Finish's accept or exclusion, on the branch).
 * @param {any} s the snapshot
 * @param {{ decision: string, reason?: string | null, bulk?: boolean, posted?: boolean,
 *     approvedBefore?: { pr: number | null } } | null} d the decision
 */
export function setDecision(s, d) {
    rowsVersion++;
    s.decision = d;
    s.before = Boolean(d?.approvedBefore);
    s.rejectedBefore = d?.posted === true && d.decision === "reject";
    s.finished = d?.posted === true && d.decision !== "reject";
}

/**
 * Whether Show keeps a snapshot. Undecided also keeps the rows that arrive decided from an earlier
 * review (approved before, in its own collapsed group; rejected before, in place) and every row
 * decided since the change was opened (`keep`), so deciding never hides the row.
 * @param {any} s the snapshot
 * @param {string} show the Show choice
 * @param {Set<string>} keep the rows kept shown
 * @returns {boolean} shown
 */
export function shownBy(s, show, keep) {
    if (show === "all" || keep.has(s.key)) {
        return true;
    }
    if (show === "undecided") {
        return !s.decision || s.before || s.rejectedBefore;
    }
    if (show === "before") {
        return s.before;
    }
    if (show === "accept" && s.before) {
        return false;
    }
    return STATUS[show] ? s.status === show : s.decision?.decision === show;
}

/**
 * How many snapshots each Show choice holds (the menu's counts): a status the change does not have
 * is not offered (it can never gain one); every other choice is, a count of 0 included.
 * @param {any[]} snaps the snapshots
 * @returns {[string, string, number][]} key, label, count
 */
export function showCounts(snaps) {
    const none = new Set();
    const count = (k) => snaps.filter((s) => (k === "undecided" ? !s.decision : shownBy(s, k, none))).length;
    return SHOWS.map(([k, label]) => /** @type {[string, string, number]} */ ([k, label, count(k)])).filter(
        ([k, , n]) => n > 0 || !STATUS[k],
    );
}

/**
 * The progress line's words: what is left, then the reader's own decisions and what was accepted
 * before this capture, each only when it is not 0. A change of 10 or fewer says only what is left
 * until something is decided.
 * @param {any[]} snaps the snapshots
 * @returns {{ left: string, rest: string[] }} "34 left", and the parts after it in the order they
 *     drop when the line is tight (the last first)
 */
export function progressOf(snaps) {
    const earlier = snaps.filter((s) => s.before).length;
    const left = snaps.filter((s) => !s.decision).length;
    const mine = snaps.length - left - earlier;
    const rest =
        snaps.length <= 10 && mine === 0
            ? []
            : [mine > 0 ? `${fmt(mine)} decided` : null, earlier > 0 ? `${fmt(earlier)} accepted earlier` : null];
    return { left: `${fmt(left)} left`, rest: rest.filter(Boolean) };
}

/**
 * What the list shows: its groups, each collapsed or open with the rows it draws, and every row
 * drawn, in order.
 * @param {any} lv the list's state
 * @param {any[]} snaps the snapshots
 * @returns {{ groups: any[], visible: any[], shown: number, filtering: boolean,
 *     byKey?: Map<string, any> }} the groups (each
 *     with `collapsed` and `drawn`), the drawn rows in order, how many rows Show and Find keep, and
 *     whether Find filters
 */
export function layoutOf(lv, snaps) {
    const head = [
        snaps,
        snaps.length,
        rowsVersion,
        lv.find,
        lv.show,
        lv.grouping,
        lv.clusters,
        lv.pairs,
        [...lv.keep].join("\n"),
        [...lv.collapsed].join("\n"),
    ];
    if (lastLayout?.head.length === head.length && lastLayout.head.every((x, i) => x === head[i])) {
        return lastLayout.out;
    }
    const out = computeLayout(lv, snaps);
    out.byKey = new Map(out.groups.map((g) => [g.key, g]));
    lastLayout = { head, out };
    return out;
}

// The last layout and what it was computed from. Every pane, key and label asks for the layout
// several times a draw (each group header once); at 3,000 snapshots each ask is a sort, so an ask
// with nothing changed reuses it. A row changes only through setDecision, which counts.
let lastLayout = null;
let rowsVersion = 0;

function computeLayout(lv, snaps) {
    const match = filterOf(lv.find);
    const rows = snaps.filter((s) => shownBy(s, lv.show, lv.keep) && (!match || match(s)));
    const groups = groupsOf(rows, { grouping: lv.grouping, clusters: lv.clusters, pairs: lv.pairs });
    const headers = lv.grouping !== "none";
    const visible = [];
    for (const g of groups) {
        // Groups holding a match open while Find holds text; a group of one in a small change is no group.
        g.headed = headers && !(snaps.length <= 10 && g.rows.length === 1 && g.key !== BEFORE);
        g.collapsed = g.headed && lv.collapsed.has(g.key) && !match;
        g.drawn = g.collapsed
            ? g.key !== BEFORE && g.rows.length > BIG && g.rows.some(undecided)
                ? [g.rows.find(undecided)]
                : []
            : g.rows;
        visible.push(...g.drawn);
    }
    return { groups, visible, shown: rows.length, filtering: match !== null };
}

/**
 * The picture a row asks for under the Row pictures choices, and how it is cropped: one request
 * per row. A changed pair is marked (its changed pixels tinted red) or plain, cropped to its change
 * (rowCrop, spot.js)
 * or whole. A snapshot of one image has only its plain picture.
 * @param {any} s the snapshot
 * @param {{ spot: boolean, zoom: "crop" | "whole" }} pics the choices
 * @returns {{ kind: string, how: string | null, shown: number | null } | null} the kind, which
 *     rule cropped it ("all", "cluster", "dense", "center" or "size"; null when whole) and how many of the
 *     changed areas the crop frames, or null for no picture
 */
export function pictureKind(s, pics) {
    if (!s.pic || s.status === "failed") {
        return null;
    }
    if (!pairOf(s)) {
        return { kind: "plain", how: null, shown: null };
    }
    if (pics.zoom === "whole") {
        return { kind: pics.spot ? "tint" : "plain", how: null, shown: null };
    }
    const a = s.areas;
    const shown = a ? (a.shown ?? a.count) : null;
    // Before the server has found the areas, the row only knows it is cropped.
    const how = a ? (a.how ?? (shown < a.count ? "cluster" : "all")) : "crop";
    return { kind: pics.spot ? "row-tint" : "row-plain", how, shown };
}

/**
 * How a resized snapshot's size changed: "2 px shorter", "10 px wider, 2 px taller".
 * @param {any} s the snapshot
 * @returns {string} the words, or "" when the size did not change
 */
export function sizeChange(s) {
    if (!s.size || !s.baselineSize) {
        return "";
    }
    const [dw, dh] = [s.size[0] - s.baselineSize[0], s.size[1] - s.baselineSize[1]];
    const said = (d, less, more) => (d === 0 ? null : `${fmt(Math.abs(d))} px ${d < 0 ? less : more}`);
    return [said(dw, "narrower", "wider"), said(dh, "shorter", "taller")].filter(Boolean).join(", ");
}

/**
 * A row's words for its change, under the story's name: how many areas changed ("66 changed
 * areas", "1 changed area"; "Only the size changed: 2 px shorter" when nothing else did), else
 * what sizeText says ("image identical"). How the picture is cropped is in its tooltip, its pixel
 * size in Details.
 * @param {any} s the snapshot
 * @returns {string} the words, or ""
 */
export function rowSizeText(s) {
    const count = s.areas?.count;
    if (s.status === "changed" && s.areas?.how === "size" && sizeChange(s)) {
        return `Only the size changed: ${sizeChange(s)}`;
    }
    if (s.status === "changed") {
        return typeof count === "number" ? `${fmt(count)} changed area${count === 1 ? "" : "s"}` : "";
    }
    return sizeText(s);
}

/**
 * The Row pictures choices, kept in this browser.
 * @returns {{ spot: boolean, zoom: "crop" | "whole", none: boolean }} the choices
 */
export function loadPictures() {
    try {
        const v = JSON.parse(localStorage.getItem(PICTURES_KEY) ?? "null");
        const zoom = OLD_ZOOMS[v?.zoom] ?? v?.zoom;
        if (v && typeof v.spot === "boolean" && ZOOMS[zoom] && typeof v.none === "boolean") {
            return { ...v, zoom };
        }
    } catch {
        // A private window: the defaults.
    }
    return { spot: true, zoom: "crop", none: false };
}

const savePictures = (pics) => {
    try {
        localStorage.setItem(PICTURES_KEY, JSON.stringify(pics));
    } catch {
        // Not kept; the defaults next time.
    }
};

// ---------------------------------------------------------------- the list's state

/**
 * Starts the list of a change just opened: Show Undecided, grouped by component above 10
 * snapshots (else none), nothing found, the big groups collapsed.
 * @param {any} app the page
 * @param {{ snaps: any[], clusters: Map<string, any> }} model the snapshots
 * @param {{ show?: string | null, group?: string | null, find?: string | null }} [wanted] what the
 *     address asks for
 */
export function openList(app, model, wanted = {}) {
    const lv = app.lv;
    lv.clusters = model.clusters;
    lv.pairs = pairCounts(model.snaps);
    lv.keep = new Set();
    lv.find = wanted.find ?? "";
    lv.show = SHOW_LABEL[wanted.show] ? wanted.show : "undecided";
    if (GROUPINGS[wanted.group]) {
        lv.grouping = wanted.group;
        lv.chosen = true;
    } else if (!lv.chosen) {
        lv.grouping = model.snaps.length > 10 ? "component" : "none";
    }
    lv.collapsed = collapsedAtStart(layoutOf({ ...lv, collapsed: new Set() }, model.snaps).groups, lv.show);
    lv.built = null;
    lv.newer = null;
    lv.rendererAnyway = false;
    findBox().value = lv.find;
}

/**
 * A fresh list state.
 * @returns {any} the state
 */
export function listState() {
    return {
        show: "undecided",
        grouping: "none",
        chosen: false,
        pics: loadPictures(),
        collapsed: new Set(),
        keep: new Set(),
        find: "",
        clusters: new Map(),
        pairs: new Map(),
        built: null,
        visible: [],
        rowEls: new Map(),
        newer: null,
        rendererAnyway: false,
        noMatch: false,
    };
}

/**
 * The snapshot rows in the order the list draws them (Up and Down walk them).
 * @param {any} app the page
 * @returns {any[]} the rows
 */
export const visibleRows = (app) => layoutOf(app.lv, app.snaps).visible;

/**
 * Makes sure the current snapshot is a drawn row: when Show, Find or a summary entry hid it, the
 * first drawn row becomes current (none when nothing is drawn). Changing the filter back does not
 * bring the old row back.
 * @param {any} app the page
 * @returns {boolean} whether the current snapshot changed
 */
export function keepCurrentShown(app) {
    const vis = visibleRows(app);
    if (app.snap !== null && vis.some((s) => s.key === app.snap)) {
        return false;
    }
    const before = app.snap;
    app.snap = vis[0]?.key ?? null;
    return app.snap !== before;
}

// ---------------------------------------------------------------- list actions

/**
 * Sets Show, and keeps the current row shown.
 * @param {any} app the page
 * @param {string} show the choice
 */
export function setShow(app, show) {
    const lv = app.lv;
    lv.show = show;
    lv.keep = new Set();
    if (show === "all" || show === "before") {
        lv.collapsed.delete(BEFORE);
    } else {
        lv.collapsed.add(BEFORE);
    }
    changed(app);
}

/**
 * Sets the grouping, with its groups collapsed as a change opens with them.
 * @param {any} app the page
 * @param {string} grouping the choice
 */
export function setGrouping(app, grouping) {
    const lv = app.lv;
    lv.grouping = grouping;
    lv.chosen = true;
    lv.collapsed = collapsedAtStart(layoutOf({ ...lv, collapsed: new Set() }, app.snaps).groups, lv.show);
    changed(app);
}

/**
 * Changes a Row pictures choice.
 * @param {any} app the page
 * @param {{ spot?: boolean, zoom?: "crop" | "whole", none?: boolean }} change the choice
 */
export function setPictures(app, change) {
    app.lv.pics = { ...app.lv.pics, ...change };
    savePictures(app.lv.pics);
    changed(app);
}

/**
 * Opens or closes a group.
 * @param {any} app the page
 * @param {string} key the group
 * @param {boolean} [open] open it (default: the other way)
 */
export function toggleGroup(app, key, open = app.lv.collapsed.has(key)) {
    if (open) {
        app.lv.collapsed.delete(key);
    } else {
        app.lv.collapsed.add(key);
    }
    changed(app);
}

// After a change to what the list shows: the current row kept shown, the page redrawn.
function changed(app) {
    keepCurrentShown(app);
    app.writeAddress(false);
    app.draw();
    scrollToCurrent();
}

/**
 * Makes a snapshot current by Find's number jump: a row in a collapsed group opens the group, and
 * a row Show hides shows everything.
 * @param {any} app the page
 * @param {number} n the snapshot's number
 * @returns {any | null} the snapshot, or null when the change has none of that number
 */
export function jumpTo(app, n) {
    const s = app.snaps.find((x) => x.n === n);
    if (!s) {
        return null;
    }
    const lv = app.lv;
    if (!shownBy(s, lv.show, lv.keep)) {
        lv.show = "all";
        lv.collapsed.delete(BEFORE);
    }
    const g = layoutOf(lv, app.snaps).groups.find((x) => x.rows.includes(s));
    if (g?.collapsed && !g.drawn.includes(s)) {
        lv.collapsed.delete(g.key);
    }
    app.snap = s.key;
    return s;
}

/**
 * What the reader typed in Find: a number makes its snapshot current at once; text filters.
 * @param {any} app the page
 */
export function findTyped(app) {
    const lv = app.lv;
    lv.find = findBox().value;
    const n = jumpOf(lv.find);
    // A number jumps at once when it exists; Enter says when it does not.
    if (n !== null) {
        jumpTo(app, n);
    }
    keepCurrentShown(app);
    const lay = layoutOf(lv, app.snaps);
    const none = lay.filtering && lay.shown === 0;
    const text = `No story matches "${lv.find.trim()}".`;
    if (none && !lv.noMatch) {
        app.say(text);
    } else if (none) {
        app.sayAgain(text);
    }
    lv.noMatch = none;
    app.writeAddress(false);
    app.draw();
    scrollToCurrent();
}

/**
 * Enter in Find: a number opens its snapshot and empties the box; text opens the first match.
 * @param {any} app the page
 */
export function findEnter(app) {
    const lv = app.lv;
    const n = jumpOf(lv.find);
    if (n !== null) {
        const s = jumpTo(app, n);
        if (!s) {
            app.say(`There is no snapshot #${n} in this change.`);
            return;
        }
        findBox().value = "";
        lv.find = "";
        app.draw();
        scrollToCurrent();
        app.openSnapshot();
        app.say(`Opened #${s.n}.`);
        return;
    }
    const first = visibleRows(app)[0];
    if (first) {
        app.snap = first.key;
        app.draw();
        scrollToCurrent();
        app.openSnapshot();
    }
}

/**
 * Empties Find, which drops its filter.
 * @param {any} app the page
 */
export function clearFind(app) {
    findBox().value = "";
    app.lv.find = "";
    app.lv.noMatch = false;
    changed(app);
}

// The one Find box, made on first use.
let finder = null;

/**
 * The list's Find box, made once and kept, so redrawing the header never takes the reader's focus
 * or caret.
 * @returns {HTMLInputElement} the box
 */
export function findBox() {
    if (!finder) {
        finder = /** @type {HTMLInputElement} */ (
            el("input", {
                type: "search",
                id: "snap-find",
                "data-act": "find",
                "data-key": "/",
                "data-zone": "snaps-head",
                "data-find": "Find",
                title: "Find a story, or #number",
                "aria-label": "Find a story, or jump to a number",
                autocomplete: "off",
            })
        );
    }
    return finder;
}

// ---------------------------------------------------------------- drawing: the header

// Text measured without layout reads, for the row and header budgets.
const measure = document.createElement("canvas").getContext("2d");
// The body's font family, read once: getComputedStyle per row would recompute styles per row.
let family = null;
export const FONT = () => (family ??= getComputedStyle(document.body).fontFamily);
export const textWidth = (t, font) => {
    measure.font = font;
    return measure.measureText(String(t)).width;
};

/**
 * A name cut in the middle to fit a width, so both its start and its end show.
 * @param {string} t the name
 * @param {number} w the width
 * @param {string} font the font
 * @returns {string} the name, whole or cut
 */
export function midCut(t, w, font) {
    if (textWidth(t, font) <= w) {
        return t;
    }
    let lo = 6;
    let hi = t.length - 1;
    const cut = (k) => `${t.slice(0, Math.ceil(k / 2))}...${t.slice(t.length - Math.floor(k / 2))}`;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (textWidth(cut(mid), font) <= w) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return cut(lo);
}

/**
 * A name cut at its start to fit a width, so its end shows ("...cytoscape-js-specimens"): sibling
 * groups share their start, and the end is what tells them apart (design 9.4 item 2).
 * @param {string} t the name
 * @param {number} w the width
 * @param {string} font the font
 * @returns {string} the name, whole or cut
 */
export function endCut(t, w, font) {
    let k = t.length;
    while (k > 6 && textWidth(k === t.length ? t : `...${t.slice(t.length - k)}`, font) > w) {
        k--;
    }
    return k === t.length ? t : `...${t.slice(t.length - k)}`;
}

const lines = {};
const line = (cls) => {
    lines[cls] ??= el("div", { class: `hl ${cls}` });
    return lines[cls];
};

// Whether a header line is wider than its box.
const over = (n) => n.scrollWidth > n.clientWidth + 1;

/**
 * The header's three lines (design 2.4 item 3, 9.4):
 * 1. the change's number and title (at most two lines) and the fold button (built by the page);
 * 2. the progress line, "34 left" then "12 decided, 1,208 accepted earlier", over the bar, and the
 *    notice chips at its right end;
 * 3. Find, Show, the List menu and the Up/Down pair;
 * and, only while rows are selected, the selection bar under them (its bulk buttons need the room).
 * Nothing wraps: line 2 drops "accepted earlier", then "decided"; Find's placeholder is
 * "Find  /" at every width. "N left", the Show value and the change's number never go.
 * @param {any} app the page
 * @param {HTMLElement} h1 line 1, built by the page (number, title, Next change, the fold button)
 */
export function drawHead(app, h1) {
    const lv = app.lv;
    const snaps = app.snaps;
    const lay = layoutOf(lv, snaps);
    const decided = snaps.filter((s) => s.decision).length;
    // Set through the element's style: the page's content security policy refuses style attributes.
    const fill = el("div");
    fill.style.width = `${snaps.length ? (100 * decided) / snaps.length : 0}%`;
    const bar = el("div", { class: "bar3" }, fill);
    const head = $("snaps-head");
    const h2 = line("h2");
    const h3 = line("h3");
    const h4 = line("h4");
    h1.classList.add("hl", "h1");
    // Line 2: the progress, the number the reader acts on first.
    const p = progressOf(snaps);
    const rest = el("span", { class: "muted num rest" }, p.rest.join(", "));
    h2.replaceChildren(el("b", { class: "num left" }, p.left), rest, bar);
    // Line 3: Find, Clear while it holds text, Show and List (or the selection bar), Up and Down.
    const box = findBox();
    if (box.value !== lv.find) {
        box.value = lv.find;
    }
    const clear = control(app, "clearfind", {
        zone: "snaps-head",
        attrs: { id: "find-clear", hidden: lv.find === "" ? true : null, title: "Empty Find" },
        children: ["Clear", el("kbd", { class: "fk quiet", "aria-hidden": "true" }, "Esc")],
    });
    // The count shows only while the list is filtered: by Show away from Undecided, or by Find.
    const show = `Show: ${SHOW_LABEL[lv.show]}`;
    const showLabel = lv.show !== "undecided" || lay.filtering ? `${show} (${fmt(lay.shown)})` : show;
    const selecting = app.sel.size > 0;
    if (box.parentNode !== h3) {
        h3.replaceChildren(box);
    }
    while (h3.childNodes.length > 1) {
        h3.lastChild.remove();
    }
    h3.append(
        clear,
        control(app, "showmenu", {
            zone: "snaps-head",
            label: showLabel,
            attrs: { "aria-label": showLabel, "aria-haspopup": "menu" },
        }),
        // Its Select section's keys act with the menu closed: Shift+Up and Shift+Down are printed here
        // at every width.
        control(app, "listmenu", {
            zone: "snaps-head",
            attrs: {
                "aria-haspopup": "menu",
                "data-menukeys": JSON.stringify({ "Shift+Up": "extendup", "Shift+Down": "extenddown" }),
            },
        }),
        ...rowButtons(app, "snaps", "snaps-head"),
    );
    h3.classList.add("findwrap");
    h4.classList.add("lselbar");
    h4.classList.remove("tight");
    h4.replaceChildren(...(selecting ? selectionBar(app) : []));
    const parts = selecting ? [h1, h2, h3, h4] : [h1, h2, h3];
    // Only the lines that are new go in: a line already in place never moves, so the Find box
    // keeps the reader's focus and caret while the header is drawn again.
    for (const c of [...head.children]) {
        if (!parts.includes(c)) {
            c.remove();
        }
    }
    parts.forEach((x, i) => {
        if (head.children[i] !== x) {
            head.insertBefore(x, head.children[i] ?? null);
        }
    });
    // The selection bar never wraps and never cuts a label: "(3 not shown)" goes into the count's
    // tooltip first, then the buttons drop their marks.
    if (selecting && over(h4)) {
        h4.querySelector(".nsh").textContent = "";
    }
    if (selecting && over(h4)) {
        h4.classList.add("tight");
    }
    fitProgress(app, h2, rest, p.rest);
    drawRenderer(app);
    $("snaps").classList.toggle("nopics", lv.pics.none);
    // One bulk Accept on screen: while rows are selected, the decision bar's Accept N is it, and
    // the group headers draw none (each group's name menu still lists Accept N  Shift+A).
    $("snaps").classList.toggle("selecting", selecting);
}

// The selection bar, under line 3 while rows are selected (design 4.6): the count, Clear [Esc] and
// its menu. The decision bar decides the selection ("Accept 3") while the current row is in it.
function selectionBar(app) {
    const n = app.sel.size;
    const hid = app.selHidden();
    const zone = "selection";
    return [
        el(
            "b",
            { class: "selcount", title: hid ? `${fmt(n)} selected, ${fmt(hid)} not shown` : `${fmt(n)} selected` },
            `${fmt(n)} selected`,
            el("span", { class: "nsh" }, hid ? ` (${fmt(hid)} not shown)` : ""),
        ),
        control(app, "clearsel", { zone, attrs: { class: "clearsel" } }),
        control(app, "selmenu", { zone, label: "More" }),
    ];
}

const rendererName = (r, major) => `${r.name} ${major ? r.version.split(".")[0] : r.version}`;

/**
 * The first project of the open change whose capture was drawn by another renderer than its
 * baselines (design 10), or null; never when either side does not say which drew it.
 * @param {any} app the page
 * @returns {{ capture: { name: string, version: string }, baselines: { name: string, version: string } } | null}
 *     the two renderers
 */
export function rendererChange(app) {
    const s = app.snaps.find(
        (x) =>
            x.renderer &&
            x.baselineRenderer &&
            (x.renderer.name !== x.baselineRenderer.name || x.renderer.version !== x.baselineRenderer.version),
    );
    return s ? { capture: s.renderer, baselines: s.baselineRenderer } : null;
}

/**
 * Whether the renderer banner stands in for the rows: the renderers differ and the reader has not
 * chosen Show the changes anyway for this change.
 * @param {any} app the page
 * @returns {boolean} the rows are hidden behind the banner
 */
export const rendererBlocked = (app) => !app.lv.rendererAnyway && rendererChange(app) !== null;

// "These captures used Chromium 131; the baselines used Chromium 128": in place of the rows.
function drawRenderer(app) {
    const b = $("snap-renderer");
    const r = rendererBlocked(app) ? rendererChange(app) : null;
    b.hidden = !r;
    $("snap-list").hidden = Boolean(r);
    if (!r) {
        b.replaceChildren();
        return;
    }
    // The major versions say it, unless only a later part differs.
    const major =
        r.capture.name !== r.baselines.name || r.capture.version.split(".")[0] !== r.baselines.version.split(".")[0];
    b.replaceChildren(
        ic("failed", "c-changed"),
        el(
            "span",
            { class: "grow" },
            `These captures used ${rendererName(r.capture, major)}; the baselines used ${rendererName(r.baselines, major)}. Every image may differ.`,
        ),
        control(app, "rendereranyway", { zone: "snaps-head" }),
        control(app, "recapture", { zone: "snaps-head" }),
    );
}

// Line 2 holds "N left", then the reader's own counts, then at its right end the notices
// ("Behind master: 1,242", "Newer capture"), each a menu button saying what it means and what to do.
// When the line is tight: "accepted earlier" goes first, then two notices fold into one "2 notices",
// then a chip says it shorter ("Behind: 1,242"), then "decided" goes, and last the chip's words are
// cut. "N left" never goes. The notices never block anything: the rows never change under the reader.
function fitProgress(app, h2, rest, parts) {
    const bar = h2.querySelector(".bar3");
    const chips = (list, short = false) => {
        h2.querySelectorAll('[data-act="stalechip"]').forEach((n) => n.remove());
        return list.map((w) => h2.insertBefore(noticeChip(app, w, short), bar));
    };
    const which = noticesOf(app);
    let drawn = chips(which);
    const words = (n) => {
        rest.textContent = parts.slice(0, n).join(", ");
    };
    const steps = [
        () => parts.at(-1)?.endsWith("accepted earlier") && words(parts.length - 1),
        () => drawn.length === 2 && (drawn = chips(["both"])),
        () => drawn.length === 1 && (drawn = chips([drawn[0].dataset.notice], true)),
        () => words(0),
        () => drawn[0]?.classList.add("squeeze"),
    ];
    for (const step of steps) {
        if (!over(h2)) {
            return;
        }
        step();
    }
}

const noticesOf = (app) => [...((app.open()?.stale ?? 0) > 0 ? ["stale"] : []), ...(app.lv.newer ? ["newer"] : [])];

function noticeChip(app, which, short) {
    const master = app.list?.defaultBranch ?? "master";
    const n = fmt(app.open()?.stale ?? 0);
    const full = { stale: `Behind ${master}: ${n}`, newer: "Newer capture", both: "2 notices" }[which];
    const label = short ? { stale: `Behind: ${n}`, newer: "Newer", both: "2 notices" }[which] : full;
    return control(app, "stalechip", {
        zone: "snaps-head",
        ctx: { which },
        attrs: { class: "chip", "aria-haspopup": "menu", "aria-label": full, "data-notice": which },
        children: [
            ic("clock"),
            el("span", { class: "cl" }, label),
            el("span", { class: "gcaret", "aria-hidden": "true" }),
        ],
    });
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * A notice chip's menu: what the notice means and what to do about it; "both" holds both.
 * @param {any} app the page
 * @param {"stale" | "newer" | "both"} which the chip
 * @returns {any[]} the items
 */
export function noticeItems(app, which) {
    const c = app.open();
    const n = c?.stale ?? 0;
    const master = app.list?.defaultBranch ?? "master";
    const stale = [
        { text: `${cap(master)} accepted ${fmt(n)} newer baseline${n === 1 ? "" : "s"} after this capture.` },
        {
            text: `Your decisions stay valid unless ${master} changed the same images. If it did, updating first saves reviewing them twice: Update from ${master} merges ${master} in and CI captures again.`,
        },
        { id: "chgonmaster", label: `See what changed on ${master}`, ctx: { id: c?.id } },
        { id: "updatefrom", label: `Update from ${master}...`, ctx: { id: c?.id } },
    ];
    const sha = app.lv.newer?.sha;
    const newer = [
        {
            text: `A newer capture${sha ? ` (${sha.slice(0, 7)})` : ""} is ready. Your decisions on unchanged images are kept.`,
        },
        { id: "loadnewer", label: "Load it" },
    ];
    return { stale, newer, both: [...stale, { sep: true }, ...newer] }[which];
}

// ---------------------------------------------------------------- drawing: the rows

const SIZE_FONT = () => `12px ${FONT()}`;
const NAME_FONT = () => `600 12px ${FONT()}`;
const BADGE_FONT = () => `11px ${FONT()}`;

// The change size on line 4: never cut.
/**
 * A snapshot's change size, as its row and the viewer's item line show it.
 * @param {any} s the snapshot
 * @param {number} [count] its changed areas: by default the capture's count, in the viewer the diff's
 * @returns {string} "3 areas, 1,234 px" (sizes of 10,000 and more as "490k px"), "image
 *     identical", or ""
 */
export function sizeText(s, count = s.areas?.count) {
    if (s.status === "changed") {
        const px = s.changedPixels === null || s.changedPixels === undefined ? "" : `${fmtShort(s.changedPixels)} px`;
        const a = count === undefined || count === null ? "" : `${fmt(count)} area${count === 1 ? "" : "s"}`;
        return [a, px].filter(Boolean).join(", ");
    }
    if (s.status === "moved") {
        return "image identical";
    }
    if (s.status === "failed") {
        return "the render failed";
    }
    return "";
}

const changeLabel = (app) => app.open()?.label ?? "";

/**
 * A decision's words, whole: "Accepted", "Accepted (not opened)", "Accepted earlier
 * (#1356)", "Rejected: reason", "Rejected before (#3486, 2026-10-20): reason" (the date when the
 * server recorded one), "Excluded: reason", "Finished: it is on the branch".
 * @param {any} app the page
 * @param {any} s the snapshot
 * @returns {string} the words
 */
export function decisionWords(app, s) {
    const d = s.decision;
    if (!d) {
        return "";
    }
    if (s.finished) {
        return "Finished: it is on the branch";
    }
    if (d.decision === "accept") {
        if (s.before) {
            const pr = d.approvedBefore.pr;
            const before = pr === null || pr === undefined ? "on the seed" : `${wordsOf(app.list).numberPrefix}${pr}`;
            return `Accepted earlier (${before})`;
        }
        return d.bulk ? "Accepted (not opened)" : "Accepted";
    }
    if (s.rejectedBefore) {
        return `Rejected before (${changeLabel(app)}${d.postedAt ? `, ${d.postedAt}` : ""}): ${d.reason ?? ""}`;
    }
    return `${d.decision === "reject" ? "Rejected" : "Excluded"}: ${d.reason ?? ""}`;
}

const decisionMark = (s) => {
    const d = s.finished ? DECISION.finished : s.before ? DECISION.before : DECISION[s.decision.decision];
    return mark(d.shape, d.cls);
};

// A row picture's tooltip: which part of the image it shows.
function pictureTitle(s, pk) {
    const count = s.areas?.count ?? 0;
    if (pk.how === "cluster" && pk.shown < count) {
        return `Cropped to ${fmt(pk.shown)} of the ${fmt(count)} changed areas`;
    }
    return (
        {
            all: "Cropped to the changed areas",
            cluster: "Cropped to the changed areas",
            dense: "Cropped to where the most pixels changed",
            center: "Cropped to the change",
            size: "Centered: only the size changed",
            crop: "Cropped to the change",
        }[pk.how] ?? "Whole image"
    );
}

// The row's picture: the server's picture for the Row pictures choices, or a placeholder chip.
function pictureOf(app, s) {
    const chip = (...c) => el("div", { class: "ph" }, el("span", {}, ...c));
    if (s.status === "failed") {
        return el("div", { class: "pic" }, chip(mark("failed", "c-failed"), "did not render"));
    }
    const pk = pictureKind(s, app.lv.pics);
    if (!pk) {
        return el("div", { class: "pic" }, chip("No picture"));
    }
    // Nothing is drawn over the picture: how it is cropped is said in this tooltip (and chosen in
    // the List menu).
    // A size-only crop is centered away from the strip that changed: nothing in it is tinted.
    const tinted = (pk.kind === "row-tint" && pk.how !== "size") || pk.kind === "tint";
    const title = `${pictureTitle(s, pk)}${tinted ? ", changed pixels tinted" : ""}`;
    const box = el("div", { class: "pic", title }, chip("Making picture..."));
    // The tooltip's words reach a keyboard or screen-reader reader too, with the tint.
    const img = el("img", {
        alt: title,
        loading: "lazy",
        decoding: "async",
        // `v` names how the server makes pictures (serve.mjs SPOTS_MADE_BY): the browser keeps a
        // picture for good, so one made the older way is fetched again.
        src: `/api/pic/${s.pic}-${pk.kind}?v=6${s.retried ? `&try=${s.retried}` : ""}`,
        "data-kind": pk.kind,
    });
    img.addEventListener("load", () => box.classList.add("ready"));
    img.addEventListener("error", () => {
        // The broken image goes, so it neither shows nor covers the chip's Retry.
        img.remove();
        box.querySelector(".ph").replaceWith(
            chip("Picture failed. ", control(app, "picretry", { zone: "rows", ctx: { key: s.key } })),
        );
    });
    box.append(img);
    if (s.status === "removed") {
        box.append(el("div", { class: "rm" }));
    }
    return box;
}

/**
 * A snapshot's badges, as its row and the viewer's item line show them.
 * @param {any} app the page
 * @param {any} s the snapshot
 * @returns {{ text: string, title?: string, cls?: string, mark?: string }[]} the badges, with a
 *     color class and a mark when they have one
 */
export function badgesOf(app, s) {
    const out = [];
    if (s.status === "changed" && s.size && s.baselineSize && String(s.size) !== String(s.baselineSize)) {
        const size = (z) => `${fmt(z[0])} x ${fmt(z[1])}`;
        out.push({ text: "resized", title: `Resized: ${size(s.baselineSize)} to ${size(s.size)}` });
    }
    if (s.reReview) {
        out.push({
            text: "re-review",
            title: `Re-review: your earlier accept was replaced by ${app.list?.defaultBranch ?? "master"}'s baseline`,
        });
    }
    if (s.disagree) {
        out.push({
            text: "unstable",
            title: "Unstable: its attempts in this run did not agree. Attempts in the details lists each",
            cls: "other",
            mark: "wavy",
        });
    }
    // Last, as the mockup orders them: the identical change's count.
    const pair = pairOf(s);
    if (pair && app.lv.grouping !== "same" && (app.lv.pairs.get(pair) ?? 0) > 1) {
        const others = app.lv.pairs.get(pair) - 1;
        out.push({
            text: `+${fmt(others)} identical`,
            title: `The same change as ${fmt(others)} other ${others === 1 ? "snapshot" : "snapshots"}`,
        });
    }
    return out;
}

/**
 * One badge, as its row and the viewer's item line draw it.
 * @param {{ text: string, title?: string, cls?: string, mark?: string }} b the badge
 * @returns {HTMLElement} the badge
 */
export const badgeNode = (b) =>
    el(
        "span",
        { class: b.cls ? `badge ${b.cls}` : "badge", title: b.title ?? null },
        // The mark carries the status color; the words stay in ink, as every status's do.
        b.mark ? mark(b.mark, "c-other") : null,
        b.text,
    );

// Badges that never fold: they change what Accept means.
const PINNED = new Set(["resized", "unstable"]);
const badgeW = (b) => textWidth(b.text, BADGE_FONT()) + 14 + (b.mark ? 15 : 0);
const MORE_W = () => textWidth("+99 more", BADGE_FONT()) + 20;

// Line 4's badges in a width: "resized" and "unstable" always, then as many of the others as fit,
// the rest folded into "+N more" (its tooltip names them) only when 2 or more are left: one left
// shows its own word. Returns the badges drawn whole and the folded ones.
function badgeFit(badges, room) {
    const pinned = badges.filter((b) => PINNED.has(b.text));
    const rest = badges.filter((b) => !PINNED.has(b.text));
    let left = room - pinned.reduce((w, b) => w + badgeW(b) + 6, 0);
    const shown = [];
    for (const [i, b] of rest.entries()) {
        const after = rest.length - i - 1;
        // The last one, or room for it and the fold of the others.
        if (badgeW(b) + (after > 1 ? MORE_W() : after === 1 ? badgeW(rest[i + 1]) + 6 : 0) > left) {
            break;
        }
        shown.push(b);
        left -= badgeW(b) + 6;
    }
    let folded = rest.slice(shown.length);
    if (folded.length === 1) {
        shown.push(folded[0]);
        folded = [];
    }
    return { shown: [...pinned, ...shown], folded };
}

function badgeNodes(badges, room) {
    const { shown, folded } = badgeFit(badges, room);
    return [
        ...shown.map(badgeNode),
        folded.length > 0
            ? el(
                  "span",
                  { class: "badge more", title: folded.map((b) => b.title ?? b.text).join("\n") },
                  `+${fmt(folded.length)} more`,
              )
            : null,
    ];
}

/**
 * One snapshot's row: 84 px with a picture, 28 px with No pictures.
 * @param {any} app the page
 * @param {any} s the snapshot
 * @param {boolean} [filled] with its contents (false: the row's element alone, filled later)
 * @returns {HTMLElement} the row
 */
export function rowOf(app, s, filled = true) {
    const lv = app.lv;
    const textW = lv.textW;
    const comp = lv.grouping === "component" ? "" : `${lv.multi ? `${s.project} > ` : ""}${s.component}`;
    const st = STATUS[s.status];
    const word = st?.word ?? s.status;
    const tip = `#${s.n} ${s.project} > ${s.component} / ${s.name}${s.mode ? ` (${s.mode})` : ""}${s.from ? `, moved from ${s.from}` : ""}`;
    const row = (children) =>
        control(app, "pickrow", {
            zone: "rows",
            tag: "div",
            ctx: { snap: s.key },
            attrs: {
                class: `srow ${s.key === app.snap ? "cur" : ""} ${s.decision ? "decided" : ""} ${app.sel.has(s.key) ? "selx" : ""}`,
                "data-snap": s.key,
                role: "option",
                "aria-selected": s.key === app.snap ? "true" : "false",
                title: tip,
            },
            children,
        });
    if (!filled) {
        return row([]);
    }
    const l1 = el(
        "div",
        { class: "l" },
        el("span", { class: "nmb" }, `#${s.n}`),
        el("span", { class: "st ell" }, mark(st?.shape ?? "wavy", st?.cls ?? "c-ink2"), word),
    );
    // The story's name, the one bold thing on the row, and its mode and "resized" as muted words
    // after it: "graph-file, dark, resized". The other badges are pills on line 4.
    const all = badgesOf(app, s);
    const resized = all.find((b) => b.text === "resized");
    const tail = [s.mode, resized?.text].filter(Boolean);
    const mode = tail.length > 0 ? `, ${tail.join(", ")}` : "";
    const modeW = mode ? textWidth(mode, `12px ${FONT()}`) : 0;
    const named = (text) => [text, mode ? el("span", { class: "mode", title: resized?.title ?? null }, mode) : null];
    let body;
    if (!s.decision) {
        const one = textWidth(s.name, NAME_FONT()) + modeW <= textW;
        const l23 = one
            ? [
                  el("div", { class: "nm1" }, named(s.name)),
                  comp ? el("div", { class: "l muted x3" }, el("span", { class: "ell" }, comp)) : null,
              ]
            : [el("div", { class: "nm" }, named(midCut(s.name, 2 * textW - 24 - modeW, NAME_FONT())))];
        const size = rowSizeText(s);
        const badges = all.filter((b) => b !== resized);
        const width = (x) => (x ? textWidth(x, SIZE_FONT()) + 8 : 0);
        body = [
            ...l23,
            el(
                "div",
                { class: "l x4" },
                el("span", { class: "keep muted" }, size),
                badgeNodes(badges, textW - width(size)),
            ),
        ];
    } else {
        const words = decisionWords(app, s);
        const undo =
            s.finished || s.before || s.rejectedBefore
                ? null
                : control(app, "rowundo", {
                      zone: "rows",
                      ctx: { key: s.key },
                      attrs: { title: "Undo this decision" },
                  });
        const name1 = el("div", { class: "nm1" }, named(midCut(s.name, textW - modeW, NAME_FONT())));
        const long = s.decision.decision !== "accept" || textWidth(words, NAME_FONT()) + 22 + (undo ? 60 : 0) > textW;
        body = long
            ? [
                  name1,
                  el(
                      "div",
                      { class: "dec2 x4", title: words },
                      el("div", { class: "reason keep" }, decisionMark(s), " ", words),
                      undo,
                  ),
              ]
            : [
                  name1,
                  comp ? el("div", { class: "l muted x3" }, el("span", { class: "ell" }, comp)) : null,
                  el("div", { class: "l x4" }, el("span", { class: "keep st" }, decisionMark(s), words), undo),
              ];
    }
    return row([
        control(app, "rowcheck", {
            zone: "rows",
            tag: "span",
            ctx: { key: s.key },
            attrs: {
                class: "rcheck",
                role: "checkbox",
                "aria-checked": app.sel.has(s.key) ? "true" : "false",
                "aria-label": `Select #${s.n}`,
                title: "Select [X]; Shift-click selects a range",
            },
            children: [el("span")],
        }),
        lv.pics.none ? null : pictureOf(app, s),
        el("div", { class: "info" }, l1, body),
    ]);
}

/**
 * What a group header's actions act on: the undecided rows the group shows (Accept N), how many
 * more undecided rows of the group Show and Find hide (never touched), and the decisions in it its
 * Undo N takes back. Accepted earlier acts on all its rows: they are decided by the server.
 * @param {any} app the page
 * @param {any} g the group, as layoutOf gives it
 * @returns {{ und: any[], hidden: number, undoable: any[], all: any[] }} the rows
 */
export function groupScope(app, g) {
    const und = g.rows.filter(undecided);
    const hiddenAll = app.lv.hiddenUnd?.get(g.key) ?? 0;
    return {
        und,
        hidden: hiddenAll,
        undoable: g.rows.filter(undoable),
        all: g.key === BEFORE ? g.rows : g.rows.filter((s) => !s.decision),
    };
}

/**
 * Whether a row's decision has an Undo: a decision taken on this capture that no Finish published
 * (approved before is derived by the server, rejected before and finished are an earlier Finish's).
 * @param {any} s the snapshot
 * @returns {boolean} it has
 */
export const undoable = (s) => Boolean(s.decision) && !s.finished && !s.before && !s.rejectedBefore;

/**
 * A group's Accept label: "Accept 14", or "Accept 2 shown (15 hidden)" when Show or Find hides some.
 * @param {{ und: any[], hidden: number }} scope the group's scope
 * @returns {string} the label
 */
export const acceptLabel = ({ und, hidden }) =>
    hidden > 0 ? `Accept ${fmt(und.length)} shown (${fmt(hidden)} hidden)` : `Accept ${fmt(und.length)}`;

// How many undecided rows of each group Show and Find hide: counted once per list build, and only
// while they hide any undecided row.
function countHidden(app) {
    const lv = app.lv;
    lv.hiddenUnd = new Map();
    if (lv.show === "undecided" && !filterOf(lv.find)) {
        return;
    }
    const shown = new Set(layoutOf(lv, app.snaps).groups.flatMap((g) => g.rows.map((s) => s.key)));
    const all = layoutOf({ ...lv, show: "all", find: "" }, app.snaps).groups;
    for (const g of all) {
        const n = g.rows.filter((s) => undecided(s) && !shown.has(s.key)).length;
        if (n > 0) {
            lv.hiddenUnd.set(g.key, n);
        }
    }
}

const groupName = (g) =>
    g.key === BEFORE ? "Accepted earlier" : g.kind === "status" ? (STATUS[g.label]?.word ?? g.label) : g.label;

// A header's third control: Accept N while the group holds undecided rows (a neutral outline; green,
// with its quiet Shift+A, only on the current snapshot's group), else Undo N while it holds
// decisions to take back. Accepted earlier has none: its Reject N... and Exclude N... are in its menu.
function headAction(app, g, name) {
    const sc = groupScope(app, g);
    if (g.key === BEFORE) {
        return null;
    }
    const zone = "rows";
    const ctx = { group: g.key };
    if (sc.und.length === 0) {
        return sc.undoable.length > 0 ? control(app, "gundo", { zone, ctx, attrs: { title: "Asks first" } }) : null;
    }
    const split = splitOf(g);
    const label = acceptLabel(sc);
    // Its key only while the current snapshot is in this group: Shift+A accepts that group.
    const mine = g.rows.some((s) => s.key === app.snap);
    return control(app, "gaccept", {
        zone,
        ctx,
        keyed: mine,
        attrs: {
            class: mine ? "acc mine" : "acc",
            title: `${label} in ${name}${split ? ` (${splitWords(split)})` : ""}`,
        },
        children: [label, mine ? kb("Shift+A", true) : null],
    });
}

// The width a header's third control takes: Accept N, with its bold label and Shift+A only on the
// current snapshot's group (the header is drawn again when the current group changes), so the
// other groups' names get the room the key would take.
function actionWidth(app, g, mine) {
    const sc = groupScope(app, g);
    if (g.key === BEFORE || (sc.und.length === 0 && sc.undoable.length === 0)) {
        return 0;
    }
    const font = `11px ${FONT()}`;
    return sc.und.length > 0
        ? mine
            ? textWidth(acceptLabel(sc), `700 ${font}`) + textWidth("Shift+A", font) + 22
            : textWidth(acceptLabel(sc), font) + 18
        : textWidth(`Undo ${fmt(sc.undoable.length)}`, font) + 22;
}

/**
 * A group's sticky header, one line: the chevron (collapses and expands, with `aria-expanded`), the
 * name button (cut at its start, keeping its end, a drawn caret after it) that opens the group's actions, and
 * Accept N: always on the current snapshot's group, on the others only while the header is hovered
 * or focused. The count is said once, in Accept N; it is also the first item of the name's menu.
 * @param {any} app the page
 * @param {any} g the group
 * @returns {{ node: HTMLElement, height: number }} the header and its height
 */
function headerOf(app, g) {
    const name = groupName(g);
    const open = !g.collapsed;
    const before = g.key === BEFORE;
    const caret = control(app, "gtoggle", {
        zone: "rows",
        ctx: { group: g.key },
        attrs: {
            class: "caret",
            "aria-expanded": open ? "true" : "false",
            title: `${open ? "Collapse" : "Expand"} ${name}`,
            "aria-label": `${name}: ${open ? "collapse" : "expand"}`,
        },
        children: [mark(open ? "chevOpen" : "chevClosed")],
    });
    // A component group is named by its component alone ("legend"), its project in the tooltip,
    // unless another project has a component of that name.
    const comp = g.kind === "component" ? g.rows[0].component : null;
    const twin =
        comp !== null &&
        layoutOf(app.lv, app.snaps).groups.some(
            (o) => o.key !== g.key && o.kind === "component" && o.rows[0]?.component === comp,
        );
    const label = comp !== null && !twin ? comp : name;
    const shape = before ? DECISION.before : g.kind === "status" ? STATUS[g.label] : null;
    const font = `${before ? 400 : 700} 12px ${FONT()}`;
    // The list's width less the header's padding, the chevron, the gaps, the name button's padding,
    // its mark, its caret and the third control.
    const mine = g.rows.some((s) => s.key === app.snap);
    const room = app.lv.listW - 74 - (shape ? 16 : 0) - actionWidth(app, g, mine);
    const menu = control(app, "gmenu", {
        zone: "rows",
        ctx: { group: g.key },
        attrs: {
            class: "gname",
            "aria-haspopup": "menu",
            "aria-label": `${name}: group actions`,
            title: `Group actions: ${name}`,
        },
        children: [
            shape ? mark(shape.shape, shape.cls) : null,
            // 4 px spare: the estimate of Accept N runs a pixel or two short, which clipped the end.
            el("span", { class: "gn" }, endCut(label, Math.max(room - 4, 48), font)),
            el("span", { class: "gcaret", "aria-hidden": "true" }),
        ],
    });
    const node = el(
        "div",
        { class: `ghead ${before ? "before" : ""} ${mine ? "mine" : ""}`, "data-group": g.key, title: name },
        caret,
        menu,
        el("span", { class: "gsp" }),
        headAction(app, g, name),
    );
    return { node, height: 32 };
}

/**
 * Replaces every drawn group header with one built from the state now (after a decision: Accept N
 * becomes Undo N, the counts change), without touching a row. Given the rows that changed, or the
 * groups, only those groups' headers, and those whose hidden count changed, are built again.
 * @param {any} app the page
 * @param {Set<string>} [rows] the keys of the rows that changed
 * @param {Set<string | null>} [groups] the keys of the groups that changed
 */
export function updateHeads(app, rows, groups) {
    const hiddenBefore = app.lv.hiddenUnd ?? new Map();
    countHidden(app);
    const stale = (g) =>
        (!rows && !groups) ||
        hiddenBefore.get(g.key) !== app.lv.hiddenUnd.get(g.key) ||
        groups?.has(g.key) ||
        g.rows.some((s) => rows?.has(s.key));
    const heads = new Map(
        [...$("snap-list").querySelectorAll(".grp > .ghead")].map((h) => [h.parentElement.dataset.group, h]),
    );
    for (const g of layoutOf(app.lv, app.snaps).groups) {
        const old = g.headed && heads.get(g.key);
        if (old && stale(g)) {
            old.replaceWith(headerOf(app, g).node);
        }
    }
}

// The empty list: no match for Find, or nothing for Show.
function emptyOf(app, lay) {
    const lv = app.lv;
    if (lay.filtering) {
        return el("div", { class: "muted lempty" }, `No story matches "${lv.find.trim()}".`);
    }
    return el(
        "div",
        { class: "muted lempty" },
        `Nothing ${lv.show === "undecided" ? "undecided" : "to show"} here. `,
        control(app, "show", { zone: "rows", ctx: { show: "all" }, label: `Show: All (${fmt(app.snaps.length)})` }),
    );
}

// A list of more rows than this fills its rows on approach; the first rows, and the rows around the
// current one, are filled at once.
const LAZY = 500;
const FIRST = 40;

/**
 * Builds the list's rows, only when what it shows changed since it was last built; otherwise moves
 * the current row's mark.
 * @param {any} app the page
 */
export function drawRows(app) {
    const lv = app.lv;
    const list = $("snap-list");
    const width = list.clientWidth || lv.listW || 405;
    const sig = JSON.stringify([
        app.openId,
        app.lv.version ?? 0,
        lv.show,
        lv.grouping,
        lv.pics,
        filterOf(lv.find) ? lv.find.trim().toLowerCase() : "",
        [...lv.collapsed].sort(),
        width,
        // Offline, a row's Undo is unavailable: the rows are built again when it goes or comes back.
        app.offline(),
    ]);
    if (sig === lv.built) {
        syncCurrent(app);
        return;
    }
    performance.mark("list-start");
    lv.built = sig;
    lv.listW = width;
    lv.multi = new Set(app.snaps.map((x) => x.project)).size > 1;
    const picW = Math.max(120, Math.min(190, width - 246));
    lv.textW = lv.pics.none ? width - 46 : width - 32 - 8 - 6 - picW;
    const lay = layoutOf(lv, app.snaps);
    countHidden(app);
    lv.rowEls = new Map();
    // A long list draws its rows' contents as they come near the screen: every row is its element
    // from the start (its place, number, state and tooltip), and its pictures and lines are added
    // once, on approach. The first screen, and the rows around the current one, are drawn at once.
    lv.filler?.disconnect();
    lv.filler = null;
    const lazy = lay.visible.length > LAZY;
    const at = lay.visible.findIndex((s) => s.key === app.snap);
    if (lazy) {
        const byKey = new Map(lay.visible.map((s) => [s.key, s]));
        lv.filler = new IntersectionObserver(
            (seen) => {
                for (const e of seen) {
                    const r = /** @type {HTMLElement} */ (e.target);
                    if (e.isIntersecting && r.childElementCount === 0) {
                        r.append(...rowOf(app, byKey.get(r.dataset.snap)).childNodes);
                        lv.filler.unobserve(r);
                    }
                }
            },
            { root: list, rootMargin: "1500px 0px" },
        );
    }
    let i = 0;
    const out = [];
    for (const g of lay.groups) {
        const rows = g.drawn.map((s) => {
            const now = !lazy || i < FIRST || Math.abs(i - at) < FIRST;
            i++;
            const r = rowOf(app, s, now);
            if (!now) {
                lv.filler.observe(r);
            }
            lv.rowEls.set(s.key, r);
            return r;
        });
        if (!g.headed) {
            out.push(...rows);
            continue;
        }
        const { node } = headerOf(app, g);
        const more =
            g.collapsed && rows.length > 0
                ? el(
                      "div",
                      { class: "gmore" },
                      control(app, "gshowall", {
                          zone: "rows",
                          ctx: { group: g.key },
                          label: `Show all ${fmt(g.rows.length)} in this group`,
                      }),
                  )
                : null;
        out.push(el("section", { class: "grp", "data-group": g.key }, node, rows, more));
    }
    lv.visible = lay.visible;
    lv.curGroup = lv.rowEls.get(app.snap)?.closest(".grp")?.dataset.group ?? null;
    list.replaceChildren(...(lay.shown === 0 && app.snaps.length > 0 ? [emptyOf(app, lay)] : out));
    performance.measure("snapshot-list", "list-start");
    // The bench reads how long the list took to its first frame.
    requestAnimationFrame(() => performance.measure("snapshot-list-frame", "list-start"));
}

/**
 * Moves the current row's mark to the current snapshot's row, without building anything.
 * @param {any} app the page
 */
export function syncCurrent(app) {
    for (const r of document.querySelectorAll("#snap-list .srow.cur")) {
        if (r.dataset.snap !== app.snap) {
            r.classList.remove("cur");
            r.setAttribute("aria-selected", "false");
        }
    }
    const r = app.lv.rowEls.get(app.snap);
    if (r && !r.classList.contains("cur")) {
        r.classList.add("cur");
        r.setAttribute("aria-selected", "true");
    }
    // Shift+A belongs to the current snapshot's group: its header is drawn again when that moved.
    const g = r?.closest(".grp")?.dataset.group ?? null;
    if (g !== app.lv.curGroup) {
        const was = app.lv.curGroup;
        app.lv.curGroup = g;
        updateHeads(app, undefined, new Set([was, g]));
    }
}

/**
 * Marks rows selected or not, in place: their class and their checkbox.
 * @param {any} app the page
 * @param {string[]} keys the rows that may have changed
 */
export function markSelected(app, keys) {
    for (const k of keys) {
        const r = app.lv.rowEls.get(k);
        if (r) {
            const on = app.sel.has(k);
            r.classList.toggle("selx", on);
            r.querySelector(":scope > .rcheck")?.setAttribute("aria-checked", on ? "true" : "false");
        }
    }
}

/**
 * Replaces one snapshot's row with one built from its state now: a decision changes exactly that
 * row element, never the rest of the list.
 * @param {any} app the page
 * @param {string} key the snapshot
 */
export function updateRow(app, key) {
    const s = app.snaps.find((x) => x.key === key);
    const old = app.lv.rowEls.get(key);
    if (!s || !old) {
        return;
    }
    const r = rowOf(app, s);
    old.replaceWith(r);
    app.lv.rowEls.set(key, r);
}

/**
 * Scrolls the current row wholly into view, below its group's sticky header.
 */
export function scrollToCurrent() {
    const list = $("snap-list");
    const r = list.querySelector(".srow.cur");
    if (!r) {
        return;
    }
    const pad = r.closest(".grp")?.querySelector(":scope > .ghead")?.offsetHeight ?? 0;
    const box = list.getBoundingClientRect();
    const at = r.getBoundingClientRect();
    if (at.top - pad < box.top) {
        list.scrollTop -= box.top + pad - at.top;
    } else if (at.bottom > box.bottom) {
        list.scrollTop += at.bottom - box.bottom;
    }
}

/**
 * Builds the Snapshots pane of an open change: the header, then the rows.
 * @param {any} app the page
 * @param {HTMLElement} h1 the header's first line
 */
export function drawList(app, h1) {
    drawHead(app, h1);
    drawRows(app);
}

// ---------------------------------------------------------------- menus

/**
 * The Show menu's items: Undecided and All, then "By kind" and "By decision", each choice with its
 * count right-aligned, a choice of 0 greyed, then Accept all N shown...
 * @param {any} app the page
 * @returns {any[]} the items
 */
export const showItems = (app) => [
    // Two breakdowns of the same snapshots, each under its muted heading (never focused, the arrow
    // keys skip it): by kind (the statuses), then by decision.
    ...showCounts(app.snaps)
        .flatMap(([k, label, n], i, all) => [
            STATUS[k] && !STATUS[all[i - 1][0]] ? { head: "By kind" } : null,
            k === "before" ? { head: "By decision" } : null,
            {
                id: "show",
                label,
                count: fmt(n),
                dim: n === 0,
                ctx: { show: k },
                checked: app.lv.show === k,
                mark: STATUS[k] ? [STATUS[k].shape, STATUS[k].cls] : null,
            },
        ])
        .filter(Boolean),
    // It acts on what Show shows, so it sits with Show, under a separator.
    { sep: true },
    { id: "acceptshown", label: `Accept all ${fmt(shownUndecided(app).length)} shown...` },
];

/**
 * The Group by items of the List menu.
 * @param {any} app the page
 * @returns {any[]} the items
 */
export const groupItems = (app) =>
    Object.entries(GROUPINGS).map(([k, label]) => ({
        id: "group",
        label,
        ctx: { grouping: k },
        checked: app.lv.grouping === k,
    }));

/**
 * The Pictures items of the List menu.
 * @param {any} app the page
 * @returns {any[]} the items
 */
export function pictureItems(app) {
    const p = app.lv.pics;
    return [
        ...Object.entries(ZOOMS).map(([k, label]) => ({
            id: "piczoom",
            label,
            ctx: { zoom: k },
            checked: p.zoom === k && !p.none,
        })),
        { id: "picnone", label: "Text only, no pictures", checked: p.none },
        { id: "picspot", label: "Mark the change", checked: p.spot && !p.none, check: true },
    ];
}

/**
 * The List menu's items, about the list only: Group by, Pictures, and Select (Extend selection up
 * and down, whose keys act with the menu closed, and Select all shown). Accept all shown is the Show
 * menu's last item; Undo all, the JUnit report and Copy link are in the change's own menu.
 * @param {any} app the page
 * @returns {any[]} the items
 */
export const listItems = (app) => [
    { head: `Group by: ${GROUPINGS[app.lv.grouping]}` },
    ...groupItems(app),
    { sep: true },
    { head: "Pictures" },
    ...pictureItems(app),
    { sep: true },
    { head: "Select" },
    ...app.selectItems(),
];

/**
 * Every undecided row Show and Find keep, collapsed groups' too, that Accept can take.
 * @param {any} app the page
 * @returns {any[]} the rows
 */
export const shownUndecided = (app) =>
    layoutOf(app.lv, app.snaps)
        .groups.flatMap((g) => g.rows)
        .filter(undecided);
