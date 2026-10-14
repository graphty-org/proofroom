/**
 * The `usage` command: reads the review page's usage events (`<workDir>/state/usage-events.jsonl`,
 * written by `serve` when the config turns `usage` on) and sums them up as facts about how reviews
 * go: how long an item takes, which controls are used and which never are, how often the reviewer
 * goes back, hesitates, or meets an error. Standard library only.
 */

import { readFileSync } from "node:fs";

/** Where `serve` appends the events, in `<workDir>/state`. */
export const USAGE_FILE = "usage-events.jsonl";

/** A decision this long after its item was shown counts as hesitation. */
const HESITATION_MS = 15000;

/**
 * Reads the events, skipping lines that are not JSON (a write cut short) and, with `since`, the
 * events before it.
 * @param {string} file the JSONL file
 * @param {number} [since] the earliest time kept, in milliseconds since the epoch
 * @returns {object[]} the events, oldest first
 */
export function readUsage(file, since = 0) {
    let text;
    try {
        text = readFileSync(file, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") {
            return [];
        }
        throw err;
    }
    const events = [];
    for (const line of text.split("\n")) {
        try {
            const e = JSON.parse(line);
            if (e && typeof e === "object" && Number.isFinite(e.at) && e.at >= since) {
                events.push(e);
            }
        } catch {
            // An empty or broken line.
        }
    }
    return events.sort((a, b) => a.at - b.at);
}

const quantile = (values, q) => {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const timing = (values) => ({ n: values.length, median: quantile(values, 0.5), p90: quantile(values, 0.9) });
const rate = (part, whole) => (whole === 0 ? null : part / whole);
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const sortedCounts = (map) =>
    [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([name, n]) => ({ name, n }));

/**
 * One session: when it ran, on what, and how much happened.
 * @param {string} id the session id
 * @param {object[]} list its events, oldest first
 * @returns {object} the session's line of the summary
 */
function sessionOf(id, list) {
    const idle = list.filter((e) => e.type === "idle").reduce((n, e) => n + e.ms, 0);
    const span = list.at(-1).at - list[0].at;
    const load = list.find((e) => e.type === "load");
    const pointers = new Set(list.filter((e) => e.type === "pointer").map((e) => e.p));
    const touch = pointers.has("touch") || pointers.has("pen") || (pointers.size === 0 && load?.coarse === true);
    return {
        session: id,
        start: new Date(list[0].at).toISOString(),
        minutes: Math.round(span / 6000) / 10,
        // An idle event names the gap before it, so the session's active time leaves it out.
        activeMs: Math.max(0, span - idle),
        targets: new Set(list.filter((e) => e.type === "project").map((e) => e.id)).size,
        items: list.filter((e) => e.type === "item").length,
        decisions: list.filter((e) => e.type === "decide").reduce((n, e) => n + (e.n ?? 1), 0),
        pointer: touch ? "touch" : "mouse",
        viewport: load ? [load.w, "x", load.h, "@", load.dpr].join("") : null,
    };
}

/**
 * Sums the events up.
 * @param {object[]} events the events, from readUsage
 * @returns {object} the summary
 */
export function summarize(events) {
    /** @type {Map<string, object[]>} */
    const sessions = new Map();
    for (const e of events) {
        if (!sessions.has(e.s)) {
            sessions.set(e.s, []);
        }
        sessions.get(e.s).push(e);
    }
    const byType = (type) => events.filter((e) => e.type === type);
    const items = byType("item");
    const single = byType("decide").filter((e) => e.n === undefined);
    const bulk = byType("decide").filter((e) => e.n !== undefined);
    const groupBy = (list, key) => {
        const out = {};
        for (const e of list) {
            const k = e[key] ?? "unknown";
            out[k] ??= [];
            out[k].push(e.ms);
        }
        return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, timing(v)]));
    };

    // Controls: presses, and the ones shown but never pressed.
    const presses = new Map();
    for (const e of byType("press")) {
        bump(presses, e.c);
    }
    const seen = new Set(byType("controls").flatMap((e) => e.c ?? []));
    const neverUsed = [...seen].filter((c) => !presses.has(c)).sort((a, b) => a.localeCompare(b));
    const controls = sortedCounts(new Map([...presses].filter(([c]) => !String(c).startsWith("key-"))));
    const keys = sortedCounts(new Map([...presses].filter(([c]) => String(c).startsWith("key-"))));

    const perSession = [...sessions].map(([id, list]) => sessionOf(id, list));
    const activeMs = perSession.reduce((n, x) => n + x.activeMs, 0);
    const decisions = perSession.reduce((n, x) => n + x.decisions, 0);
    const touch = perSession.filter((x) => x.pointer === "touch").length;
    const mouse = perSession.length - touch;

    // View changes per item shown, and how many items were reached by going back.
    const viewSwitches = byType("set").filter((e) => ["view", "zoom"].includes(e.key)).length;
    const projects = byType("project");
    const finishes = byType("finish-end").filter((e) => e.kind !== "update");
    const starts = byType("finish-start").filter((e) => e.kind !== "update");
    return {
        events: events.length,
        from: events[0] ? new Date(events[0].at).toISOString() : null,
        to: events.at(-1) ? new Date(events.at(-1).at).toISOString() : null,
        sessions: { n: sessions.size, touch, mouse, list: perSession },
        items: {
            shown: items.length,
            distinct: new Set(items.map((e) => `${e.project}/${e.file}`)).size,
            backtracked: items.filter((e) => e.back).length,
            backtrackRate: rate(items.filter((e) => e.back).length, items.length),
            imagesDrawn: timing(byType("drawn").map((e) => e.ms)),
        },
        decisions: {
            n: decisions,
            single: single.length,
            bulk: bulk.reduce((n, e) => n + e.n, 0),
            byDecision: Object.fromEntries(single.reduce((m, e) => bump(m, e.d), new Map())),
            changed: single.filter((e) => e.was !== null && e.was !== undefined).length,
            undos: byType("undo").reduce((n, e) => n + (e.n ?? 1), 0),
            perMinute: activeMs > 0 ? Math.round((decisions / (activeMs / 60000)) * 10) / 10 : null,
            timePerItem: timing(single.map((e) => e.ms)),
            byProject: groupBy(single, "project"),
            byView: groupBy(single, "view"),
            hesitations: single.filter((e) => e.ms >= HESITATION_MS).length,
            hesitationRate: rate(single.filter((e) => e.ms >= HESITATION_MS).length, single.length),
        },
        views: {
            switchesPerItem: rate(viewSwitches, items.length),
            changes: sortedCounts(byType("set").reduce((m, e) => bump(m, `${e.key}=${e.to}`), new Map())),
        },
        controls: { pressed: controls, keys, neverUsed },
        errors: {
            n: byType("error").length,
            perSession: rate(byType("error").length, sessions.size),
            top: sortedCounts(byType("error").reduce((m, e) => bump(m, e.m), new Map())).slice(0, 5),
        },
        stale: {
            projectsOpened: projects.length,
            stale: projects.filter((e) => e.stale > 0).length,
            rate: rate(projects.filter((e) => e.stale > 0).length, projects.length),
        },
        finish: {
            started: starts.length,
            completed: finishes.filter((e) => e.ok).length,
            failed: finishes.filter((e) => !e.ok).length,
            duration: timing(finishes.map((e) => e.ms)),
        },
        idle: {
            gaps: byType("idle").length,
            minutes: Math.round(byType("idle").reduce((n, e) => n + e.ms, 0) / 6000) / 10,
        },
    };
}

const seconds = (ms) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)} s`);
const percent = (r) => (r === null ? "-" : `${Math.round(r * 100)}%`);
const counts = (pairs) => pairs.map((p) => p.join(" ")).join(", ");
const timed = (t) => `median ${seconds(t.median)}, p90 ${seconds(t.p90)} (${t.n})`;

/**
 * The summary as plain text.
 * @param {ReturnType<typeof summarize>} s the summary
 * @returns {string} the report
 */
export function formatUsage(s) {
    if (s.events === 0) {
        return "No usage events recorded.";
    }
    const lines = [
        `Usage events ${s.from} to ${s.to}: ${s.events} events`,
        "",
        `Sessions: ${s.sessions.n} (${s.sessions.touch} touch, ${s.sessions.mouse} mouse)`,
        ...s.sessions.list.map(
            (x) =>
                `  ${x.start}  ${x.minutes} min  ${[x.pointer, x.viewport].filter(Boolean).join(" ")}  ` +
                `${x.targets} reviews, ${x.items} items shown, ${x.decisions} decisions`,
        ),
        "",
        `Items: ${s.items.shown} shown (${s.items.distinct} distinct); backtracking ${percent(s.items.backtrackRate)}`,
        `  images drawn after: ${timed(s.items.imagesDrawn)}`,
        `Decisions: ${s.decisions.n} (${s.decisions.single} one by one, ${s.decisions.bulk} in bulk), ${s.decisions.perMinute ?? "-"} per active minute`,
        `  ${counts(Object.entries(s.decisions.byDecision)) || "none one by one"}; ${s.decisions.changed} changed, ${s.decisions.undos} undone`,
        `  time per item: ${timed(s.decisions.timePerItem)}`,
        ...Object.entries(s.decisions.byProject).map(([k, t]) => `    project ${k}: ${timed(t)}`),
        ...Object.entries(s.decisions.byView).map(([k, t]) => `    view ${k}: ${timed(t)}`),
        `  hesitation (${HESITATION_MS / 1000} s or more before deciding): ${s.decisions.hesitations} (${percent(s.decisions.hesitationRate)})`,
        "",
        `View changes: ${s.views.switchesPerItem === null ? "-" : s.views.switchesPerItem.toFixed(2)} view or zoom switches per item`,
        ...s.views.changes.slice(0, 10).map((c) => `  ${c.name}: ${c.n}`),
        "",
        "Controls, most used:",
        ...s.controls.pressed.slice(0, 10).map((c) => `  ${c.name}: ${c.n}`),
        "Controls, least used:",
        ...s.controls.pressed
            .slice(-5)
            .reverse()
            .map((c) => `  ${c.name}: ${c.n}`),
        `Controls shown but never used: ${s.controls.neverUsed.join(", ") || "none"}`,
        `Keys: ${counts(s.controls.keys.map((k) => [k.name.slice(4), k.n])) || "none"}`,
        "",
        `Errors shown: ${s.errors.n} (${s.errors.perSession === null ? "-" : s.errors.perSession.toFixed(1)} per session)`,
        ...s.errors.top.map((e) => `  ${e.n}x ${e.name}`),
        `Stale captures: ${s.stale.stale} of ${s.stale.projectsOpened} projects opened (${percent(s.stale.rate)})`,
        `Finish: ${s.finish.started} started, ${s.finish.completed} completed, ${s.finish.failed} failed; ${timed(s.finish.duration)}`,
        `Idle: ${s.idle.gaps} gaps of a minute or more, ${s.idle.minutes} min in all`,
    ];
    return lines.join("\n");
}
