/**
 * What every runner's fixture tests do, whatever the runner: one snapshot test per id, each a
 * call of assertSnapshot() from proofroom/compare, and a test in a later file that reads the
 * result lines already on disk.
 *
 * The harness (../harness.mjs) sets BASELINES (the baselines, all gray 10), PROOFROOM_OUT (where
 * the result lines go), FIXTURE_STATE (a directory this file counts calls in) and FLIP (also run
 * the snapshot that differs on its first call and matches after).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PNG } from "pngjs";
import { assertSnapshot } from "proofroom/compare";

/**
 * A solid gray PNG.
 * @param {number} shade the gray level
 * @returns {Buffer} the PNG
 */
function png(shade) {
    const image = new PNG({ width: 4, height: 4 });
    image.data.fill(shade);
    for (let i = 3; i < image.data.length; i += 4) {
        image.data[i] = 255;
    }
    return PNG.sync.write(image);
}

/**
 * The snapshots the fixture tests.
 * @returns {string[]} their ids: `flip` only when FLIP is set
 */
export const ids = () => ["same", "changed", ...(process.env.FLIP ? ["flip"] : [])];

/**
 * One snapshot test: `same` matches its baseline, `changed` never does, and `flip` differs on its
 * first call and matches from then on (counted on disk, since a runner may retry in a new process).
 * @param {string} id the snapshot
 * @returns {Promise<void>} once it passed
 */
export async function snapshot(id) {
    let shade = id === "same" ? 10 : 200;
    if (id === "flip") {
        const count = join(process.env.FIXTURE_STATE, "flip");
        const calls = existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
        writeFileSync(count, String(calls + 1));
        shade = calls === 0 ? 200 : 10;
    }
    await assertSnapshot({ project: "app", baselines: process.env.BASELINES, id, image: png(shade) });
}

/**
 * The later file's test: the earlier file's failing result line is already on disk.
 * @returns {void}
 */
export function earlierFailureOnDisk() {
    const out = process.env.PROOFROOM_OUT;
    const lines = readdirSync(out)
        .filter((f) => /^results-.*\.ndjson$/.test(f))
        .flatMap((f) => readFileSync(join(out, f), "utf8").split("\n").filter(Boolean))
        .map((l) => JSON.parse(l));
    if (!lines.some((l) => l.id === "changed" && l.passed === false)) {
        throw new Error("no failing result line on disk yet");
    }
}
