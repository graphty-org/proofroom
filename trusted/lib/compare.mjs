/**
 * Comparison: is a capture the same as its baseline?
 *
 * The SHA-256 of the PNG bytes decides first; only when the bytes differ are both images decoded
 * and compared with pixelmatch at the story's threshold. A bounding box is [x, y, width, height].
 *
 * Published as `proofroom/compare`, for Node with no browser: `compareSnapshot()` judges one
 * snapshot and returns its result line, and `assertSnapshot()` also throws Node's own
 * `AssertionError` when the snapshot did not pass, so any test runner can report and retry it.
 */

import { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { threadId } from "node:worker_threads";

// ponytail: pngjs until milestone 3 needs a dependency-free decoder
import { PNG } from "pngjs";

import { grow, regions } from "../page/spot.js";
import pixelmatch from "../vendor/pixelmatch.mjs";
import { checkLine, fileName, judgeLine, judgeSources, loadSettings, storySettings } from "./compare-run.mjs";
import { CONFIG_FILE, loadConfig, repoRoot } from "./config.mjs";
import { outcome, resultLine } from "./result-line.mjs";
import { MAX_AREAS } from "./results.mjs";

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
 * @param {{ threshold: number, includeAA: boolean, areas?: boolean, moved?: boolean }} options
 *     pixelmatch's threshold (0..1) and whether anti-aliased pixels count as changed; `areas` also
 *     finds the changed areas of a pair with changed pixels (or of any pair whose bytes differ,
 *     with `moved`), as the server's pictures find them
 * @returns {{ status: "unchanged" | "changed", baseline: string, capture: string,
 *     size: number[] | null, baselineSize: number[] | null, changedPixels: number,
 *     bbox: number[] | null, exact: boolean, areas?: number[][] }} sizes are [width, height];
 *     `exact` is whether every RGBA byte of the capture is the baseline's, which equal bytes imply
 *     and the threshold ignores; `areas` the changed areas, largest first, when asked for
 */
export function compareImages(baseline, capture, { threshold, includeAA, areas = false, moved = false }) {
    const hashes = { baseline: sha256(baseline), capture: sha256(capture) };
    if (hashes.baseline === hashes.capture) {
        const size = pngSize(capture);
        return { status: "unchanged", ...hashes, size, baselineSize: size, changedPixels: 0, bbox: null, exact: true };
    }
    const a = PNG.sync.read(baseline);
    const b = PNG.sync.read(capture);
    const { changedPixels, bbox, mask } = diffPixels(a, b, { threshold, includeAA });
    const sameSize = a.width === b.width && a.height === b.height;
    // Of the mask the diff already made when both are one size; otherwise of both padded, as the
    // server's picture job pads them.
    const found =
        areas && (changedPixels > 0 || moved)
            ? sameSize
                ? areasOf(mask, a.width, a.height)
                : areasOf(paddedPair(a, b, { threshold, includeAA }).mask, Math.max(a.width, b.width), Math.max(a.height, b.height))
            : null;
    return {
        status: changedPixels === 0 ? "unchanged" : "changed",
        ...hashes,
        size: [b.width, b.height],
        baselineSize: [a.width, a.height],
        changedPixels,
        bbox,
        exact: sameSize && a.data.equals(b.data),
        ...(found && { areas: found }),
    };
}

/**
 * The changed areas of a pixelmatch mask: its changed pixels grown by GROW (spot.js), each separate
 * region's box, largest first, at most as many as results.json holds.
 * @param {ArrayLike<number>} mask RGBA, a changed pixel opaque
 * @param {number} w its width
 * @param {number} h its height
 * @returns {number[][]} the boxes, each [x, y, width, height]
 */
export const areasOf = (mask, w, h) => regions(grow(mask, w, h), w, h).slice(0, MAX_AREAS);

/**
 * Both decoded images padded top-left with transparent pixels to the larger size, as the page pads
 * them, and pixelmatch's mask of the two.
 * @param {{ width: number, height: number, data: Buffer }} a the decoded baseline
 * @param {{ width: number, height: number, data: Buffer }} b the decoded capture
 * @param {{ threshold: number, includeAA: boolean }} options pixelmatch's settings
 * @returns {{ width: number, height: number, pa: Buffer, pb: Buffer, mask: Buffer }} the size, both
 *     padded images' RGBA, and the mask (a changed pixel opaque)
 */
export function paddedPair(a, b, { threshold, includeAA }) {
    const width = Math.max(a.width, b.width);
    const height = Math.max(a.height, b.height);
    const pad = (img) => {
        if (img.width === width && img.height === height) {
            return img.data;
        }
        const out = Buffer.alloc(width * height * 4);
        for (let y = 0; y < img.height; y++) {
            img.data.copy(out, y * width * 4, y * img.width * 4, (y + 1) * img.width * 4);
        }
        return out;
    };
    const [pa, pb] = [pad(a), pad(b)];
    const mask = Buffer.alloc(width * height * 4);
    pixelmatch(pa, pb, mask, width, height, { threshold, includeAA, diffMask: true });
    return { width, height, pa, pb, mask };
}

/**
 * Counts the pixels that differ. Images of different sizes are compared over their top-left
 * overlap, and every pixel of the larger canvas outside that overlap counts as changed.
 * @param {PNG} a the decoded baseline
 * @param {PNG} b the decoded capture
 * @param {{ threshold: number, includeAA: boolean }} options pixelmatch's settings
 * @returns {{ changedPixels: number, bbox: number[] | null, mask: Buffer }} the count, the box
 *     around them, and pixelmatch's mask of the overlap
 */
function diffPixels(a, b, options) {
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    const W = Math.max(a.width, b.width);
    const H = Math.max(a.height, b.height);
    const mask = Buffer.alloc(w * h * 4);
    let changedPixels = pixelmatch(crop(a, w, h), crop(b, w, h), mask, w, h, { ...options, diffMask: true });

    let [x0, y0, x1, y1] = [W, H, -1, -1];
    const extend = (x, y) => {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    };
    if (changedPixels > 0) {
        // With diffMask, pixelmatch paints only the counted pixels, so opaque means changed.
        for (let i = 3; i < mask.length; i += 4) {
            if (mask[i] !== 0) {
                extend(((i - 3) / 4) % w, Math.floor((i - 3) / 4 / w));
            }
        }
    }
    const padding = W * H - w * h;
    if (padding > 0) {
        changedPixels += padding;
        // The padding is the canvas outside the overlap: right of it, below it, or both.
        if (W > w) {
            extend(w, 0);
            extend(W - 1, H - 1);
        }
        if (H > h) {
            extend(0, h);
            extend(W - 1, H - 1);
        }
    }
    return { changedPixels, bbox: x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1], mask };
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
 * Classifies one snapshot from its baseline and its capture. Each capture is judged on its own:
 * a snapshot is shot once per attempt, and retrying is the caller's choice (`run --retries`, or
 * the user's test runner).
 *
 * A story with no baseline is `unseeded` ("no baseline yet") when its capture matches
 * `reference`, master's newest capture of it: the pull request did not change it, so it needs no
 * review here. It is `new` when it differs from master's, or master has none (a new story).
 *
 * `moved` says the baseline is another story id's, named in the project's renames.json: a story
 * that only moved (same image, new id) is `moved` rather than `unchanged`, so it still needs an
 * accept, which writes its baseline under the new name.
 * @param {{ baseline: Buffer | null, first: Buffer | null, reference?: Buffer | null,
 *     threshold: number, includeAA: boolean, moved?: boolean }} input `first` is the capture, null
 *     when the story is gone (named as when a story was shot twice)
 * @returns {{ status: "unchanged" | "moved" | "changed" | "new" | "unseeded" | "removed", flaky: boolean,
 *     baseline: string | null, capture: string | null, size: number[] | null,
 *     baselineSize: number[] | null, changedPixels: number | null, bbox: number[] | null,
 *     areas?: number[][] }} `flaky` is always false, kept for the gates of older versions, which
 *     require it; `areas` are a changed (or moved, other bytes) pair's changed areas, largest first
 */
export function classify({ baseline, first, reference = null, threshold, includeAA, moved = false }) {
    const options = { threshold, includeAA };
    const none = { flaky: false, size: null, baselineSize: null, changedPixels: null, bbox: null };
    if (first === null) {
        return { status: "removed", ...none, baseline: sha256(baseline), capture: null };
    }
    if (baseline === null) {
        const same = reference !== null && compareImages(reference, first, options).status === "unchanged";
        return {
            status: same ? "unseeded" : "new",
            ...none,
            baseline: null,
            capture: sha256(first),
            size: pngSize(first),
        };
    }
    // The changed areas of a pair the page shows as one: changed, or moved with other bytes.
    const r = compareImages(baseline, first, { ...options, areas: true, moved });
    const status = r.status === "unchanged" && moved ? "moved" : r.status;
    return { ...r, status, flaky: false };
}

/**
 * Reads a PNG's dimensions.
 * @param {Buffer} bytes PNG bytes
 * @returns {number[]} [width, height], read from the IHDR chunk without decoding the image
 */
export function pngSize(bytes) {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/** The result-line files compareSnapshot() appends to: one per process and thread. */
const LINE_FILE = /^results-\d+-\d+\.ndjson$/;

/** Attempts counted without an output directory, by baselines directory, project and file. */
const counted = new Map();
/** Per output directory, per result-line file: how far it was read, which file it was, its attempts. */
const readSoFar = new Map();
/** One count-and-append at a time per output directory, so two calls never take one attempt. */
const turns = new Map();

/**
 * How many attempts of a snapshot the output directory already holds, from every process's
 * result-line file (a runner that retries in a new worker process counts on). Each file is read
 * only past where the last call stopped; a file that is gone, shorter or another file (the
 * directory was emptied for a new run) is counted again from its start.
 * @param {string} out the output directory
 * @param {string} key `<project>\0<file>`
 * @returns {Promise<number>} the attempts so far
 */
async function attemptsIn(out, key) {
    const files = readSoFar.get(out) ?? new Map();
    readSoFar.set(out, files);
    const names = (await readdir(out)).filter((f) => LINE_FILE.test(f));
    for (const name of files.keys()) {
        if (!names.includes(name)) files.delete(name);
    }
    let total = 0;
    for (const name of names) {
        const handle = await open(join(out, name), "r");
        try {
            const { size, ino, birthtimeMs } = await handle.stat();
            const was = files.get(name);
            const same = was && was.ino === ino && was.birthtimeMs === birthtimeMs && size >= was.offset;
            const state = same ? was : { offset: 0, ino, birthtimeMs, attempts: new Map() };
            files.set(name, state);
            const { buffer } = await handle.read({ buffer: Buffer.alloc(size - state.offset), position: state.offset });
            const text = buffer.toString("utf8");
            // Only whole lines: another process may be writing the last one.
            const whole = text.slice(0, text.lastIndexOf("\n") + 1);
            state.offset += Buffer.byteLength(whole);
            for (const raw of whole.split("\n").filter(Boolean)) {
                const line = JSON.parse(raw);
                const k = `${line.project}\0${line.file}`;
                state.attempts.set(k, (state.attempts.get(k) ?? 0) + 1);
            }
            total += state.attempts.get(key) ?? 0;
        } finally {
            await handle.close();
        }
    }
    return total;
}

/** What compareSnapshot() read from disk, by baselines and reference directory, with its stamp. */
const sources = new Map();
/** The repository root of each working directory. */
const roots = new Map();
/** Each root's config, with its stamp. */
const configs = new Map();

/**
 * When a file or directory last changed, so a cached read of it is redone only after a change.
 * @param {string[]} paths the paths
 * @returns {Promise<string>} their modification times; a missing path stamps as nothing
 */
const stampOf = async (paths) =>
    (
        await Promise.all(
            paths.map((p) =>
                stat(p, { bigint: true }).then(
                    (s) => s.mtimeNs,
                    () => null,
                ),
            ),
        )
    ).join(",");

/**
 * Reads once what a run of calls shares, and again only when it changed on disk: one call then
 * costs what one item of compare costs, however many baselines and reference images there are.
 * @template T
 * @param {Map<string, { stamp: string, value: T }>} cache the cache
 * @param {string} key what was read
 * @param {string[]} paths the files it was read from
 * @param {() => Promise<T> | T} read reads it
 * @returns {Promise<T>} what was read
 */
async function cached(cache, key, paths, read) {
    const stamp = await stampOf(paths);
    const hit = cache.get(key);
    if (hit?.stamp === stamp) {
        return hit.value;
    }
    const value = await read();
    cache.set(key, { stamp, value });
    return value;
}

/**
 * The baselines directory of a project of the config.
 * @param {string} project the project
 * @param {string | undefined} root the checkout, or undefined for the current one
 * @returns {Promise<string>} its baselines directory
 */
async function projectBaselines(project, root) {
    const cwd = process.cwd();
    if (root === undefined && !roots.has(cwd)) {
        roots.set(cwd, repoRoot(cwd));
    }
    const top = root ?? roots.get(cwd);
    const config = await cached(configs, top, [join(top, CONFIG_FILE)], () => loadConfig(top));
    if (!Object.hasOwn(config.projects, project)) {
        throw new Error(`compareSnapshot: no project ${project} in the config`);
    }
    return join(top, config.baselines, project);
}

/**
 * Runs `work` after every earlier turn for the same directory has ended.
 * @template T
 * @param {string} out the output directory
 * @param {() => Promise<T>} work the count and the append
 * @returns {Promise<T>} what `work` returns
 */
function inTurn(out, work) {
    const next = (turns.get(out) ?? Promise.resolve()).then(work);
    turns.set(
        out,
        next.catch(() => undefined),
    );
    return next;
}

/**
 * Judges one snapshot against its baseline, as compare judges one capture line (the same code),
 * and returns its result line. A difference is never thrown: only a failure of the tool is (a
 * baseline that is a Git LFS pointer, a bad story id). A second call for the same snapshot in the
 * same run is its next attempt.
 *
 * With `out` (or the environment variable `PROOFROOM_OUT`), the line is appended to
 * `<out>/results-<pid>-<threadId>.ndjson`, so parallel workers never write to one file, and the
 * images the review page needs are written there: the capture unless it is unchanged, and the
 * baseline it was compared with when it changed. `proofroom collect` turns those directories into
 * the capture the page and the gate read.
 * @param {{ project?: string, baselines?: string, root?: string, id: string, mode?: string | null,
 *     image?: Buffer | string | object | null, type?: "image" | "failed" | "excluded", reason?: string | null,
 *     byStory?: boolean, console?: string[], settings?: { threshold?: number, includeAA?: boolean },
 *     reference?: string | null, out?: string | null }} options `project` names a project of
 *     visual-review.config.json (in the git checkout `root`, default the current one), whose baselines
 *     and story settings files are read; `baselines` is a directory of baselines instead (the
 *     project then defaults to `images`); `image` is the PNG's bytes or path; without it (or with
 *     `type: "failed"`) the snapshot is reported as not shot, with `reason`; `settings` gives the
 *     threshold and anti-aliasing switch where the story's settings file sets none (its
 *     `disableSnapshot` always applies); `image` may also be openCapture()'s shot, whose fields are
 *     then the options; `reference` is the default
 *     branch's capture, for "no baseline yet"
 * @returns {Promise<object | null>} the result line: a results.json item with `project`, `attempt`
 *     and `passed`; null for a story its own parameters exclude while it has a baseline
 */
export async function compareSnapshot(options) {
    if (isShot(options.image)) {
        // openCapture()'s shoot() result passed as the image: { ...story, image: await cam.shoot(story) }.
        return compareSnapshot({ ...options, ...options.image });
    }
    const { id, mode = null, image = null, reference = null, console = [] } = options;
    const project = options.project ?? "images";
    let baselines = options.baselines;
    if (!baselines) {
        if (!options.project) {
            throw new Error("compareSnapshot needs a project or a baselines directory");
        }
        baselines = await projectBaselines(project, options.root);
    }
    const out = options.out ?? process.env.PROOFROOM_OUT ?? null;
    const file = typeof id === "string" ? fileName(id, mode) : null;
    // The id names files under the baselines: check it before reading any of them.
    checkLine(
        { type: "failed", project, id, mode, file, settings: { threshold: 0, includeAA: false }, console },
        project,
    );
    // The story settings file is part of the approved baselines: every key it sets wins.
    const asked = { diffThreshold: options.settings?.threshold, diffIncludeAntiAliasing: options.settings?.includeAA };
    const fromFile = storySettings({ chromatic: asked }, await loadSettings(baselines, id));
    const settings = { threshold: fromFile.threshold, includeAA: fromFile.includeAA };
    let type = options.type ?? (image === null ? "failed" : "image");
    let reason = options.reason ?? null;
    if (type !== "excluded" && fromFile.disableSnapshot) {
        [type, reason] = ["excluded", fromFile.reason];
    }
    const line = {
        type,
        project,
        id,
        mode,
        file,
        settings,
        console,
        reason: type === "failed" ? (reason ?? "the snapshot has no image") : reason,
        ...(options.byStory === true && { byStory: true }),
        ...(type === "image" && { bytes: typeof image === "string" ? await readFile(image) : Buffer.from(image) }),
    };
    checkLine(line, project);
    if (out) {
        await mkdir(join(out, "baselines"), { recursive: true });
    }
    // The story is the only one known, so a rename applies whenever its old id has the baseline.
    // The images in out are this function's own, so an earlier attempt's capture goes (prune).
    // What every call reads the same (renames, reference images, which baselines exist) is cached.
    const ctx = {
        baselines,
        captures: null,
        out,
        prune: true,
        known: new Set([id]),
        ...(await cached(sources, `${baselines}\0${reference}`, sourcePaths(baselines, reference), () =>
            judgeSources({ baselines, reference }),
        )),
        named: new Set(),
        newlyExcluded: new Set(),
    };
    const item = await judgeLine(ctx, line);
    if (!item) {
        if (out) {
            // collect reports its baseline removed, and says why from this.
            const marker = JSON.stringify({ project, file: line.file });
            await appendFile(join(out, `excluded-${process.pid}-${threadId}.ndjson`), `${marker}\n`);
        }
        return null;
    }
    const key = `${project}\0${line.file}`;
    if (!out) {
        const here = `${baselines}\0${key}`;
        const attempt = (counted.get(here) ?? 0) + 1;
        counted.set(here, attempt);
        return resultLine(item, { project, attempt });
    }
    return inTurn(out, async () => {
        const result = resultLine(item, { project, attempt: (await attemptsIn(out, key)) + 1 });
        await appendFile(join(out, `results-${process.pid}-${threadId}.ndjson`), `${JSON.stringify(result)}\n`);
        return result;
    });
}

/**
 * Whether an `image` option is a shot (openCapture()'s shoot() result) rather than an image.
 * @param {unknown} image the option
 * @returns {image is Record<string, unknown>} true for a plain object
 */
const isShot = (image) => image !== null && typeof image === "object" && !(image instanceof Uint8Array);

/**
 * The files a judge context is read from, whose change makes compareSnapshot() read it again.
 * @param {string} baselines the baselines directory
 * @param {string | null} reference the reference capture's directory
 * @returns {string[]} the paths
 */
const sourcePaths = (baselines, reference) => [
    baselines,
    join(baselines, "renames.json"),
    ...(reference ? [join(reference, "results.json")] : []),
];

/**
 * Throws when a result line did not pass, as assertSnapshot() does.
 * @param {object} line a result line
 * @returns {void}
 * @throws {AssertionError} Node's own, with the message naming the snapshot and its status, and
 *     `actual` the result line
 */
export function assertPassed(line) {
    if (line && !line.passed) {
        const { message } = outcome(line);
        throw new AssertionError({
            message: `proofroom: ${line.project}/${line.file.slice(0, -4)}: ${message}`,
            actual: line,
            operator: "assertSnapshot",
        });
    }
}

/**
 * Judges one snapshot, as compareSnapshot() does, and throws when it did not pass: every test
 * runner reports a thrown `AssertionError` as a failed test, and its retry calls the test again,
 * which is the snapshot's next attempt.
 * @param {Parameters<typeof compareSnapshot>[0]} options as for compareSnapshot()
 * @returns {Promise<object | null>} the result line, when the snapshot passed
 * @throws {AssertionError} Node's own, with `actual` the result line, when it did not
 */
export async function assertSnapshot(options) {
    const line = await compareSnapshot(options);
    assertPassed(line);
    return line;
}
