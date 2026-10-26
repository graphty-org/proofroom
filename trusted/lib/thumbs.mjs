/**
 * The list's pictures: a capture scaled down for a tile, and a changed pair's spotlit and zoomed
 * pictures, all made by one job per pair from one decode. Scaling one 2400 x 1800 capture takes about
 * 90 ms of CPU, so it runs in a few child processes, never on the server's own thread, where a
 * grid of 36 tiles held every other request for seconds. Processes, not worker threads: threads
 * share the server's memory, which grew past 500 MB while scaling, and every git the server then
 * started took 20 ms instead of 3 (the fork copies the parent's page tables). The same file is the
 * child, started with the FLAG argument.
 */

import { fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

import { cropOf, dimmed, grow, regions, ROW, rowCrop } from "../page/spot.js";
import pixelmatch from "../vendor/pixelmatch.mjs";

// A grid tile is about 190 CSS pixels wide: 400 image pixels keep it sharp on a 2x screen, at
// about a thirtieth of a 2400 x 1800 capture's memory once decoded.
const THUMB_WIDTH = 400;

/**
 * A PNG scaled down to `width` pixels across (never up), each output pixel the average of the
 * source pixels under it. For display in the grid only: comparisons use the full images.
 * @param {Buffer} bytes the PNG
 * @param {number} width the widest the result may be
 * @returns {Buffer} the smaller PNG
 */
export function thumbnail(bytes, width = THUMB_WIDTH) {
    return plainOf(PNG.sync.read(bytes), width);
}

// A decoded image whole, at most `width` pixels across.
const plainOf = (src, width = THUMB_WIDTH) =>
    PNG.sync.write(shrink(src, [0, 0, src.width, src.height], Math.min(width, src.width)));

/**
 * The part `[x, y, width, height]` (fractions allowed) of decoded RGBA pixels, scaled to `w` pixels
 * across with its shape kept (or `height` pixels high), each output pixel the average of the source
 * pixels under it.
 * @param {{ width: number, height: number, data: Uint8Array }} src the pixels
 * @param {number[]} rect the part to show
 * @param {number} w the result's width
 * @param {number} [height] the result's height
 * @returns {PNG} the result
 */
function shrink(src, [rx, ry, rw, rh], w, height) {
    const h = height ?? Math.max(1, Math.round((rh * w) / rw));
    const out = new PNG({ width: w, height: h });
    // The source pixels [from, to) under output pixel i of n, along one side.
    const span = (i, n, start, length) => {
        const from = Math.floor(start + (i * length) / n);
        return [from, Math.max(Math.floor(start + ((i + 1) * length) / n), from + 1)];
    };
    for (let y = 0; y < h; y++) {
        const ys = span(y, h, ry, rh);
        for (let x = 0; x < w; x++) {
            average(src, span(x, w, rx, rw), ys, out.data, (y * w + x) * 4);
        }
    }
    return out;
}

/**
 * Writes at `o` of `out` the average RGBA of the source pixels [x0, x1) x [y0, y1).
 * @param {{ width: number, data: Uint8Array }} src the pixels
 * @param {number[]} xs [x0, x1]
 * @param {number[]} ys [y0, y1]
 * @param {Uint8Array} out where to write
 * @param {number} o the index of the output pixel's red
 */
function average(src, [x0, x1], [y0, y1], out, o) {
    // Four locals, not an array: this loop reads every source pixel and is the job's largest cost.
    const { width, data } = src;
    let [r, g, b, a] = [0, 0, 0, 0];
    for (let sy = y0; sy < y1; sy++) {
        const end = (sy * width + x1) * 4;
        for (let i = (sy * width + x0) * 4; i < end; i += 4) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            a += data[i + 3];
        }
    }
    const n = (y1 - y0) * (x1 - x0);
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
}

/**
 * What a changed pair's job makes, the first one naming the job: Spotlight all alone, Zoom to
 * changes alone and both (today's page), the row's zoomed pictures plain and spotlit, and the
 * capture's plain thumbnail. A snapshot with one image (new, no baseline yet, removed, moved) has
 * no spotlight and makes only `plain`.
 */
export const PAIR_KINDS = ["spot", "zoom", "both", "row-plain", "row-spot", "plain"];

/** The kinds the picture route answers: PAIR_KINDS, and `auto`, which autoKind resolves. */
export const PICTURE_KINDS = [...PAIR_KINDS, "auto"];

/**
 * Zoom Auto: a row is zoomed when its crop shows the change at least twice as large as the
 * unzoomed picture would.
 * @param {{ zoom: number, areas: number }} facts what the pair's job found
 * @returns {"row-spot" | "spot"} the kind the row shows
 */
export const autoKind = (facts) => (facts.areas > 0 && facts.zoom >= 2 ? "row-spot" : "spot");

/**
 * One job's pictures, as the page draws them (spotThumb in page/review.js). For a pair: decoded
 * once, both padded top-left to the larger size as the page pads them, compared, the changed
 * pixels grown by GROW, and every kind of PAIR_KINDS made from that, with what the row needs to
 * know about its areas.
 * @param {{ image: Uint8Array } | { baseline: Uint8Array, capture: Uint8Array, threshold: number,
 *     includeAA: boolean }} job one image, or a pair with pixelmatch's options as the item has them
 * @returns {{ images: Record<string, Buffer>, facts?: { crop: number[], zoom: number, areas: number } }}
 *     a PNG per kind; for a pair, the row crop, its zoom against the unzoomed picture, and how many
 *     separate areas changed
 */
export function pictures(job) {
    if (!("baseline" in job)) {
        return { images: { plain: thumbnail(Buffer.from(job.image)) } };
    }
    const [a, b] = [PNG.sync.read(Buffer.from(job.baseline)), PNG.sync.read(Buffer.from(job.capture))];
    const width = Math.max(a.width, b.width);
    const height = Math.max(a.height, b.height);
    const pad = (img) => {
        if (img.width === width && img.height === height) {
            return img.data;
        }
        const out = Buffer.alloc(width * height * 4);
        for (let y = 0; y < img.height; y++) {
            img.data.copy(out, y * width * 4, y * img.width * 4, (y + 1) * img.width * 4);
        }
        return out;
    };
    const [pa, pb] = [pad(a), pad(b)];
    const mask = Buffer.alloc(width * height * 4);
    pixelmatch(pa, pb, mask, width, height, { threshold: job.threshold, includeAA: job.includeAA, diffMask: true });
    const grown = grow(mask, width, height);
    const boxes = regions(grown, width, height);
    const near = cropOf(boxes, width, height);
    const { crop, zoom } = rowCrop(boxes, width, height);
    const whole = [0, 0, width, height];
    const plain = { width, height, data: pb };
    const lit = { width, height, data: dimmed(pb, grown) };
    const tile = (src, rect, h) => PNG.sync.write(shrink(src, rect, THUMB_WIDTH, h));
    return {
        images: {
            spot: tile(lit, whole),
            zoom: tile(plain, near),
            both: tile(lit, near),
            "row-plain": tile(plain, crop, ROW[1]),
            "row-spot": tile(lit, crop, ROW[1]),
            // The capture's own thumbnail, unpadded: the same file a thumbnail of it alone would be.
            plain: plainOf(b),
        },
        facts: { crop, zoom, areas: boxes.length },
    };
}

const FLAG = "--visual-review-thumbnails";
if (process.argv[2] === FLAG) {
    // A server that ended while this worked has no one to answer: end quietly, not with EPIPE.
    const gone = (err) => err && process.exit(0);
    process.on("message", (/** @type {any} */ job) => {
        try {
            process.send({ made: pictures(job) }, gone);
        } catch (err) {
            process.send({ error: err.message }, gone);
        }
    });
}

/**
 * @typedef {{ images: Record<string, Buffer>, facts?: { crop: number[], zoom: number, areas: number } }} Made
 * @typedef {{ run: (load: () => Promise<object>, when?: "now" | "ahead", tag?: unknown) => Promise<Made>,
 *     raise: (match: (tag: unknown) => boolean) => void }} Pool
 */

/**
 * A queue of picture jobs, at most `size` running at once. "now" jobs (a picture on screen) go
 * ahead of every job made in advance, the newest first; jobs made in advance run in the order they
 * were queued, except that `raise` moves those of an opened change ahead of the rest. A job's input
 * is read (`load`) only when it starts, so a long queue holds no images in memory.
 * @param {(job: object) => Promise<Made>} runJob runs one job's input: in a child process, or in a
 *     test, a fake that records the order jobs start in
 * @param {number} size how many run at once
 * @returns {Pool} `run(load, when, tag)`, settling with what the job made, or rejecting with what
 *     `load` or the job threw; `raise(match)`, the queued jobs whose tag matches first, in order
 */
export function createPool(runJob, size) {
    const now = [];
    const ahead = [];
    let busy = 0;
    const pump = () => {
        while (busy < size && now.length + ahead.length > 0) {
            const task = now.shift() ?? ahead.shift();
            busy++;
            task.load()
                .then(runJob)
                .then(task.resolve, task.reject)
                .finally(() => {
                    busy--;
                    pump();
                });
        }
    };
    return {
        run: (load, when = "ahead", tag = null) =>
            new Promise((resolve, reject) => {
                const task = { load, resolve, reject, tag };
                if (when === "now") {
                    now.unshift(task);
                } else {
                    ahead.push(task);
                }
                pump();
            }),
        raise: (match) => {
            const up = ahead.filter((t) => match(t.tag));
            if (up.length > 0) {
                ahead.splice(0, ahead.length, ...up, ...ahead.filter((t) => !match(t.tag)));
            }
        },
    };
}

// Idle child processes, kept for the next job. Buffers cross as buffers ("advanced"), not as JSON.
// Idle children never keep the server's process alive, and they end with it.
const idle = [];
const spawn = () => {
    const child = fork(fileURLToPath(import.meta.url), [FLAG], { serialization: "advanced" });
    child.unref();
    child.channel?.unref();
    // One that dies while idle is dropped; a send to it would throw.
    child.on("error", () => {});
    child.on("exit", () => idle.includes(child) && idle.splice(idle.indexOf(child), 1));
    return child;
};

/**
 * Runs one job in a child process. A child that dies (out of memory, say) fails its job; the next
 * job starts another.
 * @param {object} job what `pictures` takes
 * @returns {Promise<Made>} what it made
 */
const inChild = (job) =>
    new Promise((resolve, reject) => {
        const w = idle.pop() ?? spawn();
        const died = (code) => {
            w.removeAllListeners("message");
            reject(new Error(`the picture process stopped (${code})`));
        };
        w.once("exit", died);
        w.once("message", ({ made, error }) => {
            w.removeListener("exit", died);
            w.channel?.unref();
            idle.push(w);
            if (error) {
                reject(new Error(error));
                return;
            }
            const images = Object.fromEntries(Object.entries(made.images).map(([k, v]) => [k, Buffer.from(v)]));
            resolve({ images, facts: made.facts });
        });
        // Busy, a child keeps the server's process alive until it answers.
        w.channel?.ref();
        w.send(job);
    });

/** The server's pool: half the cores, at most four, so the rest stay free for the server, git and the downloads. */
export const pool = createPool(inChild, Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))));
