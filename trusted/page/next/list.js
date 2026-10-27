/*
 * The snapshot list (design section 4): the five header lines (folded for a change of 10 or fewer),
 * the groups with their sticky headers, and the rows with their pictures, marks, badges and
 * decisions. The rows are real elements with `content-visibility: auto` and a fixed intrinsic size,
 * and their pictures load lazily from the server's content-addressed picture names, one request per
 * row. The list is built again only when what it shows changes (Show, Group, Pictures, Find, a
 * group opened or closed, a newer capture loaded); moving the current row moves one class, and a
 * decision replaces its one row element in place.
 *
 * The model (`snapsOf`, `layoutOf`, `pictureKind`) is pure; the rest builds the pane from it.
 */

import { control } from "./actions.js";
import { filterOf, jumpOf } from "./find.js";
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
import { DECISION, ORDER, STATUS, mark, statusMark } from "./marks.js";
import { el, fmt } from "./ui.js";

const $ = (id) => document.getElementById(id);
const PICTURES_KEY = "proofroom:pictures";

/** The Show menu's choices after Undecided and All: each status, then each decision. */
export const SHOWS = [
    ["undecided", "Undecided"],
    ["all", "All"],
    ...ORDER.map((s) => [s, STATUS[s].word]),
    ["accept", "Accepted"],
    ["reject", "Rejected"],
    ["exclude", "Excluded"],
];
export const SHOW_LABEL = Object.fromEntries(SHOWS);

/** The Zoom rows to the change choices. */
export const ZOOMS = {
    auto: "Auto: when the change is small (2x Fit or more)",
    always: "Always",
    never: "Never",
};

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
                look: look.get(i.file) ?? null,
                decision: null,
                before: false,
            });
            setDecision(snaps.at(-1), a.decisions?.[i.file] ?? null);
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
    return STATUS[show] ? s.status === show : s.decision?.decision === show;
}

/**
 * How many snapshots each Show choice holds (the menu's counts): a status or decision with none is
 * not offered, Undecided and All always are.
 * @param {any[]} snaps the snapshots
 * @returns {[string, string, number][]} key, label, count
 */
export function showCounts(snaps) {
    const count = (k) =>
        snaps.filter((s) =>
            k === "all"
                ? true
                : k === "undecided"
                  ? !s.decision
                  : STATUS[k]
                    ? s.status === k
                    : s.decision?.decision === k,
        ).length;
    return SHOWS.map(([k, label]) => /** @type {[string, string, number]} */ ([k, label, count(k)])).filter(
        ([k, , n]) => n > 0 || k === "undecided" || k === "all",
    );
}

/**
 * What the list shows: its groups, each collapsed or open with the rows it draws, and every row
 * drawn, in order.
 * @param {any} lv the list's state
 * @param {any[]} snaps the snapshots
 * @returns {{ groups: any[], visible: any[], shown: number, filtering: boolean }} the groups (each
 *     with `collapsed` and `drawn`), the drawn rows in order, how many rows Show and Find keep, and
 *     whether Find filters
 */
export function layoutOf(lv, snaps) {
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
 * The picture a row asks for under the Row pictures choices, and its corner tags: one request per
 * row. A changed pair is spotlit or plain, zoomed to its change or whole; Zoom Auto zooms when the
 * crop around the largest area is at least 2x Fit (the server's `auto` when spotlit). A snapshot of
 * one image has only its plain picture.
 * @param {any} s the snapshot
 * @param {{ spot: boolean, zoom: "auto" | "always" | "never" }} pics the choices
 * @returns {{ kind: string, tags: string[] } | null} the kind and tags, or null for no picture
 */
export function pictureKind(s, pics) {
    if (!s.pic || s.status === "failed") {
        return null;
    }
    if (!pairOf(s)) {
        return { kind: "plain", tags: [] };
    }
    const a = s.areas;
    const big = Boolean(a && a.count > 0 && a.zoom >= 2);
    const zoomed = pics.zoom === "always" || (pics.zoom === "auto" && big);
    let kind;
    if (pics.spot) {
        kind = pics.zoom === "auto" ? "auto" : zoomed ? "row-spot" : "spot";
    } else {
        kind = zoomed ? "row-plain" : "plain";
    }
    const tags = [];
    if (zoomed && a) {
        tags.push(`zoomed ${Math.round(a.zoom)}x`);
        if (a.count > 1) {
            tags.push(`+${a.count - 1} area${a.count === 2 ? "" : "s"}`);
        }
    }
    return { kind, tags };
}

/**
 * The Row pictures choices, kept in this browser.
 * @returns {{ spot: boolean, zoom: "auto" | "always" | "never", none: boolean }} the choices
 */
export function loadPictures() {
    try {
        const v = JSON.parse(localStorage.getItem(PICTURES_KEY) ?? "null");
        if (v && typeof v.spot === "boolean" && ZOOMS[v.zoom] && typeof v.none === "boolean") {
            return v;
        }
    } catch {
        // A private window: the defaults.
    }
    return { spot: true, zoom: "auto", none: false };
}

const savePictures = (pics) => {
    try {
        localStorage.setItem(PICTURES_KEY, JSON.stringify(pics));
    } catch {
        // Not kept; the defaults next time.
    }
};

/**
 * The Pictures button's label at three widths: "spotlit, zoom auto" (after "Pictures: "),
 * "Spotlit, zoom auto", then "Zoom auto" / "Zoomed" / "Not zoomed". The word zoom never drops.
 * @param {{ spot: boolean, zoom: string, none: boolean }} pics the choices
 * @param {number} [level] 0, 1 or 2
 * @returns {string} the label
 */
export function picturesLabel(pics, level = 0) {
    if (pics.none) {
        return "No pictures";
    }
    if (level >= 2) {
        return { auto: "Zoom auto", always: "Zoomed", never: "Not zoomed" }[pics.zoom];
    }
    const t = `${pics.spot ? "spotlit" : "plain"}, zoom ${pics.zoom}`;
    return level ? t[0].toUpperCase() + t.slice(1) : t;
}

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
    if (show === "all" || show === "accept") {
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
 * @param {{ spot?: boolean, zoom?: "auto" | "always" | "never", none?: boolean }} change the choice
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
                "data-find": "Find a story, or jump to a number",
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
const FONT = () => (family ??= getComputedStyle(document.body).fontFamily);
const textWidth = (t, font) => {
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
function midCut(t, w, font) {
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

const lines = {};
const line = (cls) => {
    lines[cls] ??= el("div", { class: `hl ${cls}` });
    return lines[cls];
};

/**
 * The status summary's entries: one per status present, a mark, a count and a word, each setting
 * Show to that status.
 * @param {any} app the page
 * @param {string[]} [only] the statuses to draw
 * @returns {HTMLElement[]} the entries
 */
function statusEntries(app, only = null) {
    return ORDER.filter((st) => (only ?? ORDER).includes(st))
        .map((st) => [st, app.snaps.filter((s) => s.status === st).length])
        .filter(([, n]) => n > 0)
        .map(([st, n]) =>
            control(app, "statshow", {
                zone: "snaps-head",
                ctx: { status: st },
                attrs: {
                    "aria-pressed": app.lv.show === st ? "true" : "false",
                    title: `Show: ${STATUS[st].word}`,
                    "data-status": st,
                },
                children: [
                    mark(STATUS[st].shape, STATUS[st].cls),
                    el("span", { class: "num" }, fmt(n)),
                    ` ${STATUS[st].word}`,
                ],
            }),
        );
}

// The entries that fold into "+N more" first: moved, then no baseline yet, then changed. Failed,
// new and removed never fold.
const FOLD = ["moved", "unseeded", "changed"];

// Folds the status entries that do not fit on their line into one "+N more" menu.
function foldStatus(app, host) {
    app.lv.more = [];
    if (host.scrollWidth <= host.clientWidth + 1) {
        return;
    }
    const more = () =>
        control(app, "statmore", {
            zone: "snaps-head",
            label: `+${app.lv.more.length} more`,
            attrs: { title: "The other statuses", "data-more": "" },
        });
    host.append(more());
    for (const st of FOLD) {
        if (host.scrollWidth <= host.clientWidth + 1) {
            break;
        }
        const b = host.querySelector(`[data-status="${st}"]`);
        if (b) {
            b.remove();
            app.lv.more.push(st);
            host.querySelector("[data-more]").replaceWith(more());
        }
    }
    if (app.lv.more.length === 0) {
        host.querySelector("[data-more]").remove();
    }
}

/**
 * The header's five lines, or four for a change of 10 or fewer (progress and summary on one line,
 * one View options menu), plus the newer-capture banner.
 * @param {any} app the page
 * @param {HTMLElement} h1 line 1, built by the page (title, Next change, Hide)
 */
export function drawHead(app, h1) {
    const lv = app.lv;
    const snaps = app.snaps;
    const small = snaps.length <= 10;
    const decided = snaps.filter((s) => s.decision).length;
    const left = snaps.length - decided;
    const lay = layoutOf(lv, snaps);
    const shownN = lay.filtering ? `${fmt(lay.shown)} of ${fmt(snaps.length)} shown` : "";
    // Set through the element's style: the page's content security policy refuses style attributes.
    const fill = el("div");
    fill.style.width = `${snaps.length ? (100 * decided) / snaps.length : 0}%`;
    const bar = el("div", { class: "bar3" }, fill);
    const head = $("snaps-head");
    const h2 = line("h2");
    const h3 = line("h3");
    const h4 = line("h4");
    const h5 = line("h5");
    h1.classList.add("hl", "h1");
    if (small) {
        h2.classList.add("ssum");
        h2.replaceChildren(
            el("span", { class: "num lead" }, `${fmt(decided)} of ${fmt(snaps.length)} decided:`),
            ...statusEntries(app),
            bar,
        );
    } else {
        h2.classList.remove("ssum");
        h2.replaceChildren(
            el("span", { class: "num" }, `${fmt(decided)} of ${fmt(snaps.length)} decided, ${fmt(left)} left`),
            el("span", { class: "grow" }),
            el("span", { class: "muted num" }, shownN),
            bar,
        );
        h3.replaceChildren(...statusEntries(app));
    }
    // Line 4: Find, its count in a small change, and Clear while it holds text.
    const box = findBox();
    if (box.value !== lv.find) {
        box.value = lv.find;
    }
    const clear = control(app, "clearfind", {
        zone: "snaps-head",
        attrs: { id: "find-clear", hidden: lv.find === "" ? true : null, title: "Empty Find" },
        children: ["Clear", el("kbd", { class: "fk", "aria-hidden": "true" }, "Esc")],
    });
    if (box.parentNode !== h4) {
        h4.replaceChildren(box);
    }
    while (h4.childNodes.length > 1) {
        h4.lastChild.remove();
    }
    h4.append(small && shownN ? el("span", { class: "small muted num" }, shownN) : "", clear);
    h4.classList.add("findwrap");
    // Line 5: the controls, their labels shortened (never cut) when the line would wrap.
    const show = SHOW_LABEL[lv.show];
    const showN = showCounts(snaps).find(([k]) => k === lv.show)?.[2] ?? 0;
    const controls = (level) =>
        small
            ? [
                  control(app, "viewopts", {
                      zone: "snaps-head",
                      attrs: {
                          title: `Show: ${show}; Group: ${GROUPINGS[lv.grouping]}; Pictures: ${picturesLabel(lv.pics)}`,
                      },
                  }),
                  el("span", { class: "grow" }),
                  el("span", { class: "small muted" }, `${show}, ${picturesLabel(lv.pics, 1)}`),
              ]
            : [
                  control(app, "showmenu", {
                      zone: "snaps-head",
                      label: `${level ? "" : "Show: "}${show} (${fmt(showN)})`,
                      attrs: { title: `Show: ${show}`, "aria-label": `Show: ${show} (${fmt(showN)})` },
                  }),
                  control(app, "groupmenu", {
                      zone: "snaps-head",
                      label: `${level ? "" : "Group: "}${GROUPINGS[lv.grouping]}`,
                      attrs: {
                          title: `Group: ${GROUPINGS[lv.grouping]}`,
                          "aria-label": `Group: ${GROUPINGS[lv.grouping]}`,
                      },
                  }),
                  control(app, "picsmenu", {
                      zone: "snaps-head",
                      label: `${level ? "" : "Pictures: "}${picturesLabel(lv.pics, level)}`,
                      attrs: {
                          title: `Pictures: ${picturesLabel(lv.pics)}`,
                          "aria-label": `Pictures: ${picturesLabel(lv.pics)}`,
                      },
                  }),
                  control(app, "listmenu", { zone: "snaps-head" }),
              ];
    h5.replaceChildren(...controls(0));
    const parts = small ? [h1, h2, h4, h5] : [h1, h2, h3, h4, h5];
    // Only the lines that are new go in: a line already in place never moves, so the Find box
    // keeps the reader's focus and caret while the header is drawn again.
    for (const c of [...head.children]) {
        if (!parts.includes(c)) {
            c.remove();
        }
    }
    parts.forEach((p, i) => {
        if (head.children[i] !== p) {
            head.insertBefore(p, head.children[i] ?? null);
        }
    });
    for (const level of [1, 2]) {
        if (!small && h5.scrollWidth > h5.clientWidth + 1) {
            h5.replaceChildren(...controls(level));
        }
    }
    foldStatus(app, small ? h2 : h3);
    drawBanner(app);
    $("snaps").classList.toggle("nopics", lv.pics.none);
}

// "A newer capture of this change is ready": the rows never change under the reader.
function drawBanner(app) {
    const b = $("snap-banner");
    const n = app.lv.newer;
    b.hidden = !n;
    b.replaceChildren(
        ...(n
            ? [
                  el(
                      "span",
                      { class: "grow" },
                      `A newer capture of this change is ready${n.sha ? ` (${n.sha.slice(0, 7)})` : ""}.`,
                  ),
                  control(app, "loadnewer", { zone: "snaps-head" }),
              ]
            : []),
    );
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
 * @returns {string} "1,234 px, 3 areas", "image identical", or ""
 */
export function sizeText(s, count = s.areas?.count) {
    if (s.status === "changed") {
        const px = s.changedPixels === null ? "" : `${fmt(s.changedPixels)} px`;
        const a = count === undefined ? "" : `${fmt(count)} area${count === 1 ? "" : "s"}`;
        return [px, a].filter(Boolean).join(", ");
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
 * A decision's words, whole: "Accepted", "Accepted (not opened)", "Accepted (approved before
 * #1356)", "Rejected: reason", "Rejected before (#3486): reason", "Excluded: reason", "Finished: it
 * is on the branch".
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
            return `Accepted (approved before ${pr === null || pr === undefined ? "on the seed" : `#${pr}`})`;
        }
        return d.bulk ? "Accepted (not opened)" : "Accepted";
    }
    if (s.rejectedBefore) {
        return `Rejected before (${changeLabel(app)}): ${d.reason ?? ""}`;
    }
    return `${d.decision === "reject" ? "Rejected" : "Excluded"}: ${d.reason ?? ""}`;
}

const decisionMark = (s) => {
    const d = s.finished ? DECISION.finished : s.before ? DECISION.before : DECISION[s.decision.decision];
    return mark(d.shape, d.cls);
};

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
    const box = el("div", { class: "pic" }, chip("Making picture..."));
    const img = el("img", {
        alt: "",
        loading: "lazy",
        decoding: "async",
        src: `/api/pic/${s.pic}-${pk.kind}${s.retried ? `?try=${s.retried}` : ""}`,
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
    if (pk.tags.length > 0) {
        box.append(
            el(
                "span",
                { class: "ztags" },
                pk.tags.map((t) => el("span", { class: "ztag" }, t)),
            ),
        );
    }
    return box;
}

/**
 * A snapshot's badges, as its row and the viewer's item line show them.
 * @param {any} app the page
 * @param {any} s the snapshot
 * @returns {{ text: string, title?: string }[]} the badges
 */
export function badgesOf(app, s) {
    const out = [];
    if (s.status === "changed" && s.size && s.baselineSize && String(s.size) !== String(s.baselineSize)) {
        out.push({ text: "size changed" });
    }
    if (s.reReview) {
        out.push({
            text: "re-review",
            title: `Re-review: your earlier accept was replaced by ${app.list?.defaultBranch ?? "master"}'s baseline`,
        });
    }
    // Last, as the mockup orders them: the identical change's count.
    const pair = pairOf(s);
    if (pair && app.lv.grouping !== "same" && (app.lv.pairs.get(pair) ?? 0) > 1) {
        out.push({ text: `same as ${fmt(app.lv.pairs.get(pair) - 1)} others` });
    }
    return out;
}

// Line 4's badges: the first that fits after the change size, the rest as one "+N" chip.
function badgeNodes(badges, room) {
    if (badges.length === 0) {
        return [];
    }
    const chip = (list) =>
        el("span", { class: "badge", title: list.map((b) => b.title ?? b.text).join(", ") }, `+${list.length}`);
    const fits = textWidth(badges[0].text, BADGE_FONT()) + 14 + (badges.length > 1 ? 30 : 0) <= room;
    if (!fits) {
        return [chip(badges)];
    }
    return [
        el("span", { class: "badge", title: badges[0].title ?? null }, badges[0].text),
        badges.length > 1 ? chip(badges.slice(1)) : null,
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
                class: `srow ${s.key === app.snap ? "cur" : ""} ${s.decision ? "decided" : ""}`,
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
        s.mode ? el("span", { class: "tag" }, s.mode) : null,
    );
    let body;
    if (!s.decision) {
        const one = textWidth(s.name, NAME_FONT()) <= textW;
        const l23 = one
            ? [
                  el("div", { class: "nm1" }, s.name),
                  el("div", { class: "l muted x3" }, el("span", { class: "ell" }, comp)),
              ]
            : [el("div", { class: "nm" }, midCut(s.name, 2 * textW - 24, NAME_FONT()))];
        const size = sizeText(s);
        const room = textW - (size ? textWidth(size, SIZE_FONT()) + 8 : 0);
        body = [
            ...l23,
            el("div", { class: "l x4" }, el("span", { class: "keep muted" }, size), badgeNodes(badgesOf(app, s), room)),
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
        const name1 = el("div", { class: "nm1" }, midCut(s.name, textW, NAME_FONT()));
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
                  el("div", { class: "l muted x3" }, el("span", { class: "ell" }, comp)),
                  el("div", { class: "l x4" }, el("span", { class: "keep st" }, decisionMark(s), words), undo),
              ];
    }
    return row([
        el("span", { class: "rcheck" }),
        lv.pics.none ? null : pictureOf(app, s),
        el("div", { class: "info" }, l1, body),
    ]);
}

// A group's count, or its status split with the marks and the words: "19: [diamond] 12 changed [plus] 7 new".
function countOf(g, fold) {
    const split = splitOf(g);
    if (!split) {
        return el("span", { class: "muted num" }, fmt(g.rows.length));
    }
    const keep = fold ? split.filter(([st]) => !["changed", "moved"].includes(st)) : split;
    const folded = fold ? split.filter(([st]) => ["changed", "moved"].includes(st)) : [];
    return el(
        "span",
        { class: "split muted num", title: `${fmt(g.rows.length)}: ${splitWords(split)}` },
        `${fmt(g.rows.length)}: `,
        keep.map(([st, n]) =>
            el("span", { class: "sent" }, mark(STATUS[st].shape, STATUS[st].cls), `${fmt(n)} ${STATUS[st].word}`),
        ),
        folded.length > 0
            ? el(
                  "span",
                  { class: "badge", title: splitWords(folded) },
                  `+${fmt(folded.reduce((a, [, n]) => a + n, 0))} other`,
              )
            : null,
    );
}

// How the header fits: one line, or the name over its split, the split folding changed and moved
// into "+N other" only when its own line is still too narrow. The name is never cut.
function headLayout(app, g, name) {
    const room = app.lv.listW - 28 - (g.collapsed && g.key === BEFORE ? 60 : 0);
    const split = splitOf(g);
    const font = `700 12px ${FONT()}`;
    const nameW =
        24 + textWidth(name, font) + (g.key === BEFORE && g.collapsed ? textWidth(" (already accepted)", font) : 0);
    const splitW = (fold) => {
        if (!split) {
            return textWidth(fmt(g.rows.length), font) + 6;
        }
        const keep = fold ? split.filter(([st]) => !["changed", "moved"].includes(st)) : split;
        return (
            textWidth(`${g.rows.length}: `, font) +
            keep.reduce((w, [st, n]) => w + 20 + textWidth(`${n} ${STATUS[st].word}`, font), 0) +
            (fold && keep.length < split.length ? textWidth("+999 other", font) + 18 : 0)
        );
    };
    if (nameW + splitW(false) <= room) {
        return { two: false, fold: false };
    }
    return { two: Boolean(split), fold: Boolean(split) && splitW(false) > room };
}

const groupName = (g) =>
    g.key === BEFORE ? "Approved before" : g.kind === "status" ? (STATUS[g.label]?.word ?? g.label) : g.label;

/**
 * A group's sticky header: the chevron (with `aria-expanded`), the name, the count or status split.
 * @param {any} app the page
 * @param {any} g the group
 * @returns {{ node: HTMLElement, height: number }} the header and its height
 */
function headerOf(app, g) {
    const name = groupName(g);
    const lay = headLayout(app, g, name);
    const open = !g.collapsed;
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
    const label =
        g.key === BEFORE
            ? el("span", { class: "st" }, mark(DECISION.before.shape, DECISION.before.cls), "Approved before")
            : g.kind === "status"
              ? statusMark(g.label)
              : el("span", {}, g.label);
    const before = g.key === BEFORE;
    const count = before
        ? [
              el("span", { class: "muted num" }, fmt(g.rows.length)),
              g.collapsed ? el("span", { class: "muted aa" }, " (already accepted)") : null,
          ]
        : [countOf(g, lay.fold)];
    const buttons =
        before && g.collapsed
            ? [
                  control(app, "gshowall", {
                      zone: "rows",
                      ctx: { group: g.key },
                      label: "Show",
                      attrs: { title: `Show the ${g.rows.length} rows` },
                  }),
              ]
            : [];
    const height = lay.two ? 50 : 32;
    const node = lay.two
        ? el(
              "div",
              { class: `ghead two ${before ? "before" : ""}`, "data-group": g.key, title: name },
              el("span", { class: "gname" }, caret, label),
              count,
              el("span", { class: "gsp" }),
              buttons,
          )
        : el(
              "div",
              { class: `ghead ${before ? "before" : ""}`, "data-group": g.key, title: name },
              caret,
              el("span", { class: "gname1" }, label, " ", count),
              el("span", { class: "gsp" }),
              buttons,
          );
    return { node, height };
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
 * The Show menu's items.
 * @param {any} app the page
 * @returns {any[]} the items
 */
export const showItems = (app) =>
    showCounts(app.snaps).map(([k, label, n]) => ({
        id: "show",
        label: `${label} (${fmt(n)})`,
        ctx: { show: k },
        checked: app.lv.show === k,
        mark: STATUS[k] ? [STATUS[k].shape, STATUS[k].cls] : null,
    }));

/**
 * The Group menu's items.
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
 * The Row pictures menu's items.
 * @param {any} app the page
 * @returns {any[]} the items
 */
export function pictureItems(app) {
    const p = app.lv.pics;
    return [
        { id: "picspot", label: "Spotlight rows (switch)", checked: p.spot && !p.none, check: true },
        { sep: true },
        { head: "Zoom rows to the change" },
        ...Object.entries(ZOOMS).map(([k, label]) => ({
            id: "piczoom",
            label,
            ctx: { zoom: k },
            checked: p.zoom === k && !p.none,
        })),
        { sep: true },
        { id: "picnone", label: "No pictures (text rows)", checked: p.none, check: true },
    ];
}

/**
 * The list menu's items.
 * @returns {any[]} the items
 */
export const listItems = () => [{ id: "listlink", label: "Copy link" }];

/**
 * The View options menu of a small change: Show, Group, Pictures and the list menu's items.
 * @param {any} app the page
 * @returns {any[]} the items
 */
export const viewItems = (app) => [
    { head: "Show" },
    ...showItems(app),
    { sep: true },
    { head: "Group" },
    ...groupItems(app),
    { sep: true },
    { head: "Pictures" },
    ...pictureItems(app),
    { sep: true },
    ...listItems(),
];

/**
 * The "+N more" menu: the status entries that did not fit on their line.
 * @param {any} app the page
 * @returns {any[]} the items
 */
export const moreItems = (app) =>
    (app.lv.more ?? []).map((st) => ({
        id: "statshow",
        label: `${fmt(app.snaps.filter((s) => s.status === st).length)} ${STATUS[st].word}`,
        ctx: { status: st },
        checked: app.lv.show === st,
        mark: [STATUS[st].shape, STATUS[st].cls],
    }));
