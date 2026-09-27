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
const FLASH_MS = 333; // one image each third of a second: about 1.5 full cycles a second

const state = {
    targets: [],
    target: null, // summary of the pull request (or master) being reviewed
    project: null,
    data: null, // GET /api/pr/:id/:project
    filter: "all",
    index: 0,
    view: "side", // side | flash | highlight
    pending: "reject", // what Enter in the reason box does
    screen: "targets",
};
const images = new Map();
let flashTimer = null;

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

const itemName = (item) => (item.mode ? `${item.id} (${item.mode})` : item.id);
const short = (sha) => (sha ? sha.slice(0, 10) : "none");
const decisionOf = (item) => state.data?.decisions[item.file] ?? null;

function visibleItems() {
    const items = state.data.items.filter((i) => REVIEWABLE.includes(i.status));
    if (state.filter === "all") {
        return items;
    }
    if (state.filter === "undecided") {
        return items.filter((i) => !decisionOf(i));
    }
    return items.filter((i) => i.status === state.filter);
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
    render(...state.targets.map(targetCard));
}

function targetCard(t) {
    const decided = t.projects.reduce((n, p) => n + p.decided, 0);
    const local = t.projects.some((p) => p.local);
    return el(
        "section",
        { class: "card" },
        el(
            "h2",
            {},
            t.pr === null ? "master (seed)" : `#${t.pr} `,
            t.pr === null
                ? null
                : t.url
                  ? el("a", { href: t.url, target: "_blank", rel: "noreferrer" }, t.title)
                  : t.title,
        ),
        el(
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
            local ? el("span", { class: "badge warn" }, "local preview, not acceptable") : null,
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
                        p.acceptable ? null : el("span", { class: "badge" }, "not seeded from master"),
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
                            .map(([s, n]) => `${n} ${s}`)
                            .join(", "),
                    ),
                    el("td", {}, `${p.decided} / ${p.reviewable}`),
                    el(
                        "td",
                        {},
                        p.reviewable > 0
                            ? el("button", { type: "button", onclick: () => openProject(t, p.project) }, "Review")
                            : null,
                    ),
                ),
            ),
        ),
        el(
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
    state.filter = "all";
    say("Loading...");
    try {
        state.data = await api(`/api/pr/${encodeURIComponent(target.id)}/${encodeURIComponent(project)}`);
        say("");
    } catch (err) {
        say(err.message, true);
        return;
    }
    showGrid();
}

function targetLabel() {
    return state.target.pr === null ? "master" : `#${state.target.pr}`;
}

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
    const observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                observer.unobserve(e.target);
                const { kind, file } = e.target.dataset;
                image(kind, file).then(
                    (url) => (e.target.src = url),
                    (err) => (e.target.alt = err.message),
                );
            }
        }
    });
    const tiles = items.map((item, index) => {
        const kind = item.capture ? "capture" : item.baseline ? "baseline" : null;
        const img = kind
            ? el("img", { "data-kind": kind, "data-file": item.file, alt: itemName(item) })
            : el("div", { class: "noimage" }, item.status);
        if (kind) {
            observer.observe(img);
        }
        const d = decisionOf(item);
        return el(
            "button",
            {
                type: "button",
                class: `tile ${d ? `decided ${d.decision}` : ""}`,
                onclick: () => {
                    state.index = index;
                    showStory();
                },
            },
            img,
            el("span", { class: "name" }, itemName(item)),
            el("span", { class: `badge ${item.status}` }, item.status),
            d ? el("span", { class: `badge ${d.decision}` }, d.decision) : null,
        );
    });
    render(
        el(
            "div",
            { class: "toolbar" },
            el("strong", { id: "progress" }, progress()),
            filterButton("all", `All (${state.data.items.filter((i) => REVIEWABLE.includes(i.status)).length})`),
            filterButton("undecided", "Undecided"),
            REVIEWABLE.filter((s) => counts[s]).map((s) => filterButton(s, `${s} (${counts[s]})`)),
            el("span", { class: "spacer" }),
            finishButton(),
        ),
        state.data.results.local ? el("p", { class: "badge warn" }, "local preview, not acceptable") : null,
        items.length === 0 ? el("p", {}, "Nothing here.") : el("div", { class: "grid" }, tiles),
    );
}

// ---------------------------------------------------------------- screen: story

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
    const d = decisionOf(item);
    const both = Boolean(item.capture && item.baseline);
    const view = both ? state.view : "side";
    const onlyExclude = item.status === "unstable" || item.status === "failed";
    setCrumbs(
        el("button", { type: "button", class: "link", onclick: showGrid }, `${targetLabel()} / ${state.project}`),
        el("span", {}, itemName(item)),
    );
    const sizeChanged =
        item.size &&
        item.baselineSize &&
        (item.size[0] !== item.baselineSize[0] || item.size[1] !== item.baselineSize[1]);
    const viewButton = (v, label) =>
        el(
            "button",
            {
                type: "button",
                "aria-pressed": String(view === v),
                disabled: !both,
                onclick: () => {
                    state.view = v;
                    showStory();
                },
            },
            label,
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
    render(
        el(
            "div",
            { class: "toolbar" },
            el("button", { type: "button", onclick: () => move(-1), title: "K" }, "Previous"),
            el("strong", {}, `${state.index + 1} of ${items.length}`),
            el("button", { type: "button", onclick: () => move(1), title: "J" }, "Next"),
            el("strong", { id: "progress" }, progress()),
            el("span", { class: "spacer" }),
            finishButton(),
        ),
        el(
            "h2",
            {},
            itemName(item),
            " ",
            el("span", { class: `badge ${item.status}` }, item.status),
            d ? el("span", { class: `badge ${d.decision}` }, `${d.decision}${d.reason ? `: ${d.reason}` : ""}`) : null,
            sizeChanged
                ? el(
                      "span",
                      { class: "badge warn" },
                      `size changed ${item.baselineSize.join("x")} -> ${item.size.join("x")}`,
                  )
                : null,
            item.flaky ? el("span", { class: "badge" }, "flaky") : null,
        ),
        el(
            "p",
            { class: "meta" },
            item.changedPixels !== null ? `${item.changedPixels} changed pixels` : "",
            item.bbox ? ` in [${item.bbox.join(", ")}]` : "",
            ` at threshold ${item.threshold}`,
        ),
        el(
            "div",
            { class: "toolbar" },
            viewButton("side", "Side by side"),
            viewButton("flash", "Flash"),
            viewButton("highlight", "Highlight"),
        ),
        el("div", { id: "stage", class: `stage ${view}` }),
        item.console.length > 0 ? el("pre", { class: "console" }, item.console.join("\n")) : null,
        el(
            "div",
            { class: "actions" },
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
                ? el("button", { type: "button", onclick: () => decide("exclude") }, "Exclude")
                : null,
            d ? el("button", { type: "button", onclick: () => decide(null) }, "Undo") : null,
            reason,
        ),
    );
    renderStage(item, view);
}

async function renderStage(item, view) {
    const stage = document.getElementById("stage");
    const label = (text) => el("div", { class: "label" }, text);
    const imgOf = async (kind) => el("img", { src: await image(kind, item.file), alt: `${kind} of ${itemName(item)}` });
    try {
        if (view === "side") {
            const panes = [];
            if (item.baseline) {
                panes.push(el("figure", {}, label("Baseline"), await imgOf("baseline")));
            }
            if (item.capture) {
                panes.push(
                    el("figure", {}, label(item.baseline ? "New" : "New (no baseline)"), await imgOf("capture")),
                );
            }
            if (panes.length === 0) {
                panes.push(el("p", {}, "No image: the story failed to render."));
            }
            stage.replaceChildren(...panes);
        } else if (view === "flash") {
            const [before, after] = [await image("baseline", item.file), await image("capture", item.file)];
            const img = el("img", { src: before, alt: `flashing ${itemName(item)}` });
            const tag = label("Baseline");
            stage.replaceChildren(el("figure", {}, tag, img));
            let showingNew = false;
            flashTimer = setInterval(() => {
                showingNew = !showingNew;
                img.src = showingNew ? after : before;
                tag.textContent = showingNew ? "New" : "Baseline";
            }, FLASH_MS);
        } else {
            stage.replaceChildren(
                el("figure", {}, label("Changed pixels in red over the dimmed baseline"), await highlight(item)),
            );
        }
    } catch (err) {
        stage.replaceChildren(el("p", { class: "error" }, err.message));
    }
}

// pixelmatch in the browser, on both images padded top-left to the larger size.
async function highlight(item) {
    const [a, b] = await Promise.all([
        loaded(await image("baseline", item.file)),
        loaded(await image("capture", item.file)),
    ]);
    const w = Math.max(a.naturalWidth, b.naturalWidth);
    const h = Math.max(a.naturalHeight, b.naturalHeight);
    const pixels = (img) => {
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h).data;
    };
    const canvas = el("canvas", { width: String(w), height: String(h) });
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(w, h);
    pixelmatch(pixels(a), pixels(b), out.data, w, h, {
        threshold: item.threshold,
        includeAA: item.includeAA,
        alpha: 0.2,
    });
    ctx.putImageData(out, 0, 0);
    if (item.bbox) {
        const [x, y, bw, bh] = item.bbox;
        ctx.strokeStyle = "#d000d0";
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 4, y - 4, bw + 8, bh + 8);
    }
    return canvas;
}

function move(step) {
    const count = visibleItems().length;
    state.index = (state.index + step + count) % count;
    showStory();
}

async function decide(decision) {
    const items = visibleItems();
    const item = items[state.index];
    const reasonBox = document.getElementById("reason");
    const reason = reasonBox?.value.trim() ?? "";
    if ((decision === "reject" || decision === "exclude") && reason === "") {
        state.pending = decision;
        reasonBox.focus();
        say(`Type a reason, then press Enter to ${decision}.`);
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
    say(`${itemName(item)}: ${decision ?? "undecided"}`);
    // With the "undecided" filter the decided item drops out, so the same index is the next one.
    if (decision !== null && state.filter !== "undecided") {
        state.index = Math.min(state.index + 1, items.length - 1);
    }
    showStory();
}

// ---------------------------------------------------------------- Finish

function finishButton() {
    return el(
        "button",
        { type: "button", class: "primary", onclick: () => finishTarget(state.target) },
        `Finish ${targetLabel()}`,
    );
}

async function finishTarget(target) {
    const what =
        target.pr === null ? "push a seed branch and open its pull request" : `commit and push to ${target.branch}`;
    if (
        !confirm(`Finish ${target.pr === null ? "the master seed" : `#${target.pr}`}: ${what}, across every project?`)
    ) {
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
        await showTargets();
        say(parts.join(" "));
    } catch (err) {
        say("Finish failed; your decisions are kept. Fix the cause and press Finish again.", true);
        app.prepend(el("pre", { class: "error" }, err.message));
    }
}

// ---------------------------------------------------------------- keys and start

document.addEventListener("keydown", (e) => {
    if (state.screen !== "story" || e.ctrlKey || e.metaKey || e.altKey) {
        return;
    }
    if (e.target instanceof HTMLInputElement) {
        if (e.key === "Escape") {
            e.target.blur();
        }
        return;
    }
    const keys = {
        j: () => move(1),
        k: () => move(-1),
        a: () => decide("accept"),
        r: () => decide("reject"),
        Escape: showGrid,
    };
    const action = keys[e.key];
    if (action) {
        e.preventDefault();
        action();
    }
});
document.getElementById("home").addEventListener("click", showTargets);

if (token === "") {
    render(el("p", { class: "error" }, "No session token: open the URL that visual-review serve printed."));
} else {
    showTargets();
}
