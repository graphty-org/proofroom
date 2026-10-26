// Measures the review server's pictures on real image pairs, with the server's own picture pool:
// how long until the first list screen's 12 pictures exist and until every picture does, with
// the jobs queued in list order as the server queues them. Not published, not run in CI.
//
// Usage: node bench/run.mjs <downloads> [pairs=300]
//   <downloads> a folder holding capture sets (any depth): <project>/results.json beside the
//   captures and baselines/, as the review server downloads them. Its changed pairs are used in
//   turn until there are [pairs] jobs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { pool } from "../trusted/lib/thumbs.mjs";

const [root, want = "300"] = process.argv.slice(2);
if (!root) {
    console.error("usage: node bench/run.mjs <downloads> [pairs=300]");
    process.exit(2);
}
const total = Number(want);

/**
 * Up to 40 changed pairs under `dir`, at most 10 from one project.
 * @param {string} dir where to look
 * @returns {{ baseline: string, capture: string, threshold: number, includeAA: boolean }[]} the pairs
 */
function findPairs(dir) {
    const pairs = [];
    const per = new Map();
    const walk = (at, depth) => {
        if (pairs.length >= 40 || depth > 3) {
            return;
        }
        let results = null;
        try {
            results = JSON.parse(readFileSync(join(at, "results.json"), "utf8"));
        } catch {
            // Not a capture set: look deeper.
        }
        for (const item of results?.items ?? []) {
            const project = results.project ?? at;
            if (item.status !== "changed" || (per.get(project) ?? 0) >= 10 || pairs.length >= 40) {
                continue;
            }
            const pair = { baseline: join(at, "baselines", item.file), capture: join(at, item.file) };
            if (
                statSync(pair.baseline, { throwIfNoEntry: false }) &&
                statSync(pair.capture, { throwIfNoEntry: false })
            ) {
                per.set(project, (per.get(project) ?? 0) + 1);
                pairs.push({ ...pair, threshold: item.threshold ?? 0.1, includeAA: item.includeAA ?? false });
            }
        }
        if (!results) {
            for (const name of readdirSync(at)) {
                if (statSync(join(at, name)).isDirectory()) {
                    walk(join(at, name), depth + 1);
                }
            }
        }
    };
    walk(dir, 0);
    return pairs;
}

const pairs = findPairs(root);
if (pairs.length === 0) {
    console.error(`no changed pairs with both images under ${root}`);
    process.exit(2);
}
const start = performance.now();
const done = [];
await Promise.all(
    Array.from({ length: total }, (_, i) => {
        const p = pairs[i % pairs.length];
        return pool
            .run(async () => ({
                baseline: readFileSync(p.baseline),
                capture: readFileSync(p.capture),
                threshold: p.threshold,
                includeAA: p.includeAA,
            }))
            .then(() => done.push(performance.now() - start));
    }),
);
done.sort((a, b) => a - b);
const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
console.log(`${total} pairs (${pairs.length} real, used in turn), one job each, in list order:`);
console.log(`  first list screen (12 pictures): ${s(done[Math.min(11, done.length - 1)])}`);
console.log(`  every picture: ${s(done.at(-1))}, ${(done.at(-1) / total).toFixed(0)} ms per pair of wall time`);
