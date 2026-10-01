/*
 * The review page. Plain JavaScript on purpose: this page is where the owner approves images, so
 * it must stay small enough to read. Every text that came from a pull request (titles, reasons,
 * console lines) is set with textContent, never parsed as HTML.
 */

import pixelmatch from "/pixelmatch.mjs";

const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
const app = document.getElementById("app");
const crumbs = document.getElementById("crumbs");
const statusLine = document.getElementById("status");

const REVIEWABLE = ["changed", "moved", "new", "removed", "unstable", "failed"];
const ACCEPTABLE = ["changed", "moved", "new", "removed"];
// A story with no baseline that this pull request did not change: shown, never a decision here.
const UNSEEDED = "unseeded";
const NO_BASELINE = "no baseline yet";
const statusLabel = (status) => (status === UNSEEDED ? NO_BASELINE : status);
// Errors first (their own list), then what changed, then moved, new, unstable and removed stories.
const RANK = { failed: 0, changed: 1, moved: 2, new: 3, unstable: 4, removed: 5, unseeded: 6 };
const FLASH_MS = 333; // one image each third of a second: about 1.5 full cycles a second
// "fit" (the default) shows the whole of both images in their panes, at one scale, never above real
// size; 1 is real size: one CSS pixel per CSS pixel the story was drawn at, scrolling when larger.
const ZOOMS = ["fit", 1, 2, 4, 8];
const CRISP_FROM = 4; // from this zoom on, pixels are drawn as hard squares
const GROW = 10; // image pixels the spotlight and the changed boxes grow each changed pixel by
const SPOT_ALPHA = 190; // the spotlight's dimming, out of 255, as Chromatic's focus mask
const RE_REVIEW = "re-review: your earlier accept was replaced by master's baseline";
// The grid's decision filters, and how a decision reads on a tile.
const DECISIONS = { accept: "Accepted", reject: "Rejected", exclude: "Excluded" };
// The reviewer's own display choices (the changed box, blinking the overlay), kept in this browser.
const OPTIONS_KEY = "visual-review:options";
const saved = loadOptions();

const state = {
    targets: [],
    target: null, // summary of the pull request (or master) being reviewed
    project: null,
    data: null, // GET /api/pr/:id/:project
    filter: "undecided", // the grid opens on what still needs a decision
    text: "", // the grid's text filter
    index: 0, // the item shown, in `sequence`
    // The files of this pass through the stories, frozen when a story is opened from the grid:
    // deciding one never drops it, so Previous goes back to it and its Undo.
    sequence: [],
    lastFile: null, // the item last opened, highlighted when the grid comes back
    view: "side", // side | flash | highlight | spotlight
    zoom: "fit",
    box: 0, // which changed box "next changed box" is on
    showBox: saved.showBox ?? true, // outline the changed box (B)
    blink: saved.blink ?? false, // blink the changed pixels Highlight lays over the images (L)
    spotFlash: saved.spotFlash ?? false, // Spotlight flashes baseline and new (F in Spotlight)
    held: null, // the view to return to when Space is released
    pending: "reject", // what Enter in the reason box does
    screen: "targets",
    job: null, // the newest Finish, from GET /api/finish-status
    armed: null, // the bulk Undo button pressed once: its second press undoes
};
const running = () => state.job?.running === true;
const VIEWS = ["side", "flash", "highlight", "spotlight"];
const FILTERS = ["undecided", "all", ...REVIEWABLE, UNSEEDED, ...Object.keys(DECISIONS)];
let routes = 0; // how many routes are running: the page follows the address (a link, Back, Forward)
let nav = 0; // bumped by each screen change that waits on the server: a superseded one stops there
// The least recently used last-opened images and diffs are dropped past these, so a long session
// stays small: an object URL holds its image, and a diff about 13 bytes per image pixel.
const images = new Map();
const IMAGES_KEPT = 50;
const diffs = new Map();
const DIFFS_KEPT = 4;
let stageRender = 0; // the newest renderStage: an older one finishing late writes nothing
let stageShown = null; // the file whose two panes are on the stage: Accept waits for it
let deciding = false; // a decision is on its way to the server
// A decision moves on to the next item, whose buttons are in the same place: the second click of
// a double click, this soon after the first, lands there and is ignored.
const DOUBLE_CLICK_MS = 500;
let clickedAt = -Infinity; // when a decision button was last clicked
let flashTimer = null;
let factor = 1; // CSS pixels per image pixel of the pictures on the stage
let shownBoxes = []; // the changed boxes of the item on the stage
let stageKey = null; // "file|zoom" of what is on the stage, to keep its scroll across view changes
// At fit, the stage refits when the window (or an iPad's orientation) changes its size.
const refit = new ResizeObserver(() => {
    const stage = document.getElementById("stage");
    if (state.screen === "story" && state.zoom === "fit" && stage?.querySelector(".sheet")) {
        fit(stage);
        showBox(stage, shownBoxes, false);
    }
});

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("on")) {
            node.addEventListener(key.slice(2), value);
        } else if (value !== false && value !== null && value !== undefined) {
            node.setAttribute(key, value === true ? "" : value);
        }
    }
    node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return node;
}

// Like replaceChildren, but a null child (a section that does not apply) is left out.
function render(...children) {
    app.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));
}

// Clearing the status line during a Finish shows the Finish's step instead, so a screen that
// opens while it runs (a reload, Visual review, a link) never blanks its progress.
function say(text, isError = false) {
    statusLine.textContent = text === "" && running() ? finishing() : text;
    statusLine.className = isError ? "error" : "";
}

// Asks in the page, never with confirm(): once a browser stops a page's dialogs ("prevent this
// page from creating additional dialogs"), confirm() returns false without showing anything, and
// the button pressed seems to do nothing. Resolves true for `yes`, false for Cancel or Escape.
function ask(message, yes) {
    // Focus on the box, not a button: the Enter that asked (in the reason box) must not answer it.
    const dialog = el("dialog", { class: "ask", tabindex: "-1" }, el("p", {}, message));
    const answer = (value) => () => dialog.close(value);
    dialog.append(
        el(
            "p",
            { class: "actions" },
            el("button", { type: "button", onclick: answer("no") }, "Cancel"),
            el("button", { type: "button", class: "primary", onclick: answer("yes") }, yes),
        ),
    );
    document.body.append(dialog);
    dialog.showModal();
    dialog.focus();
    return new Promise((resolve) =>
        dialog.addEventListener("close", () => {
            dialog.remove();
            resolve(dialog.returnValue === "yes");
        }),
    );
}

async function api(path, body) {
    const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "x-review-token": token, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(json.error ?? `${res.status} ${res.statusText}`);
    }
    return json;
}

// The promise `make` returns for `key`, kept in `map` with the least recently used dropped past
// `limit` (and handed to `drop`). A promise that fails is dropped at once, so the next use retries.
function cached(map, key, limit, make, drop = () => {}) {
    let value = map.get(key);
    if (value === undefined) {
        value = make();
        value.catch(() => {
            if (map.get(key) === value) {
                map.delete(key);
            }
        });
    }
    map.delete(key);
    map.set(key, value);
    for (const [k, old] of map) {
        if (map.size <= limit) {
            break;
        }
        map.delete(k);
        drop(old);
    }
    return value;
}

// Loads an image through the API (it needs the token header) and returns an object URL. Keyed by
// the image's hash too, so a newer CI run's image is never answered with an older one.
function image(kind, file, hash) {
    return cached(
        images,
        `${state.target.id}/${state.project}/${kind}/${file}/${hash}`,
        IMAGES_KEPT,
        () => {
            const path = ["img", state.target.id, state.project, kind, file].map(encodeURIComponent).join("/");
            return fetch(`/api/${path}`, { headers: { "x-review-token": token } }).then(async (res) => {
                if (!res.ok) {
                    throw new Error(`${file}: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
                }
                return URL.createObjectURL(await res.blob());
            });
        },
        (url) => url.then(URL.revokeObjectURL, () => {}),
    );
}

function loaded(url, what) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`${what}: the image could not be shown`));
        img.src = url;
    });
}

const componentOf = (id) => id.split("--")[0];
const itemName = (item) => (item.mode ? `${item.id} (${item.mode})` : item.id);
// A renamed story (renames.json) is compared with its old id's baseline: say which.
const movedFrom = (item) => (item.from ? `moved from ${item.from}` : "");
const short = (sha) => (sha ? sha.slice(0, 10) : "none");
const decisionOf = (item) => state.data?.decisions[item.file] ?? null;
// The image a decision is about, as the server checks it: a decision on an image another run
// replaced since this page loaded is refused.
const imageHash = (item) => item.capture ?? item.baseline ?? null;
const isLocal = () => state.target?.local === true;
// Device pixels per CSS pixel of this capture: 2 today, 1 for captures made before it was recorded.
const scale = () => state.data?.results.scale ?? 1;

// Errors first, then components by their most urgent item, stories the same way within one, and
// the modes of a story together. Tile numbers and the story's "N of M" both follow this order.
function ordered(items) {
    const best = new Map();
    const keep = (key, item) => best.set(key, Math.min(best.get(key) ?? 9, RANK[item.status] ?? 9));
    for (const item of items) {
        keep(`c:${componentOf(item.id)}`, item);
        keep(`s:${item.id}`, item);
    }
    const key = (i) => [
        i.status === "failed" ? 0 : 1,
        best.get(`c:${componentOf(i.id)}`),
        componentOf(i.id),
        best.get(`s:${i.id}`),
        i.id,
        i.mode ?? "",
    ];
    return [...items].sort((a, b) => {
        const [ka, kb] = [key(a), key(b)];
        for (let n = 0; n < ka.length; n++) {
            if (ka[n] !== kb[n]) {
                return ka[n] < kb[n] ? -1 : 1;
            }
        }
        return 0;
    });
}

function visibleItems() {
    const text = state.text.trim().toLowerCase();
    let items;
    if (state.filter === UNSEEDED) {
        items = state.data.items.filter((i) => i.status === UNSEEDED);
    } else {
        items = state.data.items.filter((i) => REVIEWABLE.includes(i.status));
        if (state.filter === "undecided") {
            items = items.filter((i) => !decisionOf(i));
        } else if (Object.hasOwn(DECISIONS, state.filter)) {
            items = items.filter((i) => decisionOf(i)?.decision === state.filter);
        } else if (state.filter !== "all") {
            items = items.filter((i) => i.status === state.filter);
        }
    }
    return ordered(text ? items.filter((i) => i.file.includes(text)) : items);
}

// The items of the frozen pass, in its order; an item gone from a reloaded project is left out.
function passItems() {
    const byFile = new Map(state.data.items.map((i) => [i.file, i]));
    return state.sequence.map((f) => byFile.get(f)).filter(Boolean);
}

const current = () => passItems()[state.index];

function progress() {
    const items = state.data.items.filter((i) => REVIEWABLE.includes(i.status));
    return `${items.filter(decisionOf).length} / ${items.length} reviewed`;
}

function setCrumbs(...parts) {
    crumbs.replaceChildren(...parts.flatMap((p, i) => (i === 0 ? [p] : [" / ", p])));
}

function stopFlash() {
    clearInterval(flashTimer);
    flashTimer = null;
}

// Local storage can be missing or refuse (a private window, blocked site data): the page then uses
// the defaults and forgets the choices, and nothing else changes.
function loadOptions() {
    try {
        return JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") ?? {};
    } catch {
        return {};
    }
}

function saveOptions() {
    try {
        localStorage.setItem(
            OPTIONS_KEY,
            JSON.stringify({ showBox: state.showBox, blink: state.blink, spotFlash: state.spotFlash }),
        );
    } catch {
        // Not remembered; the choice still holds for this page.
    }
}

function toggleOption(key) {
    state[key] = !state[key];
    saveOptions();
    showStory();
}

// ---------------------------------------------------------------- screen: targets

async function loadTargets() {
    say("Loading pull requests and captures...");
    try {
        const [prs, status] = await Promise.all([api("/api/prs"), api("/api/finish-status")]);
        state.targets = prs.targets;
        track(status.job);
        say("");
        if (running()) {
            // A reload during a Finish, on any screen: follow the running one, never offer a second.
            watchFinish();
        }
        return true;
    } catch (err) {
        say(err.message, true);
        return false;
    }
}

async function showTargets(notice = "") {
    const seq = ++nav;
    stopFlash();
    state.screen = "targets";
    setCrumbs();
    if (!(await loadTargets()) || seq !== nav) {
        return;
    }
    remember();
    say(notice);
    if (state.targets.length === 0) {
        render(finishOutcome(), el("p", {}, "No open pull request has a CI run, and no master run was given."));
        return;
    }
    const finishable = state.targets.find((t) => !t.local);
    render(finishOutcome(), finishable ? signerBlock(finishable) : null, ...state.targets.map(targetCard));
}

// The key Finish signs with comes from the server's environment, which is an agent's when an
// agent started the server.
function signerLine(s) {
    if (!s) {
        return "Finish's signing key is unknown.";
    }
    if (!s.signs) {
        return "Finish commits are NOT signed (commit.gpgsign is off).";
    }
    const key = s.key ?? "git's default key for the committer's email";
    const from = s.keyFrom ? `, set in ${s.keyFrom}` : "";
    const who = s.author ? ` as ${s.author}` : "";
    const env = s.fromEnv
        ? " This comes from the environment of whoever started this server (for example an agent through" +
          " servherd), not from your own git config."
        : "";
    return `Finish commits are signed with ${s.format} key ${key}${from}${who}.${env}`;
}

function signerBlock(t) {
    return el(
        "section",
        { class: "card signer" },
        el("p", {}, signerLine(t.signer)),
        t.startCommand
            ? el(
                  "p",
                  {},
                  "To sign as yourself, stop this server and start it from your own shell, in your own terminal:",
              )
            : null,
        t.startCommand ? el("pre", { class: "console" }, t.startCommand) : null,
    );
}

function targetCard(t) {
    const decided = t.projects.reduce((n, p) => n + p.decided, 0);
    const heading = t.local ? "Local preview " : t.pr === null ? "master (seed) " : `#${t.pr} `;
    return el(
        "section",
        { class: "card" },
        el(
            "h2",
            {},
            heading,
            t.url
                ? el("a", { href: t.url, target: "_blank", rel: "noreferrer" }, t.title)
                : t.pr === null
                  ? null
                  : t.title,
        ),
        t.local
            ? el("p", { class: "meta" }, t.title)
            : el(
                  "p",
                  { class: "meta" },
                  `CI run ${t.runId ?? "none"}, attempt ${t.runAttempt ?? "-"}; captured ${short(t.pr === null ? t.commit : t.headSha)}`,
                  t.branch ? ` on ${t.branch}` : "",
                  " ",
                  t.runUrl ? el("a", { href: t.runUrl, target: "_blank", rel: "noreferrer" }, "run") : null,
              ),
        el(
            "p",
            { class: "badges" },
            t.mergeMasterFirst ? el("span", { class: "badge warn" }, "merge master first") : null,
            t.local
                ? el(
                      "span",
                      { class: "badge warn" },
                      "local preview: look only; only a CI capture of a pushed commit can be decided",
                  )
                : null,
        ),
        el(
            "table",
            {},
            el("tr", {}, el("th", {}, "Project"), el("th", {}, "Found"), el("th", {}, "Reviewed"), el("th", {})),
            t.projects.map((p) =>
                el(
                    "tr",
                    {},
                    el(
                        "td",
                        {},
                        p.project,
                        p.acceptable || t.local ? null : el("span", { class: "badge" }, "not seeded from master"),
                    ),
                    el(
                        "td",
                        {},
                        p.problem ? el("span", { class: "badge warn" }, p.problem) : null,
                        p.problem && p.logUrl
                            ? el("a", { href: p.logUrl, target: "_blank", rel: "noreferrer" }, " job log")
                            : null,
                        " ",
                        Object.entries(p.counts)
                            .map(([s, n]) => `${n} ${statusLabel(s)}`)
                            .join(", "),
                    ),
                    el("td", {}, t.local ? "-" : `${p.decided} / ${p.reviewable}`),
                    el(
                        "td",
                        {},
                        p.reviewable > 0 || p.counts[UNSEEDED]
                            ? el("button", { type: "button", onclick: () => openProject(t, p.project) }, "Review")
                            : null,
                    ),
                ),
            ),
        ),
        t.local
            ? null
            : running() && state.job.target === t.id
              ? el("p", { class: "finish-running" }, `Finish is running: ${state.job.step}...`)
              : el(
                    "p",
                    {},
                    el(
                        "button",
                        {
                            type: "button",
                            class: "primary",
                            disabled: decided === 0 || running(),
                            onclick: (e) => finishTarget(t, e.currentTarget),
                        },
                        `Finish ${t.pr === null ? "seed" : `#${t.pr}`} (${decided} decisions)`,
                    ),
                ),
    );
}

// ---------------------------------------------------------------- screen: project grid

async function openProject(target, project) {
    const seq = ++nav;
    state.target = target;
    state.project = project;
    state.filter = "undecided";
    state.text = "";
    state.lastFile = null;
    state.sequence = [];
    say("Loading...");
    try {
        await reload();
        say("");
    } catch (err) {
        say(err.message, true);
        return;
    }
    if (seq !== nav) {
        return;
    }
    // Nothing left to decide (or a local preview): show everything instead of an empty grid.
    if (visibleItems().length === 0) {
        state.filter = "all";
    }
    showGrid();
}

async function reload() {
    state.data = await api(`/api/pr/${encodeURIComponent(state.target.id)}/${encodeURIComponent(state.project)}`);
}

function targetLabel() {
    return state.target.local ? "local preview" : state.target.pr === null ? "master" : `#${state.target.pr}`;
}

const thumbs = new IntersectionObserver((entries) => {
    for (const e of entries) {
        if (e.isIntersecting) {
            thumbs.unobserve(e.target);
            const { kind, file, hash } = e.target.dataset;
            image(kind, file, hash).then(
                (url) => (e.target.src = url),
                (err) => (e.target.alt = err.message),
            );
        }
    }
});

// Opens item `index` of the grid, and freezes what the grid shows as the pass Next and Previous
// walk through.
function openItem(index) {
    say("");
    state.sequence = visibleItems().map((i) => i.file);
    state.index = index;
    state.box = 0;
    showStory();
}

function tile(item, number) {
    const kind = item.capture ? "capture" : item.baseline ? "baseline" : null;
    const img = kind
        ? el("img", { "data-kind": kind, "data-file": item.file, "data-hash": item[kind], alt: itemName(item) })
        : el("div", { class: "noimage" }, item.status);
    if (kind) {
        thumbs.observe(img);
    }
    const d = decisionOf(item);
    return el(
        "div",
        { class: "tile-box" },
        el(
            "button",
            {
                type: "button",
                class: `tile ${d ? `decided ${d.decision}` : ""} ${item.file === state.lastFile ? "current" : ""}`,
                "data-file": item.file,
                onclick: () => openItem(number - 1),
            },
            img,
            el("span", { class: "name" }, el("span", { class: "number" }, `${number}`), " ", item.mode ?? ""),
            el("span", { class: `badge ${item.status}` }, statusLabel(item.status)),
            item.from ? el("span", { class: "moved-from", title: movedFrom(item) }, movedFrom(item)) : null,
            item.reReview ? el("span", { class: "badge warn", title: RE_REVIEW }, "re-review") : null,
        ),
        decisionLine(item),
    );
}

// An item's decision, with its reason, and an Undo that clears it without opening the story. A
// reject an earlier Finish already posted stays: it is shown, never undone from the grid.
function decisionLine(item) {
    const d = decisionOf(item);
    if (!d) {
        return null;
    }
    const text = `${DECISIONS[d.decision]}${d.bulk ? " (not opened)" : ""}${d.reason ? `: ${d.reason}` : ""}`;
    return el(
        "div",
        { class: `decision ${d.decision}`, "data-file": item.file },
        el("span", { class: "what", title: text }, text),
        d.posted
            ? el("span", { class: "meta" }, "Posted by Finish: stays")
            : el(
                  "button",
                  {
                      type: "button",
                      title: `Undo the ${d.decision} of ${itemName(item)}`,
                      onclick: () => undo([item.file], itemName(item), true),
                  },
                  "Undo",
              ),
    );
}

// A failed capture: its reason, and the console and stack output, in the errors list.
function errorRow(item, number) {
    return el(
        "li",
        { class: item.file === state.lastFile ? "current" : null, "data-file": item.file },
        el(
            "button",
            { type: "button", class: "link", onclick: () => openItem(number - 1) },
            el("span", { class: "number" }, `${number}`),
            ` ${itemName(item)}`,
        ),
        decisionLine(item),
        el("div", { class: "reason" }, item.reason ?? "no reason recorded"),
        item.console.length > 0
            ? el(
                  "details",
                  {},
                  el("summary", {}, `console and stack (${item.console.length} lines)`),
                  el("pre", { class: "console" }, item.console.join("\n")),
              )
            : null,
    );
}

// The items of `component` Accept would take without opening them.
const undecided = (component) =>
    state.data.items.filter(
        (i) => ACCEPTABLE.includes(i.status) && !decisionOf(i) && (!component || componentOf(i.id) === component),
    );
const undecidedIn = (component) => undecided(component).length;

// The files whose decisions a bulk Undo in `component` (or the whole project) clears: every
// decision not yet posted by Finish.
const undoableIn = (component) =>
    state.data.items
        .filter((i) => decisionOf(i) && !decisionOf(i).posted && (!component || componentOf(i.id) === component))
        .map((i) => i.file);

// A bulk Undo asks by a second press: the first arms it, and any other redraw of the grid disarms it.
function undoButton(component, label) {
    const files = undoableIn(component);
    if (isLocal() || files.length === 0) {
        return null;
    }
    const key = component ?? "";
    const where = component ? `the component ${component}` : state.project;
    const armed = state.armed === key;
    return el(
        "button",
        {
            type: "button",
            class: `undo-all ${armed ? "reject" : ""}`,
            "data-armed": String(armed),
            onclick: () => {
                if (armed) {
                    undo(files, where);
                    return;
                }
                state.armed = key;
                showGrid();
                say(`Press Confirm to undo the decisions of ${where}, or Escape to cancel.`);
            },
        },
        armed ? `Confirm: undo ${files.length} ${files.length === 1 ? "decision" : "decisions"}` : label(files.length),
    );
}

// Clears decisions one by one through the same request as the story screen's U.
// ponytail: one request per item; a bulk endpoint if a project ever holds thousands of decisions.
async function undo(files, where, one = false) {
    state.armed = null;
    let done = 0;
    try {
        for (const file of files) {
            await api("/api/decide", {
                id: state.target.id,
                project: state.project,
                file,
                decision: null,
                reason: null,
            });
            done++;
        }
    } catch (err) {
        say(`Undid ${done} of ${files.length}, then: ${err.message}`, true);
    }
    try {
        await reload();
    } catch (err) {
        say(err.message, true);
    }
    if (done === files.length) {
        say(
            one
                ? `${where}: undone, undecided again`
                : `Undid ${done} ${done === 1 ? "decision" : "decisions"} of ${where}.`,
        );
    }
    showGrid();
}

function showGrid() {
    stopFlash();
    thumbs.disconnect();
    state.screen = "grid";
    state.pending = "reject";
    setCrumbs(el("span", {}, targetLabel()), el("span", {}, state.project));
    const items = visibleItems();
    const counts = {};
    for (const i of state.data.items) {
        counts[i.status] = (counts[i.status] ?? 0) + 1;
    }
    const filterButton = (f, label) =>
        el(
            "button",
            {
                type: "button",
                "aria-pressed": String(state.filter === f),
                onclick: () => {
                    state.filter = f;
                    showGrid();
                },
            },
            label,
        );
    const errors = [];
    const groups = new Map(); // component -> story id -> [[item, number]]
    items.forEach((item, i) => {
        if (item.status === "failed") {
            errors.push(errorRow(item, i + 1));
            return;
        }
        const c = componentOf(item.id);
        if (!groups.has(c)) {
            groups.set(c, new Map());
        }
        const stories = groups.get(c);
        if (!stories.has(item.id)) {
            stories.set(item.id, []);
        }
        stories.get(item.id).push(tile(item, i + 1));
    });
    const acceptable = state.data.acceptable && !isLocal();
    const sections = [...groups].map(([component, stories]) => {
        const n = undecidedIn(component);
        return el(
            "section",
            { class: "component", "data-component": component },
            el(
                "h3",
                {},
                component,
                acceptable && n > 0
                    ? el(
                          "button",
                          { type: "button", class: "accept", onclick: () => acceptAll(component) },
                          `Accept ${n} undecided`,
                      )
                    : null,
                undoButton(component, (k) => `Undo ${k} ${k === 1 ? "decision" : "decisions"}`),
            ),
            el(
                "div",
                { class: "stories" },
                [...stories].map(([id, tiles]) =>
                    el(
                        "div",
                        { class: "story" },
                        el("div", { class: "story-name" }, id.slice(component.length + 2) || id),
                        el("div", { class: "modes" }, tiles),
                    ),
                ),
            ),
        );
    });
    const filterBox = el("input", {
        id: "filter",
        type: "search",
        placeholder: "Filter by story id",
        value: state.text,
        oninput: (e) => {
            state.text = e.target.value;
            const at = e.target.selectionStart;
            showGrid();
            const box = document.getElementById("filter");
            box.focus();
            box.setSelectionRange(at, at);
        },
    });
    const goto = el("input", {
        id: "goto",
        type: "text",
        placeholder: "Go to: number or story id",
        onkeydown: (e) => {
            if (e.key === "Enter") {
                goTo(e.target.value);
            }
        },
    });
    render(
        el(
            "div",
            { class: "toolbar" },
            el("strong", { id: "progress" }, progress()),
            filterButton(
                "undecided",
                `Needs a decision (${state.data.items.filter((i) => REVIEWABLE.includes(i.status) && !decisionOf(i)).length})`,
            ),
            filterButton("all", `All (${state.data.items.filter((i) => REVIEWABLE.includes(i.status)).length})`),
            ["changed", "moved", "new", "unstable", "removed", "failed"]
                .filter((s) => counts[s])
                .map((s) => filterButton(s, `${s} (${counts[s]})`)),
            counts[UNSEEDED] ? filterButton(UNSEEDED, `${NO_BASELINE} (${counts[UNSEEDED]})`) : null,
            isLocal()
                ? null
                : Object.entries(DECISIONS).map(([k, label]) =>
                      filterButton(
                          k,
                          `${label} (${state.data.items.filter((i) => REVIEWABLE.includes(i.status) && decisionOf(i)?.decision === k).length})`,
                      ),
                  ),
            el("span", { class: "spacer" }),
            filterBox,
            goto,
            acceptable
                ? el(
                      "button",
                      { type: "button", class: "accept", onclick: () => acceptAll(null), title: "Shift+A" },
                      "Accept all",
                  )
                : null,
            undoButton(null, () => "Undo all decisions"),
            finishButton(),
        ),
        isLocal()
            ? el(
                  "p",
                  { class: "badge warn" },
                  "Local preview: look only. Nothing can be decided here; only a CI capture of a pushed commit can.",
              )
            : null,
        items.length > 0
            ? el(
                  "p",
                  { id: "shown", class: "meta" },
                  `Showing ${items.length}: ${errors.length} ${errors.length === 1 ? "error" : "errors"} ` +
                      `(listed first, never accepted) and ${items.length - errors.length} ` +
                      `${items.length - errors.length === 1 ? "image" : "images"} to compare.`,
              )
            : null,
        errors.length > 0
            ? el(
                  "section",
                  { class: "errors" },
                  el(
                      "h3",
                      {},
                      `Errors: ${errors.length} ${errors.length === 1 ? "story" : "stories"} failed to capture`,
                  ),
                  el(
                      "p",
                      { class: "meta" },
                      "An error is never accepted. Fix the story, re-run the visual job for a one-off timeout, " +
                          "or exclude the story with a reason.",
                  ),
                  el("ol", { class: "error-list" }, errors),
              )
            : null,
        ...(items.length === 0 ? [el("p", {}, "Nothing here.")] : sections),
    );
    // An armed bulk Undo lasts until the next redraw: this render showed it, the next one does not.
    state.armed = null;
    remember();
    // Back from a story: show where it is in the grid.
    const current = app.querySelector(".current");
    current?.scrollIntoView({ block: "center" });
}

// A number opens that item; anything else opens the first item whose id contains it.
function goTo(value) {
    const v = value.trim().toLowerCase();
    if (v === "") {
        return;
    }
    let items = visibleItems();
    let at = /^\d+$/.test(v) ? Number(v) - 1 : items.findIndex((i) => i.file.includes(v));
    if (at < 0 || at >= items.length) {
        if (/^\d+$/.test(v)) {
            say(`There is no item ${v}: the list has ${items.length}.`, true);
            return;
        }
        // Not in this filter: look in everything reviewable.
        state.filter = "all";
        state.text = "";
        items = visibleItems();
        at = items.findIndex((i) => i.file.includes(v));
        if (at < 0) {
            say(`No story id contains "${value.trim()}".`, true);
            showGrid();
            return;
        }
    }
    openItem(at);
}

// ---------------------------------------------------------------- screen: story

// Why Flash, Highlight and Spotlight are off: they need two images.
function singleImageNote(item) {
    if (item.baseline && item.capture) {
        return null;
    }
    if (item.status === "removed") {
        return "Only one image: this story was removed, so there is only its baseline.";
    }
    if (item.status === "failed") {
        return "No image: the capture failed.";
    }
    return "New story, no baseline: there is only the new image.";
}

function showStory() {
    stopFlash();
    state.screen = "story";
    const items = passItems();
    if (items.length === 0) {
        showGrid();
        return;
    }
    state.index = Math.max(0, Math.min(state.index, items.length - 1));
    const item = items[state.index];
    if (item.file !== state.lastFile) {
        // An Exclude (or reject) left waiting for a reason on another item is abandoned.
        state.pending = "reject";
        stageShown = null;
    }
    state.lastFile = item.file;
    const d = decisionOf(item);
    if (d?.bulk && !isLocal()) {
        // Opening an item Accept all decided counts it as opened. `opened` never decides, so a stale
        // grid cannot bring back an accept another tab undid or a Finish committed; the decisions
        // are then read again, so such an item shows as undecided.
        delete d.bulk;
        const { id } = state.target;
        api("/api/decide", { id, project: state.project, file: item.file, opened: true, hash: imageHash(item) })
            .then(reload)
            .then(() => {
                if (!decisionOf(item) && state.screen === "story" && state.lastFile === item.file) {
                    showStory();
                    say(`${itemName(item)}: its accept was undone or finished elsewhere; undecided now`);
                }
            })
            .catch((err) => say(err.message, true));
    }
    const note = singleImageNote(item);
    const view = note ? "side" : state.view;
    const onlyExclude = item.status === "unstable" || item.status === "failed";
    const unseeded = item.status === UNSEEDED;
    const decidable = !isLocal() && !unseeded;
    setCrumbs(
        el("button", { type: "button", class: "link", onclick: showGrid }, `${targetLabel()} / ${state.project}`),
        el("span", {}, itemName(item)),
    );
    const sizeChanged =
        item.size &&
        item.baselineSize &&
        (item.size[0] !== item.baselineSize[0] || item.size[1] !== item.baselineSize[1]);
    const viewButton = (v, label, key) =>
        el(
            "button",
            {
                type: "button",
                "aria-pressed": String(view === v),
                disabled: Boolean(note) && v !== "side",
                title: note && v !== "side" ? note : key,
                onclick: () => {
                    state.view = v;
                    showStory();
                },
            },
            label,
        );
    const zoomButton = (z) =>
        el(
            "button",
            {
                type: "button",
                "aria-pressed": String(state.zoom === z),
                title: "Z cycles the zoom",
                onclick: () => {
                    state.zoom = z;
                    showStory();
                },
            },
            z === "fit" ? "Fit to screen" : z === 1 ? "Real size (1x)" : `${z}x`,
        );
    const reason = el("input", {
        id: "reason",
        type: "text",
        placeholder: reasonHint(),
        value: d?.reason ?? "",
        maxlength: "2000",
        onkeydown: (e) => {
            if (e.key === "Enter" && !e.repeat) {
                decide(state.pending);
            }
        },
    });
    const decisionButtons = d
        ? [
              el("span", { class: "meta" }, `Decided: ${d.decision}. To change it, undo it first.`),
              el("button", { type: "button", onclick: () => decide(null), title: "U" }, "Undo"),
          ]
        : [
              state.data.acceptable && !onlyExclude
                  ? el(
                        "button",
                        {
                            type: "button",
                            class: "accept",
                            onclick: () => clicked("accept"),
                            title: "A",
                            // Until both images are shown: renderStage enables it.
                            disabled: true,
                        },
                        "Accept",
                    )
                  : null,
              !onlyExclude
                  ? el(
                        "button",
                        { type: "button", class: "reject", onclick: () => clicked("reject"), title: "R" },
                        "Reject",
                    )
                  : null,
              state.data.acceptable
                  ? el(
                        "button",
                        {
                            type: "button",
                            onclick: () => clicked("exclude"),
                            title: "E: stop capturing every mode of this story",
                        },
                        "Exclude",
                    )
                  : null,
              reason,
          ];
    // Keep the panes' scroll when only the view changes (F, H, S, Space) on the same item and zoom.
    const oldFrame = document.querySelector("#stage .sheet")?.parentElement;
    const keep =
        oldFrame && stageKey === `${item.file}|${state.zoom}` ? [oldFrame.scrollLeft, oldFrame.scrollTop] : null;
    // One screen: the controls, then the two panes taking all the height left, then the decisions.
    render(
        el(
            "div",
            { class: "story-view" },
            el(
                "div",
                { class: "toolbar" },
                el("button", { type: "button", onclick: () => move(-1), title: "K" }, "Previous"),
                el("strong", { id: "position" }, `${state.index + 1} of ${items.length}`),
                el("button", { type: "button", onclick: () => move(1), title: "J" }, "Next"),
                el("strong", { id: "progress" }, progress()),
                el("span", { class: "spacer" }),
                el("button", { type: "button", onclick: showGrid, title: "Escape" }, "Back to the grid"),
                finishButton(),
            ),
            el(
                "h2",
                {},
                itemName(item),
                " ",
                el("span", { class: `badge ${item.status}` }, statusLabel(item.status)),
                item.from ? el("span", { class: "badge moved" }, movedFrom(item)) : null,
                d
                    ? el("span", { class: `badge ${d.decision}` }, `${d.decision}${d.reason ? `: ${d.reason}` : ""}`)
                    : null,
                sizeChanged
                    ? el(
                          "span",
                          { class: "badge warn" },
                          `size changed ${item.baselineSize.join("x")} -> ${item.size.join("x")} image pixels`,
                      )
                    : null,
                item.flaky ? el("span", { class: "badge" }, "flaky") : null,
                item.reReview ? el("span", { class: "badge warn" }, RE_REVIEW) : null,
            ),
            el(
                "p",
                { class: "meta" },
                item.changedPixels !== null ? `${item.changedPixels} changed image pixels` : "",
                item.bbox ? ` in [${item.bbox.join(", ")}]` : "",
                ` at threshold ${item.threshold}; captured at ${scale()} image pixels per CSS pixel`,
            ),
            el(
                "div",
                { class: "toolbar" },
                viewButton("side", "Side by side", ""),
                viewButton("flash", "Flash", "F, or hold Space"),
                viewButton("highlight", "Highlight", "H"),
                viewButton("spotlight", "Spotlight", "S"),
                el(
                    "button",
                    {
                        type: "button",
                        "aria-pressed": String(state.showBox),
                        title: "B: outline the changed box",
                        onclick: () => toggleOption("showBox"),
                    },
                    "Box",
                ),
                el(
                    "button",
                    {
                        type: "button",
                        "aria-pressed": String(state.blink),
                        disabled: view !== "highlight",
                        title:
                            view === "highlight"
                                ? "L: blink the changed pixels"
                                : "Blink flashes the changed pixels that Highlight lays over the images",
                        onclick: () => toggleOption("blink"),
                    },
                    "Blink",
                ),
                el(
                    "button",
                    {
                        type: "button",
                        "aria-pressed": String(state.spotFlash),
                        disabled: view !== "spotlight",
                        title:
                            view === "spotlight"
                                ? "F: flash the spotlighted baseline and new"
                                : "Spotlight flash shows the spotlighted baseline and new one after the other",
                        onclick: () => toggleOption("spotFlash"),
                    },
                    "Spotlight flash",
                ),
                note ? el("span", { id: "single-note", class: "meta" }, note) : null,
                el("span", { class: "spacer" }),
                ZOOMS.map(zoomButton),
                el(
                    "button",
                    {
                        type: "button",
                        id: "next-box",
                        onclick: nextBox,
                        title: "N",
                        disabled: !item.baseline || !item.capture,
                    },
                    "Next changed box",
                ),
                el("span", { id: "box-count", class: "meta" }),
            ),
            el("div", { id: "stage", class: `stage ${view} zoom-${state.zoom}` }),
            item.console.length > 0
                ? el(
                      "details",
                      {
                          class: `console-block ${item.status === "failed" ? "errors" : ""}`,
                          open: item.status === "failed",
                      },
                      el(
                          "summary",
                          {},
                          item.status === "failed" ? `Error: ${item.reason ?? "capture failed"}` : "Console",
                          ` (${item.console.length} lines)`,
                      ),
                      el("pre", { class: "console" }, item.console.join("\n")),
                  )
                : null,
            el(
                "div",
                { class: "actions" },
                isLocal()
                    ? el("p", {}, "Local preview: look only. Only a CI capture of a pushed commit can be decided.")
                    : null,
                unseeded
                    ? el(
                          "p",
                          {},
                          "No baseline yet, and this pull request does not change it: it looks as on master. " +
                              "Seed it from master's capture, or accept it on the pull request that changes it.",
                      )
                    : null,
                decidable ? decisionButtons : null,
            ),
        ),
    );
    renderStage(item, view, keep);
    remember();
}

const reasonHint = () => `Reason (needed to reject or exclude); Enter ${state.pending}s`;

// The changed pixels of an item, padded top-left to the larger size, grown by GROW pixels, and the
// boxes around each separate grown region. Computed once per item and pair of images.
async function diffOf(item) {
    const { file, baseline, capture, threshold, includeAA } = item;
    const key = `${state.target.id}/${state.project}/${file}/${baseline}/${capture}/${threshold}/${includeAA}`;
    return cached(diffs, key, DIFFS_KEPT, async () => {
        const [a, b] = await Promise.all([
            loaded(await image("baseline", item.file, item.baseline), `baseline of ${item.file}`),
            loaded(await image("capture", item.file, item.capture), `capture of ${item.file}`),
        ]);
        const w = Math.max(a.naturalWidth, b.naturalWidth);
        const h = Math.max(a.naturalHeight, b.naturalHeight);
        const pixels = (img) => {
            const ctx = new OffscreenCanvas(w, h).getContext("2d");
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, w, h).data;
        };
        const [pa, pb] = [pixels(a), pixels(b)];
        const mask = new Uint8ClampedArray(w * h * 4);
        pixelmatch(pa, pb, mask, w, h, {
            threshold: item.threshold,
            includeAA: item.includeAA,
            diffMask: true,
        });
        const grown = grow(mask, w, h);
        return { w, h, a: pa, b: pb, mask, grown, boxes: regions(grown, w, h) };
    });
}

// A square dilation by GROW pixels, as two passes (rows, then columns) of a sliding window.
function grow(mask, w, h) {
    const on = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        on[i] = mask[i * 4 + 3] !== 0 ? 1 : 0;
    }
    const pass = (src, count, length, at) => {
        const out = new Uint8Array(w * h);
        for (let line = 0; line < count; line++) {
            let last = -Infinity;
            // Forward then backward: distance to the nearest set pixel along the line.
            for (let k = 0; k < length; k++) {
                if (src[at(line, k)]) {
                    last = k;
                }
                if (k - last <= GROW) {
                    out[at(line, k)] = 1;
                }
            }
            last = Infinity;
            for (let k = length - 1; k >= 0; k--) {
                if (src[at(line, k)]) {
                    last = k;
                }
                if (last - k <= GROW) {
                    out[at(line, k)] = 1;
                }
            }
        }
        return out;
    };
    const rows = pass(on, h, w, (y, x) => y * w + x);
    return pass(rows, w, h, (x, y) => y * w + x);
}

// The bounding boxes [x, y, width, height] of the separate regions of a grown mask, largest first.
function regions(grown, w, h) {
    const seen = new Uint8Array(w * h);
    const boxes = [];
    const stack = [];
    for (let start = 0; start < w * h; start++) {
        if (!grown[start] || seen[start]) {
            continue;
        }
        let [x0, y0, x1, y1] = [w, h, -1, -1];
        seen[start] = 1;
        stack.push(start);
        while (stack.length > 0) {
            const p = stack.pop();
            const x = p % w;
            const y = (p - x) / w;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
            for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
                if (q >= 0 && q < w * h && grown[q] && !seen[q]) {
                    seen[q] = 1;
                    stack.push(q);
                }
            }
        }
        boxes.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1]);
    }
    return boxes.sort((p, q) => q[2] * q[3] - p[2] * p[3]);
}

// Sizes every picture on the stage at one scale, so equal-size images line up pixel for pixel in
// their panes. At "fit" the largest of them fits its pane both ways (never above real size, one CSS
// pixel per CSS pixel the story was drawn at); zoomed, it is real size times the zoom and the
// panes scroll. Each pane's sheet is as large as the largest picture, so both scroll alike.
function fit(stage) {
    const pics = [...stage.querySelectorAll(".sheet > img, .sheet > canvas")];
    const natural = (p) => [p.naturalWidth ?? p.width, p.naturalHeight ?? p.height];
    let [w, h] = [1, 1];
    for (const p of pics) {
        const [x, y] = natural(p);
        [w, h] = [Math.max(w, x), Math.max(h, y)];
    }
    const frame = stage.querySelector(".frame");
    factor =
        state.zoom === "fit"
            ? Math.min(1 / scale(), frame.clientWidth / w, frame.clientHeight / h)
            : state.zoom / scale();
    for (const p of pics) {
        const [x, y] = natural(p);
        p.style.width = `${x * factor}px`;
        p.style.height = `${y * factor}px`;
        p.classList.toggle("crisp", factor * scale() >= CRISP_FROM);
    }
    for (const sheet of stage.querySelectorAll(".sheet")) {
        sheet.style.width = `${w * factor}px`;
        sheet.style.height = `${h * factor}px`;
    }
}

// Two panes, always: the baseline on the left and the new image (or the view's picture) on the
// right. A missing image leaves its pane empty, the same size, so the other one never moves.
async function renderStage(item, view, keep) {
    const seq = ++stageRender;
    const stage = document.getElementById("stage");
    const pane = (text, ...pics) =>
        el(
            "figure",
            {},
            el("div", { class: "label", title: text }, text),
            el(
                "div",
                { class: pics.length ? "frame" : "frame empty" },
                pics.length ? el("div", { class: "sheet" }, pics) : null,
            ),
        );
    const imgOf = async (kind) => {
        const img = await loaded(await image(kind, item.file, item[kind]), `${kind} of ${item.file}`);
        img.alt = `${kind} of ${itemName(item)}`;
        return img;
    };
    try {
        const diff = item.baseline && item.capture ? await diffOf(item) : null;
        const marked = view === "highlight" && diff !== null;
        const baseName = item.from ? `Baseline of ${item.from}` : "Baseline";
        const left = item.baseline
            ? pane(
                  marked ? `${baseName}, changed pixels in red` : baseName,
                  await imgOf("baseline"),
                  ...(marked ? [overlay(diff)] : []),
              )
            : pane("No baseline");
        let right;
        if (!item.capture) {
            right = pane(item.status === "failed" ? "No capture: it failed" : "No capture");
        } else if (view === "side") {
            right = pane(item.baseline ? "New" : "New (no baseline)", await imgOf("capture"));
        } else if (view === "flash" || (view === "spotlight" && state.spotFlash)) {
            // The two images one after the other in the same place: themselves, or both spotlighted.
            const flash = view === "flash";
            const name = flash ? "Flash" : "Spotlight";
            const [base, next] = flash
                ? [await imgOf("baseline"), await imgOf("capture")]
                : [spotlight(diff, diff.a), spotlight(diff, diff.b)];
            if (seq !== stageRender) {
                return;
            }
            next.style.visibility = "hidden";
            right = pane(`${name}: baseline`, base, next);
            right.classList.add("flashing");
            const tag = right.querySelector(".label");
            let showingNew = false;
            flashTimer = setInterval(() => {
                showingNew = !showingNew;
                base.style.visibility = showingNew ? "hidden" : "visible";
                next.style.visibility = showingNew ? "visible" : "hidden";
                tag.textContent = showingNew ? `${name}: new` : `${name}: baseline`;
            }, FLASH_MS);
        } else if (view === "highlight") {
            right = pane("New, changed pixels in red", await imgOf("capture"), overlay(diff));
        } else {
            right = pane("Spotlight: the new image, dimmed except around each change", spotlight(diff));
        }
        if (seq !== stageRender) {
            // Another item (or view) was shown while this one loaded.
            return;
        }
        stage.replaceChildren(left, right);
        stageShown = item.file;
        const accept = document.querySelector(".actions button.accept");
        if (accept) {
            accept.disabled = false;
        }
        if (marked && state.blink) {
            // Both panes' overlays on and off together, at Flash's pace.
            const marks = [...stage.querySelectorAll(".diffmark")];
            let on = true;
            flashTimer = setInterval(() => {
                on = !on;
                for (const m of marks) {
                    m.style.visibility = on ? "visible" : "hidden";
                }
            }, FLASH_MS);
        }
        const frames = [...stage.querySelectorAll(".frame")];
        // Zoomed, scrolling one pane scrolls the other to the same place.
        for (const f of frames) {
            f.addEventListener("scroll", () => {
                for (const o of frames) {
                    if (o !== f && (o.scrollLeft !== f.scrollLeft || o.scrollTop !== f.scrollTop)) {
                        o.scrollLeft = f.scrollLeft;
                        o.scrollTop = f.scrollTop;
                    }
                }
            });
        }
        fit(stage);
        refit.disconnect();
        refit.observe(stage);
        shownBoxes = diff ? diff.boxes : [];
        stageKey = `${item.file}|${state.zoom}`;
        const count = document.getElementById("box-count");
        if (diff) {
            count.textContent =
                diff.boxes.length === 0
                    ? "no changed box at this threshold"
                    : `box ${Math.min(state.box, diff.boxes.length - 1) + 1} of ${diff.boxes.length}`;
            showBox(stage, diff.boxes, false);
        }
        if (keep) {
            for (const f of frames) {
                [f.scrollLeft, f.scrollTop] = keep;
            }
        }
    } catch (err) {
        if (seq === stageRender) {
            stage.replaceChildren(el("p", { class: "error" }, err.message || "the images could not be loaded"));
        }
    }
}

// Outlines the current changed box in every pane, and scrolls it into view. A pane opens at the
// top left of its image; on opening (`jump` false) it scrolls only when the box is smaller than
// the pane and out of sight. Next changed box (`jump` true) always brings the box into view, its
// top left first when it is larger than the pane.
function showBox(stage, boxes, jump) {
    if (boxes.length === 0) {
        return;
    }
    state.box = Math.min(state.box, boxes.length - 1);
    const [x, y, w, h] = boxes[state.box];
    const PAD = 16;
    for (const frame of stage.querySelectorAll(".frame")) {
        const sheet = frame.querySelector(".sheet");
        if (!sheet) {
            continue;
        }
        const [sw, sh] = [sheet.offsetWidth, sheet.offsetHeight];
        // The outline is drawn inside the image, so a box at an edge keeps all four sides.
        const [left, top] = [Math.max(0, x * factor - 2), Math.max(0, y * factor - 2)];
        const [right, bottom] = [Math.min(sw, (x + w) * factor + 2), Math.min(sh, (y + h) * factor + 2)];
        sheet.querySelector(".boxmark")?.remove();
        if (state.showBox) {
            const mark = el("div", { class: "boxmark" });
            Object.assign(mark.style, {
                left: `${left}px`,
                top: `${top}px`,
                width: `${right - left}px`,
                height: `${bottom - top}px`,
            });
            sheet.append(mark);
        }
        if (!jump) {
            frame.scrollLeft = 0;
            frame.scrollTop = 0;
        }
        const fits = right - left <= frame.clientWidth && bottom - top <= frame.clientHeight;
        if (!jump && !fits) {
            continue;
        }
        const reveal = (start, end, scroll, view) => {
            if (end - start > view || start < scroll) {
                return Math.max(0, start - PAD);
            }
            return end > scroll + view ? end - view + PAD : scroll;
        };
        const [ox, oy] = [sheet.offsetLeft, sheet.offsetTop];
        frame.scrollLeft = reveal(ox + left, ox + right, frame.scrollLeft, frame.clientWidth);
        frame.scrollTop = reveal(oy + top, oy + bottom, frame.scrollTop, frame.clientHeight);
    }
}

async function nextBox() {
    const item = current();
    if (!item?.baseline || !item?.capture) {
        return;
    }
    const { boxes } = await diffOf(item);
    if (boxes.length === 0) {
        return;
    }
    state.box = (state.box + 1) % boxes.length;
    document.getElementById("box-count").textContent = `box ${state.box + 1} of ${boxes.length}`;
    showBox(document.getElementById("stage"), boxes, true);
}

// The changed pixels alone, in solid red, transparent everywhere else: laid over an image in the
// same grid cell, so it lines up with the image at every zoom.
function overlay(diff) {
    const canvas = el("canvas", { width: String(diff.w), height: String(diff.h), class: "diffmark" });
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(diff.w, diff.h);
    for (let i = 0; i < diff.w * diff.h; i++) {
        if (diff.mask[i * 4 + 3] !== 0) {
            out.data[i * 4] = 255;
            out.data[i * 4 + 3] = 255;
        }
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
}

// An image (the new one unless given) with everything dimmed except the changed pixels grown by GROW pixels.
function spotlight(diff, px = diff.b) {
    const canvas = el("canvas", { width: String(diff.w), height: String(diff.h) });
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(diff.w, diff.h);
    const keep = 1 - SPOT_ALPHA / 255;
    for (let i = 0; i < diff.w * diff.h; i++) {
        const lit = diff.grown[i] === 1;
        for (let c = 0; c < 3; c++) {
            out.data[i * 4 + c] = lit ? px[i * 4 + c] : px[i * 4 + c] * keep;
        }
        out.data[i * 4 + 3] = lit ? px[i * 4 + 3] : Math.max(px[i * 4 + 3], SPOT_ALPHA);
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
}

async function acceptAll(component) {
    if (!state.data.acceptable || isLocal()) {
        say(`${state.project} cannot be accepted here`, true);
        return;
    }
    const items = undecided(component);
    const n = items.length;
    const where = component ? `the component ${component}` : state.project;
    if (n === 0) {
        say(`Nothing undecided to accept in ${where}.`);
        return;
    }
    // Accepting a removal deletes its baseline, so the question says how many it holds.
    const removals = items.filter((i) => i.status === "removed").length;
    const deletes =
        removals === 0
            ? ""
            : ` This includes ${removals} ${removals === 1 ? "removal" : "removals"}: accepting deletes ${removals === 1 ? "its baseline" : "their baselines"}.`;
    if (!(await ask(`Accept ${n} undecided items of ${where} without opening them?${deletes}`, "Accept"))) {
        return;
    }
    try {
        await api("/api/accept-all", {
            id: state.target.id,
            project: state.project,
            runId: state.data.target.runId,
            runAttempt: state.data.target.runAttempt,
            ...(component ? { component } : {}),
        });
        await reload();
    } catch (err) {
        say(err.message, true);
        return;
    }
    say(`Accepted ${n} items in ${where}.`);
    (state.screen === "story" ? showStory : showGrid)();
}

function move(step) {
    say("");
    const count = passItems().length;
    state.index = (state.index + step + count) % count;
    state.box = 0;
    showStory();
}

async function decide(decision) {
    if (isLocal()) {
        say("A local preview is only looked at: nothing is decided on it.", true);
        return;
    }
    if (deciding) {
        // A second click or key while the first decision is on its way.
        return;
    }
    const items = passItems();
    const item = items[state.index];
    const before = decisionOf(item);
    if (decision === null && !before) {
        return;
    }
    // No key reverses a decision: changing one is an explicit Undo first.
    if (decision !== null && before) {
        const done = { accept: "accepted", reject: "rejected", exclude: "excluded" }[before.decision];
        say(`${itemName(item)} is already ${done}. Press U (Undo) first to change it.`, true);
        return;
    }
    if (decision === "accept" && stageShown !== item.file) {
        say(`${itemName(item)}: wait for both images before accepting.`, true);
        return;
    }
    const reasonBox = document.getElementById("reason");
    const reason = reasonBox?.value.trim() ?? "";
    if ((decision === "reject" || decision === "exclude") && reason === "") {
        state.pending = decision;
        if (reasonBox) {
            reasonBox.placeholder = reasonHint();
            reasonBox.focus();
        }
        say(`A ${decision} needs a reason: type it, then press Enter.`);
        return;
    }
    if (
        decision === "exclude" &&
        !(await ask(
            `Exclude ${item.id}? Every mode of this story stops being captured, on every pull request, ` +
                "until its settings file is removed. To clear a one-off failure, re-run the visual job instead.",
            "Exclude",
        ))
    ) {
        return;
    }
    deciding = true;
    try {
        await api("/api/decide", {
            id: state.target.id,
            project: state.project,
            file: item.file,
            decision,
            reason: reason === "" ? null : reason,
            hash: imageHash(item),
        });
    } catch (err) {
        say(err.message, true);
        return;
    } finally {
        deciding = false;
    }
    if (decision === null) {
        delete state.data.decisions[item.file];
    } else {
        state.data.decisions[item.file] = { decision, reason: reason === "" ? null : reason };
    }
    state.pending = "reject";
    say(`${itemName(item)}: ${decision ?? "undone, undecided again"}`);
    // The pass is frozen, so a decided item stays in it: a decision moves on to the next one, and
    // Previous comes back to it. Undo stays on the item.
    if (decision !== null) {
        state.index = Math.min(state.index + 1, items.length - 1);
    }
    state.box = 0;
    showStory();
}

// A decision button's click; a double click's second one is not a decision on the next item.
function clicked(decision) {
    const now = performance.now();
    if (now - clickedAt >= DOUBLE_CLICK_MS) {
        clickedAt = now;
        decide(decision);
    }
}

// ---------------------------------------------------------------- Finish

function finishButton() {
    if (isLocal()) {
        return null;
    }
    return el(
        "button",
        {
            type: "button",
            class: "primary",
            disabled: running(),
            onclick: (e) => finishTarget(state.target, e.currentTarget),
        },
        `Finish ${targetLabel()}`,
    );
}

// `button` is the Finish button pressed: off from the press until Finish is started or given up,
// so the press shows at once, even while the server is slow to answer.
async function finishTarget(target, button) {
    const label = target.pr === null ? "the master seed" : `#${target.pr}`;
    const what =
        target.pr === null ? "push a seed branch and open its pull request" : `commit and push to ${target.branch}`;
    const giveUp = (text, isError) => {
        button.disabled = running();
        say(text, isError);
    };
    button.disabled = true;
    say(`Checking ${label} before Finish...`);
    let fresh;
    try {
        fresh = await api(`/api/target/${encodeURIComponent(target.id)}`);
    } catch (err) {
        giveUp(`Finish not started: ${err.message}`, true);
        return;
    }
    const lines = [`Finish ${label}: ${what}, across every project?`];
    const notOpened = fresh.projects.reduce((n, p) => n + p.notOpened, 0);
    if (notOpened > 0) {
        lines.push(`${notOpened} accepted without being opened.`);
    }
    const left = fresh.projects.filter((p) => p.undecided > 0);
    if (left.length > 0) {
        lines.push(
            `Warning: still undecided, left for a later round: ${left.map((p) => `${p.project}: ${p.undecided} undecided`).join(", ")}.`,
        );
    }
    lines.push(signerLine(fresh.signer));
    if (fresh.startCommand) {
        lines.push(
            `To sign as yourself instead, cancel and start the server from your own shell:\n${fresh.startCommand}`,
        );
    }
    lines.push("One commit status is posted when Finish completes.");
    say(`Finish ${label}? Answer in the box.`);
    if (!(await ask(lines.join("\n\n"), `Finish ${label}`))) {
        giveUp("Finish cancelled: nothing was changed.");
        return;
    }
    // Finish runs on the server and can take minutes; the page only starts it and then asks how it
    // is going, so a dropped connection or a reload loses nothing.
    say("Starting Finish...");
    try {
        state.job = (await api("/api/finish", { id: target.id })).job;
    } catch (err) {
        // The request may have been lost after the server started it: ask before calling it failed.
        state.job = await api("/api/finish-status")
            .then((s) => s.job)
            .catch(() => null);
        if (!running() || state.job.target !== target.id) {
            giveUp("Finish failed; your decisions are kept. Fix the cause and press Finish again.", true);
            app.prepend(el("pre", { class: "error" }, err.message));
            return;
        }
    }
    await watchFinish();
}

const finishing = () =>
    `Finishing ${state.job.pr === null ? "the master seed" : `#${state.job.pr}`}: ${state.job.step}...`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let watching = false;

// Follows the running Finish to its end, then shows the targets with its outcome.
async function watchFinish() {
    if (watching) {
        return;
    }
    watching = true;
    try {
        while (running()) {
            say(finishing());
            await sleep(1000);
            try {
                track((await api("/api/finish-status")).job);
            } catch (err) {
                say(`Lost contact with the server (${err.message}); Finish goes on there. Retrying...`, true);
                await sleep(2000);
            }
        }
    } finally {
        watching = false;
    }
    await showTargets();
}

// Takes the server's newest Finish. A server restarted during a Finish says it was interrupted;
// one that could not save the Finish knows of none, so the page keeps the one it was following,
// as interrupted, rather than showing the targets as if nothing had run.
function track(job) {
    const last = state.job;
    if (!job && last?.running) {
        job = {
            ...last,
            running: false,
            step: null,
            interrupted: true,
            error:
                `the server restarted while this Finish was at "${last.step}" and kept no record of it: check ` +
                `whether ${last.branch ?? "the visual/seed-* branch"} on origin has its commit before pressing Finish again`,
        };
    }
    state.job = !job && last?.interrupted ? last : job;
}

// What the newest Finish did, shown above the targets until the server restarts.
function finishOutcome() {
    const job = state.job;
    if (!job || job.running) {
        return null;
    }
    const label = job.pr === null ? "the master seed" : `#${job.pr}`;
    if (job.interrupted) {
        return el(
            "section",
            { class: "card finish-outcome" },
            el(
                "p",
                { class: "error" },
                `Finish of ${label} was interrupted: the server restarted while it ran. Your decisions are kept.`,
            ),
            el("pre", { class: "error" }, job.error),
        );
    }
    if (job.error !== null) {
        return el(
            "section",
            { class: "card finish-outcome" },
            el(
                "p",
                { class: "error" },
                `Finish of ${label} failed; your decisions are kept. Fix the cause and press Finish again.`,
            ),
            el("pre", { class: "error" }, job.error),
        );
    }
    const out = job.result;
    const parts = [out.commit ? `Committed ${short(out.commit)} to ${out.branch}.` : "No commit (nothing accepted)."];
    if (out.rejects > 0) {
        parts.push(`${out.rejects} rejects posted.`);
    }
    if (out.issue) {
        parts.push(`Issue: ${out.issue}`);
    }
    if (out.pullRequest) {
        parts.push(`Pull request: ${out.pullRequest}`);
    }
    parts.push(out.statusError ? `The commit status failed: ${out.statusError}` : `Status: ${out.status}.`);
    return el(
        "section",
        { class: "card finish-outcome" },
        el("p", { class: out.statusError ? "error" : "" }, `Finish of ${label} done. `, parts.join(" ")),
    );
}

// ---------------------------------------------------------------- the address

// Every screen is in the address, after the session token, so a copied link opens it again:
// #token=...&target=123&project=p&filter=undecided&q=text&item=file.png&view=side&zoom=fit&box=on&blink=off&flash=off
// Only the fragment holds it: a browser never sends a fragment to a server or in a Referer.
function hashFor() {
    const p = new URLSearchParams({ token });
    if (state.screen !== "targets") {
        p.set("target", state.target.id);
        p.set("project", state.project);
        p.set("filter", state.filter);
        if (state.text) {
            p.set("q", state.text);
        }
    }
    if (state.screen === "story") {
        p.set("item", current().file);
        p.set("view", state.held ?? state.view);
        p.set("zoom", String(state.zoom));
        p.set("box", state.showBox ? "on" : "off");
        p.set("blink", state.blink ? "on" : "off");
        p.set("flash", state.spotFlash ? "on" : "off");
    }
    return `#${p}`;
}

// Writes the screen into the address: a new history entry when the screen changes (so Back
// returns to the one before), in place when only the item, view, zoom or filter does.
function remember() {
    const hash = hashFor();
    if (hash === location.hash) {
        return;
    }
    const was = new URLSearchParams(location.hash.slice(1));
    const screen = was.has("item") ? "story" : was.has("target") ? "grid" : "targets";
    const moved =
        screen !== state.screen ||
        (screen !== "targets" &&
            (was.get("target") !== String(state.target.id) || was.get("project") !== state.project));
    const push = routes === 0 && moved;
    history[push ? "pushState" : "replaceState"](null, "", hash);
}

// Shows the screen the address names; what no longer exists (a closed pull request, a story gone
// from a new CI run) lands on the nearest screen that does, with a line saying so.
async function route() {
    const p = new URLSearchParams(location.hash.slice(1));
    const seq = ++nav;
    routes++;
    try {
        const id = p.get("target");
        if (!id) {
            await showTargets();
            return;
        }
        if (!(await loadTargets()) || seq !== nav) {
            return;
        }
        const target = state.targets.find((t) => String(t.id) === id);
        const project = p.get("project");
        if (!target || !target.projects.some((x) => x.project === project)) {
            const what = target ? `${project} is not a project of ${id}` : `${id} is no longer listed`;
            await showTargets(`${what}: showing every target.`);
            return;
        }
        if (state.data === null || state.target?.id !== target.id || state.project !== project) {
            state.sequence = [];
            state.data = null;
            state.target = target;
            state.project = project;
            try {
                await reload();
            } catch (err) {
                // A project whose download (or target) failed: its problem is on the targets screen.
                const problem = target.projects.find((x) => x.project === project).problem;
                await showTargets(`${project} of ${id} could not be opened: ${problem ?? err.message}`);
                return;
            }
            if (seq !== nav) {
                return;
            }
        }
        state.target = target;
        state.filter = FILTERS.includes(p.get("filter")) ? p.get("filter") : "undecided";
        state.text = p.get("q") ?? "";
        const file = p.get("item");
        if (!file) {
            showGrid();
            return;
        }
        const item = state.data.items.find((i) => i.file === file);
        if (!item) {
            showGrid();
            say(`${file} is not in this CI run any more: showing the grid.`);
            return;
        }
        // Back into the pass it came from keeps that pass; otherwise the grid's items, with this one.
        if (!state.sequence.includes(file)) {
            const shown = visibleItems();
            state.sequence = (shown.includes(item) ? shown : ordered([...shown, item])).map((i) => i.file);
        }
        state.index = state.sequence.indexOf(file);
        state.view = VIEWS.includes(p.get("view")) ? p.get("view") : "side";
        const zoom = p.get("zoom") === "fit" ? "fit" : Number(p.get("zoom"));
        state.zoom = ZOOMS.includes(zoom) ? zoom : "fit";
        // A link's box, blink and flash apply to this page; the browser's remembered choice is unchanged.
        if (["on", "off"].includes(p.get("box"))) {
            state.showBox = p.get("box") === "on";
        }
        if (["on", "off"].includes(p.get("blink"))) {
            state.blink = p.get("blink") === "on";
        }
        if (["on", "off"].includes(p.get("flash"))) {
            state.spotFlash = p.get("flash") === "on";
        }
        state.box = 0;
        say("");
        showStory();
    } finally {
        routes--;
    }
}

// ---------------------------------------------------------------- keys and start

// F, H and S switch to that view, or back to side by side when it is already shown.
function toggleView(view) {
    state.view = state.view === view ? "side" : view;
    showStory();
}

// Safari on an iPad sends a hardware keyboard's keys only to a focused element, and tapping an
// image or a button focuses nothing, so the shortcuts never arrived. The page itself holds focus
// whenever nothing else does.
function keepKeys() {
    if (document.activeElement === null || document.activeElement === document.body) {
        app.focus({ preventScroll: true });
    }
}
document.addEventListener("pointerup", () => setTimeout(keepKeys));
document.addEventListener("focusout", () => setTimeout(keepKeys));
keepKeys();

document.addEventListener("keydown", (e) => {
    // An open question (ask) takes the keys: Escape cancels it.
    const asking = document.querySelector("dialog[open]") !== null;
    if (asking || !["story", "grid"].includes(state.screen) || e.ctrlKey || e.metaKey || e.altKey) {
        return;
    }
    const inInput = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") {
        // From a story, wherever focus is (the reason box included), back to the grid.
        e.preventDefault();
        if (inInput) {
            e.target.blur();
        }
        if (state.screen === "story" || app.querySelector('[data-armed="true"]')) {
            // From a story back to the grid; on the grid, it disarms a bulk Undo pressed once.
            say("");
            showGrid();
        }
        return;
    }
    if (inInput) {
        return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.shiftKey && key === "a") {
        e.preventDefault();
        acceptAll(null);
        return;
    }
    if (state.screen !== "story") {
        return;
    }
    if (key === " ") {
        // Held: flash until released, then back to the view it came from.
        e.preventDefault();
        const item = current();
        if (!e.repeat && state.held === null && item?.baseline && item?.capture) {
            state.held = state.view;
            state.view = "flash";
            showStory();
        }
        return;
    }
    const keys = {
        j: () => move(1),
        k: () => move(-1),
        a: () => decide("accept"),
        r: () => decide("reject"),
        e: () => decide("exclude"),
        u: () => decide(null),
        // In Spotlight, F flashes the spotlighted baseline and new instead of leaving it.
        f: () => (state.view === "spotlight" ? toggleOption("spotFlash") : toggleView("flash")),
        h: () => toggleView("highlight"),
        s: () => toggleView("spotlight"),
        b: () => toggleOption("showBox"),
        l: () => {
            if (state.view === "highlight") {
                toggleOption("blink");
            }
        },
        n: nextBox,
        z: () => {
            state.zoom = ZOOMS[(ZOOMS.indexOf(state.zoom) + 1) % ZOOMS.length];
            showStory();
        },
    };
    const action = keys[key];
    if (e.repeat && ["a", "r", "e", "u"].includes(key)) {
        // A held decision key decides once, never the items after it unseen.
        e.preventDefault();
        return;
    }
    if (action) {
        e.preventDefault();
        action();
    }
});
document.addEventListener("keyup", (e) => {
    if (e.key === " " && state.held !== null) {
        e.preventDefault();
        state.view = state.held;
        state.held = null;
        if (state.screen === "story") {
            showStory();
        }
    }
});
document.getElementById("home").addEventListener("click", () => showTargets());
document.getElementById("copy-link").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(location.href);
        say("Link copied. It carries your session token: it opens this screen on any device.");
    } catch {
        // No clipboard (a page served over plain http to another device): the browser's own box.
        prompt("Copy this link:", location.href);
    }
});
window.addEventListener("popstate", () => route());

if (token === "") {
    render(el("p", { class: "error" }, "No session token: open the URL that visual-review serve printed."));
} else {
    route();
}
