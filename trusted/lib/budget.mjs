/**
 * The work directory's disk budget: how much it holds (one walk), which changes give up their
 * images first, and evicting one capture directory. An evicted directory keeps its results.json
 * (and the not-affected marker and GitHub's kept answers), so a change keeps its counts and its
 * decisions (state/, never touched here); only its full images go, and the pictures made from them.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { EVICTED_FILE } from "./github.mjs";
import { SKIPPED_FILE } from "./results.mjs";

/** A change opened this recently is never evicted. */
export const OPENED_KEEP_MS = 60 * 60000;

// What an evicted capture directory keeps.
const KEPT = new Set(["results.json", SKIPPED_FILE, EVICTED_FILE, "gh"]);

/**
 * The size of every file under `root`, read in one walk.
 * @param {string} root the directory
 * @returns {Promise<Map<string, number>>} bytes by path; empty when `root` does not exist
 */
export async function sizes(root) {
    const out = new Map();
    const walk = async (dir) => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
            const path = join(dir, e.name);
            if (e.isDirectory()) {
                await walk(path);
            } else if (e.isFile()) {
                const s = await stat(path).catch(() => null);
                if (s) {
                    out.set(path, s.size);
                }
            }
        }
    };
    await walk(root);
    return out;
}

/**
 * The changes to evict, in order: never one kept (open, pinned or opened in the last hour);
 * those that need nothing from the reviewer (finished, or nothing to decide) first, then the
 * least recently opened.
 * @param {{ id: string, needsYou: boolean, openedAt: number, keep: boolean }[]} changes the candidates
 * @param {number} now the time
 * @returns {string[]} their ids, first to evict first
 */
export function evictionOrder(changes, now) {
    return changes
        .filter((c) => !c.keep && now - c.openedAt >= OPENED_KEEP_MS)
        .sort((a, b) => Number(a.needsYou) - Number(b.needsYou) || a.openedAt - b.openedAt)
        .map((c) => c.id);
}

/**
 * Evicts one capture directory: writes its marker first (so a crash part way leaves it marked),
 * then removes everything but results.json and what KEPT names.
 * @param {string} dir the capture directory
 * @param {Map<string, number>} files the walk's sizes, for the bytes freed
 * @param {number} now the time
 * @returns {number} the bytes freed
 */
export function evict(dir, files, now) {
    const gone = readdirSync(dir).filter((n) => !KEPT.has(n));
    let bytes = 0;
    for (const n of gone) {
        const path = join(dir, n);
        for (const [f, size] of files) {
            if (f === path || f.startsWith(`${path}${sep}`)) {
                bytes += size;
            }
        }
    }
    writeFileSync(join(dir, EVICTED_FILE), JSON.stringify({ bytes, at: now }));
    for (const n of gone) {
        rmSync(join(dir, n), { recursive: true, force: true });
    }
    return bytes;
}

/**
 * Whether a capture directory was evicted, and how many bytes of images it gave up.
 * @param {string} dir the capture directory
 * @returns {{ bytes: number, at: number } | null} its marker, or null when its images are there
 */
export function evictedAt(dir) {
    const file = join(dir, EVICTED_FILE);
    if (!existsSync(file)) {
        return null;
    }
    try {
        const { bytes, at } = JSON.parse(readFileSync(file, "utf8"));
        return { bytes: Number(bytes) || 0, at: Number(at) || 0 };
    } catch {
        return { bytes: 0, at: 0 };
    }
}
