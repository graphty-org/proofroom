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

// A row's zoomed picture: its shape (400 x 156 pixels), and the smallest part of an image it shows,
// so a crop never goes past one image pixel per screen pixel at the row's largest size.
export const ROW = [400, 156];
const ROW_MIN = [380, 148];
// How much room a crop leaves around the area it is centered on.
const ROW_PAD = 1.2;

/**
 * Zoom rows to the change: the part of a w x h image a zoomed row shows, centered on the largest
 * changed box, at the row's shape and at least ROW_MIN, kept inside the image (so a small image
 * gives a smaller crop, still at the row's shape). With no boxes, it centers on the whole image.
 * @param {number[][]} boxes what regions() returns
 * @param {number} w the image's width
 * @param {number} h its height
 * @returns {{ crop: number[], zoom: number }} the crop [x, y, width, height] (fractions allowed),
 *     and how much larger it shows the image than the row's unzoomed picture fitted whole
 */
export function rowCrop(boxes, w, h) {
    const [bx, by, bw, bh] = boxes.reduce((m, b) => (b[2] * b[3] > m[2] * m[3] ? b : m), boxes[0] ?? [0, 0, w, h]);
    const shape = ROW[0] / ROW[1];
    let cw = Math.max(ROW_MIN[0], bw * ROW_PAD);
    let ch = Math.max(ROW_MIN[1], bh * ROW_PAD);
    if (cw / ch < shape) {
        cw = ch * shape;
    } else {
        ch = cw / shape;
    }
    const fit = Math.min(1, w / cw, h / ch);
    [cw, ch] = [cw * fit, ch * fit];
    const clamp = (v, max) => Math.min(Math.max(0, v), max);
    return {
        crop: [clamp(bx + bw / 2 - cw / 2, w - cw), clamp(by + bh / 2 - ch / 2, h - ch), cw, ch],
        zoom: Math.max(w / cw, h / ch),
    };
}
