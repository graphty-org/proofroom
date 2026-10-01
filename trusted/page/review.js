/*
 * The review page. Plain JavaScript on purpose: this page is where the owner approves images, so
 * it must stay small enough to read. Every text that came from a pull request (titles, reasons,
 * console lines) is set with textContent, never parsed as HTML.
 *
 * Three screens share one frame: the header (with the target and project pickers and Finish),
 * the screen's own bar (the grid bar, or the story's decision bar), and the status row, the one
 * place the page writes messages. Under them, main shows the screen. The story screen never
 * scrolls: only its two panes do, so its buttons stay where the reader's hand already is.
 */

import pixelmatch from "/pixelmatch.mjs";

const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
const app = document.getElementById("app");
const bar = document.getElementById("bar");
const statusRow = document.getElementById("status-row");
const statusLine = document.getElementById("status");
const alertLine = document.getElementById("alert");
const pickTarget = document.getElementById("pick-target");
const pickProject = document.getElementById("pick-project");
const finishSlot = document.getElementById("finish-slot");

const REVIEWABLE = ["changed", "moved", "new", "unseeded", "removed", "unstable", "failed"];
const ACCEPTABLE = ["changed", "moved", "new", "unseeded", "removed"];
// A story with no baseline that this pull request did not change. It blocks like `new`: accepting it
// creates its first baseline.
const UNSEEDED = "unseeded";
const NO_BASELINE = "no baseline yet";
const statusLabel = (status) => (status === UNSEEDED ? NO_BASELINE : status);
// The grid's More filters, in the order they are listed, with how each is named.
const STATUS_FILTERS = {
    changed: "Changed",
    moved: "Moved",
    new: "New",
    unseeded: "No baseline yet",
    removed: "Removed",
    unstable: "Unstable",
    failed: "Failed captures",
};
// Errors first (their own list), then what changed, then moved, new, unstable and removed stories.
const RANK = { failed: 0, changed: 1, moved: 2, new: 3, unstable: 4, removed: 5, unseeded: 6 };
const FLASH_MS = 333; // one image each third of a second: about 1.5 full cycles a second
// "fit" (the default) shows the whole of both images in their panes, at one scale, never above real
// size; 1 is real size: one CSS pixel per CSS pixel the story was drawn at, scrolling when larger.
const ZOOMS = ["fit", 1, 2, 4, 8];
const CRISP_FROM = 4; // from this zoom on, pixels are drawn as hard squares
const GROW = 10; // image pixels the spotlight and the changed boxes grow each changed pixel by
const SPOT_ALPHA = 190; // the spotlight's dimming, out of 255, as Chromatic's focus mask
// A decision this soon after its item's images appeared is the second tap of a double tap, not a
// decision on an image the reader saw.
const GUARD_MS = 250;
const SLOW_MS = 300; // a wait longer than this says what it waits for
// The grid's decision filters, and how a decision reads on a tile.
const DECISIONS = { accept: "Accepted", reject: "Rejected", exclude: "Excluded" };
const DONE = { accept: "accepted", reject: "rejected", exclude: "excluded" };
// The reviewer's own display choices (the changed-area outline, blinking the overlay, Spotlight
// flash, whether single-letter keys work, the failed-captures list), kept in this browser.
const OPTIONS_KEY = "visual-review:options";
const saved = loadOptions();
const reduceMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const state = {
    list: null, // GET /api/prs?cached=1: the targets, when they were read, and any refresh running
    target: null, // summary of the pull request (or master) being reviewed
    project: null,
    data: null, // GET /api/pr/:id/:project
    filter: "undecided", // the grid opens on what still needs a decision
    text: "", // the grid's Find story text
    // The files of this pass through the stories, frozen when a story is opened from the grid:
    // deciding one never drops it, so Previous goes back to it and its Undo. `pass` names the
    // filter it was taken from, which the address carries.
    pass: "undecided",
    sequence: [],
    index: 0, // the item shown, in `sequence`
    ended: false, // the end card is shown instead of the panes
    lastFile: null, // the item last opened, highlighted when the grid comes back
    view: "side", // side | flash | highlight | spotlight
    zoom: "fit",
    box: 0, // which changed area Next change is on
    showBox: saved.showBox ?? true, // outline the changed area (B)
    blink: saved.blink ?? false, // blink the changed pixels Highlight lays over the images (L)
    spotFlash: saved.spotFlash ?? false, // Spotlight flashes baseline and new (F in Spotlight)
    shortcuts: saved.shortcuts ?? true, // single-letter keys on
    // Flash, Blink and Spotlight flash run; a page load or a deep link opens them stopped.
    motion: true,
    held: null, // the view to return to when Space is released
    pending: null, // "reject" or "exclude" waiting for its reason in the note box
    screen: "targets",
    job: null, // the newest Finish, from GET /api/finish-status
    plan: null, // what the running Finish was started to do, for its step list
};
const running = () => state.job?.running === true;
const VIEWS = ["side", "flash", "highlight", "spotlight"];
const FILTERS = ["undecided", "all", ...REVIEWABLE, ...Object.keys(DECISIONS)];
let routes = 0; // how many routes are running: the page follows the address (a link, Back, Forward)
let nav = 0; // bumped by each screen change that waits on the server: a superseded one stops there
// Text typed in the note box, kept with the item it was typed on until its decision is saved.
const drafts = new Map();
// The last messages, in full, for the key overlay.
const messages = [];
// The least recently used last-opened images and diffs are dropped past these, so a long session
// stays small: an object URL holds its image, and a diff about 13 bytes per image pixel.
const images = new Map();
const IMAGES_KEPT = 50;
const thumbs = new Map();
const THUMBS_KEPT = 400;
const diffs = new Map();
const DIFFS_KEPT = 4;
let stageRender = 0; // the newest renderStage: an older one finishing late writes nothing
let stageShown = null; // the file whose images are on the stage: Accept waits for it
let appearedAt = 0; // when the item on screen appeared, or its images did
let saving = null; // the decision on its way to the server
let flashTimer = null;
let factor = 1; // CSS pixels per image pixel of the pictures on the stage
let shownBoxes = []; // the changed areas of the item on the stage
let stageKey = null; // "file|zoom" of what is on the stage, to keep its scroll across view changes
// At fit, the stage refits when the window (or an iPad's orientation) changes its size.
const refit = new ResizeObserver(() => {
    const stage = document.getElementById("stage");
    if (state.screen === "story" && state.zoom === "fit" && stage?.querySelector(".sheet")) {
        fit(stage);
        showBox(stage, shownBoxes, false, false);
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
    node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return node;
}

const kbd = (key) => el("kbd", { "aria-hidden": "true" }, key);
const spinner = () => el("span", { class: "spinner", "aria-hidden": "true" });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Like replaceChildren, but a null child (a section that does not apply) is left out.
function render(...children) {
    app.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));
}

function setBar(node = null) {
    bar.replaceChildren(...(node ? [node] : []));
}

// The status row. Clearing it during a Finish shows the Finish's step instead, so a screen that
// opens while it runs (a reload, Visual review, a link) never blanks its progress. Errors go to
// the row's alert, which a screen reader reads at once.
function say(text, isError = false) {
    const shown = text === "" && running() ? finishing() : text;
    statusRow.classList.remove("busy");
    statusLine.replaceChildren(isError ? "" : shown);
    alertLine.textContent = isError ? shown : "";
    if (shown && messages.at(-1) !== shown) {
        messages.push(shown);
        messages.splice(0, messages.length - 20);
    }
}

// A message with a spinner, for a wait under way.
function sayBusy(text, ...extra) {
    say(text);
    statusRow.classList.add("busy");
    statusLine.prepend(spinner());
    statusLine.append(...extra);
}

// Shows `label` with the time spent, once a wait has taken SLOW_MS; the returned function ends it.
function waiting(label) {
    const start = performance.now();
    let shown = false;
    let timer = setTimeout(function tick() {
        shown = true;
        const s = Math.floor((performance.now() - start) / 1000);
        sayBusy(s >= 1 ? `${label} ${s} s` : label);
        timer = setTimeout(tick, 1000);
    }, SLOW_MS);
    return () => {
        clearTimeout(timer);
        if (shown) {
            say("");
        }
    };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Asks in the page, never with confirm(): once a browser stops a page's dialogs ("prevent this
// page from creating additional dialogs"), confirm() returns false without showing anything, and
// the button pressed seems to do nothing. Resolves true for `yes`, false for Cancel or Escape.
// `onYes` runs inside the click on `yes` itself, for what a browser allows only there.
function ask(message, yes, { onYes = () => {}, label = null } = {}) {
    // Focus on the box, not a button: the Enter that asked (in the note box) must not answer it.
    const text = el("div", { class: "ask-text", id: "ask-text" }, message);
    const dialog = el("dialog", {
        class: "ask",
        tabindex: "-1",
        "aria-labelledby": label ?? "ask-text",
        "aria-describedby": "ask-text",
    });
    const answer = (value) => () => {
        if (value === "yes") {
            onYes();
        }
        dialog.close(value);
    };
    dialog.append(
        text,
        el(
            "p",
            { class: "actions" },
            el("button", { type: "button", onclick: answer("no") }, "Cancel"),
            el("button", { type: "button", class: "primary", id: "ask-yes", onclick: answer("yes") }, yes),
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
        const err = new Error(json.error ?? `${res.status} ${res.statusText}`);
        err.status = res.status;
        throw err;
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
// the image's hash too, so a newer CI run's image is never answered with an older one. `route`
// is "img" for the image itself, "thumb" for the grid's small copy.
function image(kind, file, hash, route = "img") {
    return cached(
        route === "img" ? images : thumbs,
        `${state.target.id}/${state.project}/${kind}/${file}/${hash}`,
        route === "img" ? IMAGES_KEPT : THUMBS_KEPT,
        () => {
            const path = [route, state.target.id, state.project, kind, file].map(encodeURIComponent).join("/");
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
// The default branch's name, as the server reports it.
const branchName = (t = state.target) => t?.defaultBranch ?? state.list?.defaultBranch ?? "master";
const labelOf = (t) => (t.local ? "Local preview" : t.pr === null ? `${branchName(t)} seed` : `#${t.pr}`);
const undecidedOf = (t) => t.projects.reduce((n, p) => n + p.undecided, 0);
const draftKey = (item) => `${state.target.id}/${state.project}/${item.file}`;

// Errors first, then components by their most urgent item, stories the same way within one, and
// the modes of a story together. Tile numbers follow this order over every item ("All").
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

const reviewable = () => state.data.items.filter((i) => REVIEWABLE.includes(i.status));

// What Find story narrows by: a number is the item's number, not part of an id.
const findText = (text) => (/^\s*\d+\s*$/.test(text) ? "" : text.trim().toLowerCase());

function itemsFor(filter, text = "") {
    const find = findText(text);
    let items = reviewable();
    if (filter === "undecided") {
        items = items.filter((i) => !decisionOf(i));
    } else if (Object.hasOwn(DECISIONS, filter)) {
        items = items.filter((i) => decisionOf(i)?.decision === filter);
    } else if (filter !== "all") {
        items = items.filter((i) => i.status === filter);
    }
    return ordered(find ? items.filter((i) => i.file.includes(find)) : items);
}

const visibleItems = () => itemsFor(state.filter, state.text);

// An item's number is its place in the whole project ("All"), so it never changes as items are
// decided or filtered.
const numbering = new WeakMap();
function numberOf(item) {
    let numbers = numbering.get(state.data);
    if (!numbers) {
        numbers = new Map(ordered(reviewable()).map((i, n) => [i.file, n + 1]));
        numbering.set(state.data, numbers);
    }
    return numbers.get(item.file);
}

// The items of the frozen pass, in its order; an item gone from a reloaded project is left out.
function passItems() {
    const byFile = new Map(state.data.items.map((i) => [i.file, i]));
    return state.sequence.map((f) => byFile.get(f)).filter(Boolean);
}

const current = () => passItems()[state.index];

// The pass is kept in this tab's session storage under its address, so a reload (or Safari
// restoring a tab it discarded) reopens the same pass at the same place.
const passKey = () => `visual-review:pass:${state.target.id}/${state.project}/${state.pass}`;
function savePass() {
    try {
        sessionStorage.setItem(passKey(), JSON.stringify(state.sequence));
    } catch {
        // Not kept: a reload rebuilds the pass from its filter.
    }
}
function loadPass() {
    try {
        const files = JSON.parse(sessionStorage.getItem(passKey()) ?? "null");
        return Array.isArray(files) ? files : null;
    } catch {
        return null;
    }
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

function saveOptions(extra = {}) {
    try {
        localStorage.setItem(
            OPTIONS_KEY,
            JSON.stringify({
                ...loadOptions(),
                showBox: state.showBox,
                blink: state.blink,
                spotFlash: state.spotFlash,
                shortcuts: state.shortcuts,
                ...extra,
            }),
        );
    } catch {
        // Not remembered; the choice still holds for this page.
    }
}

function toggleOption(key) {
    state[key] = !state[key];
    state.motion = true;
    saveOptions();
    showStory();
}

// Takes a project's data from the server as the one on screen.
function adopt(data, project) {
    state.data = data;
    state.target = data.target;
    state.project = project;
    const listed = state.list?.targets?.findIndex((t) => t.id === data.target.id) ?? -1;
    if (listed >= 0) {
        state.list.targets[listed] = data.target;
    }
}

// A decision changed the target's counts: the header's Finish and the pickers follow.
function counted(item, before, after, unpublished) {
    const p = state.target.projects.find((x) => x.project === state.project);
    if (p && Boolean(before) !== Boolean(after)) {
        p.decided += after ? 1 : -1;
        p.undecided += after ? -1 : 1;
    }
    if (typeof unpublished === "number") {
        state.target.unpublished = unpublished;
    }
    drawHeader();
}

// ---------------------------------------------------------------- header

// The target and project pickers (on the grid and story screens) and Finish.
function drawHeader() {
    const onTargets = state.screen === "targets" || state.target === null;
    pickTarget.parentElement.hidden = onTargets;
    pickProject.parentElement.hidden = onTargets;
    finishSlot.replaceChildren();
    if (onTargets) {
        return;
    }
    const targets = state.list?.targets ?? [state.target];
    const listed = targets.some((t) => t.id === state.target.id) ? targets : [state.target, ...targets];
    pickTarget.replaceChildren(
        ...listed.map((t) =>
            el(
                "option",
                { value: t.id, selected: t.id === state.target.id },
                t.local ? labelOf(t) : `${labelOf(t)} (${undecidedOf(t)})`,
            ),
        ),
    );
    pickProject.replaceChildren(
        ...state.target.projects
            .filter((p) => p.reviewable > 0 || p.project === state.project)
            .map((p) =>
                el(
                    "option",
                    { value: p.project, selected: p.project === state.project, disabled: p.reviewable === 0 },
                    `${p.project} (${p.undecided})`,
                ),
            ),
    );
    if (!isLocal()) {
        finishSlot.append(...finishControl(state.target));
    }
}

// Finish names its target and how many decisions it would publish. At 0 it is unavailable, and
// says why, unless the last Finish of this target could not set the commit status.
function finishControl(t) {
    const count = t.unpublished ?? 0;
    const statusAgain = state.job?.target === t.id && !running() && Boolean(state.job.result?.statusError);
    const can = (count > 0 || statusAgain) && !running();
    return [
        el(
            "button",
            {
                type: "button",
                class: "primary finish",
                "aria-disabled": String(!can),
                "aria-describedby": count === 0 && !statusAgain ? `finish-why-${t.id}` : null,
                onclick: (e) => {
                    if (can) {
                        finishTarget(t.id, e.currentTarget);
                    } else {
                        say(running() ? "A Finish is running: wait for it to end." : "Nothing new to finish.");
                    }
                },
            },
            `Finish ${labelOf(t)} (${count})`,
        ),
        count === 0 && !statusAgain
            ? el("span", { class: "meta finish-why", id: `finish-why-${t.id}` }, "Nothing new to finish")
            : null,
    ].filter(Boolean);
}

pickTarget.addEventListener("change", () => openTarget(pickTarget.value, false));
pickProject.addEventListener("change", () => openProject(state.target.id, pickProject.value));

// ---------------------------------------------------------------- screen: targets

// A refresh's step as the page says it: "Finding CI runs: 3 of 5".
function stepText(r) {
    const name = r.step.charAt(0).toUpperCase() + r.step.slice(1);
    return r.total !== null && r.done !== null ? `${name}: ${r.done} of ${r.total}` : name;
}

const secondsSince = (from, now) => Math.max(0, Math.round((now - from) / 1000));

// Every target, from the server's cached list: drawn at once, and refreshed in the background
// when the list is over a minute old or Refresh is pressed.
async function showTargets(notice = "", refresh = false) {
    const seq = ++nav;
    stopFlash();
    state.screen = "targets";
    state.ended = false;
    app.classList.remove("story-screen");
    setBar();
    drawHeader();
    remember();
    say(notice);
    drawTargets();
    let ask = refresh ? "refresh" : "cached";
    for (;;) {
        let list;
        try {
            list = await api(`/api/prs?${ask}=1`);
        } catch (err) {
            if (seq === nav) {
                say(`Could not read the targets: ${err.message}`, true);
            }
            return;
        }
        if (seq !== nav) {
            return;
        }
        const before = JSON.stringify(state.list?.targets ?? null);
        state.list = list;
        const stale = list.targets && list.updatedAt !== null && list.now - list.updatedAt > 60000;
        if (ask === "cached" && stale && !list.refreshing) {
            ask = "refresh";
            continue;
        }
        if (JSON.stringify(list.targets ?? null) === before) {
            drawListLine();
        } else {
            drawTargets();
        }
        const downloading = list.targets?.some((t) => t.downloading);
        if (!list.refreshing && !downloading) {
            return;
        }
        ask = "cached";
        await sleep(list.refreshing ? 700 : 3000);
        if (seq !== nav) {
            return;
        }
    }
}

// The line above the cards: how old the list is, and Refresh; or the refresh under way.
function listLine() {
    const list = state.list;
    if (!list) {
        return el("p", { class: "listline", id: "listline" }, spinner(), "Loading pull requests...");
    }
    if (list.refreshing) {
        const s = secondsSince(list.refreshing.startedAt, list.now);
        const what = list.targets ? "Checking pull requests" : "Loading pull requests";
        return el(
            "p",
            { class: "listline", id: "listline" },
            spinner(),
            `${what}: ${stepText(list.refreshing)}, ${s} s`,
        );
    }
    return el(
        "p",
        { class: "listline", id: "listline" },
        list.updatedAt ? `Updated ${secondsSince(list.updatedAt, list.now)} s ago` : "",
        el("button", { type: "button", onclick: () => showTargets("", true) }, "Refresh"),
    );
}

function drawListLine() {
    document.getElementById("listline")?.replaceWith(listLine());
}

function drawTargets() {
    if (state.screen !== "targets") {
        return;
    }
    const targets = state.list?.targets;
    if (!targets) {
        // The first load after the server starts: one placeholder card under the server's step.
        render(listLine(), el("section", { class: "card placeholder", "aria-hidden": "true" }));
        return;
    }
    const finishable = targets.find((t) => !t.local);
    render(
        finishOutcome(),
        finishable ? signerBlock(finishable) : null,
        listLine(),
        targets.length === 0
            ? el("p", {}, "No open pull requests. To seed baselines, start the server with --master-run <run id>.")
            : null,
        ...targets.map(targetCard),
    );
    if (running()) {
        drawFinishPanel();
    }
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

// One line; a card with the command to sign as yourself when someone else started the server.
function signerBlock(t) {
    if (!t.startCommand) {
        return el("p", { class: "meta signer" }, signerLine(t.signer));
    }
    return el(
        "section",
        { class: "card signer" },
        el("p", {}, signerLine(t.signer)),
        el("p", {}, "To sign as yourself, stop this server and start it from your own shell, in your own terminal:"),
        el("pre", { class: "console" }, t.startCommand),
    );
}

const link = (href, text) => el("a", { href, target: "_blank", rel: "noreferrer" }, text);

function targetCard(t) {
    const heading = t.local ? "Local preview " : t.pr === null ? `${branchName(t)} seed` : `#${t.pr} `;
    const busy = running() && state.job.target === t.id;
    const shown = t.projects.filter((p) => p.reviewable > 0 || p.problem || p.downloading);
    const unchanged = t.projects.filter((p) => !shown.includes(p));
    const problem = t.projects.find((p) => p.problem)?.problem;
    return el(
        "section",
        { class: "card", "data-target": t.id },
        el("h2", {}, heading, t.url ? link(t.url, t.title) : t.pr === null ? null : t.title),
        t.local
            ? el("p", { class: "meta" }, t.title)
            : t.runId
              ? el(
                    "p",
                    { class: "meta" },
                    t.commit || t.headSha
                        ? `Captured ${short(t.pr === null ? t.commit : t.headSha)}${t.branch ? ` on ${t.branch}` : ""}, `
                        : "",
                    t.runUrl ? link(t.runUrl, `CI run ${t.runId}`) : `CI run ${t.runId}`,
                    ` (attempt ${t.runAttempt})`,
                )
              : el("p", { class: "meta" }, problem ?? "No CI run"),
        ...(t.warnings ?? []).map((w) =>
            el(
                "p",
                { class: "warning" },
                w.replace(/; reload the page to retry$/, ""),
                /reload the page to retry$/.test(w)
                    ? el("button", { type: "button", onclick: () => showTargets("", true) }, "Retry")
                    : null,
            ),
        ),
        t.downloading ? el("p", { class: "meta" }, spinner(), "Downloading the captures...") : null,
        !t.local && t.unpublished > 0
            ? el("p", { class: "meta" }, `${plural(t.unpublished, "decision")} not yet finished`)
            : null,
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
        shown.length > 0
            ? el(
                  "table",
                  {},
                  el(
                      "tr",
                      {},
                      el("th", {}, "Project"),
                      el("th", {}, "Results"),
                      el("th", {}, "Decided"),
                      el("th", {}, el("span", { class: "meta" }, "")),
                  ),
                  shown.map((p) => projectRow(t, p)),
              )
            : null,
        unchanged.length > 0
            ? el(
                  "p",
                  { class: "meta" },
                  `${plural(unchanged.length, "project")} unchanged: ${unchanged.map((p) => p.project).join(", ")}`,
              )
            : null,
        t.local
            ? null
            : busy
              ? el("p", { class: "finish-running" }, `Finish is running: ${state.job.step}...`)
              : el("p", { class: "finish-line" }, ...finishControl(t)),
    );
}

function projectRow(t, p) {
    const results = Object.entries(p.counts)
        .filter(([s]) => REVIEWABLE.includes(s))
        .map(([s, n]) => `${n} ${statusLabel(s)}`)
        .join(", ");
    const retry = p.problem && /reload/.test(p.problem);
    return el(
        "tr",
        {},
        el(
            "td",
            {},
            p.project,
            p.acceptable || t.local || p.downloading || p.problem
                ? null
                : el("span", { class: "badge" }, "Reject only here: accept on a pull request"),
        ),
        el(
            "td",
            {},
            p.problem
                ? el(
                      "span",
                      { class: "badge warn" },
                      p.problem.replace(/[;:] reload (the page )?(to retry|in a moment|when it finishes)$/, ""),
                  )
                : null,
            p.problem && p.logUrl ? [" -- ", link(p.logUrl, "Job log")] : null,
            retry ? [" ", el("button", { type: "button", onclick: () => showTargets("", true) }, "Retry")] : null,
            p.problem ? " " : null,
            results,
        ),
        el("td", {}, t.local || p.downloading ? "-" : `${p.decided} of ${p.reviewable}`),
        el(
            "td",
            {},
            p.downloading
                ? el("button", { type: "button", disabled: true }, spinner(), "Downloading...")
                : p.reviewable > 0
                  ? el("button", { type: "button", onclick: () => openProject(t.id, p.project) }, "Review")
                  : null,
        ),
    );
}

// The next target after `id` in the list's order that still has undecided items.
function nextTarget(id) {
    const list = (state.list?.targets ?? []).filter((t) => !t.local);
    const at = list.findIndex((t) => t.id === id);
    return [...list.slice(at + 1), ...list.slice(0, Math.max(at, 0))].find((t) => t.id !== id && undecidedOf(t) > 0);
}

// A target from the pickers or an offer: its first project with something undecided (its grid,
// or with `story`, its first undecided item).
async function openTarget(id, story) {
    const t = state.list?.targets?.find((x) => x.id === id);
    const p = t?.projects.find((x) => x.undecided > 0 && !x.downloading) ?? t?.projects.find((x) => x.reviewable > 0);
    if (!p) {
        await showTargets(t ? `${labelOf(t)} has nothing to review yet.` : "");
        return;
    }
    await openProject(id, p.project, story);
}

// ---------------------------------------------------------------- screen: project grid

// Opens a project's grid, or with `story` its first undecided item (Next project).
async function openProject(targetId, project, story = false) {
    const seq = ++nav;
    stopFlash();
    const done = waiting(`Loading ${project}...`);
    if (state.screen === "targets") {
        render(el("p", { class: "meta" }, spinner(), `Loading ${project}...`));
    }
    let data;
    try {
        data = await api(`/api/pr/${encodeURIComponent(targetId)}/${encodeURIComponent(project)}`);
    } catch (err) {
        done();
        if (seq === nav) {
            say(err.message, true);
        }
        return;
    }
    done();
    if (seq !== nav) {
        return;
    }
    adopt(data, project);
    state.filter = "undecided";
    state.text = "";
    state.lastFile = null;
    state.sequence = [];
    say("");
    if (story && itemsFor("undecided").length > 0) {
        startPass("undecided");
        return;
    }
    // Nothing left to decide (or a local preview): show everything instead of an empty grid.
    if (visibleItems().length === 0) {
        state.filter = "all";
    }
    showGrid();
}

async function reload() {
    adopt(
        await api(`/api/pr/${encodeURIComponent(state.target.id)}/${encodeURIComponent(state.project)}`),
        state.project,
    );
}

// Thumbnails load only near the screen, at most six at a time, so a fast scroll through a large
// project fetches what is shown, not every tile it passed.
const thumbQueue = [];
let thumbsLoading = 0;
const nearScreen = new IntersectionObserver(
    (entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                nearScreen.unobserve(e.target);
                thumbQueue.push(e.target.querySelector("img[data-hash]"));
            }
        }
        pumpThumbs();
    },
    { rootMargin: "300px" },
);

function pumpThumbs() {
    while (thumbsLoading < 6 && thumbQueue.length > 0) {
        const img = thumbQueue.shift();
        if (!img.isConnected) {
            continue;
        }
        thumbsLoading++;
        const { kind, file, hash } = img.dataset;
        const wait = img.previousElementSibling;
        image(kind, file, hash, "thumb")
            .then(
                (url) => {
                    img.src = url;
                    img.hidden = false;
                    wait?.remove();
                    delete img.closest(".tile").dataset.failed;
                },
                () => {
                    if (wait) {
                        wait.textContent = "Failed -- tap to retry";
                    }
                    img.closest(".tile").dataset.failed = "";
                },
            )
            .finally(() => {
                thumbsLoading--;
                pumpThumbs();
            });
    }
}

// Opens the item `file` of the grid, and freezes what the grid shows as the pass Next and
// Previous walk through.
function openItem(file) {
    say("");
    const shown = visibleItems();
    const item = state.data.items.find((i) => i.file === file);
    state.pass = state.filter;
    state.sequence = (shown.includes(item) ? shown : ordered([...shown, item])).map((i) => i.file);
    state.index = state.sequence.indexOf(file);
    enterStory();
}

// A pass over every item a filter selects, from its first: "Review 152 undecided".
function startPass(filter) {
    const items = itemsFor(filter);
    if (items.length === 0) {
        say("Everything is decided.");
        return;
    }
    state.pass = filter;
    state.sequence = items.map((i) => i.file);
    state.index = 0;
    enterStory();
}

function enterStory() {
    savePass();
    state.ended = false;
    state.box = 0;
    if (reduceMotion()) {
        state.motion = false;
    }
    showStory();
}

function tile(item) {
    const number = numberOf(item);
    const kind = item.capture ? "capture" : item.baseline ? "baseline" : null;
    const img = kind
        ? el("img", {
              "data-kind": kind,
              "data-file": item.file,
              "data-hash": item[kind],
              alt: itemName(item),
              hidden: true,
          })
        : null;
    const d = decisionOf(item);
    const button = el(
        "button",
        {
            type: "button",
            class: `tile ${d ? `decided ${d.decision}` : ""} ${item.file === state.lastFile ? "current" : ""}`,
            "data-file": item.file,
            onclick: (e) => {
                // A failed thumbnail is fetched again; otherwise the tile opens its item.
                if (img && e.currentTarget.dataset.failed !== undefined) {
                    thumbQueue.push(img);
                    img.previousElementSibling.textContent = "Loading...";
                    pumpThumbs();
                    return;
                }
                openItem(item.file);
            },
        },
        img ? el("span", { class: "thumb-wait" }, "Loading...") : el("div", { class: "noimage" }, item.status),
        img,
        el("span", { class: "name" }, el("span", { class: "number" }, `${number}`), " ", item.mode ?? ""),
        el("span", { class: `badge ${item.status}` }, statusLabel(item.status)),
        item.from ? el("span", { class: "moved-from" }, movedFrom(item)) : null,
        item.reReview ? el("span", { class: "badge warn" }, "re-review") : null,
    );
    if (img) {
        // The tile, not its image: an image not shown yet has no box to come near the screen.
        nearScreen.observe(button);
    }
    return el("div", { class: "tile-box", "data-file": item.file }, button, decisionLine(item));
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
        el("span", { class: "what" }, text),
        d.posted
            ? el("span", { class: "meta" }, "Posted by an earlier Finish: it stays.")
            : el(
                  "button",
                  {
                      type: "button",
                      "aria-label": `Undo the ${d.decision} of ${itemName(item)}`,
                      onclick: () => undo([item.file], `#${numberOf(item)}`, true),
                  },
                  "Undo",
              ),
    );
}

// A failed capture: its reason, and the console and stack output, in the errors list.
function errorRow(item) {
    return el(
        "li",
        { class: item.file === state.lastFile ? "current" : null, "data-file": item.file },
        el(
            "button",
            { type: "button", class: "link", onclick: () => openItem(item.file) },
            el("span", { class: "number" }, `${numberOf(item)}`),
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

// The files whose decisions a bulk Undo in `component` (or the whole project) clears: every
// decision not yet posted by Finish.
const undoableIn = (component) =>
    state.data.items
        .filter((i) => decisionOf(i) && !decisionOf(i).posted && (!component || componentOf(i.id) === component))
        .map((i) => i.file);

function showGrid() {
    stopFlash();
    nearScreen.disconnect();
    thumbQueue.length = 0;
    state.screen = "grid";
    state.ended = false;
    state.pending = null;
    app.classList.remove("story-screen");
    drawHeader();
    const all = reviewable();
    const items = visibleItems();
    const decided = all.filter(decisionOf).length;
    const open = all.length - decided;
    const acceptable = state.data.acceptable && !isLocal();
    const takeable = undecided(null).length;
    const counts = {};
    for (const i of all) {
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
    const more = el(
        "select",
        {
            id: "more-filters",
            "aria-label": "More filters",
            onchange: (e) => {
                state.filter = e.target.value || "undecided";
                showGrid();
            },
        },
        el("option", { value: "" }, "More filters"),
        Object.entries(STATUS_FILTERS)
            .filter(([s]) => counts[s])
            .map(([s, name]) => el("option", { value: s, selected: state.filter === s }, `${name} (${counts[s]})`)),
        isLocal()
            ? null
            : Object.entries(DECISIONS).map(([k, name]) =>
                  el(
                      "option",
                      { value: k, selected: state.filter === k },
                      `${name} (${all.filter((i) => decisionOf(i)?.decision === k).length})`,
                  ),
              ),
    );
    let findTimer = null;
    const find = el("input", {
        id: "find",
        type: "search",
        placeholder: "Id or number; Enter opens",
        value: state.text,
        autocomplete: "off",
        oninput: (e) => {
            clearTimeout(findTimer);
            findTimer = setTimeout(() => {
                state.text = e.target.value;
                applyFind();
                remember();
            }, 200);
        },
        onkeydown: (e) => {
            if (e.key === "Enter") {
                clearTimeout(findTimer);
                state.text = findText(e.target.value) === "" ? "" : e.target.value;
                goTo(e.target.value);
            }
        },
    });
    const undoAll = undoableIn(null);
    setBar(
        el(
            "div",
            { class: "gridbar" },
            el(
                "div",
                { class: "row" },
                el("strong", { id: "progress" }, `${decided} of ${all.length} decided`),
                el(
                    "button",
                    {
                        type: "button",
                        class: "primary",
                        id: "review-undecided",
                        "aria-disabled": String(open === 0),
                        onclick: () => startPass("undecided"),
                    },
                    `Review ${open} undecided`,
                ),
                el(
                    "span",
                    { role: "group", "aria-label": "Show" },
                    filterButton("undecided", `Needs a decision (${open})`),
                    filterButton("all", `All (${all.length})`),
                    more,
                ),
            ),
            el(
                "div",
                { class: "row" },
                el("label", { for: "find" }, "Find story", find),
                acceptable
                    ? el(
                          "button",
                          {
                              type: "button",
                              class: "accept",
                              id: "accept-all",
                              "aria-keyshortcuts": "Shift+A",
                              "aria-disabled": String(takeable === 0),
                              onclick: () => acceptAll(null),
                          },
                          `Accept all undecided (${takeable})`,
                      )
                    : null,
                el(
                    "details",
                    { class: "menu" },
                    el("summary", {}, "More"),
                    el(
                        "div",
                        {},
                        isLocal()
                            ? null
                            : el(
                                  "button",
                                  {
                                      type: "button",
                                      class: "undo-all",
                                      "aria-disabled": String(undoAll.length === 0),
                                      onclick: () => bulkUndo(null),
                                  },
                                  "Undo all decisions...",
                              ),
                        el("button", { type: "button", onclick: copyLink }, "Copy link to this grid"),
                    ),
                ),
            ),
        ),
    );
    const errors = [];
    const groups = new Map(); // component -> story id -> [tile]
    for (const item of items) {
        if (item.status === "failed") {
            errors.push(errorRow(item));
            continue;
        }
        const c = componentOf(item.id);
        if (!groups.has(c)) {
            groups.set(c, new Map());
        }
        const stories = groups.get(c);
        if (!stories.has(item.id)) {
            stories.set(item.id, []);
        }
        stories.get(item.id).push(tile(item));
    }
    const sections = [...groups].map(([component, stories]) => {
        const n = undecided(component).length;
        const k = undoableIn(component).length;
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
                          `Accept ${n}`,
                      )
                    : null,
                !isLocal() && k > 0
                    ? el(
                          "button",
                          { type: "button", class: "undo-all", onclick: () => bulkUndo(component) },
                          `Undo ${k}`,
                      )
                    : null,
            ),
            el(
                "div",
                { class: "stories" },
                [...stories].map(([id, tiles]) =>
                    el(
                        "div",
                        { class: "story", "data-story": id },
                        el("div", { class: "story-name" }, id.slice(component.length + 2) || id),
                        el("div", { class: "modes" }, tiles),
                    ),
                ),
            ),
        );
    });
    const empty =
        state.filter === "undecided"
            ? isLocal()
                ? "Nothing here."
                : `Everything is decided. Finish ${labelOf(state.target)} when ready.`
            : "No stories match this filter.";
    render(
        isLocal()
            ? el(
                  "p",
                  { class: "badge warn" },
                  "Local preview: look only. Nothing can be decided here; only a CI capture of a pushed commit can.",
              )
            : null,
        errors.length > 0
            ? el(
                  "details",
                  {
                      class: "errors",
                      open: loadOptions().showFailed === true,
                      ontoggle: (e) => saveOptions({ showFailed: e.target.open }),
                  },
                  el("summary", {}, `${plural(errors.length, "failed capture")}: only Exclude applies`),
                  el(
                      "p",
                      { class: "meta" },
                      "An error is never accepted. Fix the story, re-run the visual job for a one-off timeout, " +
                          "or exclude the story with a reason.",
                  ),
                  el("ol", { class: "error-list" }, errors),
              )
            : null,
        ...(items.length === 0 ? [el("p", { class: "empty" }, empty)] : sections),
    );
    applyFind();
    remember();
    // Back from a story: show where it is in the grid.
    const here = app.querySelector(".current");
    here?.scrollIntoView({ block: "center" });
}

// Find story narrows the grid by hiding tiles (not rebuilding them), so typing stays quick.
function applyFind() {
    const text = findText(state.text);
    for (const node of app.querySelectorAll(".tile-box[data-file], .error-list li[data-file]")) {
        node.hidden = text !== "" && !node.dataset.file.includes(text);
    }
    for (const story of app.querySelectorAll(".story")) {
        story.hidden = story.querySelector(".tile-box:not([hidden])") === null;
    }
    for (const c of app.querySelectorAll(".component")) {
        c.hidden = c.querySelector(".story:not([hidden])") === null;
    }
}

// A number opens the item with that number; anything else opens the first item whose id
// contains it.
function goTo(value) {
    const v = value.trim().toLowerCase();
    if (v === "") {
        return;
    }
    const all = ordered(reviewable());
    if (/^\d+$/.test(v)) {
        const n = Number(v);
        if (n < 1 || n > all.length) {
            say(`No item ${v}: items are numbered 1 to ${all.length} in All.`, true);
            return;
        }
        openItem(all[n - 1].file);
        return;
    }
    let hit = visibleItems().find((i) => i.file.includes(v));
    if (!hit) {
        // Not in this filter: look in everything reviewable.
        hit = all.find((i) => i.file.includes(v));
        if (!hit) {
            say(`No story id contains "${value.trim()}".`, true);
            return;
        }
        state.filter = "all";
    }
    openItem(hit.file);
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
    return "Only one image: there is no baseline to compare it with.";
}

const UNSTABLE =
    "Unstable: two captures of the same commit differed, so it cannot be accepted or rejected. Fix the story, or exclude it.";
const FAILED = "Failed: the story did not render. Fix it, re-run the visual job, or exclude it.";
const notSeeded = () => `Accept on a pull request: ${state.project} is not seeded from ${branchName()}.`;
const onlyExclude = (item) => item.status === "unstable" || item.status === "failed";

// Which decision buttons apply to `item` now; one that does not is shown unavailable, never removed.
function available(item, d) {
    const open = !isLocal() && !state.ended;
    const acceptable = state.data.acceptable;
    return {
        accept: open && acceptable && !onlyExclude(item) && !d,
        reject: open && !onlyExclude(item) && !d,
        exclude: open && acceptable && !d,
        undo: open && Boolean(d) && !d.posted,
    };
}

// The item line's second line: why a button is unavailable or what it will do, the item's status
// note, or what changed.
function explanation(item, d) {
    if (isLocal()) {
        return "Local preview: look only. Only a CI capture of a pushed commit can be decided.";
    }
    if (state.pending === "exclude") {
        return "Exclude stops capturing every mode of this story.";
    }
    if (d?.posted) {
        return "Posted by an earlier Finish: it stays.";
    }
    if (item.status === "unstable") {
        return UNSTABLE;
    }
    if (item.status === "failed") {
        return FAILED;
    }
    if (!d && !state.data.acceptable) {
        return notSeeded();
    }
    if (item.status === "removed") {
        return "Removed from the Storybook: Accept deletes its baseline.";
    }
    if (item.status === UNSEEDED) {
        return (
            `No baseline yet, and this pull request does not change it: it looks as on ${branchName()}. ` +
            "Accepting it makes this image its first baseline."
        );
    }
    if (item.status === "new") {
        return "New story: no baseline yet.";
    }
    const parts = [];
    if (item.changedPixels !== null && item.changedPixels !== undefined) {
        parts.push(`${item.changedPixels} pixels changed`);
        if (item.bbox) {
            const [x, y, w, h] = item.bbox;
            parts.push(`, in a ${w} x ${h} area at (${x}, ${y})`);
        }
        parts.push(". ");
    }
    parts.push(`Threshold ${item.threshold}.`);
    return parts.join("");
}

// The id of the decision-bar button that has focus, to give it back after a redraw.
function barFocus() {
    const a = document.activeElement;
    return a && a.tagName === "BUTTON" && bar.contains(a) && a.id ? a.id : null;
}

function showStory({ focusNote = false } = {}) {
    stopFlash();
    const items = passItems();
    if (items.length === 0) {
        showGrid();
        return;
    }
    const focusId = barFocus();
    state.screen = "story";
    state.index = Math.max(0, Math.min(state.index, items.length - 1));
    const item = items[state.index];
    if (item.file !== state.lastFile) {
        // An Exclude (or reject) left waiting for a reason on another item is abandoned.
        state.pending = null;
        stageShown = null;
        appearedAt = performance.now();
    }
    state.lastFile = item.file;
    const d = decisionOf(item);
    if (d?.bulk && !isLocal()) {
        // Opening an item Accept all decided counts it as opened. `opened` never decides, so a stale
        // grid cannot bring back an accept another tab undid or a Finish committed; the decisions
        // are then read again, so such an item shows as undecided.
        delete d.bulk;
        d.wasBulk = true;
        const { id } = state.target;
        api("/api/decide", { id, project: state.project, file: item.file, opened: true, hash: imageHash(item) })
            .then(reload)
            .then(() => {
                if (!decisionOf(item) && state.screen === "story" && state.lastFile === item.file) {
                    showStory();
                    say(`#${numberOf(item)}: its accept was undone or finished elsewhere; undecided now`);
                }
            })
            .catch((err) => say(err.message, true));
    }
    app.classList.add("story-screen");
    drawHeader();
    setBar(decisionBar(item, items, d));
    const note = singleImageNote(item);
    const view = note ? "side" : state.view;
    // Keep the panes' scroll when only the view changes (F, H, S, Space) on the same item and zoom.
    const oldFrame = document.querySelector("#stage .sheet")?.parentElement;
    const keep =
        !state.ended && oldFrame && stageKey === `${item.file}|${state.zoom}`
            ? [oldFrame.scrollLeft, oldFrame.scrollTop]
            : null;
    render(
        el(
            "div",
            { class: "story-view" },
            itemLine(item, d),
            viewBar(item, view, note),
            state.ended
                ? endCard()
                : el("div", { id: "stage", class: `stage ${view} zoom-${state.zoom}`, "data-file": item.file }),
        ),
    );
    if (!state.ended) {
        renderStage(item, view, keep);
    }
    // Focus goes back where it was: on the same bar button if one had it, never into the note box
    // unless a reject or exclude is waiting for its reason.
    if (focusNote) {
        document.getElementById("note").focus();
    } else if (focusId && document.getElementById(focusId)) {
        document.getElementById(focusId).focus({ preventScroll: true });
    } else if (!state.ended) {
        app.focus({ preventScroll: true });
    }
    remember();
}

// The decision bar: Grid, Previous, the count, Next, then Accept, Reject, Exclude, Undo and the
// note box, each always present in the same place.
function decisionBar(item, items, d) {
    const can = available(item, d);
    const left = items.filter((i) => !decisionOf(i)).length;
    const waitingImages = can.accept && stageShown !== item.file;
    const button = (id, name, key, ok, extra = {}, ...prefix) =>
        el(
            "button",
            {
                type: "button",
                id,
                "aria-disabled": String(!ok),
                "aria-describedby": ok ? null : "explain",
                "aria-keyshortcuts": key,
                ...extra,
            },
            ...prefix,
            name,
            kbd(key),
        );
    const draft = drafts.get(draftKey(item)) ?? "";
    return el(
        "div",
        { class: "decisionbar", role: "toolbar", "aria-label": "Decide" },
        el(
            "button",
            { type: "button", id: "to-grid", "aria-keyshortcuts": "Escape", onclick: () => toGrid() },
            "Grid",
            kbd("Esc"),
        ),
        el(
            "button",
            { type: "button", id: "prev", "aria-label": "Previous", "aria-keyshortcuts": "K", onclick: () => move(-1) },
            "< K",
        ),
        el(
            "span",
            { id: "position" },
            state.ended
                ? `End of this pass -- ${left} left`
                : `${state.index + 1} of ${items.length} -- ${left} left in this pass`,
        ),
        el(
            "button",
            { type: "button", id: "next", "aria-label": "Next", "aria-keyshortcuts": "J", onclick: () => move(1) },
            "J >",
        ),
        button(
            "accept",
            "Accept",
            "A",
            can.accept,
            {
                class: `accept ${waitingImages ? "loading" : ""}`,
                "aria-pressed": String(d?.decision === "accept"),
                onclick: () => decide("accept"),
            },
            waitingImages ? spinner() : null,
        ),
        button("reject", "Reject", "R", can.reject, {
            class: `reject ${state.pending === "reject" ? "waiting" : ""}`,
            "aria-pressed": String(d?.decision === "reject" || state.pending === "reject"),
            onclick: () => decide("reject"),
        }),
        button("exclude", "Exclude", "E", can.exclude, {
            class: state.pending === "exclude" ? "waiting" : null,
            "aria-pressed": String(d?.decision === "exclude" || state.pending === "exclude"),
            onclick: () => decide("exclude"),
        }),
        button("undo", "Undo", "U", can.undo, { onclick: () => decide(null) }),
        el(
            "span",
            { class: "notebox" },
            el("label", { for: "note" }, "Note"),
            el("input", {
                id: "note",
                type: "text",
                maxlength: "2000",
                autocomplete: "off",
                readonly: Boolean(d) || isLocal() || state.ended,
                placeholder: d
                    ? ""
                    : state.pending
                      ? `Reason for the ${state.pending}, then Enter`
                      : "Optional for Accept; required to Reject or Exclude",
                value: d ? (d.reason ?? "") : draft,
                oninput: (e) => drafts.set(draftKey(item), e.target.value),
                onkeydown: (e) => {
                    if (e.key === "Enter" && !e.repeat) {
                        e.preventDefault();
                        if (state.pending) {
                            decide(state.pending);
                        } else {
                            e.target.blur();
                        }
                    }
                },
            }),
        ),
    );
}

// Item number, name and badges; then one explanation. Not a live region: the status row speaks.
function itemLine(item, d) {
    const sizeChanged =
        item.size &&
        item.baselineSize &&
        (item.size[0] !== item.baselineSize[0] || item.size[1] !== item.baselineSize[1]);
    return el(
        "div",
        { class: "itemline", onclick: (e) => e.currentTarget.classList.toggle("open") },
        el(
            "h2",
            {},
            el("span", { class: "number" }, `#${numberOf(item)}`),
            ` ${itemName(item)} `,
            el("span", { class: `badge ${item.status}` }, statusLabel(item.status)),
            item.from ? el("span", { class: "badge moved" }, movedFrom(item)) : null,
            d
                ? el(
                      "span",
                      { class: `badge ${d.decision}` },
                      `${DECISIONS[d.decision]}${d.reason ? `: ${d.reason}` : ""}`,
                  )
                : null,
            sizeChanged
                ? el(
                      "span",
                      { class: "badge warn" },
                      `size changed ${item.baselineSize.join(" x ")} -> ${item.size.join(" x ")}`,
                  )
                : null,
            item.flaky ? el("span", { class: "badge" }, "flaky") : null,
            item.reReview
                ? el(
                      "span",
                      { class: "badge warn" },
                      `re-review: your earlier accept was replaced by ${branchName()}'s baseline`,
                  )
                : null,
        ),
        el("p", { id: "explain" }, explanation(item, d)),
    );
}

function viewBar(item, view, note) {
    const two = Boolean(item.baseline && item.capture);
    const viewButton = (v, label, key) =>
        el(
            "button",
            {
                type: "button",
                "aria-pressed": String(view === v),
                "aria-disabled": String(Boolean(note) && v !== "side"),
                "aria-keyshortcuts": key,
                onclick: () => {
                    if (note && v !== "side") {
                        say(note);
                        return;
                    }
                    state.view = v;
                    state.motion = true;
                    showStory();
                },
            },
            label,
            key ? kbd(key) : null,
        );
    const option = (key, label, letter) =>
        el(
            "button",
            {
                type: "button",
                id: `opt-${key}`,
                "aria-pressed": String(state[key]),
                "aria-keyshortcuts": letter,
                onclick: () => toggleOption(key),
            },
            label,
            kbd(letter),
        );
    const zoomButton = (z) =>
        el(
            "button",
            {
                type: "button",
                "aria-pressed": String(state.zoom === z),
                onclick: () => {
                    state.zoom = z;
                    showStory();
                },
            },
            z === "fit" ? "Fit" : `${z}x`,
        );
    const details = [
        `Threshold ${item.threshold}; anti-aliased pixels are ${item.includeAA ? "counted" : "not counted"}.`,
        `Captured at ${scale()} image ${scale() === 1 ? "pixel" : "pixels"} per CSS pixel.`,
        item.size ? `Size ${item.size.join(" x ")} image pixels.` : null,
    ].filter(Boolean);
    return el(
        "div",
        { class: "viewbar", role: "toolbar", "aria-label": "View" },
        el(
            "span",
            { role: "group", "aria-label": "View" },
            viewButton("side", "Side by side", null),
            viewButton("flash", "Flash", "F"),
            viewButton("highlight", "Highlight", "H"),
            viewButton("spotlight", "Spotlight", "S"),
        ),
        view === "highlight" ? option("blink", "Blink", "L") : null,
        view === "spotlight" ? option("spotFlash", "Spotlight flash", "F") : null,
        option("showBox", "Outline", "B"),
        el(
            "button",
            {
                type: "button",
                id: "next-box",
                "aria-disabled": String(!two),
                "aria-keyshortcuts": "N",
                onclick: nextBox,
            },
            "Next change",
            kbd("N"),
        ),
        el("span", { id: "box-count", class: "meta" }),
        el("span", { role: "group", "aria-label": "Zoom" }, ZOOMS.map(zoomButton)),
        kbd("Z"),
        el(
            "details",
            { class: "details-pop" },
            el("summary", {}, "Details"),
            el(
                "div",
                {},
                details.map((t) => el("p", {}, t)),
                item.console.length > 0 && item.status !== "failed"
                    ? el("pre", { class: "console" }, item.console.join("\n"))
                    : null,
            ),
        ),
    );
}

// Sizes every picture on the stage at one scale, so equal-size images line up pixel for pixel in
// their panes. At "fit" the largest of them fits its pane both ways (never above real size, one CSS
// pixel per CSS pixel the story was drawn at); zoomed, it is real size times the zoom and the
// panes scroll. Each pane's sheet is as large as the largest picture, so both scroll alike.
function fit(stage) {
    const pics = [...stage.querySelectorAll(".sheet > img, .sheet > canvas")];
    if (pics.length === 0) {
        return;
    }
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

const pane = (text, content, empty = false) =>
    el(
        "figure",
        {},
        el("div", { class: "label" }, text),
        el("div", { class: empty ? "frame empty" : "frame" }, content),
    );
const paneWait = (what) => el("p", { class: "wait" }, spinner(), `Loading ${what}...`);
const paneError = (message) =>
    el(
        "p",
        { class: "failed error" },
        message || "the images could not be loaded",
        " ",
        el("button", { type: "button", onclick: () => showStory() }, "Retry"),
    );

// Two panes, always: the baseline on the left and the new image (or the view's picture) on the
// right, both drawn at once with what they are waiting for, so nothing moves when the images
// arrive. A missing image leaves its pane empty, the same size, so the other one never moves.
async function renderStage(item, view, keep) {
    const seq = ++stageRender;
    const stage = document.getElementById("stage");
    const baseName = item.from ? `Baseline of ${item.from}` : "Baseline";
    const imgOf = async (kind) => {
        const img = await loaded(
            await image(kind, item.file, item[kind]),
            `${kind === "capture" ? "new image" : "baseline"} of ${item.file}`,
        );
        img.alt = `${kind === "capture" ? "new image" : "baseline"} of ${itemName(item)}`;
        return img;
    };
    const emptyRight = () =>
        item.status === "failed"
            ? pane(
                  "No capture: it failed",
                  item.console.length > 0
                      ? el("pre", { class: "console" }, `${item.reason ?? ""}\n\n${item.console.join("\n")}`)
                      : el("p", { class: "failed" }, item.reason ?? "capture failed"),
                  true,
              )
            : pane("No capture", null, true);
    const left = item.baseline ? pane(baseName, paneWait("baseline")) : pane("No baseline", null, true);
    const right = item.capture ? pane("New", paneWait("new image")) : emptyRight();
    if (!keep) {
        stage.replaceChildren(left, right);
    }
    let diff = null;
    try {
        if (view === "side") {
            // Each image as soon as it arrives; the changed areas fill in afterwards.
            const fill = async (kind, figure) => {
                const frame = figure.querySelector(".frame");
                try {
                    const img = await imgOf(kind);
                    if (seq === stageRender) {
                        frame.replaceChildren(el("div", { class: "sheet" }, img));
                        fit(stage);
                    }
                } catch (err) {
                    if (seq === stageRender) {
                        frame.replaceChildren(paneError(err.message));
                    }
                    throw err;
                }
            };
            await Promise.all([item.baseline && fill("baseline", left), item.capture && fill("capture", right)]);
            if (seq !== stageRender) {
                return;
            }
            if (keep) {
                stage.replaceChildren(left, right);
            }
        } else {
            diff = await diffOf(item);
            const marked = view === "highlight";
            const leftPics = [await imgOf("baseline"), ...(marked ? [overlay(diff)] : [])];
            let rightLabel;
            let rightPics;
            const flashing = view === "flash" || (view === "spotlight" && state.spotFlash);
            if (flashing) {
                // The two images one after the other in the same place: themselves, or both spotlighted.
                const flash = view === "flash";
                rightPics = flash
                    ? [await imgOf("baseline"), await imgOf("capture")]
                    : [spotlight(diff, diff.a), spotlight(diff, diff.b)];
                rightLabel = `${flash ? "Flash" : "Spotlight"}: baseline${state.motion ? "" : " (stopped: press F)"}`;
            } else if (marked) {
                rightPics = [await imgOf("capture"), overlay(diff)];
                rightLabel = "New, changed pixels in red";
            } else {
                rightPics = [spotlight(diff)];
                rightLabel = "Spotlight: the new image, dimmed except around each change";
            }
            if (seq !== stageRender) {
                return;
            }
            const l = pane(
                marked ? `${baseName}, changed pixels in red` : baseName,
                el("div", { class: "sheet" }, leftPics),
            );
            const r = pane(rightLabel, el("div", { class: "sheet" }, rightPics));
            stage.replaceChildren(l, r);
            if (flashing) {
                const [base, next] = rightPics;
                next.style.visibility = "hidden";
                r.classList.add("flashing");
                if (state.motion) {
                    const name = view === "flash" ? "Flash" : "Spotlight";
                    const tag = r.querySelector(".label");
                    let showingNew = false;
                    flashTimer = setInterval(() => {
                        showingNew = !showingNew;
                        base.style.visibility = showingNew ? "hidden" : "visible";
                        next.style.visibility = showingNew ? "visible" : "hidden";
                        tag.textContent = showingNew ? `${name}: new` : `${name}: baseline`;
                    }, FLASH_MS);
                }
            }
            if (marked && state.blink && state.motion) {
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
        }
    } catch (err) {
        if (seq === stageRender) {
            if (view !== "side") {
                stage.replaceChildren(pane(baseName, paneError(err.message)), pane("New", paneError(err.message)));
            } else if (keep) {
                stage.replaceChildren(left, right);
            }
        }
        return;
    }
    shown(stage, item);
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
    stageKey = `${item.file}|${state.zoom}`;
    if (keep) {
        for (const f of frames) {
            [f.scrollLeft, f.scrollTop] = keep;
        }
    }
    if (item.baseline && item.capture) {
        try {
            diff ??= await diffOf(item);
        } catch {
            return;
        }
        if (seq !== stageRender) {
            return;
        }
        shownBoxes = diff.boxes;
        const count = document.getElementById("box-count");
        count.textContent =
            diff.boxes.length === 0
                ? "No changed area at this threshold"
                : `${Math.min(state.box, diff.boxes.length - 1) + 1} of ${diff.boxes.length}`;
        showBox(stage, diff.boxes, false, !keep);
    } else {
        shownBoxes = [];
    }
}

// The item's images are on the screen: Accept applies, the next two items load in the
// background, and a quarter second later the stage says it is ready (a decision before then is
// taken for the second tap of a double tap).
function shown(stage, item) {
    const first = stageShown !== item.file;
    stageShown = item.file;
    const accept = document.getElementById("accept");
    if (accept?.classList.contains("loading")) {
        accept.classList.remove("loading");
        accept.querySelector(".spinner")?.remove();
    }
    if (first) {
        appearedAt = performance.now();
        for (const next of passItems().slice(state.index + 1, state.index + 3)) {
            for (const kind of ["baseline", "capture"]) {
                if (next[kind]) {
                    image(kind, next.file, next[kind]).catch(() => {});
                }
            }
        }
    }
    setTimeout(
        () => {
            if (stage.isConnected && stageShown === item.file) {
                stage.dataset.ready = "";
            }
        },
        Math.max(0, GUARD_MS - (performance.now() - appearedAt)),
    );
}

// Outlines the current changed area in every pane, and scrolls it into view. A pane opens at the
// top left of its image (`reset`); on opening (`jump` false) it scrolls only when the area is
// smaller than the pane and out of sight. Next change (`jump` true) always brings the area into
// view, its top left first when it is larger than the pane.
function showBox(stage, boxes, jump, reset = true) {
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
        // The outline is drawn inside the image, so an area at an edge keeps all four sides.
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
        if (!jump && !reset) {
            continue;
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
    if (!item?.baseline || !item?.capture || state.ended) {
        say("Next change needs two images.");
        return;
    }
    const { boxes } = await diffOf(item);
    if (boxes.length === 0) {
        say("No changed area at this threshold.");
        return;
    }
    state.box = (state.box + 1) % boxes.length;
    document.getElementById("box-count").textContent = `${state.box + 1} of ${boxes.length}`;
    showBox(document.getElementById("stage"), boxes, true);
}

// ---------------------------------------------------------------- the end of a pass

// The end card replaces the panes; the address stays on the last item, so K and Back return to
// it. It asks the server for the target's current counts (no GitHub call) and offers what is next.
function endCard() {
    const card = el(
        "section",
        { class: "endcard", id: "endcard", "aria-labelledby": "end-heading" },
        el("h2", { id: "end-heading", tabindex: "-1" }, spinner(), `End of ${state.project}...`),
    );
    fillEnd(card, nav);
    return card;
}

async function fillEnd(card, seq) {
    let t;
    try {
        [t] = await Promise.all([
            api(`/api/target/${encodeURIComponent(state.target.id)}`),
            api("/api/prs?cached=1").then((list) => {
                if (list.targets) {
                    state.list = list;
                }
            }),
        ]);
    } catch (err) {
        card.replaceChildren(
            el("h2", { id: "end-heading" }, `End of ${state.project}.`),
            el(
                "p",
                { class: "error" },
                err.message,
                " ",
                el("button", { type: "button", onclick: () => showStory() }, "Retry"),
            ),
        );
        return;
    }
    if (seq !== nav || !card.isConnected) {
        return;
    }
    state.target = { ...state.target, ...t };
    drawHeader();
    const here = t.projects.find((p) => p.project === state.project);
    const at = t.projects.indexOf(here);
    const others = [...t.projects.slice(at + 1), ...t.projects.slice(0, at)];
    const next = others.find((p) => p.undecided > 0 && !p.downloading && !p.problem);
    const waitingFor = others.filter((p) => p.downloading);
    const everything = t.projects.every((p) => p.undecided === 0 && !p.downloading);
    const offer = (label, onclick, cls = null) =>
        el("button", { type: "button", class: cls, onclick, "aria-describedby": "end-heading" }, label);
    const offers = [];
    const finish = isLocal()
        ? null
        : el(
              "button",
              {
                  type: "button",
                  class: next ? null : "primary",
                  "aria-describedby": "end-heading",
                  onclick: (e) => finishTarget(t.id, e.currentTarget),
              },
              `Finish ${labelOf(t)} (${t.unpublished})`,
          );
    if (next) {
        offers.push(
            offer(
                `Next project: ${next.project} (${next.undecided} undecided)`,
                () => openProject(t.id, next.project, true),
                "primary",
            ),
        );
    }
    if (here.undecided > 0) {
        offers.push(offer(`Review the ${here.undecided} undecided`, () => startPass("undecided")));
    }
    if (!next && finish && t.unpublished > 0) {
        offers.unshift(finish);
    }
    offers.push(offer("Back to the grid", () => toGrid()));
    if (next && finish && t.unpublished > 0) {
        offers.push(finish);
    }
    const after = !next ? nextTarget(t.id) : null;
    if (after) {
        offers.push(
            offer(`Next: ${labelOf(after)} (${undecidedOf(after)} undecided)`, () => openTarget(after.id, true)),
        );
    }
    card.replaceChildren(
        ...[
            el(
                "h2",
                { id: "end-heading", tabindex: "-1" },
                `End of ${state.project}: ${here.decided} of ${here.reviewable} decided, ${here.undecided} undecided.`,
            ),
            everything && !isLocal() ? el("p", {}, `Every project of ${labelOf(t)} is decided.`) : null,
            el("div", { class: "offers" }, offers),
            waitingFor.length > 0
                ? el(
                      "ul",
                      { class: "meta" },
                      waitingFor.map((p) => el("li", {}, `${p.project}: downloading`)),
                  )
                : null,
        ].filter(Boolean),
    );
    offers[0].focus();
}

function showEnd(message) {
    state.ended = true;
    state.pending = null;
    showStory();
    say(message);
}

// ---------------------------------------------------------------- the changed pixels

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

// ---------------------------------------------------------------- moving and deciding

function toGrid() {
    say("");
    showGrid();
}

// Next and Previous walk the pass. Next on its last item shows the end card (it never wraps);
// Previous on the end card comes back to the last item.
function move(step) {
    if (state.ended) {
        if (step < 0) {
            state.ended = false;
            say("");
            showStory();
        } else {
            say("End of this pass: choose what is next.");
        }
        return;
    }
    const count = passItems().length;
    const at = state.index + step;
    if (at >= count) {
        showEnd("");
        return;
    }
    if (at < 0) {
        say("This is the first item of the pass.");
        return;
    }
    say("");
    state.index = at;
    state.box = 0;
    if (reduceMotion()) {
        state.motion = false;
    }
    showStory();
}

// Accept, Reject, Exclude and (with null) Undo of the item on screen. Every press either decides
// or says in the status row why it did not.
async function decide(decision) {
    if (state.ended) {
        say("End of this pass: choose what is next.");
        return;
    }
    const items = passItems();
    const item = items[state.index];
    if (!item) {
        return;
    }
    const n = `#${numberOf(item)}`;
    if (isLocal()) {
        say("Local preview: look only. Nothing is decided on it.");
        return;
    }
    if (saving) {
        say("Still saving the last decision.");
        return;
    }
    const before = decisionOf(item);
    const draft = (drafts.get(draftKey(item)) ?? "").trim();
    if (decision === null) {
        if (!before) {
            say("Nothing to undo.");
            return;
        }
        if (before.posted) {
            say("Posted by an earlier Finish: it stays.");
            return;
        }
    } else {
        // No press reverses a decision: changing one is an explicit Undo first.
        if (before) {
            say(
                decision === "accept" && before.decision === "accept" && before.wasBulk && draft !== ""
                    ? "Accepted without opening. Undo it to add a note."
                    : `Already ${DONE[before.decision]}. Undo it to change it.`,
            );
            return;
        }
        if (onlyExclude(item) && decision !== "exclude") {
            say(item.status === "unstable" ? UNSTABLE : FAILED);
            return;
        }
        if (!state.data.acceptable && decision !== "reject") {
            say(notSeeded());
            return;
        }
        if (decision === "accept" && stageShown !== item.file) {
            say("Loading images: Accept waits for them.");
            return;
        }
        if (performance.now() - appearedAt < GUARD_MS) {
            say("Ignored: this image appeared less than a quarter second ago.");
            return;
        }
        if ((decision === "reject" || decision === "exclude") && draft === "") {
            state.pending = decision;
            showStory({ focusNote: true });
            say(`Type the reason, then press Enter to ${decision}.`);
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
            say("Exclude cancelled.");
            return;
        }
    }
    const reason = decision === null || draft === "" ? null : draft;
    const slow = setTimeout(() => sayBusy("Saving the last decision..."), SLOW_MS);
    let answer;
    saving = api("/api/decide", {
        id: state.target.id,
        project: state.project,
        file: item.file,
        decision,
        reason,
        hash: imageHash(item),
    });
    try {
        answer = await saving;
    } catch (err) {
        say(
            decision === null
                ? `Not saved: ${err.message}. ${n} is still ${DONE[before.decision]}.`
                : `Not saved: ${err.message}. ${n} is still undecided.`,
            true,
        );
        return;
    } finally {
        clearTimeout(slow);
        saving = null;
    }
    if (decision === null) {
        delete state.data.decisions[item.file];
    } else {
        state.data.decisions[item.file] = { decision, reason };
        drafts.delete(draftKey(item));
    }
    state.pending = null;
    counted(item, before, decision, answer.unpublished);
    if (decision === null) {
        // Undo stays on the item, undecided again.
        showStory();
        say(`Undid ${n}: undecided again.`);
        return;
    }
    // The pass is frozen, so a decided item stays in it: a decision moves on to the next one, and
    // Previous comes back to it. After the last one, the end card.
    const did = `${DECISIONS[decision]} ${n}.`;
    if (state.index >= items.length - 1) {
        showEnd(`${did} End of this pass.`);
        return;
    }
    state.index++;
    state.box = 0;
    if (reduceMotion()) {
        state.motion = false;
    }
    showStory();
    const next = current();
    // One message per item, for the eye and for a screen reader.
    say(
        `${did} Now #${numberOf(next)}, ${state.index + 1} of ${items.length}: ${itemName(next)}, ${statusLabel(next.status)}.`,
    );
}

// Clears decisions one by one through the same request as the story screen's U, with a progress
// bar and Stop when there are many.
// ponytail: one request per item; a bulk endpoint if a project ever holds thousands of decisions.
async function undo(files, where, one = false) {
    let done = 0;
    let stopped = false;
    const stop = el("button", { type: "button", onclick: () => (stopped = true) }, "Stop");
    const meter = el("progress", { max: String(files.length), value: "0" });
    try {
        for (const file of files) {
            if (stopped) {
                break;
            }
            if (!one) {
                sayBusy(`Undoing ${done + 1} of ${files.length}...`, " ", meter, " ", stop);
            }
            await api("/api/decide", {
                id: state.target.id,
                project: state.project,
                file,
                decision: null,
                reason: null,
            });
            done++;
            meter.value = done;
        }
    } catch (err) {
        say(`Undid ${done} of ${files.length}, then: ${err.message}`, true);
    }
    try {
        await reload();
    } catch (err) {
        say(err.message, true);
    }
    showGrid();
    if (done === files.length || stopped) {
        say(
            one
                ? `Undid ${where}: undecided again.`
                : stopped
                  ? `Stopped: undid ${done} of ${plural(files.length, "decision")} of ${where}.`
                  : `Undid ${plural(done, "decision")} of ${where}.`,
        );
    }
}

// A component's Undo N, or More > Undo all decisions: asks first, naming the count.
async function bulkUndo(component) {
    const files = undoableIn(component);
    if (files.length === 0) {
        say("Nothing to undo.");
        return;
    }
    const k = files.length;
    const question = component
        ? `Undo the ${plural(k, "decision")} of ${component}?`
        : `Undo all ${plural(k, "decision")} of ${state.project}?`;
    if (await ask(question, `Undo ${k}`)) {
        await undo(files, component ? `the component ${component}` : state.project);
    }
}

async function acceptAll(component) {
    if (!state.data.acceptable || isLocal()) {
        say(isLocal() ? "Local preview: look only. Nothing is decided on it." : notSeeded());
        return;
    }
    const items = undecided(component);
    const n = items.length;
    const where = component ?? state.project;
    if (n === 0) {
        say(`Nothing undecided to accept in ${where}.`);
        return;
    }
    // Accepting a removal deletes its baseline, so the question says how many it holds.
    const removals = items.filter((i) => i.status === "removed").length;
    const deletes =
        removals === 0
            ? ""
            : ` This includes ${plural(removals, "removal")}: accepting deletes ${removals === 1 ? "its baseline" : "their baselines"}.`;
    const stuck = state.data.items.filter(
        (i) => onlyExclude(i) && !decisionOf(i) && (!component || componentOf(i.id) === component),
    );
    const left =
        stuck.length === 0
            ? ""
            : ` ${stuck.length} more (${[...new Set(stuck.map((i) => i.status))].sort().join(", ")}) can only be excluded and stay undecided.`;
    const question = component
        ? `Accept the ${n} undecided ${n === 1 ? "item" : "items"} of ${component} without opening them?`
        : `Accept ${n} undecided ${n === 1 ? "item" : "items"} of ${where} without opening them?`;
    if (!(await ask(`${question}${deletes}${left}`, `Accept ${n}`))) {
        return;
    }
    let answer;
    try {
        answer = await api("/api/accept-all", {
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
    (state.screen === "story" ? showStory : showGrid)();
    say(`Accepted ${plural(answer.accepted, "item")} in ${where}.`);
}

// ---------------------------------------------------------------- Finish

const finishing = () =>
    `Finishing ${state.job.pr === null ? `${branchName()} seed` : `#${state.job.pr}`}: ${state.job.step}...`;

// What Finish's sheet says it will do, from the server's preview: every line is the server's count.
function sheet(t, f, notice) {
    const label = labelOf(t);
    const seed = t.pr === null;
    const lines = [];
    const kinds = [
        f.accepts > 0 ? plural(f.accepts, "accept") : null,
        f.excludes > 0 ? plural(f.excludes, "exclusion") : null,
    ].filter(Boolean);
    if (kinds.length === 0) {
        lines.push("Nothing is committed: only rejects.");
    } else if (seed) {
        const day = new Date().toISOString().slice(0, 10);
        lines.push(
            `Push visual/seed-${day} with ${kinds.join(" and ")} and open its pull request` +
                `${f.acceptNotes > 0 ? `, with ${plural(f.acceptNotes, "accept note")} in its description` : ""}.`,
        );
    } else {
        lines.push(`Commit ${kinds.join(" and ")} to ${t.branch}.`);
    }
    const posts = [
        f.rejects > 0 ? plural(f.rejects, "reject") : null,
        !seed && f.acceptNotes > 0 ? plural(f.acceptNotes, "accept note") : null,
    ].filter(Boolean);
    if (seed && f.rejects > 0) {
        lines.push(`Open one issue for ${plural(f.rejects, "reject")}.`);
    } else if (posts.length > 0) {
        lines.push(`Post ${posts.join(" and ")} as a comment on ${label}.`);
    }
    const why =
        f.status.state === "failure"
            ? ` (${f.rejects} rejected)`
            : f.status.state === "pending"
              ? ` (${[
                    f.undecided.length > 0 ? `${f.undecided.reduce((k, p) => k + p.undecided, 0)} undecided` : null,
                    f.unloaded.length > 0 ? `not loaded: ${f.unloaded.join(", ")}` : null,
                ]
                    .filter(Boolean)
                    .join("; ")})`
              : "";
    lines.push(`Then set the commit status 'Visual review' to ${f.status.state}${why}.`);
    if (f.notOpened > 0) {
        lines.push(`Accepted without opening: ${f.notOpened}.`);
    }
    if (f.undecided.length > 0) {
        lines.push(
            `Still undecided, left for a later round: ${f.undecided.map((p) => `${p.project} ${p.undecided}`).join(", ")}.`,
        );
    }
    if (f.unloaded.length > 0) {
        lines.push(`Not loaded, so not reviewed: ${f.unloaded.join(", ")}.`);
    }
    return [
        el("h2", { id: "sheet-title" }, `Finish ${label}, every project:`),
        notice ? el("p", { class: "error" }, notice) : null,
        ...lines.map((l) => el("p", {}, l)),
        f.notes.length > 0
            ? [
                  el("p", {}, "Notes to publish:"),
                  el(
                      "ul",
                      { class: "notes" },
                      f.notes.map((x) => el("li", {}, `${DECISIONS[x.decision]} ${x.project}/${x.file}: ${x.note}`)),
                  ),
              ]
            : null,
        el("p", {}, signerLine(t.signer)),
        t.startCommand
            ? el(
                  "p",
                  {},
                  `To sign as yourself instead, cancel and start the server from your own shell:\n${t.startCommand}`,
              )
            : null,
    ].filter(Boolean);
}

// The passkey's place in Finish. The owner's passkey (Face ID or a security key) is to approve each
// Finish through WebAuthn (design.md section 8). iPad Safari allows the WebAuthn call only inside
// the tap itself, so it belongs in the sheet's final button's click handler, which runs this, with
// the preview's digest; its assertion then goes to POST /api/finish with the digest. It is not
// built yet, so Finish sends no approval.
function approveFinish() {
    return null;
}

// Finish publishes every decision of one target. It asks the server what it would do, states it
// in a sheet, and starts on the server; then the targets screen follows it step by step.
async function finishTarget(id, button) {
    if (running()) {
        say("A Finish is running: wait for it to end.");
        return;
    }
    const reset = () => {
        button.classList.remove("busy");
        button.querySelector(".spinner")?.remove();
        button.setAttribute("aria-disabled", String(running()));
    };
    button.classList.add("busy");
    button.prepend(spinner());
    if (saving) {
        sayBusy("Saving the last decision...");
        await saving.catch(() => {});
    }
    let notice = "";
    for (;;) {
        let t;
        try {
            t = await api(`/api/target/${encodeURIComponent(id)}?finish=1`);
        } catch (err) {
            reset();
            say(`Finish not started: ${err.message}`, true);
            return;
        }
        const f = t.finish;
        const onlyRejects = f.accepts + f.excludes === 0 && f.acceptNotes === 0 && f.rejects > 0;
        let approval = null;
        const go = await ask(
            sheet(t, f, notice),
            onlyRejects ? `Post ${plural(f.rejects, "reject")} to ${labelOf(t)}` : `Finish ${labelOf(t)}`,
            { label: "sheet-title", onYes: () => (approval = approveFinish(f)) },
        );
        if (!go) {
            reset();
            say("Finish cancelled: nothing was changed.");
            return;
        }
        // Finish runs on the server and can take minutes; the page only starts it and then asks how
        // it is going, so a dropped connection or a reload loses nothing.
        sayBusy("Starting Finish...");
        state.plan = { seed: t.pr === null, commits: f.accepts + f.excludes > 0, posts: f.rejects + f.acceptNotes > 0 };
        try {
            state.job = (await api("/api/finish", { id, digest: f.digest, ...(approval ? { approval } : {}) })).job;
            break;
        } catch (err) {
            if (err.status === 409 && /Decisions changed/.test(err.message)) {
                notice = err.message;
                continue;
            }
            // The request may have been lost after the server started it: ask before calling it failed.
            state.job = await api("/api/finish-status")
                .then((s) => s.job)
                .catch(() => null);
            if (!running() || state.job.target !== id) {
                reset();
                say(`Finish of ${labelOf(t)} failed: ${err.message}`, true);
                return;
            }
            break;
        }
    }
    state.finishSeen = performance.now();
    showTargets();
    await watchFinish();
}

let watching = false;

// Follows the running Finish to its end, then shows its result above the targets.
async function watchFinish() {
    if (watching) {
        return;
    }
    watching = true;
    state.finishSeen ??= performance.now();
    try {
        while (running()) {
            say(finishing());
            drawFinishPanel();
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
    state.finishSeen = null;
    say("");
    if (state.screen === "targets") {
        showTargets("", true);
        document.getElementById("outcome-heading")?.focus();
    } else {
        drawHeader();
    }
}

// The steps a Finish goes through, as the server names them when each starts.
const FINISH_STEPS = [
    ["checking", "Checking", /^(starting|checking)/],
    ["writing", "Writing the files", /^writing/],
    ["committing", "Committing", /^committing/],
    ["lfs", "Uploading images to LFS", /^uploading images to LFS/],
    ["pushing", "Pushing", /^pushing/],
    ["pull", "Opening the pull request", /^opening the pull request/],
    ["comment", "Posting the comment", /^(posting the comment|opening the issue)/],
    ["status", "Posting the status", /^posting the status/],
];

// The running Finish's steps, each marked done, in progress or waiting, with the count of the
// current one and the time spent: at the top of the targets screen.
function drawFinishPanel() {
    if (state.screen !== "targets" || !running()) {
        return;
    }
    const plan = state.plan;
    const steps = FINISH_STEPS.filter(([key]) => {
        if (!plan) {
            return true;
        }
        if (["writing", "committing", "lfs", "pushing"].includes(key)) {
            return plan.commits;
        }
        if (key === "pull") {
            return plan.seed && plan.commits;
        }
        if (key === "comment") {
            return plan.posts;
        }
        return true;
    });
    const step = state.job.step ?? "";
    const now = steps.findIndex(([, , match]) => match.test(step));
    const count = /\((\d+) of (\d+) done\)/.exec(step);
    const secs = Math.round((performance.now() - (state.finishSeen ?? performance.now())) / 1000);
    const time = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    const panel = el(
        "section",
        { class: "card finish-panel", id: "finish-panel", "aria-labelledby": "finish-panel-title" },
        el(
            "h2",
            { id: "finish-panel-title" },
            `Finishing ${state.job.pr === null ? `${branchName()} seed` : `#${state.job.pr}`}, ${time}`,
        ),
        el(
            "ol",
            {},
            steps.map(([, name], i) =>
                el(
                    "li",
                    { class: i < now ? "done" : i === now ? "now" : "waiting" },
                    `${name}: ${i < now ? "done" : i === now ? "in progress" : "waiting"}`,
                    i === now && count
                        ? [
                              ` (${count[1]} of ${count[2]})`,
                              el("progress", { max: count[2], value: count[1], "aria-hidden": "true" }),
                          ]
                        : null,
                ),
            ),
        ),
        el("p", { class: "meta" }, "Closing or reloading this page does not stop it."),
    );
    const old = document.getElementById("finish-panel");
    if (old) {
        old.replaceWith(panel);
    } else {
        app.prepend(panel);
    }
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

// The commit link, from the pull request's address (github.com/o/r/pull/1 -> github.com/o/r).
const repoUrl = (url) => (url ? url.replace(/\/pull\/\d+$/, "") : null);

// What the newest Finish did, shown above the targets until it is dismissed or the server restarts.
function finishOutcome() {
    const job = state.job;
    if (!job || job.running || state.dismissed === job.id) {
        return null;
    }
    const label = job.pr === null ? `${branchName()} seed` : `#${job.pr}`;
    const t = state.list?.targets?.find((x) => x.id === job.target);
    const dismiss = el(
        "button",
        {
            type: "button",
            onclick: () => {
                state.dismissed = job.id;
                drawTargets();
            },
        },
        "Dismiss",
    );
    const warnings = (job.warnings ?? []).map((w) => el("p", { class: "warning" }, w));
    if (job.interrupted || job.error !== null) {
        return el(
            "section",
            { class: "card finish-outcome" },
            el(
                "h2",
                { id: "outcome-heading", tabindex: "-1", class: "error" },
                job.interrupted
                    ? `Finish of ${label} was interrupted.`
                    : `Finish of ${label} failed. Decisions not yet published are kept; anything pushed is listed below.`,
            ),
            el("pre", { class: "error" }, job.error),
            warnings,
            el("p", { class: "offers" }, dismiss),
        );
    }
    const out = job.result;
    const repo = repoUrl(t?.url ?? out.pullRequest);
    const parts = [];
    parts.push(
        out.commit
            ? el(
                  "p",
                  {},
                  "Committed ",
                  repo ? link(`${repo}/commit/${out.commit}`, short(out.commit)) : short(out.commit),
                  ` to ${out.branch}.`,
              )
            : el("p", {}, "No commit: nothing was accepted or excluded."),
    );
    if (out.pullRequest) {
        parts.push(
            el("p", {}, "Opened pull request ", link(out.pullRequest, `#${out.pullRequest.split("/").pop()}`), "."),
        );
    }
    const notes = out.acceptNotes ?? 0;
    if (out.issue) {
        parts.push(
            el(
                "p",
                {},
                `Filed ${plural(out.rejects, "reject")} as issue `,
                link(out.issue, `#${out.issue.split("/").pop()}`),
                ".",
            ),
        );
    } else if (out.rejects > 0 || (job.pr !== null && notes > 0)) {
        const posted = [
            out.rejects > 0 ? plural(out.rejects, "reject") : null,
            notes > 0 ? plural(notes, "accept note") : null,
        ]
            .filter(Boolean)
            .join(" and ");
        parts.push(el("p", {}, `Posted ${posted} as a comment.`));
    }
    if (out.commentError) {
        parts.push(el("p", { class: "error" }, `The comment with the accept notes failed: ${out.commentError}`));
    }
    const counts = (out.status ?? "").replace(/^Reviewed: /, "").replace(" left undecided", " undecided");
    parts.push(
        out.statusError
            ? el("p", { class: "error" }, `The commit status failed: ${out.statusError}`)
            : el("p", {}, `Commit status: ${out.state ?? "set"} -- ${counts}.`),
    );
    const next = nextTarget(job.target);
    const offers = [
        next
            ? el(
                  "button",
                  { type: "button", class: "primary", onclick: () => openTarget(next.id, true) },
                  `Next: ${labelOf(next)} (${undecidedOf(next)} undecided)`,
              )
            : null,
        t && undecidedOf(t) > 0
            ? el("button", { type: "button", onclick: () => openTarget(t.id, false) }, `Back to ${label}`)
            : null,
        dismiss,
    ];
    return el(
        "section",
        { class: "card finish-outcome" },
        el("h2", { id: "outcome-heading", tabindex: "-1" }, `Finished ${label}.`),
        parts,
        warnings,
        el("p", { class: "offers" }, offers),
    );
}

// ---------------------------------------------------------------- the address

// Every screen is in the address, after the session token, so a copied link opens it again:
// #token=...&target=123&project=p&filter=undecided&q=text&item=file.png&pass=undecided&view=side&zoom=fit&box=on&blink=off&flash=off
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
        p.set("pass", state.pass);
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

// Reads the newest Finish once; a running one is followed on whatever screen opens.
async function checkFinish() {
    try {
        track((await api("/api/finish-status")).job);
    } catch {
        return;
    }
    if (running()) {
        watchFinish();
    }
}

// Shows the screen the address names, from what the server already holds (no GitHub call); what
// no longer exists (a closed pull request, a story gone from a new CI run) lands on the nearest
// screen that does, with a line saying so.
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
        const project = p.get("project");
        if (state.data === null || state.target?.id !== id || state.project !== project) {
            const done = waiting(`Loading ${project ?? id}...`);
            let data;
            try {
                data = await api(`/api/pr/${encodeURIComponent(id)}/${encodeURIComponent(project)}`);
            } catch (err) {
                done();
                if (seq === nav) {
                    const what =
                        err.status === 404 && /not listed/.test(err.message)
                            ? `${id} is no longer listed`
                            : `${project} of ${id} could not be opened: ${err.message}`;
                    await showTargets(`${what}: showing every target.`);
                }
                return;
            }
            done();
            if (seq !== nav) {
                return;
            }
            adopt(data, project);
            state.sequence = [];
        }
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
        // Back into the pass it came from keeps that pass; a reload finds it in this tab's session
        // storage; otherwise it is rebuilt from its filter, with this item in it.
        const pass = FILTERS.includes(p.get("pass")) ? p.get("pass") : state.filter;
        if (state.pass !== pass || !state.sequence.includes(file)) {
            state.pass = pass;
            const kept = loadPass();
            if (kept?.includes(file)) {
                state.sequence = kept;
            } else {
                const shown = itemsFor(pass);
                state.sequence = (shown.includes(item) ? shown : ordered([...shown, item])).map((i) => i.file);
                savePass();
            }
        }
        state.index = state.sequence.indexOf(file);
        state.ended = false;
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
        // Flash, Blink and Spotlight flash open stopped from a link: a press starts them.
        state.motion = false;
        state.box = 0;
        say("");
        showStory();
    } finally {
        routes--;
    }
}

// ---------------------------------------------------------------- keys and start

// F, H and S switch to that view, or back to side by side when it is already shown; a view opened
// stopped from a link starts on its first press.
function toggleView(view) {
    const note = current() && singleImageNote(current());
    if (note) {
        say(note);
        return;
    }
    if (state.view === view && !state.motion && view === "flash") {
        state.motion = true;
    } else {
        state.view = state.view === view ? "side" : view;
        state.motion = true;
    }
    showStory();
}

const KEYS = [
    ["J / K", "Next / previous item of the pass; J on the last item shows what is next"],
    ["A", "Accept, once the images are shown"],
    ["(type), Esc, A", "Accept with a note: type it, leave the note box, accept"],
    ["R", "Reject; with an empty note, type the reason, then Enter"],
    ["E", "Exclude; with an empty note, type the reason, then Enter, then confirm"],
    ["U", "Undo the item's decision; you stay on the item"],
    ["Enter (note box)", "Send the Reject or Exclude waiting for its reason"],
    ["F", "Flash, or back to side by side; in Spotlight, Spotlight flash on or off"],
    ["Space (hold)", "Flash while held"],
    ["H", "Highlight the changed pixels in red, or back to side by side"],
    ["L", "In Highlight: Blink on or off"],
    ["S", "Spotlight, or back to side by side (on an iPad held upright, the way to see a change large)"],
    ["B", "Outline the changed area, or not"],
    ["N", "Next change"],
    ["Z", "Next zoom: Fit, 1x, 2x, 4x, 8x (on an iPad held upright, 2x is one press)"],
    ["Shift+A", "Grid: accept every undecided item (asks first)"],
    ["/", "Grid: Find story"],
    ["?", "Show or hide this list"],
    ["Esc", "Story: back to the grid; in the note box, first leaves the box (its text stays)"],
];

// The key overlay: every key, the last messages in full, and the single-key shortcuts switch.
function toggleKeys() {
    const open = document.querySelector("dialog.keys");
    if (open) {
        open.close();
        return;
    }
    const toggle = el(
        "button",
        {
            type: "button",
            "aria-pressed": String(state.shortcuts),
            onclick: () => {
                state.shortcuts = !state.shortcuts;
                saveOptions();
                toggle.setAttribute("aria-pressed", String(state.shortcuts));
                toggle.textContent = `Single-key shortcuts: ${state.shortcuts ? "on" : "off"}`;
            },
        },
        `Single-key shortcuts: ${state.shortcuts ? "on" : "off"}`,
    );
    const dialog = el(
        "dialog",
        { class: "keys", "aria-labelledby": "keys-title" },
        el("h2", { id: "keys-title" }, "Keys"),
        el("p", {}, toggle),
        el(
            "table",
            {},
            KEYS.map(([k, what]) => el("tr", {}, el("td", {}, k), el("td", {}, what))),
        ),
        el("h3", {}, "Recent messages"),
        el(
            "ol",
            { class: "recent" },
            messages.length === 0 ? el("li", {}, "None yet.") : [...messages].reverse().map((m) => el("li", {}, m)),
        ),
        el("p", { class: "actions" }, el("button", { type: "button", onclick: () => dialog.close() }, "Close")),
    );
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
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
    if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
    }
    const inInput = ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
    const open = document.querySelector("dialog[open]");
    if (e.key === "?" && !inInput && (!open || open.classList.contains("keys"))) {
        e.preventDefault();
        toggleKeys();
        return;
    }
    // An open question (ask), the Finish sheet or the overlay takes the keys: Escape cancels it.
    if (open || !["story", "grid"].includes(state.screen)) {
        return;
    }
    if (e.key === "Escape") {
        e.preventDefault();
        if (inInput) {
            // Leaves the box; its text stays with its item. A reject waiting for its reason is dropped.
            e.target.blur();
            if (state.pending) {
                state.pending = null;
                showStory();
                say("");
            }
            return;
        }
        app.querySelector("details.menu[open]")?.removeAttribute("open");
        if (state.screen === "story") {
            toGrid();
        }
        return;
    }
    if (inInput) {
        return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!state.shortcuts && /^[a-z/]$/.test(key)) {
        return;
    }
    if (state.screen === "grid") {
        if (e.shiftKey && key === "a") {
            e.preventDefault();
            acceptAll(null);
        } else if (key === "/") {
            e.preventDefault();
            document.getElementById("find")?.focus();
        }
        return;
    }
    if (key === " ") {
        // A focused button takes Space as a press.
        if (e.target.tagName === "BUTTON") {
            return;
        }
        // Held: flash until released, then back to the view it came from.
        e.preventDefault();
        const item = current();
        if (!e.repeat && state.held === null && item?.baseline && item?.capture && !state.ended) {
            state.held = state.view;
            state.view = "flash";
            state.motion = true;
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
        f: () =>
            state.view === "spotlight"
                ? state.spotFlash && !state.motion
                    ? ((state.motion = true), showStory())
                    : toggleOption("spotFlash")
                : toggleView("flash"),
        h: () => toggleView("highlight"),
        s: () => toggleView("spotlight"),
        b: () => toggleOption("showBox"),
        l: () => {
            if (state.view !== "highlight") {
                say("Blink works in Highlight (H).");
            } else if (state.blink && !state.motion) {
                state.motion = true;
                showStory();
            } else {
                toggleOption("blink");
            }
        },
        n: nextBox,
        z: () => {
            state.zoom = ZOOMS[(ZOOMS.indexOf(state.zoom) + 1) % ZOOMS.length];
            showStory();
        },
    };
    if (e.shiftKey && key === "a") {
        say("Accept all is on the grid: press Escape, then Shift+A.");
        return;
    }
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

async function copyLink() {
    document.querySelector("details.menu[open]")?.removeAttribute("open");
    try {
        await navigator.clipboard.writeText(location.href);
        say("Link copied. It carries your session token: it opens this screen on any device.");
    } catch {
        // No clipboard (a page served over plain http to another device): the browser's own box.
        prompt("Copy this link:", location.href);
    }
}

document.getElementById("home").addEventListener("click", () => showTargets());
document.getElementById("copy-link").addEventListener("click", copyLink);
document.getElementById("keys-button").addEventListener("click", toggleKeys);
window.addEventListener("popstate", () => route());

if (token === "") {
    render(el("p", { class: "error" }, "No session token: open the URL that visual-review serve printed."));
} else {
    checkFinish();
    route();
}
