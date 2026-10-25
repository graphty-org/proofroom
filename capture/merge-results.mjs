/**
 * merge-results: one project's partial story-test results (one directory per shard, written by
 * story-test.mjs) combined into the results.json, images and baselines a capture directory holds,
 * so `serve` and `gate` read it as they read capture.mjs's.
 *
 * The result is complete only when every shard 1..count is there once, each reported every story
 * test it ran, all come from one commit and no story is in two of them. Then every baseline no
 * item names is reported `removed`, as capture.mjs reports it. Otherwise the merge is written with
 * `complete: false`, which the gate refuses, and the problems are returned.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { classify, DEFAULT_THRESHOLD, readBaseline } from "../trusted/lib/compare.mjs";
import { validateResults } from "../trusted/lib/results.mjs";
import { BASELINE_NAME, fileName, pngsIn, writeResults } from "./capture.mjs";

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
 * Why a set of partials is not a whole capture of the project.
 * @param {string} project the project
 * @param {object[]} parts the parsed partial results, with `dir`
 * @returns {string[]} one message per problem
 */
function completeness(project, parts) {
    const problems = [];
    const counts = new Set(parts.map((p) => p.partial?.shard?.count));
    const indexes = parts.map((p) => p.partial?.shard?.index);
    const [count] = counts;
    if (counts.size !== 1 || !Number.isInteger(count)) {
        problems.push(`the partials disagree on the number of shards (${[...counts].join(", ")})`);
    } else {
        for (let i = 1; i <= count; i++) {
            const n = indexes.filter((x) => x === i).length;
            if (n !== 1) {
                problems.push(`shard ${i} of ${count}: ${n === 0 ? "missing" : `${n} partials`}`);
            }
        }
    }
    for (const p of parts) {
        if (p.project !== project) {
            problems.push(`${p.dir}: a capture of ${p.project}, not ${project}`);
        }
        if (p.partial?.reported !== true) {
            const missing = p.partial?.missing?.length
                ? `: no visual step for ${p.partial.missing.slice(0, 5).join(", ")}`
                : "";
            problems.push(`${p.dir}: incomplete${missing}`);
        }
    }
    if (new Set(parts.map((p) => p.commit)).size > 1) {
        problems.push("the partials come from different commits");
    }
    return problems;
}

/**
 * Merges partial story-test results of one project.
 * @param {{ project: string, baselines: string, out: string, dirs: string[] }} options the
 *     project, its baselines directory, where the merged capture goes, and the partials
 * @returns {Promise<{ results: object, problems: string[] }>} the merged results and why it is
 *     not complete (empty when it is)
 */
export async function mergeResults({ project, baselines, out, dirs }) {
    const parts = [];
    for (const dir of dirs) {
        parts.push({ ...JSON.parse(await readFile(join(dir, "results.json"), "utf8")), dir });
    }
    const problems = completeness(project, parts);
    for (const sub of ["second", "baselines"]) {
        await mkdir(join(out, sub), { recursive: true });
    }
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
            for (const sub of ["", "second", "baselines"]) {
                await copyIfThere(join(p.dir, sub, item.file), join(out, sub, item.file));
            }
        }
    }
    if (problems.length === 0) {
        const named = new Set(items.flatMap((i) => [i.file, i.from && fileName(i.from, i.mode)]));
        for (const file of await pngsIn(baselines)) {
            if (named.has(file) || !BASELINE_NAME.test(file)) {
                continue;
            }
            const baseline = await readBaseline(join(baselines, file));
            const [id, mode = null] = file.slice(0, -4).split(".");
            await writeFile(join(out, "baselines", file), baseline);
            const r = classify({ baseline, first: null, threshold: DEFAULT_THRESHOLD, includeAA: false });
            items.push({
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
    }
    items.sort((a, b) => (a.file < b.file ? -1 : 1));
    const [first] = parts;
    const header = { ...first };
    for (const key of ["dir", "partial"]) {
        delete header[key];
    }
    const results = {
        ...header,
        project,
        capturedAt: parts.map((p) => p.capturedAt).sort()[0] ?? new Date().toISOString(),
        expected: items.length,
        complete: false,
        items,
    };
    problems.push(...validateResults({ ...results, complete: true }).slice(0, 20));
    results.complete = problems.length === 0;
    await writeResults(out, results);
    return { results, problems };
}
