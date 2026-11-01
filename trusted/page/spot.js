// The spotlight: what the page and the server both draw from a pair of images' changed pixels, so a
// grid tile the server made looks like the one the page would make. Plain JavaScript with no DOM:
// the page loads it as /spot.js, the server imports it.

export const GROW = 10; // image pixels the spotlight and the changed boxes grow each changed pixel by
// The spotlight's dimming, out of 255: light enough that a many-area change is still a picture,
// not a dark slab with specks (Chromatic's focus mask used 190).
export const SPOT_ALPHA = 110;

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
 * The box around boxes.
 * @param {number[][]} boxes the boxes, each [x, y, width, height]
 * @returns {[number, number, number, number]} the box [x, y, width, height]
 */
const around = (boxes) => {
    const x0 = Math.min(...boxes.map((b) => b[0]));
    const y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
    const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
    return [x0, y0, x1 - x0, y1 - y0];
};

// The gap between two boxes along one axis, 0 when they overlap on it.
const gap = (a0, a1, b0, b1) => Math.max(0, b0 - a1, a0 - b1);

/**
 * The clusters of nearby boxes: two boxes are in one cluster when the gap between them, across and
 * down, is at most the height of the taller of the two (one area-height), and so on through every
 * box joined that way. Largest first, by the area of their boxes.
 * @param {number[][]} boxes the boxes, each [x, y, width, height]
 * @returns {number[][][]} the clusters, each a list of boxes
 */
export function clusters(boxes) {
    const near = (a, b) => {
        const room = Math.max(a[3], b[3]);
        return gap(a[0], a[0] + a[2], b[0], b[0] + b[2]) <= room && gap(a[1], a[1] + a[3], b[1], b[1] + b[3]) <= room;
    };
    const left = [...boxes];
    const out = [];
    while (left.length > 0) {
        const group = [left.pop()];
        for (let i = 0; i < group.length; i++) {
            for (let j = left.length - 1; j >= 0; j--) {
                if (near(group[i], left[j])) {
                    group.push(...left.splice(j, 1));
                }
            }
        }
        out.push(group);
    }
    const size = (g) => g.reduce((n, b) => n + b[2] * b[3], 0);
    return out.sort((p, q) => size(q) - size(p));
}

/**
 * A row-shaped crop of a w x h image centered on one box, and its zoom (see rowCrop).
 * @param {number[]} box [x, y, width, height]
 * @param {number} w the image's width
 * @param {number} h its height
 * @returns {{ crop: number[], zoom: number }} the crop and its zoom
 */
function cropAround([bx, by, bw, bh], w, h) {
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

/** The zoom from which Zoom Auto zooms a row: the crop shows the change twice as large as Fit. */
export const ROW_ZOOM_FROM = 2;

/**
 * Zoom rows to the change: the part of a w x h image a zoomed row shows, at the row's shape and at
 * least ROW_MIN, kept inside the image (so a small image gives a smaller crop, still at the row's
 * shape). It frames every changed area when that crop still zooms ROW_ZOOM_FROM or more; else the
 * largest cluster of nearby areas (clusters), so a spread-out change still shows a change, never a
 * blank stretch of page. With no boxes, it centers on the whole image.
 * @param {number[][]} boxes what regions() returns
 * @param {number} w the image's width
 * @param {number} h its height
 * @returns {{ crop: number[], zoom: number, shown: number }} the crop [x, y, width, height]
 *     (fractions allowed), how much larger it shows the image than the row's unzoomed picture
 *     fitted whole, and how many of the boxes it frames
 */
export function rowCrop(boxes, w, h) {
    if (boxes.length === 0) {
        return { ...cropAround([0, 0, w, h], w, h), shown: 0 };
    }
    const all = cropAround(around(boxes), w, h);
    if (all.zoom >= ROW_ZOOM_FROM || boxes.length === 1) {
        return { ...all, shown: boxes.length };
    }
    const [most] = clusters(boxes);
    return { ...cropAround(around(most), w, h), shown: most.length };
}
