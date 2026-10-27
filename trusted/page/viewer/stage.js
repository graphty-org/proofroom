/*
 * The viewer's stage: a snapshot's baseline and new image in two panes, side by side, flashing,
 * with the changed pixels in red (Highlight, Blink) or with everything else dimmed (Spotlight); at
 * one zoom in both panes, scrolling together; the changed areas outlined, counted and stepped
 * through (Next change); and the diffs, worked out in a worker (diff-worker.js) and ahead of the
 * keys that move on (prefetch.js). Any page can use it: it reads nothing of the page's own state,
 * only what createStage is given.
 */

import { diffable, keptDiffs, targetsOf } from "./prefetch.js";
import { dimmed } from "/spot.js";

const FLASH_MS = 333; // one image each third of a second: about 1.5 full cycles a second
const CRISP_FROM = 4; // from this zoom on, pixels are drawn as hard squares
// A press this soon after its item's images were drawn is the tail of a press meant for the item
// before, not a decision on an image the reader saw. Measured from the press's own time
// (event.timeStamp), so a page that runs the press late does not lengthen it.
export const GUARD_MS = 250;
const SKIM_MS = 120;
// Each item's focus point, as the box [x, y, width, height] in image pixels to center on: a few
// numbers each, kept for the items of a long session.
const FOCUS_KEPT = 2000;

/**
 * An element with its attributes (an `on...` one is a listener) and its children; a null, false
 * or undefined child is left out.
 * @param {string} tag the element's name
 * @param {Record<string, any>} attrs its attributes and listeners
 * @param {...any} children its children, nested arrays flattened
 * @returns {HTMLElement} the element
 */
export function el(tag, attrs = {}, ...children) {
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

export const spinner = () => el("span", { class: "spinner", "aria-hidden": "true" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `then` once what the page holds now has been drawn: a frame's callbacks run before it is
 * drawn, so the second frame's run after the first was.
 * @param {() => void} then what to run
 * @returns {number} the first frame's request
 */
export const afterPaint = (then) => requestAnimationFrame(() => requestAnimationFrame(then));

/**
 * The promise `make` returns for `key`, kept in `map` with the least recently used dropped past
 * `limit`. A promise that fails is dropped at once, so the next use retries.
 * @param {Map<string, Promise<any>>} map the cache
 * @param {string} key what the value is for
 * @param {number} limit how many are kept
 * @param {() => Promise<any>} make makes the value
 * @returns {Promise<any>} the value
 */
function cached(map, key, limit, make) {
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
    for (const k of map.keys()) {
        if (map.size <= limit) {
            break;
        }
        map.delete(k);
    }
    return value;
}

// ---------------------------------------------------------------- the diff worker

/**
 * Counted work, for tests: `worker`, the diffs started in the worker, and `done`, those it
 * answered; `waited`, the diffs the item on the stage had to wait for, because they were not asked
 * for ahead or the worker had not answered yet (one each). The page's own thread never runs a diff.
 */
export const diffCounts = { worker: 0, done: 0, waited: 0 };

let worker = null;
let asked = 0;
const waiting = new Map();

function startWorker() {
    const w = new Worker(new URL("./diff-worker.js", import.meta.url), { type: "module" });
    w.onmessage = ({ data }) => {
        const job = waiting.get(data.id);
        waiting.delete(data.id);
        diffCounts.done++;
        if (data.error) {
            job.reject(new Error(`the changed pixels could not be worked out: ${data.error}`));
        } else {
            job.resolve(data);
        }
    };
    // The worker could not start (or died): every diff it held fails, and the next one starts it again.
    w.onerror = (e) => {
        e.preventDefault();
        for (const job of waiting.values()) {
            job.reject(new Error("the changed pixels could not be worked out"));
        }
        waiting.clear();
        worker = null;
    };
    return w;
}

// An image's RGBA pixels, at w x h from its top left (transparent past its own size).
function pixels(img, w, h) {
    const ctx = new OffscreenCanvas(w, h).getContext("2d");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
}

/**
 * The changed pixels of two loaded images, padded top-left to the larger size, worked out in the
 * worker: the mask, the mask grown by GROW pixels, the boxes around each grown region (largest
 * first), and both images' pixels.
 * @param {HTMLImageElement} a the baseline
 * @param {HTMLImageElement} b the new image
 * @param {{ threshold: number, includeAA: boolean }} options pixelmatch's settings
 * @returns {Promise<{ w: number, h: number, a: Uint8ClampedArray, b: Uint8ClampedArray, mask: Uint8ClampedArray, grown: Uint8Array, boxes: number[][] }>} the diff
 */
export async function diffImages(a, b, { threshold, includeAA }) {
    const w = Math.max(a.naturalWidth, b.naturalWidth);
    const h = Math.max(a.naturalHeight, b.naturalHeight);
    const [pa, pb] = [pixels(a, w, h), pixels(b, w, h)];
    worker ??= startWorker();
    const id = ++asked;
    diffCounts.worker++;
    const done = await new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, w, h, a: pa.buffer, b: pb.buffer, threshold, includeAA }, [pa.buffer, pb.buffer]);
    });
    return { w, h, a: done.a, b: done.b, mask: done.mask, grown: done.grown, boxes: done.boxes };
}

// ---------------------------------------------------------------- the stage

/**
 * A stage, drawn from what `host` gives it.
 * @param {object} host what the stage reads of the page
 * @param {() => { zoom: "fit" | number, scale: number, focus: boolean, showBox: boolean, baselinePane: boolean, blink: boolean, spotFlash: boolean, motion: boolean, color?: number[] }} host.settings
 *   the reader's view settings now
 * @param {(url: string, what: string) => Promise<HTMLImageElement>} host.load loads an image
 * @param {(hash: string) => string} host.imageUrl an image's address, by its hash
 * @param {(item: object) => string} host.itemName a snapshot's name
 * @param {(item: object) => boolean} host.onlyExclude whether a snapshot can only be excluded (no focus point)
 * @param {() => { items: object[], index: number }} host.pass the snapshots the keys walk, and the one on screen
 * @param {(item: object) => boolean} host.undecided whether a snapshot still needs a decision
 * @param {(item: object) => string} host.groupOf the group a snapshot is in
 * @param {() => void} host.retry draws the snapshot again, after a failed load
 * @param {(item: object) => void} host.drawn told when a snapshot's images are on the stage
 * @param {(item: object, at: number) => void} host.appeared told when they have been painted
 * @param {(text: string, count: number) => void} host.boxCount shows which changed area Next change is on, or that there is none
 * @param {(item: object, view: string) => { leftLabel?: string, rightLabel?: string, flash?: [string, string], note?: string | null }} [host.labels]
 *   the frames' labels in place of the stage's own: each frame's, the two a flashing frame takes
 *   turns with, and a note beside them
 * @param {number} [host.flashMs] how long Flash and Spotlight's flash show each image (FLASH_MS)
 * @param {number} [host.blinkMs] how long Blink shows, then hides, the overlays (FLASH_MS)
 * @returns {object} the stage's controls
 */
export function createStage(host) {
    const opt = () => host.settings();
    // The least recently used diffs are dropped past keptDiffs(), so a long session stays small.
    // Images and pictures are the browser's to keep: their addresses name their content.
    const diffs = new Map();
    const settled = new WeakSet(); // the diffs the worker has answered
    const counted = new WeakSet(); // the diffs counted in diffCounts.waited
    const dropped = new Set(); // keys prefetch no longer wants, dropped once their diff is answered
    const focusBoxes = new Map();
    let stageRender = 0; // the newest render: an older one finishing late writes nothing
    let lastStageAt = 0; // when the last render began
    let lastStageFile = null; // and for which item
    let lastShown = null; // the last item whose images were shown (never reset by a move)
    let flashTimer = null;
    let factor = 1; // CSS pixels per image pixel of the pictures on the stage
    let shownBoxes = []; // the changed areas of the item on the stage
    const view = {
        box: 0, // which changed area Next change is on
        shownFile: null, // the file whose images are on the stage: Accept waits for it
        appearedAt: 0, // when the item on screen was drawn, or its images were: Infinity until then
        key: null, // "file|zoom" of what is on the stage, to keep its scroll across view changes
    };

    // At fit, the stage refits when the window (or an iPad's orientation) changes its size.
    const refit = new ResizeObserver((entries) => {
        const stage = entries[0]?.target;
        if (stage?.isConnected && opt().zoom === "fit" && stage.querySelector(".sheet")) {
            fit(stage);
            showBox(stage, shownBoxes, false, false);
        }
    });

    function stopFlash() {
        clearInterval(flashTimer);
        flashTimer = null;
    }

    // Sizes every picture on the stage at one scale, so equal-size images line up pixel for pixel
    // in their panes. At "fit" the largest of them fits its pane both ways (never above real size,
    // one CSS pixel per CSS pixel the story was drawn at); zoomed, it is real size times the zoom
    // and the panes scroll. Each pane's sheet is as large as the largest picture, so both scroll alike.
    function fit(stage) {
        const pics = [...stage.querySelectorAll(".sheet > img, .sheet > canvas")];
        if (pics.length === 0) {
            return;
        }
        const { zoom, scale } = opt();
        const natural = (p) => [p.naturalWidth ?? p.width, p.naturalHeight ?? p.height];
        let [w, h] = [1, 1];
        for (const p of pics) {
            const [x, y] = natural(p);
            [w, h] = [Math.max(w, x), Math.max(h, y)];
        }
        const frame = stage.querySelector(".frame");
        factor = zoom === "fit" ? Math.min(1 / scale, frame.clientWidth / w, frame.clientHeight / h) : zoom / scale;
        for (const p of pics) {
            const [x, y] = natural(p);
            p.style.width = `${x * factor}px`;
            p.style.height = `${y * factor}px`;
            p.classList.toggle("crisp", factor * scale >= CRISP_FROM);
        }
        for (const sheet of stage.querySelectorAll(".sheet")) {
            sheet.style.width = `${w * factor}px`;
            sheet.style.height = `${h * factor}px`;
        }
    }

    // A frame and its label; with a note (host.labels), the label's text is its own span beside it.
    const pane = (text, content, empty = false, note = null) =>
        el(
            "figure",
            {},
            el(
                "div",
                { class: "label" },
                note === null ? text : [el("span", { class: "lt" }, text), el("span", { class: "note" }, note)],
            ),
            el("div", { class: empty ? "frame empty" : "frame" }, content),
        );
    const paneWait = (what) => el("p", { class: "wait" }, spinner(), `Loading ${what}...`);
    const paneError = (message) =>
        el(
            "p",
            { class: "failed error" },
            message || "the images could not be loaded",
            " ",
            el("button", { type: "button", onclick: () => host.retry() }, "Retry"),
        );

    // Two panes: the baseline on the left and the new image (or the view's picture) on the right,
    // both drawn at once with what they are waiting for, so nothing moves when the images arrive. A
    // missing image leaves its pane empty, the same size, so the other one never moves. With the
    // Baseline pane off (P) only one pane is drawn, as wide as the two: the right one, or the
    // baseline when there is no capture (a removed story).
    // Which single pane to draw when the baseline is hidden: the capture (or a failed item's error),
    // else the baseline of a removed story. Null draws both.
    function onlyPane(item) {
        if (opt().baselinePane) {
            return null;
        }
        return item.capture || item.status === "failed" ? "right" : "left";
    }

    async function renderStage(stage, item, viewName, keep) {
        const seq = ++stageRender;
        const only = onlyPane(item);
        const panes = (l, r) => ({ right: [r], left: [l] })[only] ?? [l, r];
        const labels = stageLabels(item, viewName);
        const { left, right } = waitingPanes(item, labels);
        if (!keep) {
            stage.replaceChildren(...panes(left, right));
        }
        if (await skimmed(item, seq)) {
            return;
        }
        const s = { item, view: viewName, keep, seq, stage, only, panes, labels, left, right };
        let drawn;
        try {
            drawn = viewName === "side" ? await drawSide(s) : await drawCompared(s);
        } catch (err) {
            stageFailed(s, err);
            return;
        }
        if (!drawn) {
            return;
        }
        shown(stage, item);
        const frames = [...stage.querySelectorAll(".frame")];
        scrollTogether(frames);
        fit(stage);
        refit.disconnect();
        refit.observe(stage);
        view.key = `${item.file}|${opt().zoom}`;
        if (keep) {
            for (const f of frames) {
                [f.scrollLeft, f.scrollTop] = keep;
            }
        }
        await showChangedAreas(s, drawn.diff);
        if (seq === stageRender) {
            prefetch(item);
        }
    }

    // Each pane's label for this view, on its wait as on its pictures: a view whose pictures are
    // still being made never shows another view's label first.
    function stageLabels(item, viewName) {
        const { spotFlash, motion } = opt();
        const baseName = item.from ? `Baseline of ${item.from}` : "Baseline";
        const marked = viewName === "highlight";
        const flashing = viewName === "flash" || (viewName === "spotlight" && spotFlash);
        const leftLabel = marked ? `${baseName}, changed pixels in red` : baseName;
        let rightLabel = "New";
        if (flashing) {
            rightLabel = `${viewName === "flash" ? "Flash" : "Spotlight"}: baseline${motion ? "" : " (stopped: press F)"}`;
        } else if (marked) {
            rightLabel = "New, changed pixels in red";
        } else if (viewName === "spotlight") {
            rightLabel = "Spotlight: the new image, dimmed except around each change";
        }
        const own = { marked, flashing, leftLabel, rightLabel, flash: null, note: null };
        return host.labels ? { ...own, ...host.labels(item, viewName) } : own;
    }

    // The two panes as they wait for their pictures. A failed capture's artifact holds no copy of
    // its baseline, so none is fetched.
    function waitingPanes(item, { leftLabel, rightLabel, note }) {
        let left = pane("No baseline", null, true);
        if (item.status === "failed") {
            left = pane("Baseline not shown: the capture failed", null, true);
        } else if (item.baseline) {
            left = pane(leftLabel, paneWait("baseline"), false, note);
        }
        const right = item.capture ? pane(rightLabel, paneWait("new image"), false, note) : noCapturePane(item);
        return { left, right };
    }

    // The right pane of an item with no capture: a failed one shows why.
    function noCapturePane(item) {
        if (item.status !== "failed") {
            return pane("No capture", null, true);
        }
        return pane(
            "No capture: it failed",
            item.console.length > 0
                ? el("pre", { class: "console" }, `${item.reason ?? ""}\n\n${item.console.join("\n")}`)
                : el("p", { class: "failed" }, item.reason ?? "capture failed"),
            true,
        );
    }

    // Skimming (K held): the item before was left before its images even showed, so this one waits
    // SKIM_MS before fetching; passed in that time, it fetches nothing, and the item stopped on is
    // not queued behind every item skipped. True when the stage moved on meanwhile.
    async function skimmed(item, seq) {
        const now = performance.now();
        const skimming = now - lastStageAt < SKIM_MS && lastShown !== lastStageFile;
        lastStageAt = now;
        lastStageFile = item.file;
        if (!skimming) {
            return false;
        }
        await sleep(SKIM_MS);
        return seq !== stageRender;
    }

    // One of the item's two images, loaded, with its alt text.
    async function stageImage(item, kind) {
        const what = kind === "capture" ? "new image" : "baseline";
        const img = await host.load(host.imageUrl(item[kind]), `${what} of ${item.file}`);
        img.alt = `${what} of ${host.itemName(item)}`;
        return img;
    }

    // Side by side: each image as soon as it arrives; the changed areas fill in afterwards. Null
    // when the stage moved on meanwhile.
    async function drawSide(s) {
        const { item, keep, seq, stage, only, panes, left, right } = s;
        const failed = item.status === "failed";
        await Promise.all([
            item.baseline && !failed && only !== "right" && fillPane(s, "baseline", left),
            item.capture && fillPane(s, "capture", right),
        ]);
        if (seq !== stageRender) {
            return null;
        }
        if (keep) {
            stage.replaceChildren(...panes(left, right));
        }
        return { diff: null };
    }

    // Puts one image in its pane, or the error that kept it out.
    async function fillPane({ item, keep, seq, stage }, kind, figure) {
        const frame = figure.querySelector(".frame");
        try {
            const img = await stageImage(item, kind);
            // With Focus on, an image is put in its pane only once its focus point is known,
            // so it appears framed, never at the top left and then jumping. shown() works it
            // out for the next item ahead, so after a decision this rarely waits.
            const at = opt().focus && !keep ? await focusBox(item).catch(() => null) : null;
            if (seq === stageRender) {
                frame.replaceChildren(el("div", { class: "sheet" }, img));
                fit(stage);
                if (at) {
                    center(stage, at);
                }
            }
        } catch (err) {
            if (seq === stageRender) {
                frame.replaceChildren(paneError(err.message));
            }
            throw err;
        }
    }

    // The views that compare the two images (highlight, flash, spotlight): both panes drawn at once
    // from the item's diff. Null when the stage moved on meanwhile.
    async function drawCompared({ item, view: viewName, seq, stage, panes, labels }) {
        const { marked, flashing, leftLabel, rightLabel, note } = labels;
        const diff = await stageDiff(item);
        const leftPics = [await stageImage(item, "baseline"), ...(marked ? [overlay(diff)] : [])];
        let rightPics;
        if (flashing) {
            // The two images one after the other in the same place: themselves, or both spotlighted.
            rightPics =
                viewName === "flash"
                    ? [await stageImage(item, "baseline"), await stageImage(item, "capture")]
                    : [spotlight(diff, diff.a), spotlight(diff, diff.b)];
        } else if (marked) {
            rightPics = [await stageImage(item, "capture"), overlay(diff)];
        } else {
            rightPics = [spotlight(diff)];
        }
        if (seq !== stageRender) {
            return null;
        }
        const l = pane(leftLabel, el("div", { class: "sheet" }, leftPics), false, note);
        const r = pane(rightLabel, el("div", { class: "sheet" }, rightPics), false, note);
        stage.replaceChildren(...panes(l, r));
        if (flashing) {
            startFlash(r, rightPics, viewName, labels.flash);
        }
        if (marked && opt().blink && opt().motion) {
            startBlink(stage);
        }
        return { diff };
    }

    // Flash and flashing Spotlight: the two pictures take turns in the right pane.
    function startFlash(r, [base, next], viewName, names = null) {
        next.style.visibility = "hidden";
        r.classList.add("flashing");
        if (!opt().motion) {
            return;
        }
        const name = viewName === "flash" ? "Flash" : "Spotlight";
        const [onBase, onNew] = names ?? [`${name}: baseline`, `${name}: new`];
        const tag = r.querySelector(".label .lt") ?? r.querySelector(".label");
        let showingNew = false;
        flashTimer = setInterval(() => {
            showingNew = !showingNew;
            base.style.visibility = showingNew ? "hidden" : "visible";
            next.style.visibility = showingNew ? "visible" : "hidden";
            tag.textContent = showingNew ? onNew : onBase;
        }, host.flashMs ?? FLASH_MS);
    }

    // Both panes' overlays on and off together.
    function startBlink(stage) {
        const marks = [...stage.querySelectorAll(".diffmark")];
        let on = true;
        flashTimer = setInterval(() => {
            on = !on;
            for (const m of marks) {
                m.style.visibility = on ? "visible" : "hidden";
            }
        }, host.blinkMs ?? FLASH_MS);
    }

    // An image or the diff failed to load: the compared views show the error in both panes; side
    // by side already shows it in its pane, and a kept stage gets its panes back.
    function stageFailed({ view: viewName, keep, seq, stage, panes, labels, left, right }, err) {
        if (seq !== stageRender) {
            return;
        }
        if (viewName !== "side") {
            stage.replaceChildren(
                ...panes(
                    pane(labels.leftLabel, paneError(err.message)),
                    pane(labels.rightLabel, paneError(err.message)),
                ),
            );
        } else if (keep) {
            stage.replaceChildren(...panes(left, right));
        }
    }

    // Zoomed, scrolling one pane scrolls the other to the same place.
    function scrollTogether(frames) {
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
    }

    // With both images, outlines the changed areas and counts them; with one, frames its focus
    // point when Focus is on.
    async function showChangedAreas({ item, keep, seq, stage }, drawnDiff) {
        if (!(item.baseline && item.capture)) {
            shownBoxes = [];
            if (opt().focus && !keep) {
                const at = await focusBox(item).catch(() => null);
                if (at && seq === stageRender) {
                    center(stage, at);
                }
            }
            return;
        }
        let diff = drawnDiff;
        try {
            diff ??= await stageDiff(item);
        } catch {
            return;
        }
        if (seq !== stageRender) {
            return;
        }
        shownBoxes = diff.boxes;
        host.boxCount(
            diff.boxes.length === 0
                ? "No changed area at this threshold"
                : `${Math.min(view.box, diff.boxes.length - 1) + 1} of ${diff.boxes.length}`,
            diff.boxes.length,
        );
        showBox(stage, diff.boxes, false, !keep);
    }

    // The item's images are in the stage: Accept applies once they have been drawn, the next two
    // items load in the background, and a quarter second after the drawing the stage says it is
    // ready (a decision before then is taken for the tail of a press meant for the item before).
    function shown(stage, item) {
        const first = view.shownFile !== item.file;
        view.shownFile = item.file;
        lastShown = item.file;
        host.drawn(item);
        if (first) {
            view.appearedAt = Infinity;
            // A stage kept across snapshots (the new page's) is ready again only for this one.
            delete stage.dataset.ready;
            const { items, index } = host.pass();
            const after = items.slice(index + 1, index + 3);
            for (const next of after) {
                for (const kind of ["baseline", "capture"]) {
                    if (next[kind]) {
                        host.load(host.imageUrl(next[kind]), next.file).catch(() => {});
                    }
                }
            }
            // The next item's focus point, so after Accept it opens already framed.
            if (opt().focus && after[0]) {
                focusBox(after[0], true).catch(() => {});
            }
        }
        afterPaint(() => {
            if (!stage.isConnected || view.shownFile !== item.file) {
                return;
            }
            if (view.appearedAt === Infinity) {
                view.appearedAt = performance.now();
                host.appeared(item, view.appearedAt);
            }
            setTimeout(
                () => {
                    if (stage.isConnected && view.shownFile === item.file) {
                        stage.dataset.ready = item.file;
                    }
                },
                Math.max(0, GUARD_MS - (performance.now() - view.appearedAt)),
            );
        });
    }

    // Replaces a sheet's outline of the changed area (sheet pixels), or removes it when outlines
    // are off.
    function markBox(sheet, [left, top, right, bottom]) {
        sheet.querySelector(".boxmark")?.remove();
        if (opt().showBox) {
            const mark = el("div", { class: "boxmark" });
            Object.assign(mark.style, {
                left: `${left}px`,
                top: `${top}px`,
                width: `${right - left}px`,
                height: `${bottom - top}px`,
            });
            sheet.append(mark);
        }
    }

    // Outlines the current changed area in every pane, and scrolls it into view. A pane opens at
    // the top left of its image (`reset`); on opening (`jump` false) it scrolls only when the area
    // is smaller than the pane and out of sight. Next change (`jump` true) always brings the area
    // into view, its top left first when it is larger than the pane.
    function showBox(stage, boxes, jump, reset = true) {
        if (boxes.length === 0) {
            return;
        }
        view.box = Math.min(view.box, boxes.length - 1);
        const [x, y, w, h] = boxes[view.box];
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
            markBox(sheet, [left, top, right, bottom]);
            if (!jump && !reset) {
                continue;
            }
            if (opt().focus) {
                centerFrame(frame, sheet, [x, y, w, h]);
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
            const reveal = (start, end, scroll, size) => {
                if (end - start > size || start < scroll) {
                    return Math.max(0, start - PAD);
                }
                return end > scroll + size ? end - size + PAD : scroll;
            };
            const [ox, oy] = [sheet.offsetLeft, sheet.offsetTop];
            frame.scrollLeft = reveal(ox + left, ox + right, frame.scrollLeft, frame.clientWidth);
            frame.scrollTop = reveal(oy + top, oy + bottom, frame.scrollTop, frame.clientHeight);
        }
    }

    // Scrolls a pane so the middle of a box (image pixels) is in the middle of the pane, as near as
    // the image's edges allow. At Fit nothing scrolls.
    function centerFrame(frame, sheet, [x, y, w, h]) {
        frame.scrollLeft = sheet.offsetLeft + (x + w / 2) * factor - frame.clientWidth / 2;
        frame.scrollTop = sheet.offsetTop + (y + h / 2) * factor - frame.clientHeight / 2;
    }

    function center(stage, box) {
        for (const frame of stage.querySelectorAll(".frame")) {
            const sheet = frame.querySelector(".sheet");
            if (sheet) {
                centerFrame(frame, sheet, box);
            }
        }
    }

    // A diff and a focus point depend only on the two images and the diff's settings.
    const pairKey = (item) => `${item.baseline}/${item.capture}/${item.threshold}/${item.includeAA}`;

    // Where the reviewer should look first: the largest changed area of a changed item, or the
    // content of an item with one image (new, no baseline yet, removed). None for a failed or
    // unstable item.
    async function focusBox(item, ahead = false) {
        if (host.onlyExclude(item)) {
            return null;
        }
        const key = pairKey(item);
        if (!focusBoxes.has(key)) {
            let box;
            if (item.baseline && item.capture) {
                box = (await diffOf(item, !ahead)).boxes[0] ?? null;
            } else {
                const kind = item.capture ? "capture" : "baseline";
                box = contentBox(await host.load(host.imageUrl(item[kind]), `${kind} of ${item.file}`));
            }
            focusBoxes.set(key, box);
            if (focusBoxes.size > FOCUS_KEPT) {
                focusBoxes.delete(focusBoxes.keys().next().value);
            }
        }
        return focusBoxes.get(key);
    }

    // The box around every pixel that differs from the image's top-left pixel (the story's
    // background), or the whole image when nothing does.
    function contentBox(img) {
        const [w, h] = [img.naturalWidth, img.naturalHeight];
        const px = pixels(img, w, h);
        const TOLERANCE = 16; // per channel: compression noise and anti-aliased edges of the background
        let [x0, y0, x1, y1] = [w, h, -1, -1];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                for (let c = 0; c < 4; c++) {
                    if (Math.abs(px[i + c] - px[c]) > TOLERANCE) {
                        x0 = Math.min(x0, x);
                        x1 = Math.max(x1, x);
                        y0 = Math.min(y0, y);
                        y1 = Math.max(y1, y);
                        break;
                    }
                }
            }
        }
        return x1 < 0 ? [0, 0, w, h] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
    }

    // Next change: the next changed area of the item on the stage, outlined and in view. Says what
    // stopped it, or null.
    async function nextBox(stage, item) {
        if (!item?.baseline || !item?.capture) {
            return "Next change needs two images.";
        }
        const { boxes } = await stageDiff(item);
        if (boxes.length === 0) {
            return "No changed area at this threshold.";
        }
        view.box = (view.box + 1) % boxes.length;
        host.boxCount(`${view.box + 1} of ${boxes.length}`, boxes.length);
        showBox(stage, boxes, true);
        return null;
    }

    // ------------------------------------------------------------ the changed pixels

    // The changed pixels of an item, padded top-left to the larger size, grown by GROW pixels, and
    // the boxes around each separate grown region. Computed once per pair of images, in the worker;
    // a diff still being worked out is shared, never asked for twice. `onScreen`: the item on the
    // stage needs it now, so waiting for it is counted.
    function diffOf(item, onScreen = false) {
        const key = pairKey(item);
        dropped.delete(key); // wanted again
        const had = diffs.get(key);
        // Diffs prefetch dropped while the worker still had them do not count against the limit.
        const value = cached(diffs, key, keptDiffs() + dropped.size, async () => {
            const [a, b] = await Promise.all([
                host.load(host.imageUrl(item.baseline), `baseline of ${item.file}`),
                host.load(host.imageUrl(item.capture), `capture of ${item.file}`),
            ]);
            return diffImages(a, b, item);
        });
        if (value !== had) {
            value.then(
                () => {
                    settled.add(value);
                    if (dropped.delete(key) && diffs.get(key) === value) {
                        diffs.delete(key);
                    }
                },
                () => dropped.delete(key),
            );
        }
        if (onScreen && !settled.has(value) && !counted.has(value)) {
            counted.add(value);
            diffCounts.waited++;
        }
        return value;
    }

    // The diff the stage draws now.
    const stageDiff = (item) => diffOf(item, true);

    // The diffs of the snapshots the keys can go to next, worked out now: the one on screen and
    // they are what is kept, so moving on draws without waiting for a diff. One the worker is still
    // working out is kept until it is answered, so going back to it does not ask for it again.
    function prefetch(item) {
        const { items, index } = host.pass();
        const targets = targetsOf(items, index, host.undecided, host.groupOf);
        const wanted = (diffable(item) ? [item, ...targets] : targets).slice(0, keptDiffs());
        const keys = new Set(wanted.map(pairKey));
        for (const [k, value] of [...diffs]) {
            if (keys.has(k)) {
                continue;
            }
            if (settled.has(value)) {
                diffs.delete(k);
            } else {
                dropped.add(k);
            }
        }
        for (const i of wanted) {
            diffOf(i).catch(() => {});
        }
    }

    // The changed pixels alone, in solid red (or the page's Highlight color), transparent
    // everywhere else: laid over an image in the same grid cell, so it lines up with the image at
    // every zoom.
    function overlay(diff) {
        const canvas = el("canvas", { width: String(diff.w), height: String(diff.h), class: "diffmark" });
        const ctx = canvas.getContext("2d");
        const out = ctx.createImageData(diff.w, diff.h);
        const [r, g, b] = opt().color ?? [255, 0, 0];
        for (let i = 0; i < diff.w * diff.h; i++) {
            if (diff.mask[i * 4 + 3] !== 0) {
                out.data[i * 4] = r;
                out.data[i * 4 + 1] = g;
                out.data[i * 4 + 2] = b;
                out.data[i * 4 + 3] = 255;
            }
        }
        ctx.putImageData(out, 0, 0);
        return canvas;
    }

    // An image (the new one unless given) with everything dimmed except the changed pixels grown
    // by GROW pixels.
    function spotlight(diff, px = diff.b) {
        const canvas = el("canvas", { width: String(diff.w), height: String(diff.h) });
        canvas.getContext("2d").putImageData(new ImageData(dimmed(px, diff.grown), diff.w, diff.h), 0, 0);
        return canvas;
    }

    return Object.assign(view, {
        render: renderStage,
        stop: stopFlash,
        nextBox,
        diffOf,
        spotlight,
    });
}
