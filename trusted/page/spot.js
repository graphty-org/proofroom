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
 * A row-shaped crop of a w x h image centered on one box, and its width before it was kept inside
 * the image (see rowCrop). Each side is
 * clamped inside the image on its own: an image narrower (or shorter) than the crop at the row's
 * shape is shown whole that way, centered in the row, never zoomed further to keep the shape.
 * @param {number[]} box [x, y, width, height]
 * @param {number} w the image's width
 * @param {number} h its height
 * @returns {{ crop: number[], wide: number }} the crop and its width at the row's shape
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
    const wide = cw;
    [cw, ch] = [Math.min(cw, w), Math.min(ch, h)];
    const clamp = (v, max) => Math.min(Math.max(0, v), max);
    return { crop: [clamp(bx + bw / 2 - cw / 2, w - cw), clamp(by + bh / 2 - ch / 2, h - ch), cw, ch], wide };
}

/**
 * How much of a rect the boxes cover, from 0 to 1 (overlapping boxes count twice, capped at 1).
 * @param {number[][]} boxes the boxes, each [x, y, width, height]
 * @param {number[]} rect [x, y, width, height]
 * @returns {number} the share covered
 */
export function covered(boxes, [rx, ry, rw, rh]) {
    let sum = 0;
    for (const [x, y, bw, bh] of boxes) {
        const iw = Math.min(x + bw, rx + rw) - Math.max(x, rx);
        const ih = Math.min(y + bh, ry + rh) - Math.max(y, ry);
        sum += iw > 0 && ih > 0 ? iw * ih : 0;
    }
    return rw * rh > 0 ? Math.min(1, sum / (rw * rh)) : 0;
}

/** The spotlight dims a picture only when its changed areas cover less than this share of it. */
export const SPOT_UNDER = 1 / 3;

/**
 * The largest part of a page a row crop shows, in CSS pixels (image pixels = CSS pixels x the
 * capture's scale): at the row's 167 x 64 CSS px it keeps 14 px text about 6 CSS px tall, readable
 * on a 2x screen.
 */
export const ROW_MAX = [400, 156];

/**
 * The top-left corner of the cw x ch window, inside a w x h image, holding the most changed pixels
 * of a raw pixelmatch mask, counting only those inside `kept`. Counted per cell of a sixteenth of
 * the window each way, in a summed-area table of the cells, and every cell position tried; ties go
 * to the top-most, then the left-most.
 * @param {ArrayLike<number>} mask RGBA, a changed pixel opaque, `stride` pixels a line
 * @param {number} stride the mask's width
 * @param {number[]} kept [x, y, width, height]: where a changed pixel counts
 * @param {number[]} size [w, h, cw, ch]: the image's size and the window's
 * @returns {number[]} [x, y]
 */
function densest(mask, stride, [kx, ky, kw, kh], [w, h, cw, ch]) {
    const [sw, sh] = [Math.max(1, Math.floor(cw / 16)), Math.max(1, Math.floor(ch / 16))];
    const [cols, rows] = [Math.ceil(w / sw), Math.ceil(h / sh)];
    const line = cols + 1;
    const sat = new Float64Array(line * (rows + 1));
    for (let y = Math.max(0, ky); y < Math.min(h, ky + kh); y++) {
        for (let x = Math.max(0, kx); x < Math.min(w, kx + kw); x++) {
            if (mask[(y * stride + x) * 4 + 3] !== 0) {
                sat[(Math.floor(y / sh) + 1) * line + Math.floor(x / sw) + 1]++;
            }
        }
    }
    for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= cols; c++) {
            sat[r * line + c] += sat[r * line + c - 1] + sat[(r - 1) * line + c] - sat[(r - 1) * line + c - 1];
        }
    }
    const [nx, ny] = [Math.round(cw / sw), Math.round(ch / sh)];
    let [best, bx, by] = [-1, 0, 0];
    for (let r = 0; r <= Math.max(0, rows - ny); r++) {
        for (let c = 0; c <= Math.max(0, cols - nx); c++) {
            const [c1, r1] = [Math.min(cols, c + nx), Math.min(rows, r + ny)];
            const n = sat[r1 * line + c1] - sat[r * line + c1] - sat[r1 * line + c] + sat[r * line + c];
            if (n > best) {
                [best, bx, by] = [n, c, r];
            }
        }
    }
    return [Math.min(bx * sw, w - cw), Math.min(by * sh, h - ch)];
}

/**
 * The part of a w x h image a changed row shows, at the row's shape. The first that fits in
 * ROW_MAX (times `scale`) of: every changed area (`how` "all"), the largest cluster of nearby
 * areas ("cluster"; see clusters); else the ROW_MAX window holding the most changed pixels of the
 * raw `mask` ("dense"; see densest), or, without the mask, the window centered on the largest area
 * ("center"). Changed pixels in the strip a size change adds or removes at the edge never count,
 * so a resized row never frames the new blank band. When the only areas are that strip, or none, a
 * ROW_MAX crop centered on the image ("size"). Crops are kept inside the image; an image smaller
 * than ROW_MAX both ways is shown whole. Boxes are clipped to the image first (a baseline larger
 * than the new image changes pixels outside it). Also says how much of the crop, and of the whole
 * image, the areas cover: the spotlight helps only below SPOT_UNDER.
 * @param {number[][]} boxes what regions() returns, largest first
 * @param {number} w the new image's width
 * @param {number} h its height
 * @param {{ scale?: number, base?: number[] | null, mask?: ArrayLike<number> | null, stride?: number }} [opts]
 *     the capture's scale, the baseline's [width, height], and pixelmatch's raw mask of the pair
 *     padded to the larger size, `stride` pixels a line (default w)
 * @returns {{ crop: number[], zoom: number, shown: number, cover: number, coverAll: number,
 *     how: "all" | "cluster" | "dense" | "center" | "size" }} the crop [x, y, width, height]
 *     (fractions allowed), how much larger it shows the image than the whole image fitted in the
 *     row, how many of the boxes it frames, the share of the crop and of the whole image the boxes
 *     cover, and which rule chose it
 */
export function rowCrop(boxes, w, h, { scale = 1, base = null, mask = null, stride = w } = {}) {
    const inside = boxes
        .map(([x, y, bw, bh]) => {
            const [x0, y0] = [Math.max(0, x), Math.max(0, y)];
            return [x0, y0, Math.min(x + bw, w) - x0, Math.min(y + bh, h) - y0];
        })
        .filter((b) => b[2] > 0 && b[3] > 0);
    const coverAll = covered(inside, [0, 0, w, h]);
    const fit = (x, y) => Math.min(ROW[0] / x, ROW[1] / y);
    const out = (crop, shown, how) => ({
        crop,
        zoom: fit(crop[2], crop[3]) / fit(w, h),
        shown,
        cover: covered(inside, crop),
        coverAll,
        how,
    });
    const max = [ROW_MAX[0] * scale, ROW_MAX[1] * scale];
    // Framed when the crop at the row's shape (before it is kept inside the image) fits ROW_MAX.
    const framed = (group) => {
        const { crop, wide } = cropAround(around(group), w, h);
        return wide <= max[0] ? crop : null;
    };
    // The area left once the strip a size change adds or removes (grown by GROW) is taken off.
    const resized = Boolean(base) && (base[0] !== w || base[1] !== h);
    const kept = resized ? [0, 0, Math.min(w, base[0]) - GROW, Math.min(h, base[1]) - GROW] : [0, 0, w, h];
    const sizeOnly = inside.every((b) => covered([b], kept) === 0);
    if (inside.length > 0 && !sizeOnly) {
        const all = framed(inside);
        if (all) {
            return out(all, inside.length, "all");
        }
        const [most] = clusters(inside);
        const near = most.length < inside.length ? framed(most) : null;
        if (near) {
            return out(near, most.length, "cluster");
        }
    }
    // A ROW_MAX crop at the row's shape, smaller only where the image is; the whole image when it
    // is smaller both ways.
    const shape = ROW[0] / ROW[1];
    const cw = w <= max[0] && h <= max[1] ? w : Math.min(max[0], w, h * shape);
    const ch = w <= max[0] && h <= max[1] ? h : cw / shape;
    if (inside.length === 0 || sizeOnly) {
        return out([(w - cw) / 2, (h - ch) / 2, cw, ch], 0, "size");
    }
    if (mask) {
        return out([...densest(mask, stride, kept, [w, h, cw, ch]), cw, ch], 1, "dense");
    }
    const [lx, ly, lw, lh] = inside[0];
    const clamp = (v, top) => Math.min(Math.max(0, v), top);
    return out([clamp(lx + lw / 2 - cw / 2, w - cw), clamp(ly + lh / 2 - ch / 2, h - ch), cw, ch], 1, "center");
}
