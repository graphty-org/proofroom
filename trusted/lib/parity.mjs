/**
 * Parity: whether two captures of the same commit drew the same bytes, story by story.
 *
 * Two results.json files of one project (say, today's capture of the built Storybook and the
 * story tests' capture) are compared item by item, keyed by story id and mode, by the SHA-256 of
 * each capture, or by its `exact` flag when both match the same baseline. Two environments may encode the same picture into different PNG bytes, so
 * `samePixels` decodes the pair behind each "different bytes" and keeps only those whose size or
 * RGBA pixels differ. Any difference is a bug in one of the two environments, never something to
 * absorb, so this reports every one and the threshold plays no part: equal means every byte of
 * every pixel.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { PNG } from "pngjs";

import { sha256 } from "./compare.mjs";
import { validateResults } from "./results.mjs";

/** Statuses with no capture to compare, which agree when both sides have the same one. */
const NOTHING_TO_SHOOT = new Set(["excluded", "removed"]);

/**
 * Reads and validates one results.json.
 * @param {string} path a results.json, or the directory that holds it
 * @returns {Promise<object>} the parsed, valid results
 */
export async function readResults(path) {
    const file = (await stat(path)).isDirectory() ? join(path, "results.json") : path;
    const results = JSON.parse(await readFile(file, "utf8"));
    const problems = validateResults(results);
    if (problems.length > 0) {
        throw new Error(`${file} is not a valid results.json:\n${problems.slice(0, 20).join("\n")}`);
    }
    return results;
}

const side = (item) => item && { status: item.status, capture: item.capture, size: item.size };

/**
 * Whether an item's capture has exactly its baseline's pixels: the same bytes, or the comparison
 * found every RGBA byte equal (`exact`, written by captures since #3472).
 * @param {object} item a results item with a capture
 * @returns {boolean} true when the capture's pixels are the baseline's
 */
const exactToBaseline = (item) => item.baseline !== null && (item.capture === item.baseline || item.exact === true);

/**
 * Why two items of the same story and mode do not show parity.
 * @param {object | undefined} a the item in the first results
 * @param {object | undefined} b the item in the second results
 * @returns {string | null} the difference, or null when they agree
 */
function differs(a, b) {
    if (!a || !b) {
        return a ? "only in the first" : "only in the second";
    }
    if (a.capture && b.capture) {
        const samePicture =
            a.capture === b.capture || (a.baseline === b.baseline && exactToBaseline(a) && exactToBaseline(b));
        return samePicture ? null : "different bytes";
    }
    if (!a.capture && !b.capture && a.status === b.status && NOTHING_TO_SHOOT.has(a.status)) {
        return null;
    }
    return "not captured on both sides";
}

/**
 * Compares two captures of one project.
 * @param {object} first valid results.json
 * @param {object} second valid results.json of the same project
 * @returns {{ compared: number, same: number, differences: object[] }} every item key in either
 *     file, the ones that agree, and one entry per item that does not
 */
export function parity(first, second) {
    const key = (item) => item.file;
    const a = new Map(first.items.map((item) => [key(item), item]));
    const b = new Map(second.items.map((item) => [key(item), item]));
    const files = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => (x < y ? -1 : 1));
    const differences = [];
    for (const file of files) {
        const problem = differs(a.get(file), b.get(file));
        if (problem) {
            differences.push({ file, problem, first: side(a.get(file)), second: side(b.get(file)) });
        }
    }
    return { compared: files.length, same: files.length - differences.length, differences };
}

/** Where a capture directory may hold an item's image: the capture itself, or its baseline. */
const IMAGE_DIRS = ["", "baselines", "second"];

/**
 * Finds the PNG with the given SHA-256 among the images either capture directory holds for a file.
 * An unchanged story's capture is not written, but it is byte for byte its baseline, which the
 * other side may hold, so every candidate is checked against the hash.
 * @param {string[]} dirs the capture directories
 * @param {string} file the item's file name
 * @param {string} hash the SHA-256 the image must have
 * @returns {Promise<Buffer | null>} the image's bytes, or null when neither directory has it
 */
async function findImage(dirs, file, hash) {
    for (const dir of dirs) {
        for (const sub of IMAGE_DIRS) {
            const bytes = await readFile(join(dir, sub, file)).catch(() => null);
            if (bytes && sha256(bytes) === hash) {
                return bytes;
            }
        }
    }
    return null;
}

/**
 * How two decoded images differ, exactly.
 * @param {Buffer} a the first PNG
 * @param {Buffer} b the second PNG
 * @returns {object | null} `{ problem, changedPixels? }`, or null when every RGBA byte matches
 */
function pixelDifference(a, b) {
    const x = PNG.sync.read(a);
    const y = PNG.sync.read(b);
    if (x.width !== y.width || x.height !== y.height) {
        return { problem: "different size" };
    }
    let changedPixels = 0;
    for (let i = 0; i < x.data.length; i += 4) {
        if (x.data.readUInt32BE(i) !== y.data.readUInt32BE(i)) {
            changedPixels++;
        }
    }
    return changedPixels === 0 ? null : { problem: "different pixels", changedPixels };
}

/**
 * Re-checks every "different bytes" of a parity result by its decoded pixels. One whose images
 * cannot both be found stays "different bytes".
 * @param {{ compared: number, differences: object[] }} result what `parity` returned
 * @param {string[]} dirs the two capture directories (each holds its results.json)
 * @returns {Promise<{ compared: number, same: number, differences: object[] }>} the result with
 *     pixel-identical pairs counted as the same
 */
export async function samePixels(result, dirs) {
    const differences = [];
    for (const d of result.differences) {
        if (d.problem !== "different bytes") {
            differences.push(d);
            continue;
        }
        const a = await findImage(dirs, d.file, d.first.capture);
        const b = a && (await findImage(dirs, d.file, d.second.capture));
        if (!b) {
            differences.push(d);
            continue;
        }
        const pixels = pixelDifference(a, b);
        if (pixels) {
            differences.push({ ...d, ...pixels });
        }
    }
    return { compared: result.compared, same: result.compared - differences.length, differences };
}
