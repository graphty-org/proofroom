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
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, relative, sep } from "node:path";

import { chromium } from "playwright";
import { PNG } from "pngjs";

import { pngSize, sha256 } from "../trusted/lib/compare.mjs";
import {
    CAPTURE_LINES,
    clip,
    compareRun,
    fileName,
    loadSettings,
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

/* global document, requestAnimationFrame -- read only inside the page */

/** The instant every page's clock starts at. It keeps running from there. */
export const CLOCK_START = "2026-01-01T12:00:00Z";

export const VIEWPORT = { width: 1200, height: 900 };
/** Device pixels per CSS pixel, as Chromatic captures; recorded in results.json as `scale`. */
export const SCALE = 2;
const RENDER_TIMEOUT = 30_000;
/**
 * Chromium's switches for every capture. `--disable-gpu-rasterization` draws the page's text and
 * shapes on the CPU: rasterized through SwiftShader, a glyph that sits on a sub-pixel boundary
 * landed on either side of it from one render to the next, so a story with nothing moving read
 * `unstable` (the README, "Why captures rasterize on the CPU"). WebGL still runs on SwiftShader.
 */
export const CHROMIUM_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-rasterization",
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    "--font-render-hinting=none",
];
const MAX_LINE = 2000;

/**
 * The iframe URL of one story, relative to the Storybook root. `chromatic=true` makes
 * `isChromatic()` true inside the stories.
 * @param {string} id the story id
 * @param {Record<string, string> | null} globals the mode's Storybook globals
 * @returns {string} the relative URL
 */
export function storyUrl(id, globals) {
    const url = `iframe.html?id=${encodeURIComponent(id)}&viewMode=story&chromatic=true`;
    if (!globals) {
        return url;
    }
    return `${url}&globals=${Object.entries(globals)
        .map(([k, v]) => `${k}:${v}`)
        .join(";")}`;
}

/**
 * The story ids in a Storybook index.json, docs entries left out.
 * @param {{ entries: Record<string, { id: string, type: string }> }} index the parsed index.json
 * @returns {string[]} the ids, sorted
 */
export const storyIds = (index) =>
    Object.values(index.entries)
        .filter((e) => e.type === "story")
        .map((e) => e.id)
        .sort();

const TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".map": "application/json",
    ".wasm": "application/wasm",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".ico": "image/x-icon",
};

/**
 * Serves a directory on 127.0.0.1 at a port the OS picks.
 * @param {string} dir the directory to serve
 * @returns {Promise<[import("node:http").Server, string]>} the server and its base URL
 */
export function serve(dir) {
    const server = createServer(async (req, res) => {
        try {
            let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
            if (p === "/") {
                p = "/index.html";
            }
            const f = join(dir, p);
            if ((await stat(f)).isDirectory()) {
                throw new Error("directory");
            }
            res.writeHead(200, { "Content-Type": TYPES[extname(f)] ?? "application/octet-stream" });
            res.end(await readFile(f));
        } catch {
            res.writeHead(404);
            res.end("not found");
        }
    });
    return new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r([server, `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}/`]),
        ),
    );
}

async function newContext(browser) {
    const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: SCALE,
        timezoneId: "UTC",
        locale: "en-US",
    });
    await context.addInitScript(() => {
        delete (/** @type {any} */ (Navigator.prototype).gpu);
    });
    return context;
}

/**
 * Loads the preview once and reads every story's `parameters.chromatic`, plus what the page
 * says about its renderer.
 * @param {import("playwright").Browser} browser the browser
 * @param {string} base the Storybook's base URL
 * @returns {Promise<{ params: Record<string, { chromatic?: object }>, renderer: string | null,
 *     gpu: boolean }>} parameters by story id
 */
async function extract(browser, base) {
    const context = await newContext(browser);
    try {
        const page = await context.newPage();
        await page.goto(`${base}iframe.html`, { waitUntil: "load", timeout: RENDER_TIMEOUT });
        await page.waitForFunction(() => /** @type {any} */ (globalThis).__STORYBOOK_PREVIEW__?.storyStoreValue, null, {
            timeout: RENDER_TIMEOUT,
        });
        return await page.evaluate(async () => {
            const preview = /** @type {any} */ (globalThis).__STORYBOOK_PREVIEW__;
            const all = await preview.extract();
            const params = {};
            for (const [id, story] of Object.entries(all)) {
                // Through JSON so functions and class instances never cross into Node.
                params[id] = { chromatic: JSON.parse(JSON.stringify(story.parameters?.chromatic ?? {})) };
            }
            const gl = document.createElement("canvas").getContext("webgl");
            const info = gl?.getExtension("WEBGL_debug_renderer_info");
            let renderer = null;
            if (gl) {
                renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
            }
            return { params, renderer, gpu: "gpu" in navigator };
        });
    } finally {
        await context.close();
    }
}

/**
 * Renders one story and mode in a fresh context and screenshots it.
 * @param {import("playwright").Browser} browser the browser
 * @param {string} url the story's full URL
 * @param {{ delay: number, waitFor: { selector: string, method: string, failOnConsole: string |
 *     null } | null }} options the story's delay, and what to wait for after the render: the
 *     promise `method` returns on every element matching `selector`, failing the story when a
 *     console line contains `failOnConsole`
 * @returns {Promise<{ png: Buffer | null, reason: string | null, console: string[] }>} the PNG,
 *     or a reason it failed; a failure's console holds the rest of its message and any stack
 */
async function shoot(browser, url, { delay, waitFor }) {
    const context = await newContext(browser);
    const lines = [];
    const fail = (reason) => {
        const [first, ...rest] = reason.split("\n");
        lines.push(...rest.filter((l) => l.trim() !== ""));
        return { png: null, reason: first.slice(0, MAX_LINE), console: lines };
    };
    try {
        const page = await context.newPage();
        page.on("console", (m) => lines.push(`${m.type()}: ${m.text()}`));
        page.on("pageerror", (e) => lines.push(`pageerror: ${e.stack ?? e.message}`));
        // A fixed start that keeps running: setFixedTime would freeze Date.now(), which hangs any
        // component timed with it (graphty-element's input playback and recording, for one).
        await page.clock.install({ time: CLOCK_START });
        await page.clock.resume();
        await page.goto(url, { waitUntil: "load", timeout: RENDER_TIMEOUT });
        const phase = await page
            .waitForFunction(
                () => {
                    if (document.body.classList.contains("sb-show-errordisplay")) {
                        return "errored";
                    }
                    const p = /** @type {any} */ (globalThis).__STORYBOOK_PREVIEW__?.currentRender?.phase;
                    return ["completed", "afterEach", "finished", "errored", "aborted"].includes(p) && p;
                },
                null,
                { timeout: RENDER_TIMEOUT },
            )
            .then((h) => h.jsonValue());
        if (phase === "errored" || phase === "aborted") {
            // Storybook's error screen holds the thrown message and its stack (a play function's
            // failed expect included).
            const shown = await page.evaluate(() =>
                ["error-message", "error-stack"].map((id) => document.getElementById(id)?.textContent?.trim() ?? ""),
            );
            return fail([`story render ${phase}`, ...shown].join("\n"));
        }
        // A web font the story uses is fetched only once text needs it, which can be after the
        // render completed; a capture taken before it arrives draws the fallback face, so the
        // text and anything placed beside the text differ from a later capture.
        // Wait for every font in use, then for one frame drawn with them.
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((r) => requestAnimationFrame(() => r()));
            await document.fonts.ready;
        });
        if (waitFor) {
            await page.evaluate(
                async ({ selector, method }) => {
                    const found = [...document.querySelectorAll(selector)];
                    await Promise.all(found.map((el) => /** @type {any} */ (el)[method]()));
                    await new Promise((r) => requestAnimationFrame(() => r()));
                },
                { selector: waitFor.selector, method: waitFor.method },
            );
            if (waitFor.failOnConsole && lines.some((l) => l.includes(waitFor.failOnConsole))) {
                return fail(waitFor.failOnConsole);
            }
        }
        if (delay > 0) {
            await page.waitForTimeout(delay);
        }
        // The owner's rule: always the whole canvas, never cropped to the content. That is the
        // full page of the story iframe -- the viewport, or everything a scroll would reach when
        // the story is taller or wider -- so every story of a project is the same size unless
        // it overflows.
        const png = await screenshotWholePage(page);
        return { png, reason: null, console: lines };
    } catch (e) {
        return fail(e.message);
    } finally {
        await context.close();
    }
}

/**
 * Chromium's tallest screenshot in device pixels (8192 device px is 4096 CSS px at scale 2). A
 * taller full-page screenshot either repeats the top of the page below this row instead of
 * drawing the rest, or fails with "Unable to capture screenshot".
 */
export const MAX_SHOT_HEIGHT = 8192;

/**
 * A full-page screenshot of the whole page, however tall. A page within MAX_SHOT_HEIGHT is the
 * one screenshot Playwright takes, byte for byte; a taller one is shot in slices of at most
 * MAX_SHOT_HEIGHT device px, clipped from the full page, and stitched row for row into one PNG.
 * @param {import("playwright").Page} page the page, at device scale factor SCALE
 * @returns {Promise<Buffer>} the PNG
 */
export async function screenshotWholePage(page) {
    const options = /** @type {const} */ ({ animations: "disabled", caret: "hide", fullPage: true });
    // Chromium's first screenshot beyond the viewport lays text out again, and line boxes of
    // 'normal' height can come out a pixel shorter for good (11px monospace: 21 CSS px a line
    // before, 20 after), so a page measured before it is taller than the page it draws: the image
    // gets background rows below the story (#1982), and later slices of a tall page come back
    // short (#1976). One throwaway capture settles the layout; everything below measures after it.
    // A full-page capture also resizes the page while it runs, and a story that redraws on resize
    // (Cytoscape's canvases) draws again in the next frames: wait for them, or the real capture
    // catches that redraw half done and two captures of the story differ.
    await page.screenshot({ ...options, clip: { x: 0, y: 0, width: 1, height: 1 } });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // The page's size as Playwright measures it for a full-page screenshot.
    const size = await page.evaluate(() => {
        const [b, d] = [document.body, document.documentElement];
        return {
            width: Math.max(b.scrollWidth, d.scrollWidth, b.offsetWidth, d.offsetWidth, b.clientWidth, d.clientWidth),
            height: Math.max(
                b.scrollHeight,
                d.scrollHeight,
                b.offsetHeight,
                d.offsetHeight,
                b.clientHeight,
                d.clientHeight,
            ),
        };
    });
    const width = size.width * SCALE;
    const height = size.height * SCALE;
    if (height <= MAX_SHOT_HEIGHT) {
        return page.screenshot(options);
    }
    const out = new PNG({ width, height });
    for (let top = 0; top < height; top += MAX_SHOT_HEIGHT) {
        const rows = Math.min(MAX_SHOT_HEIGHT, height - top);
        const clip = { x: 0, y: top / SCALE, width: size.width, height: rows / SCALE };
        const slice = PNG.sync.read(await page.screenshot({ ...options, clip }));
        if (slice.width !== width || slice.height !== rows) {
            throw new Error(
                `screenshot slice at ${top} px is ${slice.width} x ${slice.height}, not ${width} x ${rows}`,
            );
        }
        slice.data.copy(out.data, top * width * 4);
    }
    // Paeth on every row: the same size as pngjs's default (try all five filters per row) on
    // screenshots, at a third of the time.
    return PNG.sync.write(out, { filterType: 4 });
}

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
            snapshots.push({ common, excluded, url: base + storyUrl(id, mode.globals), delay: s.delay });
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
    const shot = await shoot(browser, url, { delay, waitFor });
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

/**
 * Opens one project's built Storybook for a caller that drives the order itself, such as a test
 * runner that makes each snapshot a test case: `stories()` lists the snapshots, `shoot(story)`
 * shoots one, once, in a fresh browser context as capture() does, and `close()` closes the
 * browser. Hand what `shoot()` returns to `assertSnapshot()` from `proofroom/compare`.
 * @param {{ project: string, root?: string, storybook?: string, baselines?: string,
 *     stories?: string[] | null }} options the project of visual-review.config.json in the git
 *     checkout `root` (default the current one); `storybook` and `baselines` override the config's;
 *     `stories` keeps only the story ids starting with one of these prefixes
 * @returns {{ stories: () => Promise<object[]>, shoot: (story: object) => Promise<object>,
 *     close: () => Promise<void> }} each story is a capture line without an image, with its
 *     `baselines` directory: `type` is `image` (to shoot) or `excluded`; `shoot()` returns it with `image` (the PNG, or null with
 *     `reason` when the story could not be shot) and `console`, or an excluded story unchanged
 */
export function openCapture({ project, root = repoRoot(), storybook, baselines, stories = null }) {
    const config = loadConfig(root);
    const entry = config.projects[project];
    if (!entry) {
        throw new Error(`openCapture: no project ${project} in the config`);
    }
    const dir = baselines ?? join(root, config.baselines, project);
    const fontconfig = config.fontconfig ? join(root, config.fontconfig) : null;
    const planned = new Map();
    let opened = null;
    const open = () =>
        (opened ??= (async () => {
            const sb = storybook ?? join(root, entry.storybook);
            const fontEnv = fontconfig
                ? { FONTCONFIG_FILE: fontconfig, XDG_CACHE_HOME: await mkdtemp(join(tmpdir(), "visual-review-fonts-")) }
                : {};
            const [server, base] = await serve(sb);
            const browser = await chromium.launch({
                args: CHROMIUM_ARGS,
                env: { ...process.env, ...fontEnv, TZ: "UTC" },
            });
            const all = storyIds(JSON.parse(await readFile(join(sb, "index.json"), "utf8")));
            const ids = all.filter((id) => !stories || stories.some((p) => id.startsWith(p)));
            const { params } = await extract(browser, base);
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
            return snapshots.map((snapshot) => {
                planned.set(snapshot.common.file, snapshot);
                // Its baselines go with it, so assertSnapshot() judges it where capture read its settings.
                return { ...(snapshot.excluded ?? { type: "image", ...snapshot.common }), baselines: dir };
            });
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
            if (!opened) {
                return;
            }
            const { server, browser, fontEnv } = await opened;
            await browser.close();
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
        const allIds = storyIds(JSON.parse(await readFile(join(storybook, "index.json"), "utf8")));
        const ids = allIds.filter((id) => !stories || stories.some((p) => id.startsWith(p)));
        const [server, base] = await serve(storybook);
        // One browser per worker: every page of a browser shares its one GPU process, so with
        // SwiftShader a busy WebGL page on one worker stalls the others' renders and screenshots.
        const browsers = await Promise.all(
            Array.from({ length: Math.max(1, workers) }, () =>
                chromium.launch({ args: CHROMIUM_ARGS, env: { ...process.env, ...fontEnv, TZ: "UTC" } }),
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
            const { params, renderer, gpu } = await extract(browsers[0], base);
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
            await Promise.all(browsers.map((b) => b.close()));
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
 * the moment its image is written, so its result line follows it by the judging time alone.
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
        onResult: (result, line) => {
            if (!result.passed && line && result.attempt <= retries) {
                shots.again(line);
            }
        },
    });
}
