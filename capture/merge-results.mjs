/**
 * merge-results: one project's partial story-test results (one directory per shard, written by
 * story-test.mjs) combined into the results.json, images and baselines a capture directory holds,
 * so `serve` and `gate` read it as they read capture.mjs's.
 *
 * The result is complete only when every shard 1..count is there once, between them they ran every
 * story file of the project once, each reported every story test it ran, all come from one commit
 * and no story is in two of them. Then every baseline no
 * item names is reported `removed`, as capture.mjs reports it. Otherwise the merge is written with
 * `complete: false`, which the gate refuses, and the problems are returned.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { classify, DEFAULT_THRESHOLD, readBaseline } from "../trusted/lib/compare.mjs";
import { validateResults } from "../trusted/lib/results.mjs";
import { BASELINE_NAME, fileName, pngsIn, writeResults } from "./capture.mjs";
import { promotion } from "./story-outcomes.mjs";

/**
 * Copies a file when it exists.
 * @param {string} from the source
 * @param {string} to the destination
 * @returns {Promise<void>} once copied, or at once when there is nothing to copy
 */
const copyIfThere = (from, to) =>
    copyFile(from, to).catch((e) => {
        if (e.code !== "ENOENT") {
            throw e;
        }
    });

/**
 * Why the partials' shards are not exactly shards 1..count, once each.
 * @param {object[]} parts the parsed partial results
 * @returns {string[]} one message per problem
 */
function shardProblems(parts) {
    const counts = new Set(parts.map((p) => p.partial?.shard?.count));
    const [count] = counts;
    if (counts.size !== 1 || !Number.isInteger(count)) {
        return [`the partials disagree on the number of shards (${[...counts].join(", ")})`];
    }
    const problems = [];
    for (let i = 1; i <= count; i++) {
        const n = parts.filter((p) => p.partial.shard.index === i).length;
        if (n === 0) {
            problems.push(`shard ${i} of ${count}: missing`);
        } else if (n > 1) {
            problems.push(`shard ${i} of ${count}: ${n} partials`);
        }
    }
    return problems;
}

/**
 * Why the partials did not, between them, run every story file of the project exactly once (a
 * filtered run, a file that failed to load, a shard run twice).
 * @param {object[]} parts the parsed partial results
 * @returns {string[]} one message per problem, at most a few files named
 */
function fileProblems(parts) {
    const files = parts[0]?.partial?.files;
    if (!Array.isArray(files) || parts.some((p) => !Array.isArray(p.partial?.ran))) {
        return ["a partial does not list the project's story files"];
    }
    if (parts.some((p) => JSON.stringify(p.partial.files) !== JSON.stringify(files))) {
        return ["the partials list different story files"];
    }
    const runs = new Map(files.map((f) => [f, 0]));
    for (const f of parts.flatMap((p) => p.partial.ran)) {
        runs.set(f, (runs.get(f) ?? 0) + 1);
    }
    const unrun = [...runs].filter(([, n]) => n === 0).map(([f]) => f);
    const twice = [...runs].filter(([, n]) => n > 1).map(([f]) => f);
    const named = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? ` and ${list.length - 5} more` : "");
    return [
        ...(unrun.length > 0 ? [`${unrun.length} story files did not run or failed to load: ${named(unrun)}`] : []),
        ...(twice.length > 0 ? [`story files ran in more than one partial: ${named(twice)}`] : []),
    ];
}

/**
 * Why one partial cannot be part of the project's capture.
 * @param {string} project the project
 * @param {object} p the parsed partial, with `dir`
 * @returns {string[]} one message per problem
 */
function partProblems(project, p) {
    const problems = [];
    if (p.project !== project) {
        problems.push(`${p.dir}: a capture of ${p.project}, not ${project}`);
    }
    if (p.partial?.reported !== true) {
        const missing = (p.partial?.missing ?? []).slice(0, 5).join(", ");
        const why = missing ? `: no visual step for ${missing}` : "";
        problems.push(`${p.dir}: incomplete${why}`);
    }
    return problems;
}

/**
 * Why a set of partials is not a whole capture of the project.
 * @param {string} project the project
 * @param {object[]} parts the parsed partial results, with `dir`
 * @returns {string[]} one message per problem
 */
function completeness(project, parts) {
    const problems = [
        ...shardProblems(parts),
        ...fileProblems(parts),
        ...parts.flatMap((p) => partProblems(project, p)),
    ];
    if (new Set(parts.map((p) => p.commit)).size > 1) {
        problems.push("the partials come from different commits");
    }
    return problems;
}

/**
 * Every partial's items, each once, with their images copied into `out`.
 * @param {object[]} parts the parsed partials, with `dir`
 * @param {string} out the merged capture's directory
 * @param {string[]} problems where a story found in two partials is reported
 * @returns {Promise<object[]>} the items
 */
async function collectItems(parts, out, problems) {
    const items = [];
    const seen = new Map();
    for (const p of parts) {
        for (const item of p.items) {
            if (seen.has(item.file)) {
                problems.push(`${item.file} is in ${seen.get(item.file)} and ${p.dir}`);
                continue;
            }
            seen.set(item.file, p.dir);
            items.push(item);
            for (const sub of ["", "second", "baselines", "flaky"]) {
                await copyIfThere(join(p.dir, sub, item.file), join(out, sub, item.file));
            }
        }
    }
    return items;
}

/**
 * A `removed` item for every baseline no item drew or was compared with, as capture.mjs reports it.
 * @param {object[]} items the merged items
 * @param {string} baselines the project's baselines directory
 * @param {string} out the merged capture's directory, which gets each removed baseline
 * @returns {Promise<object[]>} the removed items
 */
async function removedItems(items, baselines, out) {
    const named = new Set(items.flatMap((i) => [i.file, i.from && fileName(i.from, i.mode)]));
    const removed = [];
    for (const file of await pngsIn(baselines)) {
        if (named.has(file) || !BASELINE_NAME.test(file)) {
            continue;
        }
        const baseline = await readBaseline(join(baselines, file));
        const [id, mode = null] = file.slice(0, -4).split(".");
        await writeFile(join(out, "baselines", file), baseline);
        const r = classify({ baseline, first: null, threshold: DEFAULT_THRESHOLD, includeAA: false });
        removed.push({
            id,
            mode,
            file,
            ...r,
            threshold: DEFAULT_THRESHOLD,
            includeAA: false,
            reason: null,
            console: [],
        });
    }
    return removed;
}

/**
 * Merges partial story-test results of one project.
 * @param {{ project: string, baselines: string, out: string, dirs: string[], blocking?: boolean }} options the
 *     project, its baselines directory, where the merged capture goes, the partials, and whether a
 *     changed picture blocks promotion (`promotion.blocked`, story-outcomes.mjs)
 * @returns {Promise<{ results: object, problems: string[] }>} the merged results and why it is
 *     not complete (empty when it is)
 */
export async function mergeResults({ project, baselines, out, dirs, blocking = false }) {
    const parts = [];
    for (const dir of dirs) {
        parts.push({ ...JSON.parse(await readFile(join(dir, "results.json"), "utf8")), dir });
    }
    const problems = completeness(project, parts);
    for (const sub of ["second", "baselines", "flaky"]) {
        await mkdir(join(out, sub), { recursive: true });
    }
    const items = await collectItems(parts, out, problems);
    if (problems.length === 0) {
        items.push(...(await removedItems(items, baselines, out)));
    }
    items.sort((a, b) => (a.file < b.file ? -1 : 1));
    const header = { ...parts[0] };
    for (const key of ["dir", "partial"]) {
        delete header[key];
    }
    const earliest = parts.map((p) => p.capturedAt).sort((a, b) => a.localeCompare(b))[0];
    const results = {
        ...header,
        project,
        capturedAt: earliest ?? new Date().toISOString(),
        expected: items.length,
        complete: false,
        items,
    };
    problems.push(...validateResults({ ...results, complete: true }).slice(0, 20));
    results.complete = problems.length === 0;
    results.promotion = promotion(results, blocking);
    await writeResults(out, results);
    return { results, problems };
}
