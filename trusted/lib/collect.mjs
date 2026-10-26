/**
 * collect: the result lines of one project's test runs (one directory per shard or runner, written
 * by compareSnapshot() in any test runner, or by the vitest adapter) combined into the
 * results.json, images, baselines and JUnit file a capture directory holds, so `serve` and `gate`
 * read it as they read compare's.
 *
 * Each directory holds result-line files, `results-<pid>-<thread>.ndjson`, one per process. Over
 * all of them, the last attempt of each snapshot is its item and the earlier ones its `attempts`.
 * A directory the vitest adapter wrote also holds one `run-<pid>-<n>.json` per vitest run (a rerun of
 * the failed story files into the same directory adds one): which shard it was, the project's
 * story files and those it ran, and whether every story test that ran reached the visual step.
 *
 * The result is complete only when no snapshot is in two directories and, when the directories
 * have run files, every shard 1..count is there once, between them they ran every story file of
 * the project once, each reported every story test it ran and all come from one commit. Then
 * every baseline no item names is reported `removed`. Otherwise it is written with `complete:
 * false`, which the gate refuses, and the problems are returned. A directory without run files
 * (a runner other than the vitest adapter) cannot say that its run finished: collect it once the
 * runner has ended.
 */

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { classify, DEFAULT_THRESHOLD, readBaseline } from "./compare.mjs";
import { BASELINE_NAME, fileName, pngsIn, provenance, toolVersion, writeResults } from "./compare-run.mjs";
import { junitFromResults } from "./junit.mjs";
import { itemsFromLines, parseResultLines } from "./result-line.mjs";
import { validateResults } from "./results.mjs";

const LINE_FILE = /^results-\d+-\d+\.ndjson$/;
const RUN_FILE = /^run-\d+-\d+\.json$/;
/** What a run file says about its run, beside the capture header results.json takes from it. */
const RUN_KEYS = ["project", "shard", "reported", "missing", "files", "ran"];

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
 * The files of a directory whose names match a pattern.
 * @param {string} dir the directory
 * @param {RegExp} pattern the names
 * @returns {Promise<string[]>} the names, sorted
 */
const named = async (dir, pattern) => (await readdir(dir)).filter((f) => pattern.test(f)).sort();

/**
 * Reads one directory: its result lines and its run files.
 * @param {string} dir the directory
 * @returns {Promise<{ dir: string, lines: object[], runs: object[] }>} what it holds
 */
async function readDir(dir) {
    const lines = [];
    for (const f of await named(dir, LINE_FILE)) {
        try {
            lines.push(...parseResultLines(await readFile(join(dir, f), "utf8")));
        } catch (err) {
            throw new Error(`${join(dir, f)}: ${err.message}`);
        }
    }
    const runs = [];
    for (const f of await named(dir, RUN_FILE)) {
        runs.push(JSON.parse(await readFile(join(dir, f), "utf8")));
    }
    return { dir, lines, runs };
}

/**
 * One directory's runs as one: its shard, its story files, every file any of its runs ran, and
 * whether each reported every story test it ran.
 * @param {{ dir: string, runs: object[] }} part the directory
 * @param {string[]} problems where a disagreement between its runs is reported
 * @returns {{ shard: object, files: string[], ran: string[], reported: boolean, missing: string[] }} the shard's run
 */
function shardOf({ dir, runs }, problems) {
    const [first] = runs;
    if (runs.some((r) => JSON.stringify([r.shard, r.files]) !== JSON.stringify([first.shard, first.files]))) {
        problems.push(`${dir}: its runs disagree on the shard or the story files`);
    }
    return {
        shard: first.shard,
        files: first.files,
        ran: [...new Set(runs.flatMap((r) => r.ran ?? []))].sort((a, b) => a.localeCompare(b)),
        reported: runs.every((r) => r.reported === true),
        missing: [...new Set(runs.flatMap((r) => r.missing ?? []))].sort((a, b) => a.localeCompare(b)),
    };
}

/**
 * Why the shards are not exactly shards 1..count, once each.
 * @param {object[]} shards each directory's shard run
 * @returns {string[]} one message per problem
 */
function shardProblems(shards) {
    const counts = new Set(shards.map((s) => s.shard?.count));
    const [count] = counts;
    if (counts.size !== 1 || !Number.isInteger(count)) {
        return [`the runs disagree on the number of shards (${[...counts].join(", ")})`];
    }
    const problems = [];
    for (let i = 1; i <= count; i++) {
        const n = shards.filter((s) => s.shard.index === i).length;
        if (n === 0) {
            problems.push(`shard ${i} of ${count}: missing`);
        } else if (n > 1) {
            problems.push(`shard ${i} of ${count}: ${n} directories`);
        }
    }
    return problems;
}

/**
 * Why the shards did not, between them, run every story file of the project exactly once (a
 * filtered run, a file that failed to load, a shard run twice).
 * @param {object[]} shards each directory's shard run
 * @returns {string[]} one message per problem, at most a few files named
 */
function fileProblems(shards) {
    const files = shards[0]?.files;
    if (!Array.isArray(files) || shards.some((s) => !Array.isArray(s.files))) {
        return ["a run does not list the project's story files"];
    }
    if (shards.some((s) => JSON.stringify(s.files) !== JSON.stringify(files))) {
        return ["the runs list different story files"];
    }
    const runs = new Map(files.map((f) => [f, 0]));
    for (const f of shards.flatMap((s) => s.ran)) {
        runs.set(f, (runs.get(f) ?? 0) + 1);
    }
    const unrun = [...runs].filter(([, n]) => n === 0).map(([f]) => f);
    const twice = [...runs].filter(([, n]) => n > 1).map(([f]) => f);
    const list = (l) => l.slice(0, 5).join(", ") + (l.length > 5 ? ` and ${l.length - 5} more` : "");
    return [
        ...(unrun.length > 0 ? [`${unrun.length} story files did not run or failed to load: ${list(unrun)}`] : []),
        ...(twice.length > 0 ? [`story files ran in more than one shard: ${list(twice)}`] : []),
    ];
}

/**
 * Why the directories' runs are not a whole run of the project.
 * @param {string} project the project
 * @param {{ dir: string, runs: object[] }[]} parts the directories
 * @returns {{ problems: string[], header: object | null }} the problems, and the capture header of
 *     the first run (null when no directory has a run file)
 */
function runProblems(project, parts) {
    if (parts.every((p) => p.runs.length === 0)) {
        return { problems: [], header: null };
    }
    const problems = parts
        .filter((p) => p.runs.length === 0)
        .map((p) => `${p.dir}: no run file: its run did not finish`);
    const withRuns = parts.filter((p) => p.runs.length > 0);
    for (const { dir, runs } of withRuns) {
        for (const r of runs.filter((r) => r.project !== project)) {
            problems.push(`${dir}: a run of ${r.project}, not ${project}`);
        }
    }
    const shards = withRuns.map((p) => ({ dir: p.dir, ...shardOf(p, problems) }));
    problems.push(...shardProblems(shards), ...fileProblems(shards));
    for (const s of shards.filter((s) => !s.reported)) {
        const missing = s.missing.slice(0, 5).join(", ");
        problems.push(`${s.dir}: incomplete${missing ? `: no visual step for ${missing}` : ""}`);
    }
    const runs = withRuns.flatMap((p) => p.runs);
    if (new Set(runs.map((r) => r.commit)).size > 1) {
        problems.push("the runs come from different commits");
    }
    const header = { ...runs[0] };
    for (const key of RUN_KEYS) {
        delete header[key];
    }
    header.capturedAt = runs.map((r) => r.capturedAt).sort((a, b) => a.localeCompare(b))[0];
    return { problems, header };
}

/**
 * A `removed` item for every baseline no item drew or was compared with, as compare reports it.
 * @param {object[]} items the collected items
 * @param {string} baselines the project's baselines directory
 * @param {string} out the collected capture's directory, which gets each removed baseline
 * @returns {Promise<object[]>} the removed items
 */
async function removedItems(items, baselines, out) {
    const drew = new Set(items.flatMap((i) => [i.file, i.from && fileName(i.from, i.mode)]));
    const removed = [];
    for (const file of await pngsIn(baselines)) {
        if (drew.has(file) || !BASELINE_NAME.test(file)) {
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
 * Collects one project's result lines into a capture directory.
 * @param {{ project: string, baselines: string, out: string, dirs: string[], junit?: string | null }} options
 *     the project, its baselines directory, where the capture goes, the directories the runs
 *     wrote, and the JUnit file's path (default `<out>/junit.xml`, null for none)
 * @returns {Promise<{ results: object, problems: string[] }>} the results and why they are not
 *     complete (empty when they are)
 */
export async function collect({ project, baselines, out, dirs, junit = join(out, "junit.xml") }) {
    const parts = await Promise.all(dirs.map(readDir));
    const { problems, header } = runProblems(project, parts);
    await mkdir(join(out, "baselines"), { recursive: true });
    const lines = [];
    const where = new Map();
    // A directory named twice is reported as a repeated shard; its lines count once.
    for (const { dir, lines: own } of parts.filter((p, i) => parts.findIndex((q) => q.dir === p.dir) === i)) {
        for (const line of own) {
            if (line.project !== project) {
                problems.push(`${dir}: a result of ${line.project}, not ${project}`);
                continue;
            }
            const seen = where.get(line.file);
            if (seen && seen !== dir) {
                problems.push(`${line.file} is in ${seen} and ${dir}`);
                continue;
            }
            where.set(line.file, dir);
            lines.push(line);
        }
    }
    const items = itemsFromLines(lines).get(project) ?? [];
    for (const item of items) {
        for (const sub of ["", "baselines"]) {
            await copyIfThere(join(where.get(item.file), sub, item.file), join(out, sub, item.file));
        }
    }
    if (problems.length === 0) {
        items.push(...(await removedItems(items, baselines, out)));
    }
    items.sort((a, b) => (a.file < b.file ? -1 : 1));
    const results = {
        version: 1,
        ...(header ?? {
            ...(await provenance()),
            capturedAt: new Date().toISOString(),
            clock: {},
            environment: { tool: toolVersion() },
        }),
        project,
        seeded: (await pngsIn(baselines)).length > 0,
        reference: null,
        complete: false,
        expected: items.length,
        items,
    };
    problems.push(...validateResults({ ...results, complete: true }).slice(0, 20));
    results.complete = problems.length === 0;
    await writeResults(out, results);
    if (junit) {
        await writeFile(junit, junitFromResults(results));
    }
    return { results, problems };
}
