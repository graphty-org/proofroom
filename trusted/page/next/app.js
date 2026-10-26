/*
 * The new review page, at /next/: the top bar, the Review screen's three panes with their rails,
 * the levels and their Back and Open buttons, the message line, the address, and the changes pane.
 * Plain ES modules, no framework and no build step. Every control comes from the action table
 * (actions.js); every text that came from a pull request is set as text.
 *
 * Opening a change lists its snapshots as plain text rows; the snapshot list, the viewer and the
 * decisions arrive with their own modules.
 */

import { control, runAction } from "./actions.js";
import { formatAddress, parseAddress, snapParts } from "./address.js";
import { api, currentToken, logControls, logUsage, startUsage, useToken, whenRefused } from "./api.js";
import { SORTS, changeOf, drawChanges, nextNeeding, sectionsOf, SECTIONS, sharesOf, walkOrder } from "./changes.js";
import { startKeys, syncHints } from "./keys.js";
import { history as messageHistory, say } from "./messages.js";
import { applyPanes, layoutFor, remember, remembered, shownNow, togglePane, twoLevels } from "./panes.js";
import { el, fmt, ic, kb } from "./ui.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 15000;
const DISMISSED_KEY = "proofroom:dismissed";

// The status words, marks and their colors, in the one status order (design 4.3).
const STATUS = {
    failed: ["failed", "failed", "c-failed"],
    changed: ["changed", "changed", "c-changed"],
    moved: ["moved", "moved", "c-changed"],
    new: ["new", "new", "c-new"],
    unseeded: ["no baseline yet", "unseeded", "c-new"],
    removed: ["removed", "removed", "c-removed"],
    unstable: ["unstable", "wavy", "c-other"],
};
const REVIEWABLE = Object.keys(STATUS);

// The finished rows dismissed in this browser; null on the first visit, when there are none yet.
const loadDismissed = () => {
    try {
        const kept = localStorage.getItem(DISMISSED_KEY);
        return kept === null ? null : new Set(JSON.parse(kept));
    } catch {
        return null;
    }
};

const saveDismissed = () => {
    try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...app.dismissed]));
    } catch {
        // Dismissed for this visit only.
    }
};

const app = {
    list: null, // the last GET /api/prs answer
    listAt: 0, // when it came, on this browser's clock
    changes: [], // the changes rows (changes.js changeOf)
    sort: "needs",
    secOpen: new Set(SECTIONS.filter((s) => s[2]).map((s) => s[0])),
    curId: null, // the current changes row
    pendingId: null, // the change being opened, current while its snapshots load
    openId: null, // the open change
    snaps: [], // the open change's snapshots, as plain rows
    snap: null, // the current snapshot, "<project>/<file>"
    level: 0,
    focusPane: "changes",
    dismissed: loadDismissed(),
    refreshing: false,
    failed: null, // why the last list request failed
    wanted: parseAddress(location.hash), // what the address asks for, until the list is loaded
    opening: 0, // bumped by each change opened: a superseded load stops there
    menu: null,

    logUsage,
    say,
    change: (id) => app.changes.find((c) => c.id === id) ?? null,
    open: () => app.change(app.openId),
    currentChangeId: () => app.pendingId ?? (app.level === 0 ? (app.curId ?? app.openId) : app.openId),
    findText: () => $("chg-find").value,
    sectionOpen: (k) => app.secOpen.has(k),
    sortLabel: () => SORTS[app.sort],
    holds: () => app.openId !== null && app.snap !== null,
    at: () => ({ width: innerWidth, open: app.openId !== null, holds: app.holds() }),
};

// ---------------------------------------------------------------- drawing

function drawTop() {
    $("repo").textContent = app.list?.repository ?? "";
    $("tabs").replaceChildren(control(app, "screen-review", { zone: "top", attrs: { "aria-current": "page" } }));
    const trouble = app.failed !== null || Boolean(app.list?.error);
    $("status-slot").replaceChildren(
        control(app, "refresh", {
            zone: "top",
            attrs: { class: `status ${trouble ? "trouble" : ""}`, id: "srvstatus" },
            children: [
                app.refreshing ? ic("spin") : trouble ? ic("offline") : null,
                el("span", { class: "ell" }, app.statusText()),
            ],
        }),
    );
}

app.statusText = () => {
    if (app.refreshing) {
        return "Refreshing...";
    }
    if (app.failed !== null) {
        return "Server not answering";
    }
    if (app.list?.error) {
        return "GitHub not answering";
    }
    if (!app.list?.updatedAt) {
        return "Loading...";
    }
    // On the server's clock, as the rows' ages are: its time when the list came, plus the time since.
    const now = (app.list.now ?? app.listAt) + (Date.now() - app.listAt);
    const s = Math.max(0, Math.round((now - app.list.updatedAt) / 1000));
    return s < 5 ? "Updated just now" : s < 60 ? `Updated ${s} s ago` : `Updated ${Math.floor(s / 60)} min ago`;
};

function drawChangesPane() {
    const needs = app.changes.filter((c) => c.section === "needs").length;
    $("rail-c").replaceWith(
        control(app, "pane1", {
            zone: "changes-head",
            ctx: { rail: true },
            attrs: { id: "rail-c", class: "railbar", title: "Show Changes (Shift+1)" },
            children: [
                el("span", { class: "count" }, String(app.changes.length === 1 ? 1 : needs || "")),
                el("span", { class: "vt" }, "Changes"),
                kb("Shift+1"),
            ],
        }),
    );
    $("hide-c").replaceChildren(control(app, "pane1", { zone: "changes-head" }));
    $("chg-next").replaceChildren(control(app, "nextchange", { zone: "changes-head", attrs: { id: "chg-next-btn" } }));
    $("chg-sort").replaceChildren(control(app, "chgsort", { zone: "changes-head", attrs: { class: "small" } }));
    drawChanges(app);
}

// The summary of a change, in the Snapshots pane while no change is open.
function summaryOf(c) {
    const statuses = REVIEWABLE.filter((s) => c.counts[s] > 0).map((s) =>
        el(
            "span",
            { class: "st" },
            el("span", { class: STATUS[s][2] }, ic(STATUS[s][1])),
            `${fmt(c.counts[s])} ${STATUS[s][0]}`,
        ),
    );
    const ready = !c.notReady && c.state !== "nothing";
    return el(
        "div",
        { class: "summary" },
        el("div", { class: "title" }, `${c.kind === "PR" ? `#${c.pr} ` : ""}${c.title}`),
        el("div", { class: "small" }, el("span", { class: "tag" }, c.kind), " ", c.branch ?? ""),
        el(
            "div",
            { class: "small muted" },
            [c.author && `by ${c.author}`, `from ${c.source}`, `${c.ready} projects ready`, c.age]
                .filter(Boolean)
                .join(", "),
        ),
        ready
            ? [
                  el("div", { class: "small" }, `${fmt(c.undecided)} undecided of ${fmt(c.total)}`),
                  el("div", { class: "ssum" }, statuses),
              ]
            : el("div", { class: "small" }, c.count),
        el("div", {}, control(app, "summaryopen", { zone: "snaps-head", ctx: { id: c.id } })),
    );
}

function drawSnaps() {
    const c = app.open();
    const [changesShown] = shownNow();
    $("rail-s").replaceWith(
        control(app, "pane2", {
            zone: "snaps-head",
            ctx: { rail: true },
            attrs: { id: "rail-s", class: "railbar", title: "Show Snapshots (Shift+2)" },
            children: [
                el("span", { class: "count" }, c ? fmt(c.undecided) : ""),
                el("span", { class: "vt" }, "Snapshots"),
                kb("Shift+2"),
            ],
        }),
    );
    const hide = control(app, "pane2", { zone: "snaps-head" });
    const list = $("snap-list");
    if (!c) {
        $("snaps-head").replaceChildren(el("div", { class: "h1" }, el("span", { class: "grow" }, "Change"), hide));
        const cur = app.change(app.curId);
        list.replaceChildren(
            app.changes.length === 0
                ? el(
                      "div",
                      { class: "summary" },
                      el("div", { class: "title" }, "No captures yet."),
                      el(
                          "p",
                          { class: "small" },
                          "Captures made by CI appear here on their own once a pull request runs its visual job.",
                      ),
                  )
                : cur
                  ? summaryOf(cur)
                  : el("p", { class: "muted empty" }, "Choose a change on the left."),
        );
        return;
    }
    const title = `${c.kind === "PR" ? `#${c.pr} ` : ""}${c.title}`;
    $("snaps-head").replaceChildren(
        el(
            "div",
            { class: "h1" },
            c.url
                ? el(
                      "a",
                      {
                          class: "grow ell",
                          href: c.url,
                          target: "_blank",
                          rel: "noreferrer",
                          title: `${title}: open on GitHub`,
                      },
                      title,
                  )
                : el("span", { class: "grow ell", title }, title),
            changesShown ? null : control(app, "nextchange", { zone: "snaps-head", attrs: { id: "snap-next-btn" } }),
            hide,
        ),
    );
    list.replaceChildren(
        ...(app.snaps.length === 0
            ? [el("p", { class: "muted empty" }, c.count)]
            : app.snaps.map((s) =>
                  control(app, "pickrow", {
                      zone: "rows",
                      tag: "div",
                      ctx: { snap: s.key },
                      attrs: { class: `srow ${s.key === app.snap ? "cur" : ""}`, "data-snap": s.key, title: s.name },
                      children: [
                          el("span", { class: "nmb" }, `#${s.n}`),
                          statusMark(s.status),
                          el("span", { class: "ell" }, s.name),
                          s.mode ? el("span", { class: "tag" }, s.mode) : null,
                          el("span", { class: "muted" }, s.project),
                      ],
                  }),
              )),
    );
}

const statusMark = (status) => {
    const [word, mark, cls] = STATUS[status] ?? [status, "open", "c-ink2"];
    return el("span", { class: "st" }, el("span", { class: cls }, ic(mark)), word);
};

function drawViewer() {
    const v = $("viewer");
    const c = app.open();
    if (app.changes.length === 0 && !c) {
        v.replaceChildren();
        return;
    }
    if (!c) {
        v.replaceChildren(
            el(
                "div",
                { class: "stage" },
                el(
                    "div",
                    { class: "emptyv" },
                    el("p", {}, el("b", {}, "Choose a change on the left")),
                    el(
                        "p",
                        {},
                        "Up and Down move through the changes; the current row's Open button and Next change print their keys.",
                    ),
                ),
            ),
        );
        return;
    }
    const s = app.snaps.find((x) => x.key === app.snap);
    if (!s) {
        v.replaceChildren(
            el(
                "div",
                { class: "stage" },
                el("div", { class: "emptyv" }, el("p", {}, `${c.count}. Nothing to review yet.`)),
            ),
        );
        return;
    }
    const two = twoLevels(app.snaps.length, innerWidth);
    v.replaceChildren(
        el(
            "div",
            { class: "iline" },
            app.level >= 1 ? control(app, "back", { zone: "iline" }) : null,
            el("b", { class: "num" }, `#${s.n}`),
            statusMark(s.status),
            el("b", { class: "ell", title: s.name }, s.name),
            s.mode ? el("span", { class: "tag" }, s.mode) : null,
            el("span", { class: "muted ell" }, `${s.project} > ${s.component}`),
            el("span", { class: "iright" }, app.level === 1 && two ? control(app, "openrow", { zone: "iline" }) : null),
        ),
        el("div", { class: "stage", id: "stage" }),
    );
}

function drawMsgButton() {
    $("msg-btn").replaceChildren(control(app, "messages", { zone: "msgline" }));
}

/** Redraws everything that depends on the state, then the key hints. */
function draw() {
    const focus = focusedControl();
    drawTop();
    if (!drawWaiting()) {
        drawChangesPane();
        drawSnaps();
        drawViewer();
        drawMsgButton();
    }
    refocus(focus);
    settle();
}

// The control that has focus, by what it is (its action, zone, row and id), so a redraw that
// replaces it can give focus to the new one: a poll never drops a control the reader tabbed to.
function focusedControl() {
    const f = /** @type {HTMLElement | null} */ (document.activeElement);
    if (!f?.dataset?.act) {
        return null;
    }
    return { node: f, act: f.dataset.act, zone: f.dataset.zone, id: f.id, where: rowKey(f) };
}

const rowKey = (n) => {
    const row = n.closest("[data-chg], [data-snap], [data-sec]");
    return row ? `${row.dataset.chg ?? ""}|${row.dataset.snap ?? ""}|${row.dataset.sec ?? ""}` : "";
};

function refocus(was) {
    if (!was || was.node.isConnected) {
        return;
    }
    const same = [...document.querySelectorAll(`[data-act="${CSS.escape(was.act)}"]`)].find(
        (n) => n.dataset.zone === was.zone && n.id === was.id && rowKey(n) === was.where,
    );
    same?.focus({ preventScroll: true });
}

// Until the server's first list is in, a centered box says what it is doing and for how long
// (design 10), in place of the panes: an empty list would read as "no changes".
function drawWaiting() {
    const waiting = !Array.isArray(app.list?.targets) && !$("token-box");
    $("screens").hidden = waiting || Boolean($("token-box"));
    if (!waiting) {
        $("wait-box")?.remove();
        return false;
    }
    const r = app.list?.refreshing;
    // The server's step started on its clock; without one, the time since this page asked.
    const since = r?.startedAt
        ? (app.list.now ?? app.listAt) + (Date.now() - app.listAt) - r.startedAt
        : Date.now() - app.bootAt;
    const s = Math.max(0, Math.round(since / 1000));
    const step =
        app.failed !== null
            ? "The review server did not answer."
            : r?.step
              ? `${r.step[0].toUpperCase()}${r.step.slice(1)}${r.total ? ` (${r.done ?? 0} of ${r.total})` : ""}`
              : "Waiting for the review server";
    const box = $("wait-box") ?? el("div", { class: "tokenbox", id: "wait-box", role: "status" });
    box.replaceChildren(
        el("b", {}, "Waiting for the code host"),
        el(
            "p",
            { class: "small" },
            app.failed !== null ? step : `${step}, ${s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`}`,
        ),
    );
    if (!box.isConnected) {
        $("screens").after(box);
    }
    return true;
}

// After a redraw: the key hints, and the controls on screen for the usage log.
function settle() {
    syncHints();
    logControls(
        [...document.querySelectorAll("[data-act]")]
            .filter((n) => n.getClientRects().length > 0)
            .map((n) => n.dataset.act),
    );
}

// ---------------------------------------------------------------- the address

function writeAddress(push) {
    const hash = formatAddress({ token: currentToken(), change: app.openId, snap: app.openId ? app.snap : null });
    if (hash !== location.hash && !(hash === "#" && location.hash === "")) {
        history[push ? "pushState" : "replaceState"](null, "", hash);
    }
}

// ---------------------------------------------------------------- panes and levels

function layout(prefer) {
    const c = app.open();
    const count = app.snaps.length;
    const shown = layoutFor({
        level: app.level,
        count,
        ...app.at(),
        remembered: remembered(app.level, count),
        prefer,
    });
    applyPanes(shown, { ...app.at(), open: c !== null });
}

app.togglePane = (id) => {
    const count = app.snaps.length;
    const before = shownNow();
    const { shown, moved } = togglePane(before, id, app.at());
    applyPanes(shown, app.at());
    remember(app.level, count, shown);
    const name = id === "changes" ? "Changes" : "Snapshots";
    const other = id === "changes" ? "Snapshots" : "Changes";
    const i = id === "changes" ? 0 : 1;
    say(
        shown[i]
            ? `${name} shown.${moved ? ` ${other} moved to its rail so the viewer keeps 800 px.` : ""}`
            : `${name} hidden: its rail or ${id === "changes" ? "Shift+1" : "Shift+2"} brings it back.`,
    );
    draw();
};

app.back = () => {
    if (app.level === 2) {
        app.level = 1;
        layout("snaps");
        draw();
        app.focusPane = "snaps";
        $("snap-list").focus({ preventScroll: true });
        say("Back to the list.");
    } else if (app.level === 1) {
        app.level = 0;
        app.curId = app.openId;
        layout("changes");
        draw();
        app.focusPane = "changes";
        $("chg-list").focus({ preventScroll: true });
        say("Back to the changes.");
    }
};

app.openSnapshot = () => {
    if (app.level !== 1 || !twoLevels(app.snaps.length, innerWidth) || !app.snap) {
        return;
    }
    app.level = 2;
    layout("snaps");
    draw();
    app.focusPane = "viewer";
    $("viewer").focus({ preventScroll: true });
};

app.pickSnapshot = (key) => {
    app.snap = key;
    if (app.level === 2) {
        app.level = 1;
    }
    app.focusPane = "snaps";
    writeAddress(false);
    draw();
};

// ---------------------------------------------------------------- changes

app.pickChange = (id) => {
    if (id === app.openId && app.level >= 1) {
        applyPanes([false, shownNow()[1]], app.at());
        draw();
        return;
    }
    app.openChange(id);
};

// The open change's snapshots, as plain rows from each ready project's list.
async function loadSnaps(c, seq) {
    const t = app.list.targets.find((x) => x.id === c.id);
    const out = [];
    let decisions = {};
    for (const p of t.projects.filter((x) => x.problem === null && !x.downloading && x.reviewable > 0)) {
        const answer = await api(`/api/pr/${encodeURIComponent(c.id)}/${encodeURIComponent(p.project)}?rows=1`);
        if (seq !== app.opening) {
            return null;
        }
        for (const i of answer.items.filter((x) => REVIEWABLE.includes(x.status))) {
            out.push({
                key: `${p.project}/${i.file}`,
                project: p.project,
                file: i.file,
                name: i.id,
                component: String(i.id).split("--")[0],
                mode: i.mode ?? null,
                status: i.status,
            });
        }
        decisions = {
            ...decisions,
            ...Object.fromEntries(Object.entries(answer.decisions ?? {}).map(([k, d]) => [`${p.project}/${k}`, d])),
        };
    }
    out.forEach((s, i) => {
        s.n = i + 1;
        s.decided = Boolean(decisions[s.key]);
    });
    return out;
}

app.openChange = async (id, { snap = null, quiet = false } = {}) => {
    const c = app.change(id);
    if (!c) {
        return;
    }
    const seq = ++app.opening;
    app.curId = id;
    // A change opened later supersedes any load still running: its change is no longer current.
    app.pendingId = null;
    let snaps = [];
    // A change not ready opens to say there is nothing to review yet (design 3.3).
    if (c.total > 0 && !c.notReady) {
        // The picked row is current at once, so a key pressed while its snapshots load acts on it.
        app.pendingId = id;
        draw();
        try {
            snaps = await loadSnaps(c, seq);
        } catch (err) {
            if (seq !== app.opening) {
                return;
            }
            app.pendingId = null;
            draw();
            say(`${c.label} could not be opened: ${err.message}`, "err", [
                { label: "Retry", run: () => app.openChange(id) },
            ]);
            return;
        }
        if (snaps === null) {
            return;
        }
        app.pendingId = null;
    }
    app.openId = id;
    app.snaps = snaps;
    if (snaps.length === 0) {
        // Nothing to review yet: the changes stay in front.
        app.snap = null;
        app.level = 0;
        layout("changes");
        writeAddress(true);
        draw();
        if (!quiet) {
            say(`${c.label}: ${c.count}. Nothing to review yet.`);
        }
        return;
    }
    const wanted = snap && snaps.find((s) => s.key === snap);
    app.snap = (wanted ?? snaps.find((s) => !s.decided) ?? snaps[0]).key;
    app.level = 1;
    layout("snaps");
    writeAddress(true);
    draw();
    app.focusPane = shownNow()[1] ? "snaps" : "viewer";
    (shownNow()[1] ? $("snap-list") : $("viewer")).focus({ preventScroll: true });
    if (snap && !wanted) {
        const parts = snapParts(snap);
        say(`${parts?.file ?? snap} is not in this capture any more: showing the first undecided snapshot.`);
    } else if (!quiet) {
        say(`Opened ${c.label} ${c.title}: ${fmt(c.undecided)} undecided.`);
    }
};

app.nextChange = () => {
    const n = nextNeeding(app.changes, app.sort, app.openId);
    if (!n) {
        say("No other change needs you.");
        return;
    }
    app.openChange(n.id);
};

app.setSort = (key) => {
    app.sort = key;
    say(`Sorted: ${SORTS[key]}.`);
    draw();
};

app.toggleSection = (key) => {
    if (app.secOpen.has(key)) {
        app.secOpen.delete(key);
    } else {
        app.secOpen.add(key);
    }
    draw();
};

app.focusFind = () => {
    app.focusPane = "changes";
    $("chg-find").focus();
    syncHints();
};

app.dismiss = (id) => {
    const c = app.change(id);
    app.dismissed.add(c.dismissKey);
    saveDismissed();
    rebuild();
    draw();
};

app.jobLog = (id) => {
    window.open(app.change(id).logUrl, "_blank", "noopener");
};

app.openOnHost = (id) => {
    window.open(app.change(id).url, "_blank", "noopener");
};

app.copyLink = async (id) => {
    const link = `${location.origin}${location.pathname}${formatAddress({ token: currentToken(), change: id })}`;
    try {
        await navigator.clipboard.writeText(link);
        say(`Link copied: ${app.change(id).label}. It carries your session token: it opens this change on any device.`);
    } catch (err) {
        say(`The link could not be copied: ${err.message}`, "err");
    }
};

// Up and Down: in the changes, the current row; in the snapshot rows, the current snapshot.
app.arrow = (d) => {
    if (app.focusPane === "changes" || app.level === 0) {
        const order = walkOrder(app);
        if (order.length === 0) {
            return false;
        }
        const at = order.findIndex((r) => r.id === app.currentChangeId());
        const next = order[Math.max(0, Math.min(order.length - 1, at < 0 ? 0 : at + d))];
        app.curId = next.id;
        app.level = 0;
        draw();
        document.querySelector(".chg.cur")?.scrollIntoView({ block: "nearest" });
        return true;
    }
    if (app.snaps.length > 0) {
        const at = app.snaps.findIndex((s) => s.key === app.snap);
        app.snap = app.snaps[Math.max(0, Math.min(app.snaps.length - 1, at + d))].key;
        writeAddress(false);
        draw();
        document.querySelector(".srow.cur")?.scrollIntoView({ block: "nearest" });
        return true;
    }
    return false;
};

// Esc in a field: the first clears its text and stays; the second leaves it for its list.
app.escapeField = (f) => {
    if (f.value) {
        f.value = "";
        draw();
        f.focus();
    } else {
        f.blur();
        $("chg-list").focus({ preventScroll: true });
    }
    syncHints();
};

// ---------------------------------------------------------------- menus and boxes

// Focus never stays on the button that opened a menu or box: it returns to the current row of
// the pane the reader was in (design 8.1.8).
function restoreFocus() {
    const [changesShown, snapsShown] = shownNow();
    if (app.focusPane === "changes" && changesShown) {
        $("chg-list").focus({ preventScroll: true });
    } else if (app.focusPane !== "viewer" && snapsShown) {
        $("snap-list").focus({ preventScroll: true });
    } else {
        $("viewer").focus({ preventScroll: true });
    }
    syncHints();
}

function closeMenu() {
    app.menu?.remove();
    app.menu = null;
}

function showMenu(anchor, items) {
    closeMenu();
    const m = el("div", { class: "menu", role: "menu", tabindex: "-1" });
    for (const it of items) {
        const node = control(app, it.id, {
            zone: "menu",
            tag: "div",
            ctx: it.ctx ?? {},
            attrs: {
                class: "mi",
                role: it.checked === undefined ? "menuitem" : "menuitemradio",
                tabindex: "-1",
                "aria-checked": it.checked === undefined ? null : String(it.checked),
            },
            children: [el("span", { class: "tick" }, it.checked ? ic("accept") : null), el("span", {}, it.label)],
        });
        node.addEventListener("click", () => {
            closeMenu();
            if (!document.querySelector("dialog[open]")) {
                restoreFocus();
            }
        });
        m.append(node);
    }
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)}px`;
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
    app.menu = m;
    const nodes = [...m.querySelectorAll(".mi")];
    let at = -1;
    m.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            at = (at + (e.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length;
            nodes[at].focus();
        } else if (e.key === "Enter" && at >= 0) {
            e.preventDefault();
            nodes[at].click();
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeMenu();
            restoreFocus();
        }
    });
    m.focus();
    syncHints();
}

document.addEventListener("pointerdown", (e) => {
    if (app.menu && !app.menu.contains(/** @type {Node} */ (e.target))) {
        closeMenu();
        syncHints();
    }
});

app.sortMenu = (anchor) => {
    showMenu(
        anchor,
        Object.entries(SORTS).map(([k, label]) => ({ id: `sort-${k}`, label, checked: app.sort === k })),
    );
};

app.rowMenu = (id, anchor) => {
    const c = app.change(id);
    showMenu(anchor, [
        ...(c.url ? [{ id: "onhost", label: "Open on GitHub", ctx: { id } }] : []),
        { id: "about", label: "About this change", ctx: { id } },
        { id: "copylink", label: "Copy link", ctx: { id } },
    ]);
};

function openBox(title, ...body) {
    const d = /** @type {HTMLDialogElement} */ ($("dlg"));
    d.replaceChildren(
        el("h3", {}, title),
        ...body,
        el("div", { class: "foot" }, control(app, "closebox", { zone: "box" })),
    );
    d.showModal();
    syncHints();
}

$("dlg").addEventListener("close", restoreFocus);

app.closeBox = () => {
    /** @type {HTMLDialogElement} */ ($("dlg")).close();
    restoreFocus();
};

app.aboutChange = async (id) => {
    const c = app.change(id);
    const head = `${c.kind === "PR" ? `#${c.pr} ` : ""}${c.title}`;
    const facts = el(
        "p",
        { class: "small muted" },
        [c.branch, c.author && `by ${c.author}`].filter(Boolean).join(", "),
    );
    if (c.kind !== "PR") {
        openBox(head, facts);
        return;
    }
    const body = el("div", { class: "body" }, "Loading the description...");
    openBox(head, facts, body);
    try {
        const ctx = await api(`/api/pr-context/${encodeURIComponent(id)}`);
        body.replaceChildren(
            el("p", {}, ctx.body || "No description."),
            ...ctx.comments.map((m) =>
                el(
                    "div",
                    {},
                    el("b", {}, `${m.author ?? "unknown"}, ${String(m.at ?? "").slice(0, 10)}`),
                    el("p", {}, m.body),
                ),
            ),
        );
    } catch (err) {
        body.textContent = `The description could not be read: ${err.message}`;
    }
};

app.messagesBox = () => {
    const kept = messageHistory();
    openBox(
        "Messages",
        kept.length === 0
            ? el("p", { class: "muted" }, "No messages yet.")
            : el(
                  "ul",
                  { class: "small" },
                  kept.map((m) => el("li", {}, `${m.at} ${m.text}`)),
              ),
    );
};

app.showReview = () => {
    draw();
};

// ---------------------------------------------------------------- the token box

function askToken(refused) {
    const field = el("input", {
        type: "password",
        id: "token-field",
        autocomplete: "off",
        "aria-label": "Session token",
    });
    const error = el(
        "p",
        { class: "error", role: "alert" },
        refused ? "The review server did not accept that token: paste it again." : "",
    );
    const form = el(
        "form",
        { class: "tokenbox", id: "token-box" },
        el("label", { for: "token-field" }, "Open the link the server printed, or paste its token"),
        field,
        error,
        el("div", {}, control(app, "usetoken", { zone: "box", attrs: { class: "primary" } })),
    );
    // Enter in the field submits the form: the box's default button, as it shows.
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        runAction(app, "usetoken", {}, "key");
    });
    $("token-box")?.remove();
    $("wait-box")?.remove();
    $("screens").hidden = true;
    $("screens").after(form);
    field.focus();
    syncHints();
}

app.submitToken = () => {
    const field = /** @type {HTMLInputElement} */ ($("token-field"));
    if (!useToken(field.value)) {
        document.querySelector("#token-box .error").textContent = "Paste the token or the URL first.";
        return;
    }
    $("token-box").remove();
    $("screens").hidden = false;
    boot();
};

whenRefused((refused) => askToken(refused));

// ---------------------------------------------------------------- the list

function rebuild() {
    const l = app.list;
    const shares = sharesOf(l.inbox?.groups);
    app.changes = (l.targets ?? []).map((t) =>
        changeOf(t, {
            defaultBranch: l.defaultBranch ?? "master",
            now: l.now ?? Date.now(),
            shares,
            dismissed: app.dismissed ?? new Set(),
        }),
    );
    if (app.dismissed === null) {
        // A first visit: the changes finished before it are not news, so only later finishes offer
        // Dismiss.
        app.dismissed = new Set(app.changes.filter((r) => r.dismissable).map((r) => r.dismissKey));
        for (const r of app.changes) {
            r.dismissable = false;
        }
        saveDismissed();
    }
}

async function loadList(query = "?cached=1") {
    try {
        app.list = await api(`/api/prs${query}`);
        app.listAt = Date.now();
        app.failed = null;
    } catch (err) {
        app.failed = err.message;
        say(`The review server did not answer: ${err.message}`, "err", [
            { label: "Retry", run: () => (arrived ? app.refresh() : firstLoad()) },
        ]);
        return false;
    }
    if (app.list.targets === null) {
        return false; // the first load is still running
    }
    rebuild();
    return true;
}

app.refresh = async () => {
    app.refreshing = true;
    drawTop();
    settle();
    // A failed load leaves the old answer, still refreshing: stop there, the failure said once.
    await loadList("?refresh=1");
    while (app.failed === null && app.list?.refreshing) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await loadList();
    }
    app.refreshing = false;
    draw();
    if (app.failed === null) {
        say(app.list?.error ? `GitHub did not answer: ${app.list.error}` : "Refreshed.", app.list?.error ? "err" : "");
    }
};

// One poll timer. It is set before each load, so a load that never settles (a refused token)
// does not stop polling, and boot after a new token does not start a second loop.
let pollTimer = null;
function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, POLL_MS);
}

async function poll() {
    schedulePoll();
    if (!arrived) {
        await firstLoad();
    } else if (await loadList()) {
        if (app.openId && !app.change(app.openId)) {
            say(`${app.openId} is no longer listed: showing every change.`);
            app.openId = null;
            app.snaps = [];
            app.snap = null;
            app.level = 0;
            layout("changes");
        }
        draw();
    } else if (Array.isArray(app.list?.targets)) {
        drawTop();
    } else {
        draw();
    }
}

// The state the address names: a change and a snapshot, opened once the list is in.
async function follow(wanted) {
    if (wanted.change) {
        if (app.change(wanted.change)) {
            if (wanted.change !== app.openId || wanted.snap !== app.snap) {
                await app.openChange(wanted.change, { snap: wanted.snap, quiet: wanted.old });
            }
        } else {
            say(`${wanted.change} is no longer listed: showing every change.`);
        }
        return;
    }
    if (app.openId !== null) {
        app.openId = null;
        app.snaps = [];
        app.snap = null;
        app.level = 0;
        layout("changes");
        draw();
    }
}

addEventListener("popstate", () => follow(parseAddress(location.hash)));
addEventListener("resize", () => {
    // A two-level change that becomes one level drops to the one level, the list shown.
    if (app.level === 2 && !twoLevels(app.snaps.length, innerWidth)) {
        app.level = 1;
        say("The window is 1400 px or wider: the list is shown beside the viewer.");
    }
    layout(shownNow()[1] ? "snaps" : "changes");
    draw();
});
// In a two-level change, a click in the viewer means viewing.
document.addEventListener("mousedown", (e) => {
    const t = /** @type {Element} */ (e.target);
    if (t.closest?.("#stage") && app.level === 1 && twoLevels(app.snaps.length, innerWidth) && app.snap) {
        app.openSnapshot();
    }
});
document.addEventListener("focusin", (e) => {
    const t = /** @type {Element} */ (e.target);
    if (t.closest?.("#changes")) {
        app.focusPane = "changes";
    } else if (t.closest?.("#snaps")) {
        app.focusPane = "snaps";
    } else if (t.closest?.("#viewer")) {
        app.focusPane = "viewer";
    }
    syncHints();
});
document.addEventListener("focusout", () => queueMicrotask(syncHints));
$("chg-find").addEventListener("input", () => {
    draw();
});

// Whether the first list is in and the page has opened where the reader starts.
let arrived = false;

async function boot() {
    startUsage();
    const wanted = app.wanted;
    if (wanted.old) {
        // Today's page's link: written again in the new page's form, in place.
        history.replaceState(null, "", formatAddress({ ...wanted, token: currentToken() }));
    }
    arrived = false;
    layout("changes");
    draw();
    await firstLoad();
    schedulePoll();
}

// Until the first list is in, it is asked for every half second. A failed ask stops there, its
// message and Retry left on screen; Retry and the next poll start this again.
async function firstLoad() {
    app.bootAt = Date.now();
    while (!(await loadList()) && app.failed === null) {
        draw();
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    draw();
    if (app.failed !== null || arrived) {
        return;
    }
    arrived = true;
    const wanted = app.wanted;
    if (wanted.change) {
        await follow(wanted);
    } else if (app.changes.length === 1) {
        // One change: the page opens straight into it.
        await app.openChange(app.changes[0].id);
    } else {
        const first = sectionsOf(app.changes, app.sort).get("needs")[0] ?? walkOrder(app)[0];
        app.curId = first?.id ?? null;
        draw();
        say(
            app.changes.length === 0
                ? "Ready. The server checks the code host every 2 minutes."
                : "Choose a change on the left: Up / Down move, Open [Enter] opens it.",
        );
    }
}

logUsage("load", { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, page: "next" });
startKeys(app);
if (currentToken()) {
    boot();
} else {
    askToken(false);
}
