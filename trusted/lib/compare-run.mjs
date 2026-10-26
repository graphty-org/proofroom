/**
 * Compare: judges a stream of capture lines against a project's baselines, one snapshot at a time.
 *
 * The lines come from capture's generator (`run`), from a capture's `capture.ndjson`, from
 * standard input (`capture --ndjson | compare --stdin`) or from a plain directory of PNGs that
 * any tool made (`imageLines`). Each snapshot is reported the moment it is judged: its result line
 * (result-line.mjs) is handed to `print` and appended to `<out>/results.ndjson`. When the lines
 * end, `results.json` is written once, and the JUnit file beside it.
 *
 * Compare never starts a browser. It reads the baselines (a Git LFS pointer is refused), the
 * project's renames.json and, when given, the default branch's newest capture (`reference`).
 *
 * A capture line is one JSON object: `type` is `start` (the capture's provenance and environment,
 * `stories`: every story id of the Storybook, `only`: the story id prefixes it was limited to, or
 * null), then one `image`, `failed` (with `reason`) or `excluded` (with `reason`, and `byStory`
 * when the story's own parameters exclude it) per snapshot and attempt, each with `id`, `mode`,
 * `file`, `sha256`, `size`, `settings` ({ threshold, includeAA, delay }) and `console`, and last
 * `end` (`complete`: every planned snapshot was shot). In memory an `image` line also carries its
 * PNG as `bytes`; on disk the PNG is `<captures>/<file>`.
 *
 * A story renamed in renames.json is compared with the baseline of its old id, mode by mode:
 * `moved` when it looks the same, `changed` otherwise, each carrying `from`; that old baseline is
 * then not reported `removed`. A rename whose new id is not a story is a `failed` item under the
 * new id, so the page lists it; one whose old id is still a story does nothing. A story whose own
 * parameters exclude it while it still has a baseline is reported `removed`, so a pull request
 * cannot drop a story from review without the owner seeing it.
 *
 * With `reference`, a directory holding the default branch's newest capture of the project, a
 * story with no baseline whose capture matches it is `unseeded`, not `new`: seeding is per story,
 * so a story nobody has accepted yet does not block every pull request, only one that changes it.
 *
 * The output directory gets the capture of every changed, moved, new and unseeded item, and
 * `baselines/<file>`: the baseline each changed and removed item was compared with (and a moved
 * item's, when its bytes differ from the capture's).
 */

import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { classify, DEFAULT_THRESHOLD, pngSize, readBaseline, sha256 } from "./compare.mjs";
import { junitFromResults } from "./junit.mjs";
import { itemsFromLines, resultLine } from "./result-line.mjs";
import { validateResults } from "./results.mjs";

const MAX_CONSOLE = 100;
const MAX_LINE = 2000;

/** The capture lines a capture appends, beside its images. */
export const CAPTURE_LINES = "capture.ndjson";
/** The result lines compare appends, beside results.json. */
export const RESULT_LINES = "results.ndjson";

/**
 * A console list as results.json holds it: at most 100 lines of at most 2000 characters.
 * @param {string[]} lines the lines
 * @returns {string[]} the kept lines
 */
export const clip = (lines) => lines.slice(0, MAX_CONSOLE).map((l) => l.slice(0, MAX_LINE));

/**
 * The PNG name of a story and mode.
 * @param {string} id the story id
 * @param {string | null} mode the mode name
 * @returns {string} `<id>.png` or `<id>.<mode>.png`
 */
export const fileName = (id, mode) => (mode === null ? `${id}.png` : `${id}.${mode}.png`);

export const EMPTY = {
    flaky: false,
    baseline: null,
    capture: null,
    size: null,
    baselineSize: null,
    changedPixels: null,
    bbox: null,
    console: [],
};

export const BASELINE_NAME = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?\.png$/;

/**
 * The PNG files in a directory.
 * @param {string} dir the directory
 * @returns {Promise<string[]>} their names, sorted; empty when the directory does not exist
 */
export async function pngsIn(dir) {
    try {
        return (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    } catch (e) {
        if (e.code === "ENOENT") {
            return [];
        }
        throw e;
    }
}

/**
 * Whether a project has any baseline PNG, which is what makes its results `seeded`.
 * @param {string} dir the project's baselines directory
 * @returns {Promise<boolean>} true when the directory holds a PNG
 */
export async function hasBaselines(dir) {
    return (await pngsIn(dir)).length > 0;
}

/** A project's renames file, in its baselines directory. */
const RENAMES = "renames.json";

const STORY_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Reads a project's renames file, `<dir>/renames.json`: `[{ "from": "<old story id>", "to":
 * "<new story id>" }]`, for stories whose id changed while they stayed the same story.
 * @param {string} dir the project's baselines directory
 * @returns {Promise<Map<string, string>>} the old id by new id; empty when there is no file
 */
export async function loadRenames(dir) {
    const path = join(dir, RENAMES);
    let list;
    try {
        list = JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
        if (e.code === "ENOENT") {
            return new Map();
        }
        throw new Error(`${path}: ${e.message}`);
    }
    if (!Array.isArray(list)) {
        throw new Error(`${path}: must be an array of { "from": "<old id>", "to": "<new id>" }`);
    }
    const byTo = new Map();
    const froms = new Set();
    list.forEach((r, i) => {
        const ok = (v) => typeof v === "string" && v.length <= 200 && STORY_ID.test(v);
        if (!ok(r?.from) || !ok(r?.to) || r.from === r.to) {
            throw new Error(`${path}: entry ${i} must be { "from": "<old id>", "to": "<another id>" }`);
        }
        if (byTo.has(r.to) || froms.has(r.from)) {
            throw new Error(`${path}: entry ${i} renames ${r.from} or to ${r.to} a second time`);
        }
        byTo.set(r.to, r.from);
        froms.add(r.from);
    });
    return byTo;
}

/**
 * Writes results.json atomically, so a reader never sees half a file.
 * @param {string} out the capture directory
 * @param {object} results the results
 * @returns {Promise<void>} once written
 */
export async function writeResults(out, results) {
    const tmp = join(out, "results.json.tmp");
    await writeFile(tmp, `${JSON.stringify(results, null, 2)}\n`);
    await rename(tmp, join(out, "results.json"));
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 }).trim();

/**
 * Which build of this tool ran: the commit of its source checkout when it runs from one (a
 * repository that develops it), else the installed package's name and version.
 * @returns {string} a commit sha, or `proofroom@<version>`
 */
export function toolVersion() {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8"));
    const installed = `${pkg.name}@${pkg.version}`;
    if (here.split(sep).includes("node_modules")) {
        return installed;
    }
    try {
        return git("-C", here, "rev-parse", "HEAD");
    } catch {
        return installed;
    }
}

/**
 * Where this run came from: GitHub Actions' environment in CI, the working tree locally. A local
 * preview of a pull request (tools/visual-preview.sh) sets VISUAL_REVIEW_PREVIEW_PR and
 * VISUAL_REVIEW_PREVIEW_HEAD while it captures the pull request's merge tree: the capture then names
 * the pull request and its head, and `local.preview` says which merge commit was built, where, and
 * with which build of this tool, so the review page can offer it for decisions before CI's lands.
 * @returns {Promise<object>} the commit, pull request and run fields of results.json, and `local`
 */
export async function provenance() {
    if (process.env.GITHUB_ACTIONS !== "true") {
        const diff = execFileSync("git", ["diff", "HEAD", "--binary"], { maxBuffer: 1 << 30 });
        const commit = git("rev-parse", "HEAD");
        const pr = Number(process.env.VISUAL_REVIEW_PREVIEW_PR) || null;
        const head = process.env.VISUAL_REVIEW_PREVIEW_HEAD ?? "";
        const preview = pr !== null && /^[0-9a-f]{40}$/.test(head);
        return {
            commit,
            headSha: preview ? head : null,
            pr: preview ? pr : null,
            runId: null,
            runAttempt: null,
            local: {
                describe: git("describe", "--always", "--dirty"),
                diff: sha256(diff),
                ...(preview && { preview: { merge: commit, host: hostname(), tool: toolVersion() } }),
            },
        };
    }
    const event = process.env.GITHUB_EVENT_PATH
        ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"))
        : {};
    return {
        commit: process.env.GITHUB_SHA,
        headSha: event.pull_request?.head?.sha ?? null,
        pr: event.pull_request?.number ?? null,
        runId: Number(process.env.GITHUB_RUN_ID),
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        local: null,
    };
}

/**
 * Reads an earlier capture's images of stories that had no baseline, to compare new captures with.
 * Only complete, valid results are used, and only `new` and `unseeded` items whose file hashes to
 * the capture results.json names.
 * @param {string | null} dir the earlier capture's directory, or null
 * @returns {Promise<{ images: Map<string, Buffer>, runId: number | null }>} images by file name
 */
export async function loadReference(dir) {
    const images = new Map();
    let results = null;
    try {
        results = dir ? JSON.parse(await readFile(join(dir, "results.json"), "utf8")) : null;
    } catch {
        // No reference downloaded: every story without a baseline is new.
    }
    if (!results || validateResults(results).length > 0 || !results.complete) {
        return { images, runId: null };
    }
    // Both statuses mean "captured with no baseline, hash recorded". Reading only `new` made a story
    // alternate: a run that matched its reference says `unseeded`, so the next run found no image
    // for it and said `new` again.
    for (const item of results.items.filter((i) => i.status === "new" || i.status === "unseeded")) {
        const bytes = await readFile(join(dir, item.file)).catch(() => null);
        if (bytes && sha256(bytes) === item.capture) {
            images.set(item.file, bytes);
        }
    }
    return { images, runId: results.runId };
}

/**
 * Reads JSON lines from a stream, one object per line; blank lines are skipped.
 * @param {NodeJS.ReadableStream} stream the stream, such as standard input or a file
 * @yields {any} each parsed line, as soon as it is read
 * @returns {AsyncGenerator<any>} the lines
 */
export async function* jsonLines(stream) {
    let n = 0;
    for await (const raw of createInterface({ input: stream, crlfDelay: Infinity })) {
        n++;
        if (raw.trim() === "") {
            continue;
        }
        try {
            yield JSON.parse(raw);
        } catch {
            throw new Error(`capture line ${n} is not JSON`);
        }
    }
}

/**
 * The capture lines of a capture directory's `capture.ndjson`.
 * @param {string} dir the capture directory
 * @returns {AsyncGenerator<any>} the lines
 */
export const captureLines = (dir) => jsonLines(createReadStream(join(dir, CAPTURE_LINES)));

/**
 * Capture lines for a plain directory of PNGs that any tool made, matched to the baselines by file
 * name (`<id>.png` or `<id>.<mode>.png`): one `image` line per PNG, between a `start` line naming
 * this checkout's commit and an `end` line. A PNG whose name is no story id is skipped.
 * @param {{ project: string, captures: string, threshold: number, includeAA: boolean,
 *     log?: (line: string) => void }} options the project name the results carry, the directory,
 *     and the comparison settings every image is judged with
 * @yields {object} the start line, one image line per PNG, the end line
 * @returns {AsyncGenerator<object>} the lines
 */
export async function* imageLines({ project, captures, threshold, includeAA, log = console.error }) {
    yield {
        type: "start",
        project,
        ...(await provenance().catch((err) => {
            throw new Error(`run compare inside a git checkout: results.json records its commit (${err.message})`);
        })),
        capturedAt: new Date().toISOString(),
        clock: {},
        environment: { tool: toolVersion() },
    };
    for (const file of await pngsIn(captures)) {
        if (!BASELINE_NAME.test(file)) {
            log(`skipped ${file}: not <story id>.png or <story id>.<mode>.png`);
            continue;
        }
        const [id, mode = null] = file.slice(0, -4).split(".");
        const bytes = await readFile(join(captures, file));
        yield {
            type: "image",
            project,
            id,
            mode,
            file,
            sha256: sha256(bytes),
            size: pngSize(bytes),
            settings: { threshold, includeAA, delay: 0 },
            console: [],
            bytes,
        };
    }
    yield { type: "end", project, complete: true };
}

/**
 * Checks the fields of a capture line that name a file, before any path is made from them.
 * @param {any} line the parsed line, untrusted
 * @param {string} project the project being compared
 * @returns {void}
 * @throws {Error} naming what is wrong
 */
function checkLine(line, project) {
    const ok =
        typeof line === "object" &&
        line !== null &&
        ["image", "failed", "excluded"].includes(line.type) &&
        line.project === project &&
        typeof line.id === "string" &&
        STORY_ID.test(line.id) &&
        (line.mode === null || (typeof line.mode === "string" && STORY_ID.test(line.mode))) &&
        line.file === fileName(line.id, line.mode) &&
        typeof line.settings?.threshold === "number" &&
        typeof line.settings?.includeAA === "boolean" &&
        Array.isArray(line.console);
    if (!ok) {
        throw new Error(`not a capture line of project ${project}: ${JSON.stringify(line).slice(0, 300)}`);
    }
}

/**
 * Judges a stream of capture lines and writes the results.
 * @param {{ project: string, baselines: string, captures: string, out: string,
 *     lines: AsyncIterable<any>, reference?: string | null, ids?: Set<string> | null,
 *     junit?: string | null, prune?: boolean, print?: (line: object) => void,
 *     onResult?: (result: object, line: object | null) => void,
 *     log?: (line: string) => void }} options `captures` is where an image line's PNG is when it
 *     carries no bytes; `ids` judges only these snapshots (`<id>` or `<id>.<mode>`), and then
 *     neither removed baselines, results.json nor JUnit are written; `junit` is the JUnit file's
 *     path (default `<out>/junit.xml`, null for none); `prune` deletes the capture of a snapshot
 *     that needs no image from `out`, for a capture that wrote it there (`run`); `onResult` sees
 *     every result line with the capture line it judged (null for a removed baseline or a broken
 *     rename) before the next line is read
 * @returns {Promise<{ results: object | null, passed: boolean, lines: object[] }>} results.json's
 *     contents (null with `ids`), whether every snapshot passed, and every result line
 */
export async function compareRun({
    project,
    baselines,
    captures,
    out,
    lines,
    reference = null,
    ids = null,
    junit = join(out, "junit.xml"),
    prune = false,
    print = () => {},
    onResult = () => {},
    log = console.error,
}) {
    await mkdir(join(out, "baselines"), { recursive: true });
    // A run of a few snapshots (`ids`) adds its lines to the run they belong to.
    if (!ids) {
        await writeFile(join(out, RESULT_LINES), "");
    }
    const renames = await loadRenames(baselines);
    const refs = await loadReference(reference);
    const existing = new Set(await pngsIn(baselines));
    const seeded = existing.size > 0;
    const written = [];
    const attempts = new Map();
    // Baselines a line named (its own, or the old id's it was compared with): not removed.
    const named = new Set();
    const newlyExcluded = new Set();
    let start = null;
    let end = null;
    // Every story id of the Storybook, from the start line; null for a plain directory of images.
    let known = null;

    const report = async (item, line) => {
        const attempt = (attempts.get(item.file) ?? 0) + 1;
        attempts.set(item.file, attempt);
        const result = resultLine(item, { project, attempt });
        written.push(result);
        await appendFile(join(out, RESULT_LINES), `${JSON.stringify(result)}\n`);
        print(result);
        if (!result.passed) {
            log(`${item.status} ${item.file}${item.reason ? `: ${item.reason}` : ""}`);
        }
        onResult(result, line);
    };

    /**
     * The old id a renamed story is compared under, in this mode, or null.
     * @param {string} id the story id
     * @param {string | null} mode the mode
     * @returns {string | null} the old id, while the new id has no baseline of its own
     */
    const renamedFrom = (id, mode) => {
        const old = renames.get(id);
        // A rename from an id that is still a story is not a move: it does nothing.
        if (!old || !known || known.has(old)) {
            return null;
        }
        return !existing.has(fileName(id, mode)) && existing.has(fileName(old, mode)) ? old : null;
    };

    const judge = async (line) => {
        const { id, mode, file, settings } = line;
        const common = { id, mode, file, threshold: settings.threshold, includeAA: settings.includeAA };
        if (line.type === "excluded") {
            if (line.byStory === true && existing.has(file)) {
                newlyExcluded.add(file);
                return;
            }
            named.add(file);
            await report({ ...common, ...EMPTY, status: "excluded", reason: line.reason ?? "excluded" }, line);
            return;
        }
        const from = renamedFrom(id, mode);
        named.add(file);
        if (from) {
            named.add(fileName(from, mode));
        }
        const withFrom = from ? { ...common, from } : common;
        const baseline = await readBaseline(join(baselines, from ? fileName(from, mode) : file));
        if (line.type === "failed") {
            await rm(join(out, "baselines", file), { force: true });
            if (prune) {
                await rm(join(out, file), { force: true });
            }
            await report(
                {
                    ...withFrom,
                    ...EMPTY,
                    baseline: baseline && sha256(baseline),
                    status: "failed",
                    reason: String(line.reason ?? "failed").slice(0, MAX_LINE),
                    console: clip(line.console),
                },
                line,
            );
            return;
        }
        const bytes =
            line.bytes ??
            (await readFile(join(captures, file)).catch((e) => {
                if (e.code === "ENOENT") {
                    return null;
                }
                throw e;
            }));
        if (bytes === null) {
            await report(
                {
                    ...withFrom,
                    ...EMPTY,
                    baseline: baseline && sha256(baseline),
                    status: "failed",
                    reason: `the capture has no image ${file}: run removes the images of snapshots that need no review`,
                    console: [],
                },
                line,
            );
            return;
        }
        const r = classify({
            baseline,
            first: bytes,
            reference: baseline ? null : (refs.images.get(file) ?? null),
            threshold: settings.threshold,
            includeAA: settings.includeAA,
            moved: from !== null,
        });
        // A moved capture is also its baseline when the bytes are the same: the page reads it.
        if (["changed", "moved", "new", "unseeded"].includes(r.status)) {
            if (join(captures, file) !== join(out, file)) {
                await writeFile(join(out, file), bytes);
            }
        } else if (prune) {
            await rm(join(out, file), { force: true });
        }
        const ownBaseline = r.status === "moved" && r.baseline !== r.capture;
        if (baseline && (r.status === "changed" || ownBaseline)) {
            await writeFile(join(out, "baselines", file), baseline);
        } else {
            await rm(join(out, "baselines", file), { force: true });
        }
        const console = r.status === "unchanged" || r.status === "moved" ? [] : clip(line.console);
        await report({ ...withFrom, ...r, reason: null, console }, line);
    };

    try {
        for await (const line of lines) {
            if (start === null) {
                if (line?.type !== "start" || line.project !== project) {
                    throw new Error(`the capture lines must begin with project ${project}'s start line`);
                }
                start = line;
                known = Array.isArray(line.stories) ? new Set(line.stories) : null;
                if (!ids) {
                    await renameErrors();
                }
                continue;
            }
            if (line?.type === "end") {
                end = line;
                break;
            }
            checkLine(line, project);
            if (!ids || ids.has(line.file.slice(0, -4))) {
                await judge(line);
            }
        }
    } catch (err) {
        // What was judged before the tool failed stays readable, marked incomplete.
        if (start && !ids) {
            await finish(false).catch(() => {});
        }
        throw err;
    }
    if (start === null) {
        throw new Error("no capture lines: the capture did not start");
    }
    const passed = () => written.every((l) => l.passed);
    if (ids) {
        return { results: null, passed: passed(), lines: written };
    }
    // Every baseline nothing named, once the whole capture has been seen.
    if (end?.complete === true && !start.only) {
        await removedBaselines();
    }
    const results = await finish(end?.complete === true);
    return { results, passed: passed(), lines: written };

    /**
     * Writes results.json once, and the JUnit file.
     * @param {boolean} complete whether the whole capture was judged
     * @returns {Promise<object>} the results
     */
    async function finish(complete) {
        const header = { ...start };
        for (const key of ["type", "stories", "only"]) {
            delete header[key];
        }
        const items = itemsFromLines(written).get(project) ?? [];
        const results = {
            version: 1,
            ...header,
            project,
            seeded,
            reference: refs.runId,
            complete,
            expected: items.length,
            items,
        };
        // Validated before it is saved, so an invalid file is never uploaded.
        const problems = validateResults(results);
        if (problems.length > 0) {
            throw new Error(`results.json is invalid:\n${problems.slice(0, 20).join("\n")}`);
        }
        await writeResults(out, results);
        if (junit) {
            await writeFile(junit, junitFromResults(results));
        }
        return results;
    }

    /**
     * Reports every baseline no line named as removed, with the image it was compared with.
     * @returns {Promise<void>} once reported
     */
    async function removedBaselines() {
        for (const file of [...existing].filter((f) => !named.has(f) && BASELINE_NAME.test(f))) {
            const baseline = await readBaseline(join(baselines, file));
            const [id, mode = null] = file.slice(0, -4).split(".");
            await writeFile(join(out, "baselines", file), baseline);
            await report(
                {
                    id,
                    mode,
                    file,
                    ...classify({ baseline, first: null, threshold: DEFAULT_THRESHOLD, includeAA: false }),
                    threshold: DEFAULT_THRESHOLD,
                    includeAA: false,
                    reason: newlyExcluded.has(file) ? "the story's parameters now set disableSnapshot" : null,
                    console: [],
                },
                null,
            );
        }
    }

    /**
     * Reports each rename to a story id the Storybook does not have, while its old id still has a
     * baseline: the page lists it as failed under the new id, so it gets fixed.
     * @returns {Promise<void>} once reported
     */
    async function renameErrors() {
        if (!known || start.only) {
            return;
        }
        for (const [to, from] of renames) {
            if (known.has(to)) {
                continue;
            }
            // Only a rename with an old baseline left to move is an error; once it is accepted the
            // old baselines are gone, and the entry does nothing.
            for (const file of existing) {
                const [id, mode = null] = file.slice(0, -4).split(".");
                if (id === from && BASELINE_NAME.test(file)) {
                    named.add(file);
                    await report(
                        {
                            id: to,
                            mode,
                            file: fileName(to, mode),
                            from,
                            threshold: DEFAULT_THRESHOLD,
                            includeAA: false,
                            ...EMPTY,
                            status: "failed",
                            reason: `${RENAMES} renames ${from} to ${to}, but the Storybook has no story ${to}: fix ${RENAMES}`,
                        },
                        null,
                    );
                }
            }
        }
    }
}
