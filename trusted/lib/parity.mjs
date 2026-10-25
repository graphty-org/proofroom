/**
 * Parity: whether two captures of the same commit drew the same bytes, story by story.
 *
 * Two results.json files of one project (say, today's capture of the built Storybook and the
 * story tests' capture) are compared item by item, keyed by story id and mode, by the SHA-256 of
 * each capture. Any difference is a bug in one of the two environments, never something to
 * absorb, so this reports every one and the threshold plays no part.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

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
        return a.capture === b.capture ? null : "different bytes";
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
