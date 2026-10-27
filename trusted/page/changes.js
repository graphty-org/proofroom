/*
 * The changes pane: every change that has captures or will have them, in seven sections. The
 * model (`changeOf`, `sectionsOf`, `nextNeeding`, `matchesFind`) is pure, from the server's target
 * summaries (GET /api/prs); `drawChanges` builds the pane from it.
 */

import { control } from "./actions.js";
import { GITHUB_WORDS } from "./messages.js";
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
 * @returns {"ready" | "none" | "downloading" | "capturing" | "expired" | "failed"} the state: "none"
 *     for a project the change has no capture of (not affected, or never captured), which hides
 *     nothing of the projects it has
 */
export function projectState(p) {
    if (p.downloading) {
        return "downloading";
    }
    if (p.problem === null || p.problem === undefined) {
        return "ready";
    }
    if (p.problem === "no capture" || p.problem === "not affected") {
        return "none";
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
 * @param {{ defaultBranch: string, now: number, shares?: Map<string, string>, dismissed?: Set<string>,
 *     words?: ReturnType<typeof import("./messages.js").wordsOf> }} at the default branch's name, the server's clock, each
 *     change's "shares N baselines with #M" badge, the finished rows the reader dismissed (by
 *     `dismissKey`), and the code host's words
 * @returns {any} the row's model
 */
export function changeOf(t, { defaultBranch, now, shares = new Map(), dismissed = new Set(), words = GITHUB_WORDS }) {
    // A project with no capture (not affected, never captured) is left out of the row, so it
    // hides nothing of the projects that were captured. When no project was captured at all, the
    // ones never captured read as failed captures.
    const all = t.projects ?? [];
    const withCapture = all.filter((p) => projectState(p) !== "none");
    const projects = withCapture.length > 0 ? withCapture : all.filter((p) => p.problem !== "not affected");
    const stateOf = (p) => (projectState(p) === "none" ? "failed" : projectState(p));
    const states = projects.map(stateOf);
    const readyN = states.filter((s) => s === "ready").length;
    const total = projects.reduce((n, p) => n + (p.reviewable ?? 0), 0);
    const decided = projects.reduce((n, p) => n + (p.decided ?? 0), 0);
    const undecided = projects.reduce((n, p) => n + (p.undecided ?? 0), 0);
    const failedStories = projects.filter((p) => (p.failed ?? []).length > 0);
    const local = t.local === true;
    // An ISO time only: Date.parse reads other text too, as some year.
    const readyAt = /^\d{4}-\d\d-\d\dT/.test(t.readyAt ?? "") ? Date.parse(t.readyAt) : null;
    // A capture made from the page is named by what it captured (captures.js).
    const captured = t.capture?.label ?? "";
    const kind = t.localBranch
        ? "branch"
        : local
          ? captured === "working tree"
              ? "working tree"
              : captured.startsWith("branch ")
                ? "branch"
                : "preview"
          : t.pr === null
            ? "seed"
            : "PR";
    // Plain git's changes are branches: a branch's row is named by the branch, as a number names a
    // pull request's.
    const byBranch = words.numberPrefix === "" && t.localBranch && t.branch;
    const row = {
        id: t.id,
        kind,
        // The tag before the title: the host's word for its changes ("PR"), else what was captured.
        tag: kind === "PR" ? words.changeTag : kind,
        // "#3486 " before the title of a change the host numbers.
        num: kind === "PR" ? `${words.numberPrefix}${t.pr} ` : "",
        pr: t.pr,
        label: t.pr !== null && !local ? `${words.numberPrefix}${t.pr}` : byBranch ? t.branch : kind,
        // A change the code host knows: a pull request, or under plain git a branch.
        hostChange: kind === "PR" || Boolean(byBranch),
        title: kind === "seed" ? `Seed from ${defaultBranch}` : (t.title ?? ""),
        head: t.head ?? null,
        // The page's capture this row stands for while it runs or after it failed (captureRowOf).
        capId: null,
        branch:
            t.branch ??
            (t.pr === null && !local ? `${defaultBranch}${t.commit ? ` at ${t.commit.slice(0, 7)}` : ""}` : null),
        author: t.author ?? null,
        source:
            local || t.localBranch || (projects.length > 0 && projects.every((p) => p.preview))
                ? "this machine"
                : (words.ciName ?? "this machine"),
        ready: `${readyN} of ${projects.length}`,
        readyAt,
        age: readyAt === null ? null : ageText(now - readyAt),
        total,
        decided,
        undecided,
        draft: t.draft === true,
        lookOnly: t.lookOnly === true,
        url: t.url ?? null,
        logUrl: projects.find((p) => stateOf(p) !== "ready" && p.logUrl)?.logUrl ?? t.runUrl ?? null,
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
            count: `Capturing on ${words.ciName ?? "this machine"}, ${readyN} of ${plural(projects.length, "project")}`,
        });
    } else if (states.includes("failed")) {
        const names = projects.filter((p) => stateOf(p) === "failed").map((p) => p.project);
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
                .filter((p) => stateOf(p) === "expired")
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
    if (t.pendingPush || t.unpushed) {
        row.badges.push({ text: "pending push" });
    }
    if (projects.some((p) => p.preview && p.ci && p.ci.status !== "completed")) {
        row.badges.push({ text: `${words.ciName ?? "CI"} pending` });
    }
    if (shares.has(t.id)) {
        row.badges.push({ text: shares.get(t.id) });
    }
    return row;
}

const CAPTURE_KINDS = { tree: "working tree", branch: "branch", change: "PR" };

/**
 * The changes row of a capture started from the page while it waits or runs, or after it failed or
 * was cancelled (design 3.5): Capturing or downloading, then Not ready. A capture that finished is
 * the row of what it made instead.
 * @param {any} c the capture, as GET /api/captures lists it
 * @param {{ now: number, words?: ReturnType<typeof import("./messages.js").wordsOf>, status?: boolean }} at the
 *     server's clock, the code host's words, and whether the capture store reports CI job states
 *     (without them a capture on CI has no count)
 * @returns {any} the row's model
 */
export function captureRowOf(c, { now, words = GITHUB_WORDS, status = true }) {
    const kind = CAPTURE_KINDS[c.what.kind];
    const failed = c.state === "failed" || c.state === "cancelled";
    const id = `capture-${c.id}`;
    const onCi = c.where === "ci";
    return {
        id,
        capId: c.id,
        kind,
        tag: kind === "PR" ? words.changeTag : kind,
        num: kind === "PR" ? `${words.numberPrefix}${c.what.number} ` : "",
        pr: c.what.number ?? null,
        label: kind === "PR" ? `${words.numberPrefix}${c.what.number}` : kind,
        title: kind === "PR" ? (c.what.title ?? "") : `Capture of ${c.what.label}`,
        head: c.head,
        branch: c.what.branch ?? null,
        author: c.what.author ?? null,
        source: onCi ? (words.ciName ?? "CI") : "this machine",
        onCi,
        ready: `0 of ${c.projects.length}`,
        readyAt: c.createdAt,
        age: ageText(now - c.createdAt),
        total: 0,
        decided: 0,
        undecided: 0,
        draft: false,
        lookOnly: false,
        url: null,
        logUrl: null,
        runKey: id,
        projects: c.projects,
        counts: {},
        badges: [],
        stale: 0,
        evicted: null,
        deleted: false,
        state: failed ? "failed" : "capturing",
        mark: failed ? ["failed", "c-failed"] : ["spin", "c-ink2"],
        count:
            c.state === "cancelled"
                ? "Capture cancelled by you"
                : failed
                  ? `Capture failed: ${c.error}`
                  : onCi
                    ? `Capturing on ${words.ciName ?? "CI"}${status ? `, ${fmt(c.done)} of ${plural(c.projects.length, "project")}` : ""}`
                    : c.state === "queued"
                      ? "On this machine, queued: local captures run one at a time"
                      : c.total > 0
                        ? `On this machine, ${fmt(c.done)} of ${fmt(c.total)} stories`
                        : // No count before the capture has counted its stories, as on the Captures screen.
                          "On this machine",
        notReady: true,
        dismissKey: id,
        dismissable: false,
        section: failed ? "notready" : "busy",
    };
}

/**
 * The "shares N baselines with #M" badge of each change in a group of changes that change the same
 * baseline files (the server's inbox groups).
 * @param {{ ids: string[], prs: number[], shared: string[] }[] | null | undefined} groups the groups
 * @param {ReturnType<typeof import("./messages.js").wordsOf>} [words] the code host's words
 * @returns {Map<string, string>} the badge text by change id
 */
export function sharesOf(groups, words = GITHUB_WORDS) {
    const out = new Map();
    for (const g of groups ?? []) {
        g.ids.forEach((id, i) => {
            const other = g.prs.find((_, j) => j !== i);
            if (other !== undefined && g.shared.length > 0) {
                out.set(id, `shares ${plural(g.shared.length, "baseline")} with ${words.numberPrefix}${other}`);
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
    const title = `${r.num}${r.title}`;
    const details = [r.branch, r.author, r.source, `${r.ready} projects ready`, r.age].filter(Boolean).join("  ");
    const acts = [];
    if (r.capId !== null) {
        // A capture from the page: its log is on the Captures screen. One on CI says how to follow
        // it, and is cancelled only where the store can cancel.
        acts.push(
            ...(r.state === "capturing"
                ? [
                      r.onCi ? control(app, "joblog", { zone: "rows", ctx: { id: r.id } }) : null,
                      !r.onCi || app.captures?.ci?.cancel
                          ? control(app, "capcancel", { zone: "rows", ctx: { cap: r.capId } })
                          : null,
                  ].filter(Boolean)
                : [
                      control(app, "joblog", { zone: "rows", ctx: { id: r.id } }),
                      control(app, "capagain", { zone: "rows", ctx: { id: r.id, label: "Retry" } }),
                  ]),
        );
    } else if (["failed", "capturing"].includes(r.state) && r.logUrl) {
        acts.push(control(app, "joblog", { zone: "rows", ctx: { id: r.id } }));
    }
    acts.push(...app.finishControls(r));
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
                el("span", { class: "tag" }, r.tag),
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
            const head = control(app, "section", {
                zone: "rows",
                ctx: { section: key, label },
                attrs: { class: "sec", "data-sec": key, "aria-expanded": open ? "true" : "false" },
                children: [
                    ic(open ? "chevOpen" : "chevClosed"),
                    el("span", { class: "grow" }, label),
                    el("span", { class: "num" }, String(these.length)),
                ],
            });
            // Decided, not finished carries Finish all N... (or Stop while it runs) before its count:
            // a button of its own beside the header's, never inside it.
            const fa = key === "decided" ? app.finishAllControl() : null;
            if (fa) {
                fa.classList.add("fa");
                fa.style.setProperty("--numw", `${String(these.length).length}ch`);
            }
            out.push(fa ? el("div", { class: "sechead" }, head, fa) : head);
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
