/*
 * The viewer at /next/ (design section 5): the toolbar, the item line, Details, the stage and the
 * decision bar's Previous and Next. All drawing is the stage's (viewer/stage.js, with its diffs in
 * a worker and worked out ahead); this module chooses what it draws: the view, the zoom, whether
 * the baseline is shown, one frame or two, side by side or over and under, the one-sided and
 * failed rules, and the locator at 2x and above.
 *
 * The toolbar is one 44 px row in a fixed priority. Below a viewer width of 1100 px, Image only,
 * Layout and Options move into More, by a CSS container query (next.css), never by measuring.
 */

import { createStage } from "../viewer/stage.js";
import { control } from "./actions.js";
import { badgesOf, decisionWords, layoutOf, sizeText } from "./list.js";
import { makeLocator, moveToPressed } from "./locator.js";
import { STATUS, statusMark } from "./marks.js";
import { applyPanes, imageOnlyPressed, pressImageOnly, remember, shownNow, twoLevels } from "./panes.js";
import { HIGHLIGHTS, highlight } from "./settings.js";
import { el, fmt, ic, kb } from "./ui.js";

const KEPT_KEY = "proofroom:viewer";
const VIEWS = [
    ["side", "V"],
    ["flash", "F"],
    ["highlight", "H"],
    ["spotlight", "S"],
];
const VIEW_NAME = { side: "Side by side", flash: "Flash", highlight: "Highlight", spotlight: "Spotlight" };
const ZOOMS = ["fit", 1, 2, 4, 8];
const LAYOUTS = { auto: "Auto", side: "Side by side", stacked: "Over and under" };
const fullName = (s) => `${s.component} / ${s.name}`;
const ONE_SIDED = ["new", "unseeded", "removed"];
const LOCATOR_FROM = 2; // the zoom from which the locator shows
const LABEL_H = 22; // a frame's label strip
const GAP = 8; // between two frames

// The reader's choices, kept across snapshots and visits. A new reader starts in Spotlight at Fit.
function loadKept() {
    const kept = { view: "spotlight", zoom: "fit", showBase: true, layout: "auto", outline: false, center: true };
    try {
        const saved = JSON.parse(localStorage.getItem(KEPT_KEY) ?? "{}") ?? {};
        for (const k of Object.keys(kept)) {
            if (saved[k] !== undefined) {
                kept[k] = saved[k];
            }
        }
    } catch {
        // A private window: the defaults.
    }
    if (!VIEW_NAME[kept.view] || !ZOOMS.includes(kept.zoom) || !LAYOUTS[kept.layout]) {
        return { ...kept, view: "spotlight", zoom: "fit", layout: "auto" };
    }
    return kept;
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// The one key box of the Flash segment, naming both of its keys (design 5.1).
const flashKeys = () => el("kbd", { "aria-hidden": "true" }, el("span", { class: "lk" }, "F / "), "hold Space");
// The check of the one on/off pressed style.
const check = () => el("span", { class: "chk" }, ic("accept"));
const short = (hash) => (hash ? hash.slice(0, 8) : "none");
// Puts children in a node in place of its own: nested lists flattened, null and false left out.
const fill = (node, ...kids) =>
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

/**
 * The viewer, for the page `app`; the page calls `draw(snapshot)` whenever it redraws while a
 * snapshot is current, and `stop()` when it shows none.
 * @param {any} app the page
 * @returns {object} the viewer's state and actions (app.viewer)
 */
export function createViewer(app) {
    const vs = { ...loadKept(), blink: false, spotFlash: false, space: false, details: false };
    const items = new WeakMap(); // each snapshot as the stage reads it
    const areas = { key: null, text: "", count: 0 }; // the changed areas of the snapshot on the stage
    let parts = null; // the viewer's own elements, kept across redraws so the stage keeps its scroll
    let shownKey = null; // what the stage draws now
    let stacked = false; // whether the two frames are over and under now
    let ioBefore = null; // the panes Image only hid

    const save = () => {
        try {
            const { view, zoom, showBase, layout, outline, center } = vs;
            localStorage.setItem(KEPT_KEY, JSON.stringify({ view, zoom, showBase, layout, outline, center }));
        } catch {
            // Not kept; the defaults apply next time.
        }
    };

    const current = () => app.snaps.find((x) => x.key === app.snap) ?? null;
    const oneSided = (s) => ONE_SIDED.includes(s.status);
    const twoImages = (s = current()) => Boolean(s && !oneSided(s) && s.status !== "failed" && s.baseline && s.capture);

    function viewOK(v, s = current()) {
        if (!s) {
            return "Choose a snapshot first";
        }
        if (s.status === "failed") {
            return "The story did not render: there is no image to compare.";
        }
        if (v !== "side" && !twoImages(s)) {
            return s.status === "removed"
                ? "Needs a new image: this snapshot was removed."
                : "Needs a baseline: this snapshot is new.";
        }
        return true;
    }
    // The view drawn now: the reader's, or Side by side where it is not available.
    const shownView = (s = current()) => (viewOK(vs.view, s) === true ? vs.view : "side");
    // What the stage is asked to draw: holding Space flashes the current view.
    const stageView = (s) => (vs.space && twoImages(s) && shownView(s) !== "spotlight" ? "flash" : shownView(s));
    const flashing = (s) => {
        const v = stageView(s);
        return v === "flash" || (v === "spotlight" && (vs.spotFlash || vs.space));
    };
    // One frame or two: one for a one-sided snapshot, while flashing, and with the baseline hidden.
    const twoFrames = (s) => twoImages(s) && vs.showBase && !flashing(s);

    // ------------------------------------------------------------ the stage

    function itemOf(s) {
        let it = items.get(s);
        if (!it) {
            // The pair's diff settings are in its picture's name: <baseline>-<capture>-<threshold>-<aa>.
            const [threshold, aa] = s.pic ? s.pic.split("-").slice(-2) : ["0.1", "0"];
            it = {
                snap: s,
                file: s.key,
                id: s.id,
                status: s.status,
                from: s.from,
                baseline: s.baseline,
                capture: s.capture,
                threshold: Number(threshold),
                includeAA: aa === "1",
                reason: s.reason,
                console: [],
            };
            items.set(s, it);
        }
        return it;
    }

    // The snapshots Previous and Next walk, in the list's order (every row Show and Find keep).
    const walk = () => layoutOf(app.lv, app.snaps).groups.flatMap((g) => g.rows);

    const stage = createStage({
        flashMs: 667, // one image each two thirds of a second: about 1.5 swaps a second
        blinkMs: 500, // the overlays on, then off, each half a second
        settings: () => {
            const s = current();
            return {
                zoom: vs.zoom,
                scale: s?.scale ?? 1,
                focus: vs.center,
                showBox: vs.outline,
                baselinePane: Boolean(s && twoFrames(s)),
                blink: vs.blink,
                spotFlash: Boolean(s) && shownView(s) === "spotlight" && (vs.spotFlash || vs.space),
                motion: !reducedMotion(),
                color: HIGHLIGHTS[highlight()],
            };
        },
        load: (url, what) =>
            new Promise((resolve, reject) => {
                const img = new Image();
                img.decoding = "async";
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error(`${what}: the image could not be shown`));
                img.src = url;
            }),
        imageUrl: (hash) => `/api/blob/${hash}`,
        itemName: (item) => item.snap.name,
        onlyExclude: (item) => ["failed", "unstable"].includes(item.status),
        pass: () => {
            const rows = walk();
            return { items: rows.map(itemOf), index: rows.findIndex((r) => r.key === app.snap) };
        },
        undecided: (item) => !item.snap.decision,
        groupOf: (item) => item.snap.component,
        retry: () => {
            shownKey = null;
            render(current());
        },
        drawn: () => {},
        appeared: (item) => performance.mark("viewer-drawn", { detail: item.file }),
        boxCount: (text, count) => {
            areas.key = app.snap;
            areas.text = text;
            areas.count = count;
            const s = current();
            if (s && parts) {
                fillLine(s);
            }
        },
        labels: (item, view) => labelsOf(item.snap, view),
    });

    // The label strip above each frame: never over the image (design 5.6).
    function labelsOf(s, view) {
        if (s.status === "removed") {
            return { leftLabel: "Removed: accepting deletes this baseline." };
        }
        if (s.status === "new") {
            return { rightLabel: "New: no baseline yet. Accept makes this the first baseline." };
        }
        if (s.status === "unseeded") {
            return { rightLabel: "No baseline yet: never approved. Accept makes this the first baseline." };
        }
        const note = vs.space ? "flashing while Space is held" : "alternating, about 1.5 times a second";
        if (view === "flash") {
            return { rightLabel: "Baseline", flash: ["Baseline", "New"], note };
        }
        if (view === "spotlight" && (vs.spotFlash || vs.space)) {
            return { rightLabel: "Spotlit baseline", flash: ["Spotlit baseline", "Spotlit new"], note };
        }
        return { leftLabel: "Baseline", rightLabel: view === "spotlight" ? "Spotlit new" : "New" };
    }

    // Over and under, when Auto finds each image drawn larger that way (or the reader chose it).
    function stackedFor(s) {
        if (!twoFrames(s)) {
            return false;
        }
        if (vs.layout !== "auto") {
            return vs.layout === "stacked";
        }
        const [w, h] = s.size ?? s.baselineSize ?? [1, 1];
        const b = parts.wrap.getBoundingClientRect();
        const side = Math.min((b.width - GAP) / 2 / w, (b.height - LABEL_H) / h);
        const over = Math.min(b.width / w, (b.height - 2 * LABEL_H - GAP) / 2 / h);
        return over > side;
    }

    // Draws the snapshot on the stage, unless the stage already shows it as asked.
    function render(s) {
        stacked = stackedFor(s);
        const view = stageView(s);
        const key = JSON.stringify([
            s.key,
            s.baseline,
            s.capture,
            view,
            vs.zoom,
            vs.outline,
            vs.center,
            vs.blink,
            vs.spotFlash,
            vs.space,
            twoFrames(s),
            stacked,
            highlight(),
        ]);
        if (key === shownKey) {
            return;
        }
        const was = shownKey === null ? null : JSON.parse(shownKey);
        shownKey = key;
        const st = parts.stage;
        parts.wrap.querySelector(".locator")?.remove();
        parts.wrap.querySelector(".note")?.remove();
        st.classList.toggle("stacked", stacked);
        st.dataset.status = s.status;
        st.classList.toggle("zoom-fit", vs.zoom === "fit");
        if (s.status === "failed") {
            stage.stop();
            st.replaceChildren(errorPanel(s));
            return;
        }
        // Same snapshot and zoom: the frames keep where they were scrolled to.
        const frame = st.querySelector(".frame");
        const keep =
            was && was[0] === s.key && was[4] === vs.zoom && frame ? [frame.scrollLeft, frame.scrollTop] : null;
        stage.stop();
        stage.render(st, itemOf(s), view, keep).then(() => {
            if (shownKey === key && st.isConnected) {
                decorate(s, view);
            }
        });
    }

    // After the stage drew: "No pixels changed." on a moved snapshot's compared views, and the
    // locator at 2x and above.
    async function decorate(s, view) {
        if (s.status === "moved" && (view === "highlight" || view === "spotlight")) {
            parts.wrap.append(el("div", { class: "note" }, "No pixels changed."));
        }
        if (vs.zoom === "fit" || vs.zoom < LOCATOR_FROM) {
            return;
        }
        const key = shownKey;
        let diff = null;
        if (twoImages(s) || s.status === "moved") {
            diff = await stage.diffOf(itemOf(s)).catch(() => null);
        }
        if (key !== shownKey) {
            return;
        }
        const frames = [...parts.stage.querySelectorAll(".frame")];
        const hash = s.capture ?? s.baseline;
        if (frames.length === 0 || !hash) {
            return;
        }
        parts.wrap.querySelector(".locator")?.remove();
        parts.wrap.append(
            makeLocator(app, {
                src: `/api/blob/${hash}`,
                size: diff ? [diff.w, diff.h] : (s.size ?? s.baselineSize ?? [1, 1]),
                boxes: s.status === "changed" && diff ? diff.boxes : [],
                frames,
            }),
        );
    }

    // A failed snapshot: what went wrong, in place of the images (design 5.6).
    function errorPanel(s) {
        const consoleBox = el("pre", {}, "Loading...");
        const attempts = el("p", { class: "attempts" }, "Loading...");
        const reason = el("p", {}, `Reason: ${s.reason ?? "not recorded"}`);
        app.fullItem(s).then(
            (full) => {
                reason.textContent = `Reason: ${full?.reason ?? s.reason ?? "not recorded"}`;
                consoleBox.textContent = full?.console?.length ? full.console.join("\n") : "no output";
                attempts.textContent = attemptsText(full);
            },
            (err) => {
                consoleBox.textContent = `The console could not be read: ${err.message}`;
                attempts.textContent = "";
            },
        );
        return el(
            "div",
            { class: "errpanel", role: "region", "aria-label": "Why the capture failed" },
            el("div", { class: "st big" }, ic("failed", "c-failed"), "This story did not render."),
            reason,
            el("b", {}, "Console"),
            consoleBox,
            el("b", {}, "Attempts"),
            attempts,
            el("p", { class: "muted" }, "Fix the story or capture again. Exclude stops capturing it."),
        );
    }

    function attemptsText(full) {
        const tries = [...(full?.attempts ?? []), full].filter(Boolean);
        if (tries.length === 0) {
            return "No attempt was recorded.";
        }
        const said = tries.map((a) => (a.reason ? `${a.status} (${a.reason})` : a.status));
        return `${tries.length} attempt${tries.length === 1 ? "" : "s"}: ${said.join(", ")}.`;
    }

    // ------------------------------------------------------------ the toolbar and the item line

    function toolbar(s) {
        const ev = shownView(s);
        const inSpot = ev === "spotlight";
        const segs = VIEWS.map(([v, key]) => {
            const id = `view-${v}`;
            if (v === "flash" && inSpot) {
                // In Spotlight the one Flash segment is a toggle, never a second selected view.
                return control(app, id, {
                    zone: "toolbar",
                    attrs: {
                        class: "tog",
                        "aria-pressed": String(vs.spotFlash),
                        title: "Flashes the spotlit pair. Plain Flash: Side by side [V], then Flash [F]",
                    },
                    children: [check(), "Flash", flashKeys()],
                });
            }
            const on = ev === v && viewOK(v, s) === true;
            return control(app, id, {
                zone: "toolbar",
                attrs: { class: on ? "on" : null, role: "radio", "aria-checked": String(on) },
                children: [VIEW_NAME[v], v === "flash" ? flashKeys() : kb(key)],
            });
        });
        const blinkOn = ev === "highlight";
        const zooms = ZOOMS.map((z) =>
            control(app, `zoom-${z}`, { zone: "toolbar", attrs: { class: vs.zoom === z ? "on" : null } }),
        );
        const two = twoImages(s);
        const display = el(
            "div",
            { class: "tg", "data-g": "display", title: "Display" },
            control(app, "imageonly", {
                zone: "toolbar",
                attrs: { "aria-pressed": String(imageOnly()) },
                children: [check(), "Image only", kb("Shift+3")],
            }),
            control(app, "layoutmenu", { zone: "toolbar" }),
            control(app, "options", {
                zone: "toolbar",
                attrs: { "data-menukeys": JSON.stringify({ B: "outline", O: "centerarea" }) },
            }),
        );
        return [
            el(
                "div",
                { class: "tg", "data-g": "view", title: "View" },
                el("span", { class: "seg", role: "radiogroup", "aria-label": "View" }, segs),
            ),
            el(
                "div",
                { class: "tg", "data-g": "option", title: "View option" },
                control(app, "blink", {
                    zone: "toolbar",
                    attrs: { "aria-pressed": blinkOn ? String(vs.blink) : null },
                    children: [check(), "Blink", kb("L")],
                }),
            ),
            el(
                "div",
                { class: "tg", "data-g": "zoom", title: "Zoom" },
                control(app, "zoomcycle", { zone: "toolbar" }),
                el("span", { class: "seg", role: "group", "aria-label": "Zoom" }, zooms),
            ),
            el(
                "div",
                { class: "tg", "data-g": "baseline", title: "Baseline" },
                control(app, "baseline", {
                    zone: "toolbar",
                    attrs: { "aria-pressed": two ? String(vs.showBase) : null },
                    children: two ? [check(), "Baseline", kb("P")] : ["Baseline: none", kb("P")],
                }),
            ),
            imageOnly()
                ? el("span", { class: "itemsum grow" }, lineHead(s, "iline", fullName(s)), lineEnd(s))
                : el("span", { class: "grow" }),
            display,
            control(app, "more", {
                zone: "toolbar",
                attrs: {
                    id: "morebtn",
                    "data-menukeys": JSON.stringify({
                        "Shift+3": "imageonly",
                        Y: "more",
                        B: "outline",
                        O: "centerarea",
                    }),
                },
            }),
        ];
    }

    // The item line's start: Back, the number, the status and the story's name (in the toolbar,
    // its full name).
    function lineHead(s, zone, name = s.name) {
        return [
            app.level >= 1 ? control(app, "back", { zone }) : null,
            el("b", { class: "num" }, `#${s.n}`),
            statusMark(s.status),
            el("b", { class: "name ell", title: fullName(s) }, name),
        ];
    }

    // The item line's right end: Open [Enter] at the list level of a two-level change.
    const lineEnd = (s) =>
        el(
            "span",
            { class: "iright" },
            app.level === 1 && twoLevels(app.snaps.length, innerWidth) && s
                ? control(app, "openrow", { zone: "iline" })
                : null,
        );

    const COMP_MIN_PX = 48; // about four letters and the ellipsis
    function fillLine(s) {
        // One count for the size text, Next area and "n of N": the diff's areas once drawn.
        const count = areas.key === s.key ? areas.count : (s.areas?.count ?? 0);
        const text = areas.key === s.key ? areas.text : `1 of ${count}`;
        const size = sizeText(s, areas.key === s.key ? areas.count : s.areas?.count);
        const words = decisionWords(app, s);
        parts.line.className = `iline ${imageOnly() ? "ionly" : ""}`;
        fill(
            parts.line,
            lineHead(s, "iline"),
            s.mode ? el("span", { class: "tag" }, s.mode) : null,
            el("span", { class: "muted ell comp" }, `${s.project} > ${s.component}`),
            size ? el("span", { class: "muted keep" }, size) : null,
            count > 1
                ? [control(app, "nextarea", { zone: "iline" }), el("span", { class: "num keep", id: "area-at" }, text)]
                : null,
            badgesOf(app, s).map((b) => el("span", { class: "badge", title: b.title ?? null }, b.text)),
            words ? el("span", { class: "keep" }, words) : null,
            el("span", { class: "muted asay" }, STATUS[s.status]?.say ?? ""),
            el("span", { class: "grow" }),
            lineEnd(s),
        );
        // No room: the Accept sentence goes first, whole and never cut, before the component is cut.
        // The component then shrinks with an ellipsis, and goes only when it would be narrower than a
        // few letters. Last, the story's name is cut in the middle.
        const line = parts.line;
        const cut = (n) => n !== null && n.scrollWidth > n.clientWidth + 1;
        const comp = line.querySelector(".comp");
        const name = line.querySelector(".name");
        const over = () => line.scrollWidth > line.clientWidth + 1 || cut(name);
        if (over() || cut(comp)) {
            line.querySelector(".asay")?.remove();
        }
        if (over() || (cut(comp) && comp.clientWidth < COMP_MIN_PX)) {
            comp.remove();
        }
        for (let keep = s.name.length - 2; cut(name) && keep > 4; keep -= 2) {
            name.textContent = `${s.name.slice(0, Math.ceil(keep / 2))}...${s.name.slice(s.name.length - Math.floor(keep / 2))}`;
        }
    }

    function fillDetails(s) {
        parts.details.hidden = !vs.details;
        if (!vs.details) {
            parts.details.replaceChildren();
            return;
        }
        const it = itemOf(s);
        const field = (name, value, id) => [el("span", { class: "muted" }, name), el("span", { id }, value)];
        const base = app.list?.baselines ?? "baselines";
        fill(
            parts.details,
            field("Threshold", s.status === "failed" ? "none" : String(it.threshold)),
            field("Anti-aliasing", it.includeAA ? "counted" : "ignored"),
            field("Capture scale", String(s.scale ?? 1)),
            field("Renderer", s.renderer ? `${s.renderer.name} ${s.renderer.version}` : "not recorded"),
            field("Baseline hash", short(s.baseline)),
            field("New hash", short(s.capture)),
            field("Attempts", "...", "det-attempts"),
            field("Settings file", `${base}/${s.project}/${s.id}.json`),
            el("span", { class: "muted" }, "Console"),
            el("span", { class: "dcon", id: "det-console" }, "..."),
        );
        const key = s.key;
        app.fullItem(s).then(
            (full) => {
                if (current()?.key === key && vs.details) {
                    document.getElementById("det-attempts").textContent = attemptsText(full);
                    document.getElementById("det-console").textContent = full?.console?.length
                        ? full.console.join("\n")
                        : "no output";
                }
            },
            () => {
                if (document.getElementById("det-console")) {
                    document.getElementById("det-console").textContent = "could not be read";
                }
            },
        );
    }

    function fillBar(s) {
        const left = app.snaps.filter((x) => !x.decision).length;
        parts.bar.replaceChildren(
            control(app, "prev", {
                zone: "decision",
                children: [el("span", { class: "lbl" }, "Previous"), kb("Left / J")],
            }),
            el(
                "span",
                { class: "pos num small" },
                el("b", {}, `#${s.n}`),
                el("span", { class: "pl" }, `, ${fmt(left)} left`),
            ),
            control(app, "next", {
                zone: "decision",
                children: [el("span", { class: "lbl" }, "Next"), kb("Right / K")],
            }),
            el("span", { class: "grow" }),
        );
    }

    // The viewer's elements: made once, and put back when the viewer showed something else.
    function ensureParts() {
        const v = document.getElementById("viewer");
        if (parts && parts.stage.parentElement === parts.wrap && parts.wrap.parentElement === v) {
            return;
        }
        parts ??= {
            bar: el("div", { class: "decide" }),
            details: el("div", { class: "details", id: "details", hidden: true }),
            line: el("div", { class: "iline" }),
            stage: el("div", { class: "stage", id: "stage" }),
            tools: el("div", { class: "vtb", id: "vtb", role: "toolbar", "aria-label": "Viewer" }),
            wrap: el("div", { class: "stagewrap" }),
        };
        parts.wrap.replaceChildren(parts.stage);
        v.replaceChildren(parts.tools, parts.line, parts.details, parts.wrap, parts.bar);
        shownKey = null;
        resized.disconnect();
        resized.observe(parts.wrap);
    }

    // Auto chooses again when the stage changes size.
    const resized = new ResizeObserver(() => {
        const s = current();
        if (s && parts?.wrap.isConnected && vs.layout === "auto" && stackedFor(s) !== stacked) {
            render(s);
            fill(parts.tools, toolbar(s));
            app.settle?.();
        }
    });

    /**
     * Draws the viewer for snapshot `s`.
     * @param {any} s the snapshot
     */
    function draw(s) {
        ensureParts();
        if (areas.key !== s.key) {
            areas.key = null;
            stage.box = 0;
        }
        parts.tools.className = `vtb ${imageOnly() ? "merged" : ""}`;
        fill(parts.tools, toolbar(s));
        fillLine(s);
        fillDetails(s);
        fillBar(s);
        render(s);
        // The Layout button says what Auto chose, once the stage has its size.
        const lay = parts.tools.querySelector('[data-act="layoutmenu"]');
        if (lay && vs.layout === "auto") {
            lay.title = layoutTitle();
        }
    }

    // ------------------------------------------------------------ actions

    const imageOnly = () => imageOnlyPressed(shownNow());
    const redraw = () => app.draw();
    const layoutTitle = () =>
        vs.layout === "auto" ? `Auto chose ${stacked ? "over and under" : "side by side"} for this window` : "Layout";

    function menuItem(id, label, checked) {
        return { id, label, checked, check: true };
    }

    return {
        state: vs,
        draw,
        stop: () => {
            stage.stop();
            shownKey = null;
        },
        stage,
        current,
        twoImages: () => twoImages(),
        viewOK: (v) => viewOK(v),
        shownView: () => shownView(),
        imageOnly,
        layoutTitle,
        layoutName: () => LAYOUTS[vs.layout],
        viewTitle: (v) => {
            if (v === "flash") {
                return "Flash: the baseline and the new image in turn, in one frame; hold Space to flash while held";
            }
            const key = VIEWS.find((x) => x[0] === v)[1];
            return shownView() === v && v !== "side" ? `${VIEW_NAME[v]}. ${key} again: Side by side [V]` : VIEW_NAME[v];
        },
        // A view's key: the view, or pressed again, Side by side; F in Spotlight flashes the
        // spotlit pair.
        pressView: (v) => {
            const ev = shownView();
            if (v === "flash" && ev === "spotlight") {
                vs.spotFlash = !vs.spotFlash;
            } else {
                vs.view = ev === v && v !== "side" ? "side" : v;
            }
            save();
            redraw();
        },
        toggle: (name) => {
            vs[name] = !vs[name];
            save();
            const said = {
                outline: `Outline ${vs.outline ? "on" : "off"}.`,
                center: `Open centered on the area: ${vs.center ? "on" : "off"}.`,
                showBase: `Baseline ${vs.showBase ? "shown" : "hidden"}.`,
            }[name];
            if (said) {
                app.say(said);
            }
            redraw();
        },
        setZoom: (z) => {
            vs.zoom = z;
            save();
            redraw();
        },
        cycleZoom: () => {
            vs.zoom = ZOOMS[(ZOOMS.indexOf(vs.zoom) + 1) % ZOOMS.length];
            save();
            redraw();
        },
        setLayout: (k) => {
            vs.layout = k;
            save();
            redraw();
        },
        layoutMenu: (anchor) =>
            app.showMenu(
                anchor,
                Object.keys(LAYOUTS).map((k) => ({
                    id: `layout-${k}`,
                    label: k === "auto" ? `Auto (${stacked ? "over and under" : "side by side"} now)` : LAYOUTS[k],
                    checked: vs.layout === k,
                })),
            ),
        optionsMenu: (anchor) =>
            app.showMenu(anchor, [
                menuItem("outline", "Outline", vs.outline),
                menuItem("centerarea", "Open centered on the area", vs.center),
                menuItem("details", "Details", vs.details),
                { id: "listlink", label: "Copy link" },
            ]),
        // Below a viewer width of 900 px More also holds Flash while held, and below 800 px Zoom.
        moreMenu: (anchor) => {
            const vw = document.getElementById("viewer")?.clientWidth ?? innerWidth;
            app.showMenu(
                anchor,
                [
                    vw < 900
                        ? [{ head: "View" }, { id: "flashheld", label: "Flash while held", key: "hold Space" }]
                        : [],
                    vw < 800
                        ? [
                              { head: "Zoom" },
                              ...ZOOMS.map((z) => ({
                                  id: `zoom-${z}`,
                                  label: z === "fit" ? "Fit" : `${z}x`,
                                  checked: vs.zoom === z,
                              })),
                          ]
                        : [],
                    { head: "Display" },
                    menuItem("imageonly", "Image only", imageOnly()),
                    Object.entries(LAYOUTS).map(([k, l]) => ({
                        id: `layout-${k}`,
                        label: `Layout: ${l}`,
                        key: "Y",
                        checked: vs.layout === k,
                    })),
                    { sep: true },
                    { head: "Options" },
                    menuItem("outline", "Outline", vs.outline),
                    menuItem("centerarea", "Open centered on the area", vs.center),
                    menuItem("details", "Details", vs.details),
                    { id: "listlink", label: "Copy link" },
                ].flat(),
            );
        },
        pressImageOnly: () => {
            const at = app.at();
            const { shown, before } = pressImageOnly(shownNow(), ioBefore, at);
            ioBefore = before;
            applyPanes(shown, at);
            remember(app.level, app.snaps.length, shown);
            const names = ["Changes", "Snapshots"].filter((_, i) => shown[i]);
            app.say(
                imageOnlyPressed(shown)
                    ? "Image only: Shift+3 brings the panes back."
                    : `Image only off: ${names.join(" and ") || "no pane"} shown again.`,
            );
            redraw();
        },
        nextArea: async () => {
            const s = current();
            if (s) {
                const said = await stage.nextBox(parts.stage, itemOf(s));
                if (said) {
                    app.say(said);
                }
            }
        },
        locate: (node) => moveToPressed(node),
        step: (d) => app.stepSnap(d),
        // Hold Space: the current view flashes while the key is down.
        holdSpace: (on) => {
            const s = current();
            if (vs.space === on || !s || !parts?.stage.isConnected || (on && !twoImages(s))) {
                return;
            }
            vs.space = on;
            parts.tools.querySelector('[data-act="view-flash"]')?.classList.toggle("flashing", on);
            render(s);
        },
    };
}
