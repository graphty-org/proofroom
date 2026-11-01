/*
 * The viewer (design section 5): the toolbar, the item line, Details, the stage, the
 * end card and the decision bar (design 6.1; its decisions are decide.js's). All drawing is the stage's (viewer/stage.js, with its diffs in
 * a worker and worked out ahead); this module chooses what it draws: the view, the zoom, whether
 * the baseline is shown, one frame or two, side by side or over and under, the one-sided and
 * failed rules, and the locator at 2x and above.
 *
 * The toolbar is one 44 px row of seven controls at every width: the view segment, Blink, Zoom
 * and the Display menu. Zoom's digits and the Display settings' keys act with their menus closed.
 */

import { createStage } from "./viewer/stage.js";
import { control, labelOf } from "./actions.js";
import { badgeNode, badgesOf, decisionWords, layoutOf } from "./list.js";
import { makeLocator, moveToPressed } from "./locator.js";
import { statusMark } from "./marks.js";
import { PANES, SMALL, applyPanes, imageOnlyPressed, pressImageOnly, remember, shownNow } from "./panes.js";
import { HIGHLIGHTS, highlight } from "./settings.js";
import { SPOT_UNDER } from "./spot.js";
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
const ZOOM_KEY = { fit: "0", 1: "1", 2: "2", 4: "4", 8: "8" };
const zoomName = (z) => (z === "fit" ? "Fit" : `${z}x`);
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
// The check of an on/off toggle (Blink, Select); never in the view segment.
const check = () => el("span", { class: "chk" }, ic("accept"));
const short = (hash) => (hash ? hash.slice(0, 8) : "none");
// Puts children in a node in place of its own: nested lists flattened, null and false left out.
const fill = (node, ...kids) =>
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

/**
 * The viewer, for the page `app`; the page calls `draw(snapshot)` whenever it redraws while a
 * snapshot is current, and `stop()` when it shows none. The Review screen's by default; the
 * Baselines screen's (baselines.js) draws its own item line and bar, and shows no Baseline toggle,
 * Options, Details or end card.
 * @param {any} app the page, or the screen that stands for it
 * @param {object} [o] another screen's viewer
 * @param {string} [o.root] the viewer's element id ("viewer")
 * @param {string} [o.idp] the prefix of its elements' ids ("")
 * @param {string} [o.screen] the screen ("review")
 * @param {string[]} [o.names] its side panes' names
 * @param {(hash: string) => string} [o.imageUrl] an image's address, by its hash
 * @param {(s: any, view: string, state: object) => object} [o.labels] the frames' labels
 * @param {(view: string) => string} [o.oneImageWhy] why a view needing two images is unavailable
 * @param {(line: HTMLElement, s: any) => void} [o.line] fills the item line
 * @param {(bar: HTMLElement, s: any) => void} [o.bar] fills the bar under the stage
 * @param {HTMLElement} [o.below] what goes under the bar
 * @returns {object} the viewer's state and actions (app.viewer)
 */
export function createViewer(app, o = {}) {
    const review = !o.line;
    const root = o.root ?? "viewer";
    const idp = o.idp ?? "";
    const screen = o.screen ?? "review";
    const panes = PANES[screen];
    const imageUrl = o.imageUrl ?? ((hash) => `/api/blob/${hash}`);
    const vs = { ...loadKept(), blink: false, spotFlash: false, space: false, details: false };
    const items = new WeakMap(); // each snapshot as the stage reads it
    const areas = { key: null, text: "", count: 0 }; // the changed areas of the snapshot on the stage
    let parts = null; // the viewer's own elements, kept across redraws so the stage keeps its scroll
    let shownKey = null; // what the stage draws now
    let stacked = false; // whether the two frames are over and under now
    let explain = null; // the snapshot H or S was just pressed on: its areas' share may need a word
    const explained = new Set(); // the snapshots that word was said on
    let ioBefore = null; // the panes Image only hid
    let ioLevel = null; // the level Image only was pressed at, while it is on
    let zoomStep = false; // the next drawing is a zoom step: it centers on the current area
    let centerKey = null; // the drawing a zoom step asked to center
    let doneKey = null; // the last drawing the stage finished

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
            if (o.oneImageWhy) {
                return o.oneImageWhy(v);
            }
            return s.status === "removed"
                ? "Needs a new image: this snapshot was removed."
                : "Needs a baseline: this snapshot is new.";
        }
        return true;
    }
    // The view drawn now: the reader's, or Side by side where it is not available.
    const shownView = (s = current()) => (viewOK(vs.view, s) === true ? vs.view : "side");
    // Flash entered from Spotlight flashes the spotlit pair; any other view leaves it.
    const spotlit = (s) => shownView(s) === "flash" && vs.spotFlash;
    // What the stage is asked to draw: holding Space flashes the current view. The spotlit Flash is
    // the stage's flashing Spotlight.
    const stageView = (s) => {
        if (spotlit(s)) {
            return "spotlight";
        }
        return vs.space && twoImages(s) && shownView(s) !== "spotlight" ? "flash" : shownView(s);
    };
    const flashing = (s) => shownView(s) === "flash" || (twoImages(s) && vs.space);
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
    const walk = () => (review ? layoutOf(app.lv, app.snaps).groups.flatMap((g) => g.rows) : app.snaps);

    const stage = createStage({
        flashMs: 667, // one image each two thirds of a second: about 1.5 swaps a second
        blinkMs: 500, // the overlays on, then off, each half a second
        settings: () => {
            const s = current();
            return {
                zoom: vs.zoom,
                scale: s?.scale ?? 1,
                focus: vs.center || (centerKey !== null && centerKey === shownKey),
                showBox: vs.outline,
                baselinePane: Boolean(s && twoFrames(s)),
                blink: vs.blink,
                spotFlash: Boolean(s) && (spotlit(s) || (shownView(s) === "spotlight" && vs.space)),
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
        imageUrl,
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
            if (s && parts && review) {
                fillLine(s);
                // The item line's controls are new: their key boxes follow the zones again.
                app.settle?.();
            }
        },
        labels: (item, view) => (o.labels ? o.labels(item.snap, view, vs) : labelsOf(item.snap, view)),
        // H or S on a snapshot whose changed areas cover a third or more of it: says once per
        // snapshot why Highlight is a red slab and Spotlight dims nothing.
        covers: (item, share) => {
            const s = item.snap;
            if (explain !== s.key || stageView(s) !== vs.view) {
                return;
            }
            explain = null;
            if (share >= SPOT_UNDER && !explained.has(s.key)) {
                explained.add(s.key);
                app.say(
                    s.size && s.baselineSize && (s.size[0] !== s.baselineSize[0] || s.size[1] !== s.baselineSize[1])
                        ? "Resized: everything below the first change moved, so it all counts as changed. Flash (F) shows the move."
                        : "Most of this image changed. Flash (F) shows it.",
                );
            }
        },
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
        // Flashing: the strip names the image showing, with each flash; nothing is said on the image.
        if (view === "spotlight" && (spotlit(s) || vs.space)) {
            const flash = ["Baseline (flashing, spotlit)", "New (flashing, spotlit)"];
            return { rightLabel: flash[0], flash };
        }
        if (view === "flash") {
            return { rightLabel: "Baseline (flashing)", flash: ["Baseline (flashing)", "New (flashing)"] };
        }
        return { leftLabel: "Baseline", rightLabel: "New" };
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
        // A drawing replaced before it finished hands on what it was still to do: its centering,
        // and no scroll to keep (its frames were never placed).
        const settled = doneKey === shownKey;
        const centering = zoomStep || (!settled && centerKey !== null && centerKey === shownKey);
        shownKey = key;
        centerKey = centering && was?.[0] === s.key ? key : null;
        zoomStep = false;
        const st = parts.stage;
        parts.wrap.querySelector(".locator")?.remove();
        parts.wrap.querySelector(".note")?.remove();
        parts.wrap.querySelector(".showbase")?.remove();
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
            settled && was && was[0] === s.key && was[4] === vs.zoom && frame
                ? [frame.scrollLeft, frame.scrollTop]
                : null;
        stage.stop();
        // A wait for the picture on screen (scripts/uat.mjs) takes only a "viewer-drawn" newer than
        // this mark (design 11.3). Marked when the stage starts drawing a snapshot it does not show:
        // a view or zoom of the one on the stage keeps its pictures, and Accept never waits for it.
        if (stage.shownFile !== s.key) {
            performance.mark("viewer-drawing", { detail: s.key });
        }
        stage.render(st, itemOf(s), view, keep).then(() => {
            if (shownKey === key) {
                doneKey = key;
            }
            if (shownKey === key && st.isConnected) {
                decorate(s, view);
            }
        });
    }

    // After the stage drew: "No pixels changed" on a moved snapshot's compared views, with the
    // baseline hidden (P) a quiet "Show baseline  P" at the strip's left end, and the locator at 2x
    // and above, all in the New panel's label strip, never over the image.
    const newStrip = () => [...parts.stage.querySelectorAll(".frame")].at(-1)?.previousElementSibling ?? null;
    async function decorate(s, view) {
        if (s.status === "moved" && (view === "highlight" || view === "spotlight")) {
            newStrip()?.append(el("span", { class: "note" }, "no pixels changed"));
        }
        if (review && twoImages(s) && !vs.showBase) {
            newStrip()?.prepend(
                control(app, "baseline", { zone: "toolbar", quiet: true, attrs: { class: "quietbtn showbase" } }),
            );
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
        newStrip()?.append(
            makeLocator(app, {
                src: imageUrl(hash),
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

    // The toolbar: the view segment (V F H S, boxed, exactly one filled, never a check mark),
    // Blink only in Highlight (the one view it acts in), Zoom and the Display menu. Zoom's digits and
    // every Display setting's key act with their menu closed, through the button's data-menukeys.
    function toolbar(s) {
        const ev = shownView(s);
        const io = imageOnly();
        // Baselines draws only the views that act there: until two versions are ticked, none.
        const views = review ? VIEWS : VIEWS.filter(([v]) => viewOK(v, s) === true);
        const segs = (views.length > 1 ? views : []).map(([v, key]) => {
            const on = ev === v && viewOK(v, s) === true;
            return control(app, `view-${v}`, {
                zone: "toolbar",
                attrs: { class: on ? "on" : null, role: "radio", "aria-checked": String(on) },
                children: [VIEW_NAME[v], v === "flash" ? flashKeys() : kb(key)],
            });
        });
        return [
            // Image only: one strip, Back first with the snapshot's name (Review), then the views.
            io && review ? el("span", { class: "itemsum" }, lineHead(s, "toolbar", fullName(s))) : null,
            segs.length
                ? el(
                      "div",
                      { class: "tg", "data-g": "view", title: "View" },
                      el("span", { class: "seg", role: "radiogroup", "aria-label": "View" }, segs),
                  )
                : null,
            el(
                "div",
                { class: "tg", "data-g": "zoom", title: "Zoom" },
                control(app, "zoomcycle", {
                    zone: "toolbar",
                    attrs: {
                        "aria-haspopup": "menu",
                        "data-menukeys": JSON.stringify(
                            Object.fromEntries(ZOOMS.map((z) => [ZOOM_KEY[z], `zoom-${z}`])),
                        ),
                    },
                    children: [
                        labelOf(app, "zoomcycle"),
                        kb("Z", true),
                        el("span", { class: "gcaret", "aria-hidden": "true" }),
                    ],
                }),
            ),
            // Blink after Zoom: its coming and going in Highlight moves nothing but the gap after it.
            ev === "highlight"
                ? el(
                      "div",
                      { class: "tg", "data-g": "blink", title: "Blink" },
                      control(app, "blink", {
                          zone: "toolbar",
                          quiet: true,
                          attrs: { "aria-pressed": String(vs.blink) },
                          children: [check(), "Blink", kb("L", true)],
                      }),
                  )
                : null,
            el("span", { class: "grow" }),
            // Image only's way out, its check filled; the Display menu's settings wait until then.
            io
                ? control(app, "imageonly", {
                      zone: "toolbar",
                      quiet: true,
                      attrs: { "aria-pressed": "true" },
                      children: [check(), "Image only", kb("Shift+3", true)],
                  })
                : el(
                      "div",
                      { class: "tg", "data-g": "display", title: "Display" },
                      control(app, "displaymenu", {
                          zone: "toolbar",
                          attrs: {
                              id: `${idp}displaybtn`,
                              "aria-haspopup": "menu",
                              "data-menukeys": JSON.stringify(
                                  review
                                      ? {
                                            P: "baseline",
                                            "Shift+3": "imageonly",
                                            Y: "layoutmenu",
                                            B: "outline",
                                            O: "centerarea",
                                        }
                                      : { "Shift+3": "imageonly", Y: "layoutmenu" },
                              ),
                          },
                      }),
                  ),
        ];
    }

    // The item line's start: Back, the number, the status and the story's name (in the toolbar,
    // its full name).
    function lineHead(s, zone, name = s.name) {
        return [
            app.level >= 1 ? control(app, "back", { zone, quiet: true }) : null,
            el("b", { class: "num" }, `#${s.n}`),
            statusMark(s.status),
            el(
                "span",
                { class: "who" },
                el("b", { class: "name ell", title: fullName(s) }, name),
                s.mode ? el("span", { class: "muted mode" }, `, ${s.mode}`) : null,
            ),
        ];
    }

    // Select [X] (Shift+Up/Down, which extend the selection, are in the List menu); Open [Enter]
    // while a large change's list is shown beside the viewer, at every window width (it folds the
    // list to its rail: the viewing level under 1400 px, the Snapshots fold at 1400 px and wider).
    const lineEnd = (s) =>
        el(
            "span",
            { class: "iright" },
            control(app, "select", {
                zone: "iline",
                attrs: { "aria-pressed": app.sel.has(s.key) ? "true" : "false" },
                children: [labelOf(app, "select"), kb("X", true)],
            }),
            app.level === 1 && app.snaps.length > SMALL && shownNow()[1] && s
                ? control(app, "openrow", { zone: "iline" })
                : null,
        );

    // Badges that never drop from the item line: they change what Accept means.
    const KEEP_BADGE = /^(resized|unstable|size changed|attempts disagree)$/;
    const NAME_MIN = 24; // the story's name is never cut shorter

    // The item line: Back Esc, #1028 [mark] changed, the name, badges, the decision, Next area (with
    // "Area 1 of 26" while zoomed above Fit), and on the right Select and Details. The size is on
    // the row and in Details, never repeated here.
    function fillLine(s) {
        // One count for Next area and "Area n of N": the diff's areas once drawn.
        const count = areas.key === s.key ? areas.count : (s.areas?.count ?? 0);
        const at = areas.key === s.key ? areas.text.replace(/ of .*/, "") : "1";
        const words = decisionWords(app, s);
        parts.line.className = `iline ${imageOnly() ? "ionly" : ""}`;
        parts.line.dataset.snap = s.key;
        fill(
            parts.line,
            lineHead(s, "iline"),
            badgesOf(app, s).map((b) => {
                const n = badgeNode(b);
                n.classList.toggle("fixed", KEEP_BADGE.test(b.text));
                return n;
            }),
            words ? el("span", { class: "keep" }, words) : null,
            count > 1
                ? [
                      vs.zoom === "fit" || !/^\d+$/.test(at)
                          ? null
                          : el("span", { class: "num keep", id: "area-at" }, `Area ${at} of ${fmt(count)}`),
                      control(app, "nextarea", { zone: "iline", quiet: true }),
                  ]
                : null,
            el("span", { class: "grow" }),
            lineEnd(s),
            review
                ? control(app, "details", {
                      zone: "iline",
                      attrs: { class: "quietbtn", "aria-expanded": String(vs.details) },
                  })
                : null,
        );
        // No room: the badges that may drop go first, then the name is cut in the middle, never
        // below 24 characters; still too wide, the line wraps to a second line rather than cut
        // more. "unstable", "resized", Back, Select, Open and Details never shrink or drop.
        const line = parts.line;
        const over = () => line.scrollWidth > line.clientWidth + 1;
        for (const b of [...line.querySelectorAll(".badge:not(.fixed)")].reverse()) {
            if (!over()) {
                break;
            }
            b.remove();
        }
        const name = line.querySelector(".name");
        for (let keep = s.name.length - 2; over() && keep >= NAME_MIN; keep -= 2) {
            name.textContent = `${s.name.slice(0, Math.ceil(keep / 2))}...${s.name.slice(s.name.length - Math.floor(keep / 2))}`;
        }
        line.classList.toggle("wrap", over());
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
            field("Component", `${s.project} > ${s.component}`),
            el("span", { class: "muted" }, "Console"),
            el("span", { class: "dcon", id: "det-console" }, "..."),
            el("span", { class: "dlink" }, control(app, "imagelink", { zone: "iline" })),
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

    // Previous [J] Left and Next [K] Right; Undo and Exclude...; Reject... and Accept on the right,
    // Accept the only filled button. With the current row in the selection the decision words say how
    // many they decide ("Accept 3"). Every word stays at every width: measured too wide, the quiet
    // Left and Right shorten to <- and ->, then the bar takes its compact size.
    function fillBar() {
        const zone = "decision";
        const step = (id, word, letter, arrow) =>
            control(app, id, {
                zone,
                attrs: { "aria-label": word },
                children: [el("span", { class: "lbl" }, word), kb(letter), kb(arrow, true)],
            });
        parts.bar.classList.remove("tight");
        fill(
            parts.bar,
            step("prev", "Previous", "J", "Left"),
            step("next", "Next", "K", "Right"),
            el("span", { class: "gap8" }),
            control(app, "undo", {
                zone,
                attrs: { "aria-label": "Undo" },
                children: [el("span", { class: "lbl" }, "Undo"), kb("U")],
            }),
            control(app, "exclude", { zone }),
            el("span", { class: "grow" }),
            el(
                "div",
                { class: "rc" },
                control(app, "reject", {
                    zone,
                    attrs: { class: "big rej" },
                    children: [ic("reject"), labelOf(app, "reject"), kb("R")],
                }),
                control(app, "accept", {
                    zone,
                    attrs: { class: "big acc" },
                    children: [ic("accept"), labelOf(app, "accept"), kb("A")],
                }),
            ),
        );
        const over = () => parts.bar.scrollWidth > parts.bar.clientWidth + 1;
        if (over()) {
            for (const [id, arrow] of [
                ["prev", "<-"],
                ["next", "->"],
            ]) {
                const k = parts.bar.querySelector(`[data-act="${id}"] kbd.quiet`);
                if (k) {
                    k.textContent = arrow;
                }
            }
        }
        // Still too narrow (a viewer under the 800 px floor): the compact size, never a second row.
        if (over()) {
            parts.bar.classList.add("tight");
        }
    }

    // The end card, in place of the image, after the last undecided snapshot (design 6.6).
    function fillCard() {
        const showing = app.endCard === true;
        const had = !parts.card.hidden;
        parts.stage.hidden = showing;
        parts.card.hidden = !showing;
        parts.card.replaceChildren(...(showing ? [app.endCardOf()] : []));
        if (showing && !had) {
            // The one control the page focuses on its own: Finish [Enter] (design 8.1.8).
            document.getElementById("endfinish")?.focus({ preventScroll: true });
        }
    }

    // The viewer's elements: made once, and put back when the viewer showed something else.
    function ensureParts() {
        const v = document.getElementById(root);
        if (parts && parts.stage.parentElement === parts.wrap && parts.wrap.parentElement === v) {
            return;
        }
        parts ??= {
            bar: el("div", { class: "decide" }),
            card: el("div", { class: "endwrap", hidden: true }),
            details: el("div", { class: "details", id: `${idp}details`, hidden: true }),
            line: el("div", { class: "iline" }),
            stage: el("div", { class: "stage", id: `${idp}stage` }),
            tools: el("div", { class: "vtb", id: `${idp}vtb`, role: "toolbar", "aria-label": "Viewer" }),
            wrap: el("div", { class: "stagewrap" }),
        };
        parts.wrap.replaceChildren(parts.stage, parts.card);
        v.replaceChildren(parts.tools, parts.line, parts.details, parts.wrap, parts.bar, ...(o.below ? [o.below] : []));
        shownKey = null;
        resized.disconnect();
        resized.observe(parts.wrap);
    }

    // Auto chooses again when the stage changes size; a viewer whose screen is hidden draws nothing.
    const resized = new ResizeObserver(() => {
        const s = current();
        const shown = parts?.wrap.isConnected && parts.wrap.getClientRects().length > 0;
        if (s && shown && vs.layout === "auto" && stackedFor(s) !== stacked) {
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
        parts.tools.className = `vtb ${imageOnly() ? "ionly" : ""}`;
        fill(parts.tools, toolbar(s));
        if (review) {
            fillLine(s);
            fillDetails(s);
            fillBar();
        } else {
            o.line(parts.line, s);
            o.bar(parts.bar, s);
        }
        render(s);
        if (review) {
            fillCard();
        }
        app.opened.add(s.key);
    }

    // ------------------------------------------------------------ actions

    // Image only is on from its press until it is pressed again, or the panes or the level change
    // under it (Back, a rail): both panes folded by hand are not Image only.
    const imageOnly = () => {
        if (ioLevel !== null && (ioLevel !== app.level || !imageOnlyPressed(shownNow(panes)))) {
            ioLevel = null;
            ioBefore = null;
        }
        return ioLevel !== null;
    };
    const redraw = () => app.draw();
    const layoutTitle = () =>
        vs.layout === "auto" ? `Auto chose ${stacked ? "over and under" : "side by side"} for this window` : "Layout";
    // A submenu opened from a Display item opens under the Display button: the item is gone with
    // its menu.
    const menuAnchor = (anchor) =>
        anchor?.closest(".menu") || !anchor ? document.getElementById(`${idp}displaybtn`) : anchor;

    const menuItem = (id, label, checked) => ({ id, label, checked, check: true });
    const setZoom = (z) => {
        vs.zoom = z;
        // Every zoom step centers on the current area (Start zoomed on the change governs only
        // the first open of a snapshot).
        zoomStep = true;
        save();
        redraw();
    };
    const layoutLabel = () =>
        vs.layout === "auto" ? `Auto (${stacked ? "over and under" : "side by side"} now)` : LAYOUTS[vs.layout];

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
        // A view's key: the view, or pressed again, Side by side. Flash is one view: from Spotlight
        // it flashes the spotlit pair, and leaving it (V, H, S) ends the flashing.
        pressView: (v) => {
            const ev = shownView();
            vs.spotFlash = v === "flash" && ev === "spotlight" && twoImages();
            vs.view = ev === v && v !== "side" ? "side" : v;
            explain = vs.view === "highlight" || vs.view === "spotlight" ? current()?.key : null;
            save();
            redraw();
        },
        toggle: (name) => {
            vs[name] = !vs[name];
            save();
            const said = {
                outline: `Outline changed areas: ${vs.outline ? "on" : "off"}.`,
                center: `Start zoomed on the change: ${vs.center ? "on" : "off"}.`,
                showBase: `Baseline ${vs.showBase ? "shown" : "hidden"}.`,
            }[name];
            if (said) {
                app.say(said);
            }
            redraw();
        },
        setZoom,
        zoomLabel: () => `Zoom: ${zoomName(vs.zoom)}`,
        cycleZoom: () => setZoom(ZOOMS[(ZOOMS.indexOf(vs.zoom) + 1) % ZOOMS.length]),
        // Z cycles; a click on Zoom (or Enter on it) opens its menu, whose digits act closed too.
        zoomMenu: (anchor) =>
            app.showMenu(
                anchor,
                ZOOMS.map((z) => ({
                    id: `zoom-${z}`,
                    label: z === "fit" ? "Fit" : z === 1 ? "Actual size" : `${z}x`,
                    checked: vs.zoom === z,
                })),
            ),
        setLayout: (k) => {
            vs.layout = k;
            save();
            redraw();
        },
        // Y: one press, the next layout (Auto, Side by side, Over and under).
        cycleLayout: () => {
            const ks = Object.keys(LAYOUTS);
            vs.layout = ks[(ks.indexOf(vs.layout) + 1) % ks.length];
            save();
            app.say(`Layout: ${layoutLabel()}.`);
            redraw();
        },
        layoutLabel,
        layoutMenu: (anchor) =>
            app.showMenu(
                menuAnchor(anchor),
                Object.keys(LAYOUTS).map((k) => ({
                    id: `layout-${k}`,
                    label: k === "auto" ? `Auto (${stacked ? "over and under" : "side by side"} now)` : LAYOUTS[k],
                    checked: vs.layout === k,
                })),
            ),
        // Display: the settings a reader sets once a session, each printing its key, which acts with
        // the menu closed.
        displayMenu: (anchor) => {
            const two = twoImages();
            app.showMenu(
                anchor,
                [
                    review
                        ? menuItem("baseline", two ? "Show baseline" : "Show baseline (none)", two && vs.showBase)
                        : [],
                    menuItem("imageonly", "Image only", imageOnly()),
                    { id: "layoutmenu", label: `Layout: ${LAYOUTS[vs.layout]}` },
                    review
                        ? [
                              menuItem("outline", "Outline changed areas", vs.outline),
                              menuItem("centerarea", "Start zoomed on the change", vs.center),
                          ]
                        : [],
                ].flat(),
            );
        },
        pressImageOnly: () => {
            const at = app.at();
            const on = imageOnly();
            // Off: exactly the panes it hid come back. On: both panes fold, whatever they were.
            const { shown, before } = on
                ? pressImageOnly([false, false], ioBefore, at)
                : { shown: [false, false], before: shownNow(panes) };
            ioBefore = before;
            ioLevel = on ? null : app.level;
            // Baselines redraws only its own screen: the page's chrome is told here too.
            document.body.classList.toggle("ionly", !on);
            applyPanes(shown, at);
            remember(app.level, app.snaps.length, shown, screen);
            app.say(on ? "Image only off: panes back as they were." : "Image only: Shift+3 brings everything back.");
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
