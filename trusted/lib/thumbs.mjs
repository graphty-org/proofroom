/**
 * Grid thumbnails: a capture scaled down for a tile. Scaling one 2400 x 1800 capture takes about
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

import { cropOf, dimmed, grow, regions } from "../page/spot.js";
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
    const src = PNG.sync.read(bytes);
    const w = Math.min(width, src.width);
    return PNG.sync.write(shrink(src, [0, 0, src.width, src.height], w));
}

/**
 * The part `[x, y, width, height]` (fractions allowed) of decoded RGBA pixels, scaled to `w` pixels
 * across with its shape kept, each output pixel the average of the source pixels under it.
 * @param {{ width: number, height: number, data: Uint8Array }} src the pixels
 * @param {number[]} rect the part to show
 * @param {number} w the result's width
 * @returns {PNG} the result
 */
function shrink(src, [rx, ry, rw, rh], w) {
    const h = Math.max(1, Math.round((rh * w) / rw));
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
    const sum = [0, 0, 0, 0];
    for (let sy = y0; sy < y1; sy++) {
        for (let i = (sy * src.width + x0) * 4; i < (sy * src.width + x1) * 4; i += 4) {
            sum[0] += src.data[i];
            sum[1] += src.data[i + 1];
            sum[2] += src.data[i + 2];
            sum[3] += src.data[i + 3];
        }
    }
    const n = (y1 - y0) * (x1 - x0);
    for (let c = 0; c < 4; c++) {
        out[o + c] = Math.round(sum[c] / n);
    }
}

/** The grid's spotlit and zoomed tiles: Spotlight all alone, Zoom to changes alone, and both. */
export const SPOT_KINDS = ["spot", "zoom", "both"];

/**
 * A changed item's grid tiles, as the page draws them (spotThumb in page/review.js): the capture
 * with everything dimmed but its changed pixels (grown by GROW), and/or cropped toward them. Both
 * images are padded top-left to the larger size, as the page pads them.
 * @param {Buffer} baseline PNG bytes
 * @param {Buffer} capture PNG bytes
 * @param {{ threshold: number, includeAA: boolean }} options pixelmatch's, as the item has them
 * @returns {Record<string, Buffer>} a PNG 400 pixels wide per kind of SPOT_KINDS
 */
function spotTiles(baseline, capture, { threshold, includeAA }) {
    const [a, b] = [PNG.sync.read(baseline), PNG.sync.read(capture)];
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
    pixelmatch(pa, pb, mask, width, height, { threshold, includeAA, diffMask: true });
    const grown = grow(mask, width, height);
    const near = cropOf(regions(grown, width, height), width, height);
    const whole = [0, 0, width, height];
    const plain = { width, height, data: pb };
    const lit = { width, height, data: dimmed(pb, grown) };
    const tile = (src, rect) => PNG.sync.write(shrink(src, rect, THUMB_WIDTH));
    return { spot: tile(lit, whole), zoom: tile(plain, near), both: tile(lit, near) };
}

const FLAG = "--visual-review-thumbnails";
if (process.argv[2] === FLAG) {
    // A server that ended while this worked has no one to answer: end quietly, not with EPIPE.
    const gone = (err) => err && process.exit(0);
    // A PNG to scale, or a pair to make the spotlit tiles of.
    process.on("message", (/** @type {any} */ job) => {
        try {
            const out =
                job instanceof Uint8Array
                    ? { png: thumbnail(Buffer.from(job)) }
                    : spotTiles(Buffer.from(job.baseline), Buffer.from(job.capture), job);
            process.send({ made: out }, gone);
        } catch (err) {
            process.send({ error: err.message }, gone);
        }
    });
}

// Half the cores, at most four: the rest stay free for the server, git and the downloads.
const SIZE = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
const idle = [];
let made = 0;
/**
 * @typedef {{ load: () => Promise<unknown>, resolve: (made: Record<string, Buffer>) => void,
 *     reject: (err: Error) => void }} Task
 */
/** @type {Task[]} */
const queue = [];
// Made in advance after every other: the spotlit tiles wait for the plain thumbnails.
/** @type {Task[]} */
const last = [];

function pump() {
    while (queue.length + last.length > 0 && (idle.length > 0 || made < SIZE)) {
        let worker = idle.pop();
        if (!worker) {
            // Buffers cross as buffers ("advanced"), not as JSON. Idle children never keep the
            // server's process alive, and they end with it.
            worker = fork(fileURLToPath(import.meta.url), [FLAG], { serialization: "advanced" });
            worker.unref();
            worker.channel?.unref();
            made++;
            // One that dies while idle is dropped; a send to it would throw.
            const child = worker;
            child.on("error", () => {});
            child.on("exit", () => {
                if (idle.includes(child)) {
                    idle.splice(idle.indexOf(child), 1);
                    made--;
                }
            });
        }
        run(worker, queue.shift() ?? last.shift());
    }
}

async function run(w, task) {
    let job;
    try {
        job = await task.load();
    } catch (err) {
        idle.push(w);
        task.reject(err);
        pump();
        return;
    }
    // A child that dies (out of memory, say) fails its task and is replaced by the next one.
    const died = (code) => {
        w.removeAllListeners("message");
        made--;
        task.reject(new Error(`the thumbnail process stopped (${code})`));
        pump();
    };
    w.once("exit", died);
    w.once("message", ({ made: images, error }) => {
        w.removeListener("exit", died);
        w.channel?.unref();
        idle.push(w);
        if (error) {
            task.reject(new Error(error));
        } else {
            task.resolve(Object.fromEntries(Object.entries(images).map(([k, v]) => [k, Buffer.from(v)])));
        }
        pump();
    });
    // Busy, a child keeps the server's process alive until it answers.
    w.channel?.ref();
    w.send(job);
}

/**
 * `thumbnail` (when `load` gives a PNG) or `spotTiles` (when it gives `{ baseline, capture,
 * threshold, includeAA }`) in a child process. The images are read only when a child takes them,
 * so a long queue of tiles made in advance holds no images in memory.
 * @param {() => Promise<unknown>} load reads the input; what it throws, this rejects with
 * @param {"now" | "ahead" | "last"} [when] "now" for a tile on screen, ahead of everything made in
 *     advance; "last" after every other
 * @returns {Promise<Record<string, Buffer>>} the PNGs made: `png` for a thumbnail, else one per kind
 */
export function scaled(load, when = "ahead") {
    return new Promise((resolve, reject) => {
        const task = { load, resolve, reject };
        if (when === "now") {
            queue.unshift(task);
        } else {
            (when === "last" ? last : queue).push(task);
        }
        pump();
    });
}
