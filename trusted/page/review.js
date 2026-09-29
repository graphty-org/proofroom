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

const REVIEWABLE = ["changed", "new", "removed", "unstable", "failed"];
const ACCEPTABLE = ["changed", "new", "removed"];
// A story with no baseline that this pull request did not change: shown, never a decision here.
const UNSEEDED = "unseeded";
const NO_BASELINE = "no baseline yet";
const statusLabel = (status) => (status === UNSEEDED ? NO_BASELINE : status);
// Errors first (their own list), then what changed, then new, unstable and removed stories.
const RANK = { failed: 0, changed: 1, new: 2, unstable: 3, removed: 4, unseeded: 5 };
const FLASH_MS = 333; // one image each third of a second: about 1.5 full cycles a second
// "fit" (the default) shows the whole of both images in their panes, at one scale, never above real
// size; 1 is real size: one CSS pixel per CSS pixel the story was drawn at, scrolling when larger.
const ZOOMS = ["fit", 1, 2, 4, 8];
const CRISP_FROM = 4; // from this zoom on, pixels are drawn as hard squares
const GROW = 10; // image pixels the spotlight and the changed boxes grow each changed pixel by
const SPOT_ALPHA = 190; // the spotlight's dimming, out of 255, as Chromatic's focus mask
const RE_REVIEW = "re-review: your earlier accept was replaced by master's baseline";

const state = {
    targets: [],
    target: null, // summary of the pull request (or master) being reviewed
    project: null,
    data: null, // GET /api/pr/:id/:project
    filter: "undecided", // the grid opens on what still needs a decision
    text: "", // the grid's text filter
    index: 0,
    lastFile: null, // the item last opened, highlighted when the grid comes back
    view: "side", // side | flash | highlight | spotlight
    zoom: "fit",
    box: 0, // which changed box "next changed box" is on
    held: null, // the view to return to when Space is released
    pending: "reject", // what Enter in the reason box does
    screen: "targets",
};
const images = new Map();
const diffs = new Map();
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

function say(text, isError = false) {
    statusLine.textContent = text;
    statusLine.className = isError ? "error" : "";
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

// Loads an image through the API (it needs the token header) and returns an object URL.
function image(kind, file) {
    const key = `${state.target.id}/${state.project}/${kind}/${file}`;
    if (!images.has(key)) {
        const path = ["img", state.target.id, state.project, kind, file].map(encodeURIComponent).join("/");
        images.set(
            key,
            fetch(`/api/${path}`, { headers: { "x-review-token": token } }).then(async (res) => {
                if (!res.ok) {
                    throw new Error(`${file}: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
                }
                return URL.createObjectURL(await res.blob());
            }),
        );
    }
    return images.get(key);
}

function loaded(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

const componentOf = (id) => id.split("--")[0];
const itemName = (item) => (item.mode ? `${item.id} (${item.mode})` : item.id);
const short = (sha) => (sha ? sha.slice(0, 10) : "none");
const decisionOf = (item) => state.data?.decisions[item.file] ?? null;
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
        } else if (state.filter !== "all") {
            items = items.filter((i) => i.status === state.filter);
        }
    }
    return ordered(text ? items.filter((i) => i.file.includes(text)) : items);
}

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

// ---------------------------------------------------------------- screen: targets

async function showTargets() {
    stopFlash();
    state.screen = "targets";
    setCrumbs();
    say("Loading pull requests and captures...");
    try {
        state.targets = (await api("/api/prs")).targets;
        say("");
    } catch (err) {
        say(err.message, true);
        return;
    }
    if (state.targets.length === 0) {
        render(el("p", {}, "No open pull request has a CI run, and no master run was given."));
        return;
    }
    const finishable = state.targets.find((t) => !t.local);
    render(finishable ? signerBlock(finishable) : null, ...state.targets.map(targetCard));
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
            : el(
                  "p",
                  {},
                  el(
                      "button",
                      { type: "button", class: "primary", disabled: decided === 0, onclick: () => finishTarget(t) },
                      `Finish ${t.pr === null ? "seed" : `#${t.pr}`} (${decided} decisions)`,
                  ),
              ),
    );
}

// ---------------------------------------------------------------- screen: project grid

async function openProject(target, project) {
    state.target = target;
    state.project = project;
    state.filter = "undecided";
    state.text = "";
    state.lastFile = null;
    say("Loading...");
    try {
        await reload();
        say("");
    } catch (err) {
        say(err.message, true);
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
            const { kind, file } = e.target.dataset;
            image(kind, file).then(
                (url) => (e.target.src = url),
                (err) => (e.target.alt = err.message),
            );
        }
    }
});

function openItem(index) {
    say("");
    state.index = index;
    state.box = 0;
    showStory();
}

function tile(item, number) {
    const kind = item.capture ? "capture" : item.baseline ? "baseline" : null;
    const img = kind
        ? el("img", { "data-kind": kind, "data-file": item.file, alt: itemName(item) })
        : el("div", { class: "noimage" }, item.status);
    if (kind) {
        thumbs.observe(img);
    }
    const d = decisionOf(item);
    return el(
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
        d ? el("span", { class: `badge ${d.decision}` }, d.decision) : null,
        item.reReview ? el("span", { class: "badge warn", title: RE_REVIEW }, "re-review") : null,
    );
}

// A failed capture: its reason, and the console and stack output, in the errors list.
function errorRow(item, number) {
    const d = decisionOf(item);
    return el(
        "li",
        { class: item.file === state.lastFile ? "current" : null, "data-file": item.file },
        el(
            "button",
            { type: "button", class: "link", onclick: () => openItem(number - 1) },
            el("span", { class: "number" }, `${number}`),
            ` ${itemName(item)}`,
        ),
        d ? el("span", { class: `badge ${d.decision}` }, d.decision) : null,
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

// How many items of `component` Accept would take without opening them.
const undecidedIn = (component) =>
    state.data.items.filter(
        (i) => ACCEPTABLE.includes(i.status) && !decisionOf(i) && (!component || componentOf(i.id) === component),
    ).length;

function showGrid() {
    stopFlash();
    state.screen = "grid";
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
            ["changed", "new", "unstable", "removed", "failed"]
                .filter((s) => counts[s])
                .map((s) => filterButton(s, `${s} (${counts[s]})`)),
            counts[UNSEEDED] ? filterButton(UNSEEDED, `${NO_BASELINE} (${counts[UNSEEDED]})`) : null,
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
    const items = visibleItems();
    if (items.length === 0) {
        showGrid();
        return;
    }
    state.index = Math.max(0, Math.min(state.index, items.length - 1));
    const item = items[state.index];
    state.lastFile = item.file;
    const d = decisionOf(item);
    if (d?.bulk && !isLocal()) {
        // Opening an item Accept all decided counts it as opened.
        delete d.bulk;
        api("/api/decide", { id: state.target.id, project: state.project, file: item.file, ...d }).catch((err) =>
            say(err.message, true),
        );
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
        placeholder: "Reason (needed to reject or exclude)",
        value: d?.reason ?? "",
        maxlength: "2000",
        onkeydown: (e) => {
            if (e.key === "Enter") {
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
                        { type: "button", class: "accept", onclick: () => decide("accept"), title: "A" },
                        "Accept",
                    )
                  : null,
              !onlyExclude
                  ? el(
                        "button",
                        { type: "button", class: "reject", onclick: () => decide("reject"), title: "R" },
                        "Reject",
                    )
                  : null,
              state.data.acceptable
                  ? el(
                        "button",
                        {
                            type: "button",
                            onclick: () => decide("exclude"),
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
}

// The changed pixels of an item, padded top-left to the larger size, grown by GROW pixels, and the
// boxes around each separate grown region. Computed once per item.
async function diffOf(item) {
    if (!diffs.has(item.file)) {
        diffs.set(
            item.file,
            (async () => {
                const [a, b] = await Promise.all([
                    loaded(await image("baseline", item.file)),
                    loaded(await image("capture", item.file)),
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
                return { w, h, a: pa, b: pb, grown, boxes: regions(grown, w, h) };
            })(),
        );
    }
    return diffs.get(item.file);
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
        const img = await loaded(await image(kind, item.file));
        img.alt = `${kind} of ${itemName(item)}`;
        return img;
    };
    try {
        const diff = item.baseline && item.capture ? await diffOf(item) : null;
        const left = item.baseline ? pane("Baseline", await imgOf("baseline")) : pane("No baseline");
        let right;
        if (!item.capture) {
            right = pane(item.status === "failed" ? "No capture: it failed" : "No capture");
        } else if (view === "side") {
            right = pane(item.baseline ? "New" : "New (no baseline)", await imgOf("capture"));
        } else if (view === "flash") {
            // The two images themselves, one after the other in the same place: no overlay.
            const [base, next] = [await imgOf("baseline"), await imgOf("capture")];
            next.style.visibility = "hidden";
            right = pane("Flash: baseline", base, next);
            right.classList.add("flashing");
            const tag = right.querySelector(".label");
            let showingNew = false;
            flashTimer = setInterval(() => {
                showingNew = !showingNew;
                base.style.visibility = showingNew ? "hidden" : "visible";
                next.style.visibility = showingNew ? "visible" : "hidden";
                tag.textContent = showingNew ? "Flash: new" : "Flash: baseline";
            }, FLASH_MS);
        } else if (view === "highlight") {
            right = pane("Changed pixels in red over the dimmed baseline", highlight(item, diff));
        } else {
            right = pane("Spotlight: the new image, dimmed except around each change", spotlight(diff));
        }
        stage.replaceChildren(left, right);
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
        stage.replaceChildren(el("p", { class: "error" }, err.message));
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
        const mark = el("div", { class: "boxmark" });
        Object.assign(mark.style, {
            left: `${left}px`,
            top: `${top}px`,
            width: `${right - left}px`,
            height: `${bottom - top}px`,
        });
        sheet.append(mark);
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
    const items = visibleItems();
    const item = items[state.index];
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

// pixelmatch's own picture: the changed pixels in red over the dimmed baseline.
function highlight(item, diff) {
    const canvas = el("canvas", { width: String(diff.w), height: String(diff.h) });
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(diff.w, diff.h);
    pixelmatch(diff.a, diff.b, out.data, diff.w, diff.h, {
        threshold: item.threshold,
        includeAA: item.includeAA,
        alpha: 0.2,
    });
    ctx.putImageData(out, 0, 0);
    return canvas;
}

// The new image with everything dimmed except the changed pixels grown by GROW pixels.
function spotlight(diff) {
    const canvas = el("canvas", { width: String(diff.w), height: String(diff.h) });
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(diff.w, diff.h);
    const keep = 1 - SPOT_ALPHA / 255;
    for (let i = 0; i < diff.w * diff.h; i++) {
        const lit = diff.grown[i] === 1;
        for (let c = 0; c < 3; c++) {
            out.data[i * 4 + c] = lit ? diff.b[i * 4 + c] : diff.b[i * 4 + c] * keep;
        }
        out.data[i * 4 + 3] = lit ? diff.b[i * 4 + 3] : Math.max(diff.b[i * 4 + 3], SPOT_ALPHA);
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
}

async function acceptAll(component) {
    if (!state.data.acceptable || isLocal()) {
        say(`${state.project} cannot be accepted here`, true);
        return;
    }
    const n = undecidedIn(component);
    const where = component ? `the component ${component}` : state.project;
    if (n === 0) {
        say(`Nothing undecided to accept in ${where}.`);
        return;
    }
    if (!confirm(`Accept ${n} undecided items of ${where} without opening them?`)) {
        return;
    }
    try {
        await api("/api/accept-all", {
            id: state.target.id,
            project: state.project,
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
    const count = visibleItems().length;
    state.index = (state.index + step + count) % count;
    state.box = 0;
    showStory();
}

async function decide(decision) {
    if (isLocal()) {
        say("A local preview is only looked at: nothing is decided on it.", true);
        return;
    }
    const items = visibleItems();
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
    const reasonBox = document.getElementById("reason");
    const reason = reasonBox?.value.trim() ?? "";
    if ((decision === "reject" || decision === "exclude") && reason === "") {
        state.pending = decision;
        reasonBox?.focus();
        say(`A ${decision} needs a reason: type it, then press Enter.`);
        return;
    }
    if (
        decision === "exclude" &&
        !confirm(
            `Exclude ${item.id}? Every mode of this story stops being captured, on every pull request, ` +
                "until its settings file is removed. To clear a one-off failure, re-run the visual job instead.",
        )
    ) {
        return;
    }
    try {
        await api("/api/decide", {
            id: state.target.id,
            project: state.project,
            file: item.file,
            decision,
            reason: reason === "" ? null : reason,
        });
    } catch (err) {
        say(err.message, true);
        return;
    }
    if (decision === null) {
        delete state.data.decisions[item.file];
    } else {
        state.data.decisions[item.file] = { decision, reason: reason === "" ? null : reason };
    }
    state.pending = "reject";
    say(`${itemName(item)}: ${decision ?? "undone, undecided again"}`);
    // With the "undecided" filter the decided item drops out, so the same index is the next one.
    if (decision !== null && state.filter !== "undecided") {
        state.index = Math.min(state.index + 1, items.length - 1);
    }
    // Undo under the "undecided" filter brings the item back; stay on it.
    if (decision === null && state.filter === "undecided") {
        state.index = Math.max(
            0,
            visibleItems().findIndex((i) => i.file === item.file),
        );
    }
    state.box = 0;
    showStory();
}

// ---------------------------------------------------------------- Finish

function finishButton() {
    if (isLocal()) {
        return null;
    }
    return el(
        "button",
        { type: "button", class: "primary", onclick: () => finishTarget(state.target) },
        `Finish ${targetLabel()}`,
    );
}

async function finishTarget(target) {
    const what =
        target.pr === null ? "push a seed branch and open its pull request" : `commit and push to ${target.branch}`;
    let fresh;
    try {
        fresh = await api(`/api/target/${encodeURIComponent(target.id)}`);
    } catch (err) {
        say(err.message, true);
        return;
    }
    const lines = [
        `Finish ${target.pr === null ? "the master seed" : `#${target.pr}`}: ${what}, across every project?`,
    ];
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
    if (!confirm(lines.join("\n\n"))) {
        return;
    }
    say("Finishing: committing, pushing, commenting...");
    try {
        const out = await api("/api/finish", { id: target.id });
        const parts = [
            out.commit ? `Committed ${short(out.commit)} to ${out.branch}.` : "No commit (nothing accepted).",
        ];
        if (out.rejects > 0) {
            parts.push(`${out.rejects} rejects posted.`);
        }
        if (out.pullRequest) {
            parts.push(`Pull request: ${out.pullRequest}`);
        }
        parts.push(out.statusError ? `The commit status failed: ${out.statusError}` : `Status: ${out.status}.`);
        await showTargets();
        say(parts.join(" "), Boolean(out.statusError));
    } catch (err) {
        say("Finish failed; your decisions are kept. Fix the cause and press Finish again.", true);
        app.prepend(el("pre", { class: "error" }, err.message));
    }
}

// ---------------------------------------------------------------- keys and start

// F, H and S switch to that view, or back to side by side when it is already shown.
function toggleView(view) {
    state.view = state.view === view ? "side" : view;
    showStory();
}

document.addEventListener("keydown", (e) => {
    if (!["story", "grid"].includes(state.screen) || e.ctrlKey || e.metaKey || e.altKey) {
        return;
    }
    const inInput = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") {
        // From a story, wherever focus is (the reason box included), back to the grid.
        e.preventDefault();
        if (inInput) {
            e.target.blur();
        }
        if (state.screen === "story") {
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
        const item = visibleItems()[state.index];
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
        f: () => toggleView("flash"),
        h: () => toggleView("highlight"),
        s: () => toggleView("spotlight"),
        n: nextBox,
        z: () => {
            state.zoom = ZOOMS[(ZOOMS.indexOf(state.zoom) + 1) % ZOOMS.length];
            showStory();
        },
    };
    const action = keys[key];
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
document.getElementById("home").addEventListener("click", showTargets);

if (token === "") {
    render(el("p", { class: "error" }, "No session token: open the URL that visual-review serve printed."));
} else {
    showTargets();
}
