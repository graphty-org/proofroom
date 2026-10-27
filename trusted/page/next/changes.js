/*
 * The changes pane: every change that has captures or will have them, in seven sections. The
 * model (`changeOf`, `sectionsOf`, `nextNeeding`, `matchesFind`) is pure, from the server's target
 * summaries (GET /api/prs); `drawChanges` builds the pane from it.
 */

import { control } from "./actions.js";
import { ageText, el, fmt, ic, megabytes } from "./ui.js";

/** The sections, in order: key, title, open by default. */
export const SECTIONS = [
    ["needs", "Needs you", true],
    ["decided", "Decided, not finished", true],
    ["busy", "Capturing or downloading", true],
    ["notready", "Not ready", true],
    ["look", "Look only", true],
    ["nothing", "Nothing to decide", false],
    ["drafts", "Drafts", false],
];

/** The Sort menu's orders. */
export const SORTS = { needs: "Needs me first", newest: "Newest", most: "Most undecided", author: "Author" };

/**
 * A project's state, from its summary.
 * @param {any} p the project summary
 * @returns {"ready" | "downloading" | "capturing" | "expired" | "failed"} the state
 */
export function projectState(p) {
    if (p.downloading) {
        return "downloading";
    }
    if (p.problem === null || p.problem === undefined) {
        return "ready";
    }
    if (/still running|waiting for CI/.test(p.problem)) {
        return "capturing";
    }
    return /expired/.test(p.problem) ? "expired" : "failed";
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One changes row, from a target summary.
 * @param {any} t the summary
 * @param {{ defaultBranch: string, now: number, shares?: Map<string, string>, dismissed?: Set<string> }} at
 *     the default branch's name, the server's clock, each change's "shares N baselines with #M"
 *     badge, and the finished rows the reader dismissed (by `dismissKey`)
 * @returns {any} the row's model
 */
export function changeOf(t, { defaultBranch, now, shares = new Map(), dismissed = new Set() }) {
    const projects = t.projects ?? [];
    const states = projects.map(projectState);
    const readyN = states.filter((s) => s === "ready").length;
    const total = projects.reduce((n, p) => n + (p.reviewable ?? 0), 0);
    const decided = projects.reduce((n, p) => n + (p.decided ?? 0), 0);
    const undecided = projects.reduce((n, p) => n + (p.undecided ?? 0), 0);
    const failedStories = projects.filter((p) => (p.failed ?? []).length > 0);
    const local = t.local === true;
    // An ISO time only: Date.parse reads other text too, as some year.
    const readyAt = /^\d{4}-\d\d-\d\dT/.test(t.readyAt ?? "") ? Date.parse(t.readyAt) : null;
    const kind = local ? "preview" : t.pr === null ? "seed" : "PR";
    const row = {
        id: t.id,
        kind,
        pr: t.pr,
        label: t.pr !== null && !local ? `#${t.pr}` : kind,
        title: kind === "seed" ? `Seed from ${defaultBranch}` : (t.title ?? ""),
        branch:
            t.branch ??
            (t.pr === null && !local ? `${defaultBranch}${t.commit ? ` at ${t.commit.slice(0, 7)}` : ""}` : null),
        author: t.author ?? null,
        source: local || (projects.length > 0 && projects.every((p) => p.preview)) ? "this machine" : "CI",
        ready: `${readyN} of ${projects.length}`,
        readyAt,
        age: readyAt === null ? null : ageText(now - readyAt),
        total,
        decided,
        undecided,
        draft: t.draft === true,
        lookOnly: t.lookOnly === true,
        url: t.url ?? null,
        logUrl: projects.find((p) => projectState(p) !== "ready" && p.logUrl)?.logUrl ?? t.runUrl ?? null,
        runKey: `${t.runId}-${t.runAttempt}`,
        projects: projects.map((p) => p.project),
        counts: projects.reduce((all, p) => {
            for (const [k, v] of Object.entries(p.counts ?? {})) {
                all[k] = (all[k] ?? 0) + v;
            }
            return all;
        }, {}),
        badges: [],
        stale: t.stale ?? 0,
        // The disk budget evicted its images: the bytes opening it downloads again (design 11.1).
        evicted: t.evicted && !t.evicted.deleted ? t.evicted.bytes : null,
        deleted: t.evicted?.deleted === true,
    };
    // The state, its mark and its words (design 3.5). A look-only change is look only whatever its
    // projects' state: it is viewed, never decided.
    if (row.lookOnly) {
        Object.assign(row, { state: "look", mark: ["eye", "c-ink2"], count: `Look only: ${fmt(total)} to view` });
    } else if (t.downloading || states.includes("downloading")) {
        const d = t.download ?? { done: 0, total: projects.length, bytesDone: 0 };
        Object.assign(row, {
            state: "downloading",
            mark: ["down", "c-ink2"],
            count: `Downloading: ${d.done} of ${d.total} projects${d.bytesDone > 0 ? ` (${megabytes(d.bytesDone)})` : ""}`,
        });
    } else if (states.includes("capturing")) {
        Object.assign(row, {
            state: "capturing",
            mark: ["spin", "c-ink2"],
            count: `Capturing on CI, ${readyN} of ${plural(projects.length, "project")}`,
        });
    } else if (states.includes("failed")) {
        const names = projects.filter((p) => projectState(p) === "failed").map((p) => p.project);
        Object.assign(row, {
            state: "failed",
            mark: ["failed", "c-failed"],
            count: `Capture failed: ${names.join(", ")}`,
        });
    } else if (states.includes("expired")) {
        Object.assign(row, {
            state: "incomplete",
            mark: ["failed", "c-failed"],
            count: `Incomplete: ${readyN} of ${plural(projects.length, "project")}`,
            why: projects
                .filter((p) => projectState(p) === "expired")
                .map((p) => `${p.project}: ${p.problem}`)
                .join("\n"),
        });
    } else if (failedStories.length > 0) {
        const n = failedStories.reduce((k, p) => k + p.failed.length, 0);
        Object.assign(row, {
            state: "failed",
            mark: ["failed", "c-failed"],
            count: `Capture failed: ${failedStories.map((p) => p.project).join(", ")}, ${plural(n, "story", "stories")}`,
        });
    } else if (total === 0) {
        Object.assign(row, { state: "nothing", mark: null, count: "No differences" });
    } else if (undecided === 0 && (t.unpublished ?? 0) === 0) {
        Object.assign(row, { state: "finished", mark: ["accept", "c-accept"], count: "Finished, signed" });
    } else if (undecided === 0) {
        Object.assign(row, {
            state: "decided",
            mark: ["full", "c-accept"],
            count: `${fmt(total)} decided, not finished`,
        });
    } else if (decided > 0) {
        Object.assign(row, {
            state: "half",
            mark: ["half", "c-new"],
            count: `${fmt(decided)} of ${fmt(total)} decided`,
        });
    } else {
        Object.assign(row, { state: "review", mark: ["open", "c-new"], count: `${fmt(undecided)} undecided` });
    }
    if (row.deleted && row.state !== "look") {
        Object.assign(row, {
            state: "deleted",
            mark: ["failed", "c-failed"],
            count: "Images deleted by the code host: capture again",
        });
    } else if (row.evicted !== null && ["review", "half", "decided", "finished", "nothing"].includes(row.state)) {
        // Its counts as before, an open circle, and what opening it costs.
        row.mark = ["open", "c-ink2"];
        row.badges.push({ text: `Images not on disk: opening downloads ${megabytes(row.evicted)}` });
    } else {
        row.evicted = null;
    }
    // Nothing to review until its captures are in: a project still downloading or capturing, or one
    // whose capture failed or expired. A capture with failed stories has those stories to review.
    row.notReady =
        ["downloading", "capturing", "incomplete", "deleted"].includes(row.state) || states.includes("failed");
    row.dismissKey = `${t.id} ${row.runKey}`;
    row.dismissable = row.state === "finished" && !dismissed.has(row.dismissKey);
    row.section =
        row.state === "look"
            ? "look"
            : ["downloading", "capturing"].includes(row.state)
              ? "busy"
              : ["failed", "incomplete", "deleted"].includes(row.state)
                ? "notready"
                : ["nothing", "finished"].includes(row.state)
                  ? "nothing"
                  : row.draft && decided === 0
                    ? "drafts"
                    : row.state === "decided"
                      ? "decided"
                      : "needs";
    // Badges.
    if (row.stale > 0 && row.state !== "finished") {
        row.badges.push({
            text: `Changed on ${defaultBranch}: ${plural(row.stale, "newer baseline")}`,
            mark: ["clock", "c-changed"],
        });
    }
    if (t.behind) {
        row.badges.push({ text: `behind ${t.behind}` });
    }
    if (t.pendingPush) {
        row.badges.push({ text: "pending push" });
    }
    if (projects.some((p) => p.preview && p.ci && p.ci.status !== "completed")) {
        row.badges.push({ text: "CI pending" });
    }
    if (shares.has(t.id)) {
        row.badges.push({ text: shares.get(t.id) });
    }
    return row;
}

/**
 * The "shares N baselines with #M" badge of each change in a group of changes that change the same
 * baseline files (the server's inbox groups).
 * @param {{ ids: string[], prs: number[], shared: string[] }[] | null | undefined} groups the groups
 * @returns {Map<string, string>} the badge text by change id
 */
export function sharesOf(groups) {
    const out = new Map();
    for (const g of groups ?? []) {
        g.ids.forEach((id, i) => {
            const other = g.prs.find((_, j) => j !== i);
            if (other !== undefined && g.shared.length > 0) {
                out.set(id, `shares ${plural(g.shared.length, "baseline")} with #${other}`);
            }
        });
    }
    return out;
}

const SORTERS = {
    needs: () => 0,
    newest: (a, b) => (b.readyAt ?? -Infinity) - (a.readyAt ?? -Infinity),
    most: (a, b) => b.undecided - a.undecided,
    author: (a, b) => String(a.author ?? "").localeCompare(String(b.author ?? "")),
};

/**
 * Whether a row matches the Find text: its number, title, branch or author.
 * @param {any} row the row
 * @param {string} text the text
 * @returns {boolean} it matches
 */
export function matchesFind(row, text) {
    const q = text.trim().toLowerCase().replace(/^#/, "");
    return q === "" || `${row.pr ?? ""} ${row.title} ${row.branch ?? ""} ${row.author ?? ""}`.toLowerCase().includes(q);
}

/**
 * The rows of each section, in the order they show. Needs you, in "Needs me first": the fewest
 * snapshots first, then the longest waiting, so small changes clear first.
 * @param {any[]} rows every row
 * @param {string} sort the Sort menu's choice
 * @param {string} [find] the Find text
 * @returns {Map<string, any[]>} the rows by section key, every section present
 */
export function sectionsOf(rows, sort, find = "") {
    const out = new Map(SECTIONS.map(([k]) => [k, []]));
    for (const r of rows) {
        if (matchesFind(r, find)) {
            out.get(r.section).push(r);
        }
    }
    const waiting = (a, b) => (a.readyAt ?? Infinity) - (b.readyAt ?? Infinity);
    for (const [k, list] of out) {
        list.sort(
            k === "needs" && sort === "needs"
                ? (a, b) => a.total - b.total || waiting(a, b)
                : (a, b) => SORTERS[sort](a, b) || (k === "needs" ? a.total - b.total : 0),
        );
    }
    return out;
}

/**
 * The next change that needs you: the first of Needs you, in the order it shows, after the open
 * change (or from the top). Look-only previews are never in Needs you.
 * @param {any[]} rows every row
 * @param {string} sort the Sort menu's choice
 * @param {string | null} openId the open change
 * @returns {any | null} the change, or null when no other needs you
 */
export function nextNeeding(rows, sort, openId) {
    const needs = sectionsOf(rows, sort).get("needs");
    const at = needs.findIndex((r) => r.id === openId);
    const order = at < 0 ? needs : [...needs.slice(at + 1), ...needs.slice(0, at)];
    return order.find((r) => r.id !== openId) ?? null;
}

// ---------------------------------------------------------------- the pane

/**
 * One change's two-line row.
 * @param {any} app the page
 * @param {any} r the row
 * @returns {HTMLElement} the row
 */
function rowOf(app, r) {
    const current = r.id === app.currentChangeId();
    const title = `${r.pr !== null && r.kind === "PR" ? `#${r.pr} ` : ""}${r.title}`;
    const details = [r.branch, r.author, r.source, `${r.ready} projects ready`, r.age].filter(Boolean).join("  ");
    const acts = [];
    if (["failed", "capturing"].includes(r.state) && r.logUrl) {
        acts.push(control(app, "joblog", { zone: "rows", ctx: { id: r.id } }));
    }
    if (r.dismissable) {
        acts.push(control(app, "dismiss", { zone: "rows", ctx: { id: r.id } }));
    }
    if (current && app.level === 0) {
        acts.push(control(app, "openchg", { zone: "rows", ctx: { id: r.id } }));
    }
    return control(app, "pickchg", {
        zone: "rows",
        tag: "div",
        ctx: { id: r.id },
        attrs: {
            class: `chg ${current ? "cur" : ""}`,
            "data-chg": r.id,
            title,
            role: "option",
            "aria-selected": current ? "true" : "false",
            "aria-label": `${title}: ${r.count}`,
        },
        children: [
            el(
                "div",
                { class: "l1" },
                el("span", { class: "tag" }, r.kind),
                el("span", { class: "t ell grow" }, title),
                control(app, "rowmenu", { zone: "rows", ctx: { id: r.id } }),
            ),
            el(
                "div",
                { class: "l2" },
                el(
                    "span",
                    { class: "cnt", title: r.why ?? null },
                    r.mark ? ic(r.mark[0], r.mark[1]) : null,
                    el("span", { class: r.mark ? "" : "muted" }, r.count),
                ),
                el("span", { class: "ell grow" }, details),
                r.badges.map((b) =>
                    el("span", { class: "badge", title: b.text }, b.mark ? ic(b.mark[0], b.mark[1]) : null, b.text),
                ),
                acts,
            ),
        ],
    });
}

/**
 * Builds the changes pane's list: the sections in order with their counts, or the empty states.
 * @param {any} app the page
 */
export function drawChanges(app) {
    performance.mark("changes-start");
    const list = document.getElementById("chg-list");
    const rows = app.changes;
    const needs = rows.filter((r) => r.section === "needs").length;
    document.title = needs > 0 ? `(${needs}) Visual review` : "Visual review";
    const find = app.findText();
    const sections = sectionsOf(rows, app.sort, find);
    const shownN = [...sections.values()].reduce((n, l) => n + l.length, 0);
    document.getElementById("chg-count").textContent = find.trim()
        ? `${shownN} of ${rows.length} match`
        : `${rows.length} change${rows.length === 1 ? "" : "s"}`;
    if (rows.length === 0) {
        list.replaceChildren(el("p", { class: "muted nochg" }, "No changes yet"));
    } else {
        const out = [];
        if (rows.every((r) => r.section !== "needs")) {
            const busy = rows.filter((r) => r.section === "busy").length;
            const nothing = rows.filter((r) => r.section === "nothing").length;
            out.push(
                el(
                    "p",
                    { class: "small muted empty" },
                    `Nothing needs you. ${busy} capturing, ${nothing} with nothing to decide.`,
                ),
            );
        }
        for (const [key, label] of SECTIONS) {
            const these = sections.get(key);
            if (these.length === 0) {
                continue;
            }
            const open = app.sectionOpen(key);
            out.push(
                control(app, "section", {
                    zone: "rows",
                    ctx: { section: key, label },
                    attrs: { class: "sec", "data-sec": key, "aria-expanded": open ? "true" : "false" },
                    children: [
                        ic(open ? "chevOpen" : "chevClosed"),
                        el("span", { class: "grow" }, label),
                        el("span", { class: "num" }, String(these.length)),
                    ],
                }),
            );
            if (open) {
                out.push(...these.map((r) => rowOf(app, r)));
            }
        }
        list.replaceChildren(...(shownN === 0 ? [el("p", { class: "muted empty" }, "Nothing matches.")] : out));
    }
    performance.measure("changes-pane", "changes-start");
}

/**
 * The rows in the order Up and Down walk them: the open sections' rows, as shown.
 * @param {any} app the page
 * @returns {any[]} the rows
 */
export function walkOrder(app) {
    const sections = sectionsOf(app.changes, app.sort, app.findText());
    return SECTIONS.flatMap(([k]) => (app.sectionOpen(k) ? sections.get(k) : []));
}
