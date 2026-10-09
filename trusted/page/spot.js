// The spotlight: what the page and the server both draw from a pair of images' changed pixels, so a
// grid tile the server made looks like the one the page would make. Plain JavaScript with no DOM:
// the page loads it as /spot.js, the server imports it.

export const GROW = 10; // image pixels the spotlight and the changed boxes grow each changed pixel by
export const SPOT_ALPHA = 190; // the spotlight's dimming, out of 255, as Chromatic's focus mask

// Sets `out` at every point of one line within GROW of a set point of `src` along it. `at(k)` is
// the index of the line's point k; forward then backward: distance to the nearest set point.
function growLine(src, out, length, at) {
    let last = -Infinity;
    for (let k = 0; k < length; k++) {
        last = src[at(k)] ? k : last;
        out[at(k)] |= k - last <= GROW ? 1 : 0;
    }
    last = Infinity;
    for (let k = length - 1; k >= 0; k--) {
        last = src[at(k)] ? k : last;
        out[at(k)] |= last - k <= GROW ? 1 : 0;
    }
}

/**
 * A square dilation by GROW pixels, as two passes (rows, then columns) of a sliding window.
 * @param {ArrayLike<number>} mask RGBA, a changed pixel opaque
 * @param {number} w its width
 * @param {number} h its height
 * @returns {Uint8Array} 1 per pixel within GROW of a changed one, else 0
 */
export function grow(mask, w, h) {
    const on = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        on[i] = mask[i * 4 + 3] === 0 ? 0 : 1;
    }
    const rows = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        growLine(on, rows, w, (x) => y * w + x);
    }
    const out = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
        growLine(rows, out, h, (y) => y * w + x);
    }
    return out;
}

// The bounding box [x, y, width, height] of the region of a grown mask holding `start`, each of
// its pixels marked in `seen`.
function regionAt(grown, seen, w, h, start) {
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
        const p = stack.pop();
        const x = p % w;
        const y = (p - x) / w;
        [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
            if (q >= 0 && q < w * h && grown[q] && !seen[q]) {
                seen[q] = 1;
                stack.push(q);
            }
        }
    }
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/**
 * The bounding boxes of the separate regions of a grown mask, largest first.
 * @param {Uint8Array} grown what grow() returns
 * @param {number} w its width
 * @param {number} h its height
 * @returns {number[][]} the boxes, each [x, y, width, height]
 */
export function regions(grown, w, h) {
    const seen = new Uint8Array(w * h);
    const boxes = [];
    for (let start = 0; start < w * h; start++) {
        if (grown[start] && !seen[start]) {
            boxes.push(regionAt(grown, seen, w, h, start));
        }
    }
    return boxes.sort((p, q) => q[2] * q[3] - p[2] * p[3]);
}

/**
 * RGBA pixels with everything dimmed except the grown changed pixels.
 * @param {ArrayLike<number>} px the pixels, RGBA
 * @param {Uint8Array} grown what grow() returns for them
 * @returns {Uint8ClampedArray} the spotlit pixels
 */
export function dimmed(px, grown) {
    const out = new Uint8ClampedArray(px.length);
    const keep = 1 - SPOT_ALPHA / 255;
    for (let i = 0; i < grown.length; i++) {
        const lit = grown[i] === 1;
        for (let c = 0; c < 3; c++) {
            out[i * 4 + c] = lit ? px[i * 4 + c] : px[i * 4 + c] * keep;
        }
        out[i * 4 + 3] = lit ? px[i * 4 + 3] : Math.max(px[i * 4 + 3], SPOT_ALPHA);
    }
    return out;
}

/**
 * The grid's Zoom to changes: the part of a w x h image to show, cropped toward the changed
 * boxes. The crop keeps the image's shape and shows at least a quarter of each side; with no
 * boxes, it shows all of the image.
 * @param {number[][]} boxes what regions() returns
 * @param {number} w the image's width
 * @param {number} h its height
 * @returns {number[]} [x, y, width, height], fractions allowed
 */
export function cropOf(boxes, w, h) {
    const all = boxes.length > 0 ? boxes : [[0, 0, w, h]];
    const x0 = Math.min(...all.map((b) => b[0]));
    const y0 = Math.min(...all.map((b) => b[1]));
    const x1 = Math.max(...all.map((b) => b[0] + b[2]));
    const y1 = Math.max(...all.map((b) => b[1] + b[3]));
    const f = Math.min(1, Math.max(0.25, (2 * (x1 - x0)) / w, (2 * (y1 - y0)) / h));
    const [cw, ch] = [w * f, h * f];
    const clamp = (v, max) => Math.min(Math.max(0, v), max);
    return [clamp((x0 + x1) / 2 - cw / 2, w - cw), clamp((y0 + y1) / 2 - ch / 2, h - ch), cw, ch];
}
