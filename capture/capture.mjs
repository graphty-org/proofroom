/**
 * Capture: screenshot every story of one built Storybook, once per snapshot, and judge nothing.
 *
 * Serves storybook-static on 127.0.0.1, reads the story list from index.json and every story's
 * `parameters.chromatic` from the preview's own `extract()`, then opens each story and mode in a
 * fresh browser context: a fixed start time, SwiftShader WebGL, a 1200 x 900 viewport at device
 * scale factor 2, as Chromatic captures. Each PNG is the whole canvas, never cropped to the content:
 * the full page of the story iframe, which is the viewport unless the story overflows it, however
 * tall (see screenshotWholePage). It waits
 * for Storybook's render (play functions included) and, when the project's config names a
 * `waitFor` (an element selector and a method returning a promise, such as graphty-element's
 * `waitForStableFrame()`), for that; a story that errors or never settles is `failed`, never a
 * picture, and is not shot again behind the caller's back: retrying is `run --retries` or the
 * test runner's. WebGPU is removed from every page (`navigator.gpu` is deleted before any script runs):
 * no Chromium switch hides it, and whether an adapter request fails differs by host, so without
 * this a component with a CPU and a GPU path would draw whichever the machine offers.
 *
 * `capture()` is an async generator of capture lines (see compare-run.mjs for their fields): a
 * `start` line, one line per snapshot the moment its image is on disk (with the PNG's bytes), and
 * an `end` line. Each is also appended to `<out>/capture.ndjson`, and each image is written to
 * `<out>/<file>`. Capture never reads a baseline image; it reads only the story settings files
 * beside the baselines. Compare (compare-run.mjs) judges the lines.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { threadId } from "node:worker_threads";

import { CLOCK_START, close, open as openBrowser, probe, rendererOf, SCALE, shoot, webpEncoder } from "./chromium.mjs";
import { preview, rendered, serve, stories as storiesIn, url as storyUrlAt } from "./storybook.mjs";

import { pngSize, sha256 } from "../trusted/lib/compare.mjs";
import {
    CAPTURE_LINES,
    clip,
    compareRun,
    fileName,
    loadSettings,
    PROGRESS_FILE,
    provenance,
    storySettings,
    toolVersion,
} from "../trusted/lib/compare-run.mjs";
import { loadConfig, repoRoot } from "../trusted/lib/config.mjs";
import { MAX_ATTEMPTS } from "../trusted/lib/results.mjs";

// Moved to compare-run.mjs, where compare reads them without loading Playwright; still exported
// here for the modules and callers that import them from capture.
export {
    BASELINE_NAME,
    clip,
    EMPTY,
    fileName,
    hasBaselines,
    loadRenames,
    loadSettings,
    pngsIn,
    provenance,
    storySettings,
    toolVersion,
    writeResults,
} from "../trusted/lib/compare-run.mjs";

// The renderer's and the story source's, still exported here for the callers that import them from capture.
export {
    CHROMIUM_ARGS,
    CLOCK_START,
    MAX_SHOT_HEIGHT,
    pinFixedInPage,
    SCALE,
    screenshotWholePage,
    SHOT,
    shootTiles,
    twoFrames,
    VIEWPORT,
} from "./chromium.mjs";
export { serve, storyIds, storyUrl } from "./storybook.mjs";

/**
 * Whether any font draws emoji, asked of fontconfig with one common emoji (U+1F680): the pinned
 * fonts when `env` names a FONTCONFIG_FILE, else the machine's. Without one, every emoji in a story
 * renders as an empty box, so capture warns.
 * @param {NodeJS.ProcessEnv} [env] the environment fc-list runs in
 * @returns {boolean | null} null when fc-list is not installed
 */
export function hasEmojiFont(env = process.env) {
    try {
        return execFileSync("fc-list", [":charset=1f680", "family"], { encoding: "utf8", env }).trim() !== "";
    } catch {
        return null;
    }
}

const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";

/**
 * Checks a pinned font configuration and fingerprints it: the SHA-256 over every file under the
 * fonts.conf's directory (path and content), recorded in results.json as `environment.fonts`.
 * A file that is still a Git LFS pointer is refused, never skipped: Chromium would silently fall
 * back to some other font and every capture would differ from its baseline.
 * @param {string} fontconfig the fonts.conf's absolute path
 * @returns {Promise<string>} the fingerprint
 */
export async function pinnedFonts(fontconfig) {
    const dir = dirname(fontconfig);
    await stat(fontconfig).catch(() => {
        throw new Error(`the config's fontconfig file ${fontconfig} does not exist`);
    });
    const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
        .sort();
    const hash = createHash("sha256");
    for (const file of files) {
        const bytes = await readFile(file);
        const name = relative(dir, file).split(sep).join("/");
        if (bytes.subarray(0, LFS_POINTER.length).toString() === LFS_POINTER) {
            throw new Error(
                `${name} in ${dir} is a Git LFS pointer, not a font: run \`git lfs pull --include "${relative(process.cwd(), dir) || "."}/**"\``,
            );
        }
        hash.update(`${name}\0${sha256(bytes)}\n`);
    }
    return hash.digest("hex");
}

async function cpuModel() {
    try {
        return /^model name\s*:\s*(.*)$/m.exec(await readFile("/proc/cpuinfo", "utf8"))?.[1] ?? null;
    } catch {
        return null;
    }
}

/**
 * The snapshots of some stories: one per story and mode, each with its capture line's common
 * fields, and either the excluded line or what shooting it needs.
 * @param {{ project: string, ids: string[], params: Record<string, { chromatic?: object }>,
 *     baselines: string, base: string }} options the stories, their parameters, where their
 *     settings files are, and the Storybook's base URL
 * @returns {Promise<{ common: object, excluded: object | null, url: string, delay: number }[]>} in story order
 */
async function snapshotsOf({ project, ids, params, baselines, base }) {
    const snapshots = [];
    for (const id of ids) {
        const s = storySettings(params[id] ?? {}, await loadSettings(baselines, id));
        for (const mode of s.modes) {
            const common = {
                project,
                id,
                mode: mode.name,
                file: fileName(id, mode.name),
                settings: { threshold: s.threshold, includeAA: s.includeAA, delay: s.delay },
            };
            const excluded = s.disableSnapshot
                ? {
                      type: "excluded",
                      ...common,
                      sha256: null,
                      size: null,
                      console: [],
                      reason: s.reason,
                      ...(s.excludedByStory && { byStory: true }),
                  }
                : null;
            snapshots.push({ common, excluded, url: storyUrlAt(base, id, mode.globals), delay: s.delay });
        }
    }
    return snapshots;
}

/**
 * Shoots one snapshot once.
 * @param {import("playwright").Browser} browser the browser
 * @param {{ common: object, url: string, delay: number }} snapshot what snapshotsOf() planned
 * @param {object | null} waitFor the project's config entry (see shoot)
 * @returns {Promise<object>} its `image` capture line, with the PNG as `bytes`, or its `failed` line
 */
async function shootSnapshot(browser, { common, url, delay }, waitFor) {
    const shot = await shoot(browser, url, { delay, waitFor, rendered });
    if (!shot.png) {
        return {
            type: "failed",
            ...common,
            sha256: null,
            size: null,
            reason: shot.reason,
            console: clip(shot.console),
        };
    }
    return {
        type: "image",
        ...common,
        sha256: sha256(shot.png),
        size: pngSize(shot.png),
        console: clip(shot.console),
        bytes: shot.png,
    };
}

/** openCapture() calls in this thread, which name their plan files. */
let plans = 0;

/**
 * Opens one project's built Storybook for a caller that drives the order itself, such as a test
 * runner that makes each snapshot a test case: `stories()` lists the snapshots, `shoot(story)`
 * shoots one, once, in a fresh browser context as capture() does, and `close()` closes the
 * browser. Hand what `shoot()` returns to `assertSnapshot()` from `proofroom/compare`.
 *
 * With `out`, the first `stories()` writes there a plan of the snapshots it listed and `close()`
 * marks it closed, so `collect` can tell a whole run from one that stopped early or was filtered.
 * @param {{ project: string, root?: string, storybook?: string, baselines?: string,
 *     stories?: string[] | null, out?: string | null }} options the project of
 *     visual-review.config.json in the git checkout `root` (default the current one); `storybook`
 *     and `baselines` override the config's; `stories` keeps only the story ids starting with one
 *     of these prefixes; `out` is the directory compareSnapshot() writes to (default
 *     `$PROOFROOM_OUT`)
 * @returns {{ stories: () => Promise<object[]>, shoot: (story: object) => Promise<object>,
 *     close: () => Promise<void> }} each story is a capture line without an image, with its
 *     `baselines` directory: `type` is `image` (to shoot) or `excluded`; `shoot()` returns it with `image` (the PNG, or null with
 *     `reason` when the story could not be shot) and `console`, or an excluded story unchanged
 */
export function openCapture({
    project,
    root = repoRoot(),
    storybook,
    baselines,
    stories = null,
    out = process.env.PROOFROOM_OUT ?? null,
}) {
    const config = loadConfig(root);
    const entry = config.projects[project];
    if (!entry) {
        throw new Error(`openCapture: no project ${project} in the config`);
    }
    const dir = baselines ?? join(root, config.baselines, project);
    const fontconfig = config.fontconfig ? join(root, config.fontconfig) : null;
    const planned = new Map();
    // A file of its own per openCapture(), read by collect.
    const planFile = out && join(out, `plan-${process.pid}-${threadId}-${++plans}.json`);
    let plan = null;
    const writePlan = async () => {
        await mkdir(out, { recursive: true });
        await writeFile(planFile, JSON.stringify(plan));
    };
    let opened = null;
    const open = () =>
        (opened ??= (async () => {
            const sb = storybook ?? join(root, entry.storybook);
            const fontEnv = fontconfig
                ? { FONTCONFIG_FILE: fontconfig, XDG_CACHE_HOME: await mkdtemp(join(tmpdir(), "visual-review-fonts-")) }
                : {};
            const [server, base] = await serve(sb);
            const browser = await openBrowser({ env: { ...process.env, ...fontEnv, TZ: "UTC" } });
            const all = await storiesIn(sb);
            const ids = all.filter((id) => !stories || stories.some((p) => id.startsWith(p)));
            const { value: params } = await probe(browser, preview.url(base), preview);
            return {
                server,
                browser,
                fontEnv,
                snapshots: await snapshotsOf({ project, ids, params, baselines: dir, base }),
            };
        })());
    return {
        async stories() {
            const { snapshots } = await open();
            const listed = snapshots.map((snapshot) => {
                planned.set(snapshot.common.file, snapshot);
                // Its baselines go with it, so assertSnapshot() judges it where capture read its settings.
                return { ...(snapshot.excluded ?? { type: "image", ...snapshot.common }), baselines: dir };
            });
            if (planFile && !plan) {
                plan = { project, only: stories, files: listed.map((s) => s.file), closed: false };
                await writePlan();
            }
            return listed;
        },
        async shoot(story) {
            if (story.type === "excluded") {
                return story;
            }
            const snapshot = planned.get(story.file);
            if (!snapshot) {
                throw new Error(`openCapture: ${story.file} is not a story stories() listed`);
            }
            const { browser } = await open();
            const { bytes = null, ...line } = await shootSnapshot(browser, snapshot, entry.waitFor ?? null);
            return { ...line, baselines: dir, image: bytes };
        },
        async close() {
            if (plan) {
                plan.closed = true;
                await writePlan();
            }
            if (!opened) {
                return;
            }
            const { server, browser, fontEnv } = await opened;
            await close(browser);
            server.close();
            if (fontEnv.XDG_CACHE_HOME) {
                await rm(fontEnv.XDG_CACHE_HOME, { recursive: true, force: true });
            }
        },
    };
}

/**
 * Captures one project, yielding one capture line per snapshot as soon as its image is written.
 *
 * The returned generator also has `again(line)`: it shoots that line's snapshot once more, and the
 * new shot is yielded as a later line of the same snapshot before the `end` line. Call it while
 * handling the line (before asking for the next one), as `run --retries` does.
 * @param {{ project: string, storybook: string, baselines: string, out: string, workers: number,
 *     waitFor?: object | null, stories?: string[] | null, fontconfig?: string | null,
 *     log?: (line: string) => void }} options `baselines` is where the story settings files are
 *     (no baseline image is read); `fontconfig` is the absolute path of the fonts.conf every
 *     browser draws with (the config's `fontconfig`), null for the host's fonts; `waitFor` is the
 *     project's config entry (see shoot); `stories` keeps only the story ids starting with one of
 *     these prefixes, for a quick local preview, and then compare reports no baseline removed
 * @returns {AsyncGenerator<object> & { again: (line: object) => void }} the capture lines
 */
export function capture({
    project,
    storybook,
    baselines,
    out,
    workers,
    waitFor = null,
    stories = null,
    fontconfig = null,
    log = console.error,
}) {
    const queue = [];
    const jobs = new Map();
    let pump = () => {};
    async function* lines() {
        const started = Date.now();
        // Pinned fonts: only the committed directory, and a font cache of this run's own (only for the
        // browsers: Playwright finds its Chromium under XDG_CACHE_HOME).
        const fonts = fontconfig ? await pinnedFonts(fontconfig) : null;
        const fontEnv = fontconfig
            ? { FONTCONFIG_FILE: fontconfig, XDG_CACHE_HOME: await mkdtemp(join(tmpdir(), "visual-review-fonts-")) }
            : {};
        await mkdir(out, { recursive: true });
        await writeFile(join(out, CAPTURE_LINES), "");
        const allIds = await storiesIn(storybook);
        const ids = allIds.filter((id) => !stories || stories.some((p) => id.startsWith(p)));
        const [server, base] = await serve(storybook);
        // One browser per worker: every page of a browser shares its one GPU process, so with
        // SwiftShader a busy WebGL page on one worker stalls the others' renders and screenshots.
        const browsers = await Promise.all(
            Array.from({ length: Math.max(1, workers) }, () =>
                openBrowser({ env: { ...process.env, ...fontEnv, TZ: "UTC" } }),
            ),
        );
        let shots = 0;
        // The bytes stay in memory: on disk the image is its own file.
        const record = async (line) => {
            const text = JSON.stringify(line, (key, value) => (key === "bytes" ? undefined : value));
            await appendFile(join(out, CAPTURE_LINES), `${text}\n`);
            return line;
        };
        try {
            const { value: params, renderer, gpu } = await probe(browsers[0], preview.url(base), preview);
            const excluded = [];
            for (const snapshot of await snapshotsOf({ project, ids, params, baselines, base })) {
                if (snapshot.excluded) {
                    excluded.push(snapshot.excluded);
                } else {
                    jobs.set(snapshot.common.file, snapshot);
                    queue.push(snapshot.common.file);
                }
            }
            const emojiFont = hasEmojiFont({ ...process.env, ...fontEnv });
            if (emojiFont === false) {
                const where = fontconfig ? `in ${fontconfig}` : "on this machine";
                log(
                    `warning: no font ${where} draws emoji (fc-list ` +
                        ":charset=1f680 found none), so every emoji in a story is captured as an empty box; " +
                        "add one, such as Noto Color Emoji",
                );
            }
            yield await record({
                type: "start",
                project,
                ...(await provenance()),
                capturedAt: new Date().toISOString(),
                clock: { start: CLOCK_START, running: true },
                scale: SCALE,
                // The browser that draws every image: compare keeps it, and the page warns when the
                // baselines were drawn by another.
                renderer: rendererOf(browsers[0]),
                environment: {
                    chromium: browsers[0].version(),
                    renderer,
                    gpu,
                    cpu: await cpuModel(),
                    emojiFont,
                    fonts,
                    tool: toolVersion(),
                },
                stories: allIds,
                only: stories,
                // How many snapshot lines follow, before any shot again: a progress count's total.
                planned: jobs.size + excluded.length,
            });
            for (const line of excluded) {
                yield await record(line);
            }

            // Each free browser takes the next snapshot in the queue as soon as it is free, whether
            // or not the caller is still handling an earlier line.
            const ready = [];
            const free = [...browsers];
            let running = 0;
            let wake = () => {};
            const shootJob = async (browser, file) => {
                shots++;
                const line = await shootSnapshot(browser, jobs.get(file), waitFor);
                if (line.bytes) {
                    await writeFile(join(out, file), line.bytes);
                }
                return record(line);
            };
            pump = () => {
                while (free.length > 0 && queue.length > 0) {
                    const browser = free.pop();
                    running++;
                    shootJob(browser, queue.shift())
                        .then(
                            (line) => ready.push({ line }),
                            (error) => ready.push({ error }),
                        )
                        .finally(() => {
                            running--;
                            free.push(browser);
                            pump();
                            wake();
                        });
                }
            };
            for (;;) {
                pump();
                if (ready.length === 0) {
                    if (running === 0) {
                        break;
                    }
                    await new Promise((r) => (wake = () => r(null)));
                    continue;
                }
                const { line, error } = ready.shift();
                if (error) {
                    throw error;
                }
                yield line;
            }
            yield await record({ type: "end", project, complete: true });
            log(
                JSON.stringify({
                    project,
                    snapshots: jobs.size + excluded.length,
                    shots,
                    seconds: (Date.now() - started) / 1000,
                }),
            );
        } finally {
            pump = () => {};
            await Promise.all(browsers.map((b) => close(b)));
            server.close();
            if (fontEnv.XDG_CACHE_HOME) {
                await rm(fontEnv.XDG_CACHE_HOME, { recursive: true, force: true });
            }
        }
    }
    return Object.assign(lines(), {
        again(line) {
            if (!jobs.has(line.file)) {
                throw new Error(`capture: ${line.file} is not a snapshot this capture shoots`);
            }
            // At the front, so a retry runs while the snapshot's first shot is still fresh.
            queue.unshift(line.file);
            pump();
        },
    });
}

/**
 * Captures one project and compares it in one process (`proofroom run`): each snapshot is judged
 * the moment its image is written, so its result line follows it by the judging time alone. Each
 * item that needs a decision also gets its list pictures, encoded as WebP by a Chromium of
 * capture's own (opened at the first one), so the review server makes none for this capture.
 * ponytail: the judging runs on this thread, between the browsers' events (230 ms for a changed
 * pair, 0.3 ms for equal bytes); a worker-thread pool if a change-heavy capture shows browser stalls.
 * @param {Parameters<typeof capture>[0] & { reference?: string | null, retries?: number,
 *     junit?: string | null, print?: (line: object) => void }} options capture()'s options, and
 *     compareRun()'s `reference`, `junit` and `print`; `retries` shoots a snapshot that did not pass
 *     again, up to that many times, each shot one attempt
 * @returns {ReturnType<typeof compareRun>} what compareRun returns
 */
export function run({ reference = null, retries = 0, junit, print, ...options }) {
    if (!(Number.isInteger(retries) && retries >= 0 && retries <= MAX_ATTEMPTS)) {
        throw new Error(`retries must be an integer from 0 to ${MAX_ATTEMPTS}`);
    }
    const shots = capture(options);
    let encoder = null;
    const encode = async (images) => {
        encoder ??= openBrowser().then(async (browser) => ({ browser, page: await webpEncoder(browser) }));
        return (await encoder).page.encode(images);
    };
    return compareRun({
        project: options.project,
        baselines: options.baselines,
        captures: options.out,
        out: options.out,
        lines: shots,
        reference,
        ...(junit !== undefined && { junit }),
        prune: true,
        print,
        log: options.log,
        progress: join(options.out, PROGRESS_FILE),
        encode,
        onResult: (result, line) => {
            if (!result.passed && line && result.attempt <= retries) {
                shots.again(line);
            }
        },
    }).finally(async () => {
        // One that failed to open has nothing to close; its error is the run's already.
        const opened = await encoder?.catch(() => null);
        if (opened) {
            await close(opened.browser);
        }
    });
}
