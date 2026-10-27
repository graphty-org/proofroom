/*
 * The Captures screen (design 9.2): the captures list on the left, in four sections (Running,
 * Queued, Finished today, Earlier), and the capture detail on the right: each project's stories
 * done, the story being captured, the failures so far with their reason, the log tail, Cancel, and
 * once it ended Review results [Enter]. Captures on this machine run one at a time; the page asks
 * for the list (GET /api/captures) and the open capture (GET /api/captures/<id>, its log since the
 * last line it has) once a second while one runs or this screen is shown. A capture asked of CI
 * shows each project's job state instead, from the capture store: the code host gives a job's log
 * only once the job ends, so there is no story progress or log tail for it here.
 */

import { control } from "./actions.js";
import { wordsOf } from "./messages.js";
import { ADAPTER_NAMES } from "./settings.js";
import { el, fmt, ic } from "./ui.js";

const SECTIONS = ["Running", "Queued", "Finished today", "Earlier"];

/**
 * Every capture of the list, newest first within its section.
 * @param {any} caps the GET /api/captures answer
 * @returns {any[]} them
 */
export const allCaptures = (caps) => [...(caps?.running ?? []), ...(caps?.queued ?? []), ...(caps?.finished ?? [])];

/**
 * Whether a capture still waits or runs.
 * @param {any} c the capture
 * @returns {boolean} it does
 */
export const busy = (c) => c.state === "running" || c.state === "queued";

// The section a capture is listed in: by its state, and a finished one by the day it ended.
function sectionOf(c, now) {
    if (c.state === "running") {
        return "Running";
    }
    if (c.state === "queued") {
        return "Queued";
    }
    return new Date(c.endedAt ?? c.createdAt).toDateString() === new Date(now).toDateString()
        ? "Finished today"
        : "Earlier";
}

// "4 min", "35 s".
const span = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
};

// "17:20" today, "yesterday 17:20", "Oct 24 17:20" before.
const clock = (ms, now) => {
    const at = new Date(ms);
    const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const day = new Date(now);
    if (at.toDateString() === day.toDateString()) {
        return time;
    }
    day.setDate(day.getDate() - 1);
    return at.toDateString() === day.toDateString()
        ? `yesterday ${time}`
        : `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
};

// A capture that finished with stories that did not render is marked as one that failed.
const troubled = (c) => c.state === "failed" || c.state === "cancelled" || (c.state === "done" && c.failures > 0);

const markOf = (c) =>
    c.state === "running"
        ? ic("spin", "c-ink2")
        : c.state === "queued"
          ? ic("clock", "c-ink2")
          : troubled(c)
            ? ic("failed", "c-failed")
            : ic("accept", "c-accept");

// When it ran, as the row and the detail say it.
const timeOf = (c, now) =>
    c.state === "running"
        ? span(now - c.startedAt)
        : c.state === "queued"
          ? "queued"
          : `${clock(c.endedAt ?? c.createdAt, now)}, ${span((c.endedAt ?? c.createdAt) - (c.startedAt ?? c.createdAt))}`;

// Where a capture runs, as its row's tag and its detail say it.
const whereOf = (app, c) => (c.where === "ci" ? (wordsOf(app.list).ciName ?? "CI") : "this machine");

// A project job's mark, by its state.
const JOB_MARKS = {
    queued: ["clock", "c-ink2"],
    running: ["spin", "c-ink2"],
    passed: ["accept", "c-accept"],
    failed: ["failed", "c-failed"],
    cancelled: ["failed", "c-failed"],
    skipped: ["clock", "c-ink2"],
};

// How long a project job ran, or has run so far.
const jobTime = (j, now) =>
    j.startedAt
        ? j.endedAt
            ? exact(Date.parse(j.endedAt) - Date.parse(j.startedAt))
            : `${span(now - Date.parse(j.startedAt))} so far`
        : "";

// "3 min 10 s", "35 s".
const exact = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

// A progress bar; its width is set through the style object, as the page's policy allows.
const bar = (done, total, failed) => {
    const fill = el("div");
    fill.style.width = `${total > 0 ? (100 * done) / total : 0}%`;
    return el("div", { class: `prog ${failed ? "bad" : ""}` }, fill);
};

/**
 * Draws the Captures screen.
 * @param {any} app the page: `captures` (the list), `capCur` (the capture shown), `capOpen` (its
 *     detail and log)
 */
export function drawCaptures(app) {
    const caps = app.captures;
    const now = app.capNow();
    const all = allCaptures(caps);
    if (app.capCur === null || !all.some((c) => c.id === app.capCur)) {
        app.capCur = all[0]?.id ?? null;
    }
    document
        .getElementById("cap-new")
        .replaceChildren(control(app, "newcap", { zone: "changes-head", attrs: { class: "primary" } }));
    const rows = [];
    for (const name of SECTIONS) {
        const these = all.filter((c) => sectionOf(c, now) === name);
        if (these.length === 0) {
            continue;
        }
        rows.push(
            el(
                "div",
                { class: "sec" },
                el("span", { class: "grow" }, name),
                el("span", { class: "num" }, String(these.length)),
            ),
        );
        for (const c of these) {
            rows.push(
                control(app, "pickcap", {
                    zone: "rows",
                    tag: "div",
                    ctx: { cap: c.id },
                    attrs: {
                        class: `caprow ${c.id === app.capCur ? "cur" : ""}`,
                        "data-cap": String(c.id),
                        role: "option",
                        "aria-selected": c.id === app.capCur ? "true" : "false",
                        "aria-label": `${c.what.label}: ${c.state}`,
                    },
                    children: [
                        el(
                            "div",
                            { class: "l1" },
                            markOf(c),
                            el("b", { class: "grow ell" }, c.what.label),
                            el("span", { class: "tag" }, whereOf(app, c)),
                        ),
                        ...rowCount(app, c, now),
                    ],
                }),
            );
        }
    }
    document
        .getElementById("cap-rows")
        .replaceChildren(
            ...(rows.length ? rows : [el("p", { class: "muted empty" }, "No captures on this machine yet.")]),
        );
    drawDetail(app, all.find((c) => c.id === app.capCur) ?? null, now);
}

// A row's second and third lines: its progress bar and count. On CI, project jobs are counted,
// and with a store that reports no job states only the time is said.
function rowCount(app, c, now) {
    if (c.where === "ci") {
        if (!app.captures?.ci?.status && busy(c)) {
            return [el("div", { class: "small muted" }, `Capturing on ${whereOf(app, c)}, ${timeOf(c, now)}`)];
        }
        return [
            bar(c.done, c.total, troubled(c)),
            el("div", { class: "small muted" }, `${fmt(c.done)} of ${fmt(c.total)} project jobs, ${timeOf(c, now)}`),
        ];
    }
    return [
        bar(c.done, c.total, troubled(c)),
        el(
            "div",
            { class: "small muted" },
            // No count before the capture has counted its stories.
            c.total > 0 ? `${fmt(c.done)} of ${fmt(c.total)} stories, ${timeOf(c, now)}` : timeOf(c, now),
        ),
    ];
}

function drawDetail(app, c, now) {
    const box = document.getElementById("cap-detail");
    if (!c) {
        box.replaceChildren(el("p", { class: "muted" }, "Captures you start from New capture... are listed here."));
        return;
    }
    if (c.where === "ci") {
        drawCiDetail(app, c, now, box);
        return;
    }
    const open = app.capOpen?.id === c.id ? app.capOpen : null;
    const state =
        c.state === "running"
            ? `running for ${timeOf(c, now)}`
            : c.state === "queued"
              ? "queued: local captures run one at a time"
              : c.state === "done"
                ? `finished ${c.failures > 0 ? "with failures, " : ""}${timeOf(c, now)}`
                : c.state === "cancelled"
                  ? `cancelled ${timeOf(c, now)}`
                  : `failed ${timeOf(c, now)}`;
    const scope = [
        c.projects.length === (app.captures?.projects ?? []).length
            ? "Every project"
            : `Projects: ${c.projects.join(", ")}`,
        c.stories ? `stories starting with ${c.stories.join(", ")}` : "every story",
    ].join(", ");
    const progress =
        open?.progress ?? c.projects.map((p) => ({ project: p, done: 0, total: 0, failures: 0, failed: [] }));
    const failed = progress.flatMap((p) => p.failed.map((f) => ({ ...f, project: p.project })));
    const failures = progress.reduce((n, p) => n + p.failures, 0);
    const current = c.state === "running" ? progress.find((p) => p.current && p.done < p.total) : null;
    const log = el(
        "div",
        { class: "log", id: "caplog", role: "log", "aria-label": "Log" },
        (open?.lines ?? []).join("\n"),
    );
    box.replaceChildren(
        ...el(
            "div",
            {},
            el("h2", {}, c.what.label),
            el(
                "p",
                { class: "muted" },
                `This machine, ${state}. Against the baselines of ${c.baselines.label}. ${scope}.`,
                c.look ? ` Look only: ${c.look}.` : "",
            ),
            c.error && c.state === "failed" ? el("p", { class: "c-failed" }, c.error) : null,
            el("h3", {}, "Projects"),
            progress.map((p) =>
                el(
                    "div",
                    { class: "projbar" },
                    el("span", {}, p.project),
                    bar(p.done, p.total, false),
                    el("span", { class: "small num muted" }, `${fmt(p.done)} of ${fmt(p.total)} stories`),
                ),
            ),
            current
                ? el("p", { class: "small" }, "Now: ", el("code", {}, `${current.project} / ${current.current}`))
                : null,
            el("h3", {}, `Failures so far (${failures})`),
            failures === 0
                ? el("p", { class: "small muted" }, "None.")
                : el(
                      "ul",
                      { class: "small" },
                      failed.map((f) =>
                          el(
                              "li",
                              {},
                              el("span", { class: "c-failed" }, ic("failed")),
                              " ",
                              el("code", {}, `${f.project}/${f.file}`),
                              `: ${f.reason}`,
                          ),
                      ),
                      failures > failed.length
                          ? el("li", { class: "muted" }, `and ${fmt(failures - failed.length)} more, in the log`)
                          : null,
                  ),
            el("h3", {}, "Log"),
            log,
            el(
                "div",
                { class: "capacts" },
                busy(c) ? control(app, "capcancel", { zone: "rows", ctx: { cap: c.id } }) : null,
                c.state === "done"
                    ? control(app, "capreview", { zone: "rows", ctx: { cap: c.id }, attrs: { class: "primary" } })
                    : null,
                c.state === "failed" || c.state === "cancelled"
                    ? control(app, "capagain", { zone: "rows", ctx: { cap: c.id, label: "Capture again" } })
                    : null,
            ),
        ).childNodes,
    );
    log.scrollTop = log.scrollHeight;
}

// The detail of a capture asked of CI: each project's job state, with a link to its log once it
// has one, the run's whole log, and Cancel when the store can cancel.
function drawCiDetail(app, c, now, box) {
    const ci = app.captures?.ci ?? {};
    const name = whereOf(app, c);
    const state =
        c.state === "running"
            ? `running for ${timeOf(c, now)}`
            : c.state === "queued"
              ? "queued"
              : c.state === "cancelled"
                ? `cancelled ${timeOf(c, now)}`
                : troubled(c)
                  ? `finished with failures, ${timeOf(c, now)}`
                  : `finished ${timeOf(c, now)}`;
    const link = (text) =>
        c.runUrl ? el("a", { href: c.runUrl, target: "_blank", rel: "noreferrer" }, text) : el("span", {}, text);
    const store = app.list?.adapters?.captureStore?.name;
    // The stories that did not render, from the capture each ended job uploaded.
    const failed = (c.jobs ?? []).flatMap((j) => j.failed ?? []);
    const failures = (c.jobs ?? []).reduce((n, j) => n + (j.failures ?? 0), 0);
    box.replaceChildren(
        ...el(
            "div",
            {},
            el("h2", {}, c.what.label),
            el(
                "p",
                { class: "muted" },
                `${name[0].toUpperCase()}${name.slice(1)}, ${state}. Against the baselines of ${c.baselines.label}. Every project, every story.`,
            ),
            ci.status
                ? [
                      el("h3", {}, `Project jobs (from ${ADAPTER_NAMES[store] ?? store ?? name})`),
                      el(
                          "table",
                          { class: "jobs" },
                          (c.jobs.length ? c.jobs : c.projects.map((project) => ({ project, state: "queued" }))).map(
                              (j) =>
                                  el(
                                      "tr",
                                      {},
                                      el("td", {}, el("code", {}, `visual (${j.project})`)),
                                      el(
                                          "td",
                                          {},
                                          el(
                                              "span",
                                              { class: "st" },
                                              ic(...(JOB_MARKS[j.state] ?? JOB_MARKS.queued)),
                                              j.state,
                                          ),
                                      ),
                                      el("td", { class: "muted" }, jobTime(j, now)),
                                      el(
                                          "td",
                                          {},
                                          j.url && j.state !== "queued"
                                              ? el("a", { href: j.url, target: "_blank", rel: "noreferrer" }, "Log")
                                              : null,
                                      ),
                                  ),
                          ),
                      ),
                      el("p", { class: "small cinote" }, "Story progress is shown when the job ends."),
                      el("p", { class: "small cinote" }, link(`Open the whole ${name} log`)),
                  ]
                : el(
                      "p",
                      { class: "small cinote" },
                      c.state === "running" ? `Capturing on ${name}. ` : "",
                      "Your capture store reports no job states. ",
                      link(`Open the ${name} log`),
                  ),
            failures > 0
                ? [
                      el("h3", {}, `Failed stories (${fmt(failures)}), from the finished job`),
                      el(
                          "ul",
                          { class: "small" },
                          failed.map((f) =>
                              el(
                                  "li",
                                  {},
                                  el("span", { class: "c-failed" }, ic("failed")),
                                  " ",
                                  el("code", {}, f.story),
                                  `: ${f.reason}`,
                              ),
                          ),
                          failures > failed.length
                              ? el("li", { class: "muted" }, `and ${fmt(failures - failed.length)} more, in the log`)
                              : null,
                      ),
                  ]
                : null,
            el(
                "div",
                { class: "capacts" },
                busy(c) && ci.cancel ? control(app, "capcancel", { zone: "rows", ctx: { cap: c.id } }) : null,
                c.state === "done" || c.state === "failed"
                    ? control(app, "capreview", { zone: "rows", ctx: { cap: c.id }, attrs: { class: "primary" } })
                    : null,
                c.state === "failed" || c.state === "cancelled"
                    ? control(app, "capagain", { zone: "rows", ctx: { cap: c.id, label: "Capture again" } })
                    : null,
            ),
        ).childNodes,
    );
}
