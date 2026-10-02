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
    const h = Math.max(1, Math.round((src.height * w) / src.width));
    const out = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        const [y0, y1] = [
            Math.floor((y * src.height) / h),
            Math.max(Math.floor(((y + 1) * src.height) / h), 1 + Math.floor((y * src.height) / h)),
        ];
        for (let x = 0; x < w; x++) {
            const [x0, x1] = [
                Math.floor((x * src.width) / w),
                Math.max(Math.floor(((x + 1) * src.width) / w), 1 + Math.floor((x * src.width) / w)),
            ];
            const sum = [0, 0, 0, 0];
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const i = (sy * src.width + sx) * 4;
                    for (let c = 0; c < 4; c++) {
                        sum[c] += src.data[i + c];
                    }
                }
            }
            const n = (y1 - y0) * (x1 - x0);
            const o = (y * w + x) * 4;
            for (let c = 0; c < 4; c++) {
                out.data[o + c] = Math.round(sum[c] / n);
            }
        }
    }
    return PNG.sync.write(out);
}

const FLAG = "--visual-review-thumbnails";
if (process.argv[2] === FLAG) {
    process.on("message", (/** @type {Uint8Array} */ bytes) => {
        try {
            process.send({ png: thumbnail(Buffer.from(bytes)) });
        } catch (err) {
            process.send({ error: err.message });
        }
    });
}

// Half the cores, at most four: the rest stay free for the server, git and the downloads.
const SIZE = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
const idle = [];
let made = 0;
/** @type {{ load: () => Promise<Buffer>, resolve: (png: Buffer) => void, reject: (err: Error) => void }[]} */
const queue = [];

function pump() {
    while (queue.length > 0 && (idle.length > 0 || made < SIZE)) {
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
        run(worker, queue.shift());
    }
}

async function run(w, task) {
    let bytes;
    try {
        bytes = await task.load();
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
    w.once("message", ({ png, error }) => {
        w.removeListener("exit", died);
        w.channel?.unref();
        idle.push(w);
        if (error) {
            task.reject(new Error(error));
        } else {
            task.resolve(Buffer.from(png));
        }
        pump();
    });
    // Busy, a child keeps the server's process alive until it answers.
    w.channel?.ref();
    w.send(bytes);
}

/**
 * `thumbnail` in a child process. The image is read only when a child takes it, so a long queue
 * of thumbnails made in advance holds no images in memory.
 * @param {() => Promise<Buffer>} load reads the PNG; what it throws, this rejects with
 * @param {boolean} [urgent] a tile on screen now: ahead of the thumbnails made in advance
 * @returns {Promise<Buffer>} the smaller PNG
 */
export function scaled(load, urgent = false) {
    return new Promise((resolve, reject) => {
        queue[urgent ? "unshift" : "push"]({ load, resolve, reject });
        pump();
    });
}
