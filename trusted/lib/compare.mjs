/**
 * Comparison: is a capture the same as its baseline, and what does a story's pair of captures say?
 *
 * The SHA-256 of the PNG bytes decides first; only when the bytes differ are both images decoded
 * and compared with pixelmatch at the story's threshold. A bounding box is [x, y, width, height].
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// ponytail: pngjs until milestone 3 needs a dependency-free decoder
import { PNG } from "pngjs";

import pixelmatch from "../vendor/pixelmatch.mjs";

/** Chromatic's default `diffThreshold`, used when a story sets none. */
export const DEFAULT_THRESHOLD = 0.063;

/**
 * Hashes PNG bytes; equal hashes mean the images are identical without decoding either.
 * @param {Buffer | string} bytes the file's bytes (or text)
 * @returns {string} the hex SHA-256 of the bytes
 */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The first line of every Git LFS pointer file. */
const LFS_POINTER = "version https://git-lfs.github.com/spec/";

/**
 * Whether bytes are a Git LFS pointer file rather than the image it stands for.
 * @param {Buffer} bytes a file's bytes
 * @returns {boolean} true for a pointer
 */
export const isLfsPointer = (bytes) => bytes.subarray(0, LFS_POINTER.length).toString("latin1") === LFS_POINTER;

/**
 * Reads a baseline PNG. Baselines are stored in Git LFS; a checkout without `git lfs pull` holds
 * pointer files, and comparing a pointer would report every image as changed, so it throws.
 * @param {string} path the baseline's path
 * @returns {Promise<Buffer | null>} its bytes, or null when there is no baseline
 */
export async function readBaseline(path) {
    const bytes = await readFile(path).catch((e) => {
        if (e.code === "ENOENT") {
            return null;
        }
        throw e;
    });
    if (bytes && isLfsPointer(bytes)) {
        throw new Error(`${path}: baseline is an LFS pointer; run git lfs pull`);
    }
    return bytes;
}

/**
 * Compares a capture with its baseline.
 * @param {Buffer} baseline PNG bytes
 * @param {Buffer} capture PNG bytes
 * @param {{ threshold: number, includeAA: boolean }} options pixelmatch's threshold (0..1) and
 *     whether anti-aliased pixels count as changed
 * @returns {{ status: "unchanged" | "changed", baseline: string, capture: string,
 *     size: number[] | null, baselineSize: number[] | null, changedPixels: number,
 *     bbox: number[] | null }} sizes are [width, height]
 */
export function compareImages(baseline, capture, { threshold, includeAA }) {
    const hashes = { baseline: sha256(baseline), capture: sha256(capture) };
    if (hashes.baseline === hashes.capture) {
        const size = pngSize(capture);
        return { status: "unchanged", ...hashes, size, baselineSize: size, changedPixels: 0, bbox: null };
    }
    const a = PNG.sync.read(baseline);
    const b = PNG.sync.read(capture);
    const { changedPixels, bbox } = diffPixels(a, b, { threshold, includeAA });
    return {
        status: changedPixels === 0 ? "unchanged" : "changed",
        ...hashes,
        size: [b.width, b.height],
        baselineSize: [a.width, a.height],
        changedPixels,
        bbox,
    };
}

/**
 * Counts the pixels that differ. Images of different sizes are compared over their top-left
 * overlap, and every pixel of the larger canvas outside that overlap counts as changed.
 * @param {PNG} a the decoded baseline
 * @param {PNG} b the decoded capture
 * @param {{ threshold: number, includeAA: boolean }} options pixelmatch's settings
 * @returns {{ changedPixels: number, bbox: number[] | null }} the count and the box around them
 */
function diffPixels(a, b, options) {
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    const W = Math.max(a.width, b.width);
    const H = Math.max(a.height, b.height);
    const mask = Buffer.alloc(w * h * 4);
    let changedPixels = pixelmatch(crop(a, w, h), crop(b, w, h), mask, w, h, { ...options, diffMask: true });

    let [x0, y0, x1, y1] = [W, H, -1, -1];
    const grow = (x, y) => {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    };
    if (changedPixels > 0) {
        // With diffMask, pixelmatch paints only the counted pixels, so opaque means changed.
        for (let i = 3; i < mask.length; i += 4) {
            if (mask[i] !== 0) {
                grow(((i - 3) / 4) % w, Math.floor((i - 3) / 4 / w));
            }
        }
    }
    const padding = W * H - w * h;
    if (padding > 0) {
        changedPixels += padding;
        // The padding is the canvas outside the overlap: right of it, below it, or both.
        if (W > w) {
            grow(w, 0);
            grow(W - 1, H - 1);
        }
        if (H > h) {
            grow(0, h);
            grow(W - 1, H - 1);
        }
    }
    return { changedPixels, bbox: x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1] };
}

/**
 * Copies out the top-left corner of an image, or returns its data when it is already that size.
 * @param {PNG} img the decoded image
 * @param {number} w the width to keep
 * @param {number} h the height to keep
 * @returns {Buffer} the RGBA of the top-left w x h of the image
 */
function crop(img, w, h) {
    if (img.width === w && img.height === h) {
        return img.data;
    }
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        img.data.copy(out, y * w * 4, y * img.width * 4, (y * img.width + w) * 4);
    }
    return out;
}

/**
 * Classifies one story and mode from its baseline and up to two captures. A second capture is
 * taken, in a fresh browser context, only when the first differs from the baseline or there is
 * no baseline; without one (a local run) the first capture stands alone.
 *
 * A story with no baseline is `unseeded` ("no baseline yet") when its capture matches
 * `reference`, master's newest capture of it: the pull request did not change it, so it needs no
 * review here. It is `new` when it differs from master's, or master has none (a new story).
 *
 * `moved` says the baseline is another story id's, named in the project's renames.json: a story
 * that only moved (same image, new id) is `moved` rather than `unchanged`, so it still needs an
 * accept, which writes its baseline under the new name.
 * @param {{ baseline: Buffer | null, first: Buffer | null, second?: Buffer | null,
 *     reference?: Buffer | null, threshold: number, includeAA: boolean, moved?: boolean }} input
 *     `first` is null when the story is gone
 * @returns {{ status: "unchanged" | "moved" | "changed" | "new" | "unseeded" | "removed" | "unstable", flaky: boolean,
 *     baseline: string | null, capture: string | null, size: number[] | null,
 *     baselineSize: number[] | null, changedPixels: number | null, bbox: number[] | null }}
 *     `capture` is the hash of the capture the status describes: the second one when flaky
 */
export function classify({ baseline, first, second = null, reference = null, threshold, includeAA, moved = false }) {
    const options = { threshold, includeAA };
    const matched = (r, flaky) => ({ ...r, status: moved ? "moved" : "unchanged", flaky });
    const none = { flaky: false, size: null, baselineSize: null, changedPixels: null, bbox: null };
    if (first === null) {
        return { status: "removed", ...none, baseline: sha256(baseline), capture: null };
    }
    const agree = () => second === null || compareImages(first, second, options).status === "unchanged";
    if (baseline === null) {
        const same = reference !== null && compareImages(reference, first, options).status === "unchanged";
        const status = same ? "unseeded" : agree() ? "new" : "unstable";
        return { status, ...none, baseline: null, capture: sha256(first), size: pngSize(first) };
    }
    const vsFirst = compareImages(baseline, first, options);
    if (vsFirst.status === "unchanged") {
        return matched(vsFirst, false);
    }
    if (second === null) {
        return { ...vsFirst, flaky: false };
    }
    const vsSecond = compareImages(baseline, second, options);
    if (vsSecond.status === "unchanged") {
        return matched(vsSecond, true);
    }
    return { ...vsFirst, status: agree() ? "changed" : "unstable", flaky: false };
}

/**
 * Reads a PNG's dimensions.
 * @param {Buffer} bytes PNG bytes
 * @returns {number[]} [width, height], read from the IHDR chunk without decoding the image
 */
function pngSize(bytes) {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
