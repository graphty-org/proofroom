/**
 * Capture: screenshot every story of one built Storybook and classify each against its baseline.
 *
 * Serves storybook-static on 127.0.0.1, reads the story list from index.json and every story's
 * `parameters.chromatic` from the preview's own `extract()`, then opens each story and mode in a
 * fresh browser context: a fixed start time, SwiftShader WebGL, a 1200 x 900 viewport at device
 * scale factor 2, as Chromatic captures. Each PNG is the whole canvas, never cropped to the content:
 * the full page of the story iframe, which is the viewport unless the story overflows it. It waits
 * for Storybook's render (play functions included) and, when the project's config names a
 * `waitFor` (an element selector and a method returning a promise, such as graphty-element's
 * `waitForStableFrame()`), for that; a story that errors or never settles is `failed`, never a picture,
 * after one retry in a new context, so a single timeout on a busy runner does not block a pull
 * request. WebGPU is removed from every page (`navigator.gpu` is deleted before any script runs):
 * no Chromium switch hides it, and whether an adapter request fails differs by host, so without
 * this a component with a CPU and a GPU path would draw whichever the machine offers.
 * Anything that differs from its baseline, or has none, is captured once more in a new context,
 * so a real change, an unstable story and a one-off flake are told apart (see compare.mjs).
 *
 * The output directory gets results.json (rewritten after every item; `complete: true` only at
 * the end), the first capture of every changed, new and unstable item, `second/<file>` for the
 * second capture of an unstable one, and `baselines/<file>`: the baseline each changed, unstable
 * and removed item was compared with.
 *
 * A story renamed in the project's `renames.json` (see loadRenames) is compared with the baseline
 * of its old id, mode by mode: `moved` when it looks the same, `changed` otherwise, each carrying
 * `from`; that old baseline is then not reported `removed`. A rename whose new id is not a story
 * is a `failed` item under the new id, so the page lists it; one whose old id is still a story
 * does nothing.
 *
 * With `reference`, a directory holding the default branch's newest capture of the project (CI
 * downloads it on pull requests), a story with no baseline whose capture matches it is `unseeded`, not
 * `new`: seeding is per story, so a story nobody has accepted yet does not block every pull
 * request, only one that changes it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { classify, DEFAULT_THRESHOLD, readBaseline, sha256 } from "../trusted/lib/compare.mjs";
import { validateResults } from "../trusted/lib/results.mjs";

/* global document, window, requestAnimationFrame -- read only inside the page */

/** The instant every page's clock starts at. It keeps running from there. */
const CLOCK_START = "2026-01-01T12:00:00Z";

const VIEWPORT = { width: 1200, height: 900 };
/** Device pixels per CSS pixel, as Chromatic captures; recorded in results.json as `scale`. */
const SCALE = 2;
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
const MAX_CONSOLE = 100;
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

/**
 * The PNG name of a story and mode.
 * @param {string} id the story id
 * @param {string | null} mode the mode name
 * @returns {string} `<id>.png` or `<id>.<mode>.png`
 */
export const fileName = (id, mode) => (mode === null ? `${id}.png` : `${id}.${mode}.png`);

/**
 * Whether a project has any baseline PNG, which is what makes its results `seeded`.
 * @param {string} dir the project's baselines directory
 * @returns {Promise<boolean>} true when the directory holds a PNG
 */
export async function hasBaselines(dir) {
    return (await pngsIn(dir)).length > 0;
}

/**
 * Reads a story's settings file, `<dir>/<id>.json`.
 * @param {string} dir the project's baselines directory
 * @param {string} id the story id
 * @returns {Promise<object | null>} the parsed settings, or null when the story has none
 */
export async function loadSettings(dir, id) {
    try {
        return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
    } catch (e) {
        if (e.code === "ENOENT") {
            return null;
        }
        throw e;
    }
}

/**
 * A story's capture settings: its `parameters.chromatic`, with every key its settings file sets
 * taking precedence. Modes map a name to Storybook globals; `disable: true` drops a mode.
 * @param {{ chromatic?: object }} parameters the story's parameters (only `chromatic` is read)
 * @param {object | null} file the story's settings file
 * @returns {{ disableSnapshot: boolean, excludedByStory: boolean, reason: string | null, delay: number, threshold: number,
 *     includeAA: boolean, modes: { name: string | null, globals: object | null }[] }} one mode
 *     with a null name when the story has none
 */
export function storySettings(parameters, file) {
    const fromStory = parameters.chromatic ?? {};
    const s = { ...fromStory, ...file };
    const disableSnapshot = s.disableSnapshot === true;
    const byFile = file?.disableSnapshot === true;
    const modes = Object.entries(s.modes ?? {})
        .filter(([, m]) => m?.disable !== true)
        .map(([name, m]) => ({
            name,
            globals: Object.fromEntries(Object.entries(m).filter(([k]) => k !== "disable")),
        }));
    // A mode names files and results.json items, which allow only these: refused before any story
    // is captured, not when results.json is checked at the end.
    for (const { name } of modes) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 50) {
            throw new Error(`Chromatic mode "${name}": a mode name is lowercase letters, digits and "-", at most 50`);
        }
    }
    const where = byFile ? "settings file" : "story's parameters";
    return {
        disableSnapshot,
        excludedByStory: disableSnapshot && !byFile,
        reason: disableSnapshot ? (file?.reason ?? `disableSnapshot in the ${where}`) : null,
        delay: s.delay ?? 0,
        threshold: s.diffThreshold ?? DEFAULT_THRESHOLD,
        includeAA: s.diffIncludeAntiAliasing === true,
        modes: modes.length > 0 ? modes : [{ name: null, globals: null }],
    };
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
async function loadRenames(dir) {
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

async function pngsIn(dir) {
    try {
        return (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    } catch (e) {
        if (e.code === "ENOENT") {
            return [];
        }
        throw e;
    }
}

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
function serve(dir) {
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
        await page.waitForFunction(() => /** @type {any} */ (window).__STORYBOOK_PREVIEW__?.storyStoreValue, null, {
            timeout: RENDER_TIMEOUT,
        });
        return await page.evaluate(async () => {
            const preview = /** @type {any} */ (window).__STORYBOOK_PREVIEW__;
            const all = await preview.extract();
            const params = {};
            for (const [id, story] of Object.entries(all)) {
                // Through JSON so functions and class instances never cross into Node.
                params[id] = { chromatic: JSON.parse(JSON.stringify(story.parameters?.chromatic ?? {})) };
            }
            const gl = document.createElement("canvas").getContext("webgl");
            const info = gl?.getExtension("WEBGL_debug_renderer_info");
            const renderer = gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : null;
            return { params, renderer, gpu: "gpu" in navigator };
        });
    } finally {
        await context.close();
    }
}

/**
 * Renders one story and mode, retrying once in a new context when it fails.
 * @param {import("playwright").Browser} browser the browser
 * @param {string} url the story's full URL
 * @param {{ delay: number, waitFor: object | null }} options as for shootOnce
 * @returns {Promise<{ png: Buffer | null, reason: string | null, console: string[] }>} the
 *     second attempt's result when the first failed
 */
async function shoot(browser, url, options) {
    const first = await shootOnce(browser, url, options);
    return first.png ? first : shootOnce(browser, url, options);
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
async function shootOnce(browser, url, { delay, waitFor }) {
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
                    const p = /** @type {any} */ (window).__STORYBOOK_PREVIEW__?.currentRender?.phase;
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
        const png = await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true });
        return { png, reason: null, console: lines };
    } catch (e) {
        return fail(e.message);
    } finally {
        await context.close();
    }
}

/**
 * Which build of this tool captured: the commit of its source checkout when it runs from one
 * (a monorepo that develops it), else the installed package's name and version.
 * @returns {string} a commit sha, or `@graphty/visual-review@<version>`
 */
function toolVersion() {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
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

const clip = (lines) => lines.slice(0, MAX_CONSOLE).map((l) => l.slice(0, MAX_LINE));

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 }).trim();

/**
 * Where this run came from: GitHub Actions' environment in CI, the working tree locally.
 * @returns {Promise<object>} the commit, pull request and run fields of results.json, and `local`
 */
async function provenance() {
    if (process.env.GITHUB_ACTIONS !== "true") {
        const diff = execFileSync("git", ["diff", "HEAD", "--binary"], { maxBuffer: 1 << 30 });
        return {
            commit: git("rev-parse", "HEAD"),
            headSha: null,
            pr: null,
            runId: null,
            runAttempt: null,
            local: { describe: git("describe", "--always", "--dirty"), diff: sha256(diff) },
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
 * Whether any font on this machine draws emoji, asked of fontconfig with one common emoji
 * (U+1F680). Without one, every emoji in a story renders as an empty box, so capture warns.
 * ponytail: one code point, a machine-level check; the pinned fonts of milestone 2 replace it.
 * @returns {boolean | null} null when fc-list is not installed
 */
export function hasEmojiFont() {
    try {
        return execFileSync("fc-list", [":charset=1f680", "family"], { encoding: "utf8" }).trim() !== "";
    } catch {
        return null;
    }
}

async function cpuModel() {
    try {
        return /^model name\s*:\s*(.*)$/m.exec(await readFile("/proc/cpuinfo", "utf8"))?.[1] ?? null;
    } catch {
        return null;
    }
}

/**
 * Reads an earlier capture's images of stories that had no baseline, to compare new captures with.
 * Only complete, valid results are used, and only `new` items (captured twice and stable) whose
 * file hashes to the capture results.json names.
 * @param {string | null} dir the earlier capture's directory, or null
 * @returns {Promise<{ images: Map<string, Buffer>, runId: number | null }>} images by file name
 */
async function loadReference(dir) {
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
    for (const item of results.items.filter((i) => i.status === "new")) {
        const bytes = await readFile(join(dir, item.file)).catch(() => null);
        if (bytes && sha256(bytes) === item.capture) {
            images.set(item.file, bytes);
        }
    }
    return { images, runId: results.runId };
}

/**
 * Captures one project.
 * @param {{ project: string, storybook: string, baselines: string, out: string, workers: number,
 *     waitFor?: object | null, reference?: string | null, stories?: string[] | null,
 *     log?: (line: string) => void }} options `waitFor` is the project's config entry (see
 *     shootOnce); `reference` is the default branch's capture (see above); `stories` keeps only
 *     the story ids starting with one of these prefixes, for a quick local preview, and then no
 *     baseline is reported removed
 * @returns {Promise<object>} the final results.json contents
 */
export async function capture({
    project,
    storybook,
    baselines,
    out,
    workers,
    waitFor = null,
    reference = null,
    stories = null,
    log = console.log,
}) {
    const started = Date.now();
    await mkdir(join(out, "baselines"), { recursive: true });
    await mkdir(join(out, "second"), { recursive: true });
    const allIds = storyIds(JSON.parse(await readFile(join(storybook, "index.json"), "utf8")));
    const ids = allIds.filter((id) => !stories || stories.some((p) => id.startsWith(p)));
    const renames = await loadRenames(baselines);
    const refs = await loadReference(reference);
    const [server, base] = await serve(storybook);
    // One browser per worker: every page of a browser shares its one GPU process, so with
    // SwiftShader a busy WebGL page on one worker stalls the others' renders and screenshots.
    const browsers = await Promise.all(
        Array.from({ length: Math.max(1, workers) }, () =>
            chromium.launch({ args: CHROMIUM_ARGS, env: { ...process.env, TZ: "UTC" } }),
        ),
    );
    const [browser] = browsers;
    try {
        const { params, renderer, gpu } = await extract(browser, base);

        const jobs = [];
        const items = [];
        const planned = new Set();
        const existing = new Set(await pngsIn(baselines));
        // A story whose own parameters exclude it while it still has a baseline is reported as
        // removed, so a pull request cannot drop a story from review without the owner seeing it.
        const newlyExcluded = new Set();
        // Old baselines a rename compares a story with (or reports as a broken rename): not removed.
        const renamed = new Set();
        const renameErrors = [];
        const known = new Set(allIds);
        for (const [to, from] of stories ? [] : renames) {
            if (known.has(to)) {
                continue;
            }
            // Only a rename with an old baseline left to move is an error; once it is accepted the
            // old baselines are gone, and the entry does nothing.
            for (const file of existing) {
                const [id, mode = null] = file.slice(0, -4).split(".");
                if (id === from && BASELINE_NAME.test(file)) {
                    renamed.add(file);
                    renameErrors.push({
                        id: to,
                        mode,
                        file: fileName(to, mode),
                        from,
                        threshold: DEFAULT_THRESHOLD,
                        includeAA: false,
                        ...EMPTY,
                        status: "failed",
                        reason: `${RENAMES} renames ${from} to ${to}, but the Storybook has no story ${to}: fix ${RENAMES}`,
                    });
                }
            }
        }
        items.push(...renameErrors);
        for (const id of ids) {
            const s = storySettings(params[id] ?? {}, await loadSettings(baselines, id));
            for (const mode of s.modes) {
                const file = fileName(id, mode.name);
                const common = { id, mode: mode.name, file, threshold: s.threshold, includeAA: s.includeAA };
                if (s.excludedByStory && existing.has(file)) {
                    newlyExcluded.add(file);
                    continue;
                }
                planned.add(file);
                if (s.disableSnapshot) {
                    items.push({ ...common, ...EMPTY, status: "excluded", reason: s.reason });
                } else {
                    // Renamed: compared with the old id's baseline of this mode, while the new id
                    // has none of its own (after the accept it does, and the rename is done).
                    // A rename from an id that is still a story is not a move: it does nothing.
                    const old =
                        renames.has(id) && !known.has(renames.get(id)) ? fileName(renames.get(id), mode.name) : null;
                    const from = old && !existing.has(file) && existing.has(old) ? renames.get(id) : null;
                    if (from) {
                        renamed.add(old);
                    }
                    jobs.push({ ...common, from, url: base + storyUrl(id, mode.globals), delay: s.delay });
                }
            }
        }
        const gone = stories
            ? []
            : [...existing].filter((f) => !planned.has(f) && !renamed.has(f) && BASELINE_NAME.test(f));

        const emojiFont = hasEmojiFont();
        if (emojiFont === false) {
            log(
                "warning: no font on this machine draws emoji (fc-list :charset=1f680 found none), so " +
                    "every emoji in a story is captured as an empty box; install fonts-noto-color-emoji",
            );
        }
        const results = {
            version: 1,
            project,
            ...(await provenance()),
            seeded: await hasBaselines(baselines),
            reference: refs.runId,
            complete: false,
            expected: items.length + jobs.length + gone.length,
            capturedAt: new Date().toISOString(),
            clock: { start: CLOCK_START, running: true },
            scale: SCALE,
            environment: {
                chromium: browser.version(),
                renderer,
                gpu,
                cpu: await cpuModel(),
                emojiFont,
                tool: toolVersion(),
            },
            items,
        };
        let saving = Promise.resolve();
        const save = () => (saving = saving.then(() => writeResults(out, results)));
        await save();

        for (const file of gone) {
            const baseline = await readBaseline(join(baselines, file));
            const [id, mode = null] = file.slice(0, -4).split(".");
            await writeFile(join(out, "baselines", file), baseline);
            items.push({
                id,
                mode,
                file,
                ...classify({ baseline, first: null, threshold: DEFAULT_THRESHOLD, includeAA: false }),
                threshold: DEFAULT_THRESHOLD,
                includeAA: false,
                reason: newlyExcluded.has(file) ? "the story's parameters now set disableSnapshot" : null,
                console: [],
            });
        }

        const run = async (browser, job) => {
            const { url, delay, from, ...rest } = job;
            // `from` only on a renamed story, so results.json of a project with no renames is as before.
            const common = from ? { ...rest, from } : rest;
            const baseline = await readBaseline(join(baselines, from ? fileName(from, job.mode) : job.file));
            const reference = baseline ? null : (refs.images.get(job.file) ?? null);
            const opts = { threshold: job.threshold, includeAA: job.includeAA, reference, moved: from !== null };
            const failed = (shot, prefix = "") => ({
                ...common,
                ...EMPTY,
                baseline: baseline && sha256(baseline),
                status: "failed",
                reason: prefix + shot.reason,
                console: clip(shot.console),
            });
            const first = await shoot(browser, url, { delay, waitFor });
            if (!first.png) {
                return failed(first);
            }
            let result = classify({ baseline, first: first.png, ...opts });
            let second = null;
            if (result.status === "changed" || result.status === "new") {
                second = await shoot(browser, url, { delay, waitFor });
                if (!second.png) {
                    return failed(second, "second capture: ");
                }
                result = classify({ baseline, first: first.png, second: second.png, ...opts });
            }
            const { status } = result;
            // A moved capture is also its baseline when the bytes are the same: the page reads it.
            if (["changed", "moved", "new", "unseeded", "unstable"].includes(status)) {
                // The capture results.json names: the second one when the first was a flake.
                await writeFile(join(out, job.file), result.flaky ? second.png : first.png);
            }
            if (status === "unstable") {
                await writeFile(join(out, "second", job.file), second.png);
            }
            const ownBaseline = status === "moved" && result.baseline !== result.capture;
            if (baseline && (status === "changed" || status === "unstable" || ownBaseline)) {
                await writeFile(join(out, "baselines", job.file), baseline);
            }
            const lines =
                status === "unchanged" || status === "moved"
                    ? []
                    : clip([...first.console, ...(second?.console ?? [])]);
            return { ...common, ...result, reason: null, console: lines };
        };

        let next = 0;
        await Promise.all(
            browsers.map(async (b) => {
                while (next < jobs.length) {
                    const item = await run(b, jobs[next++]);
                    items.push(item);
                    if (item.status !== "unchanged") {
                        log(`${item.status} ${item.file}${item.reason ? `: ${item.reason}` : ""}`);
                    }
                    await save();
                }
            }),
        );

        items.sort((a, b) => (a.file < b.file ? -1 : 1));
        // Validated before it is saved as complete, so an invalid file is never uploaded as finished.
        const problems = validateResults({ ...results, complete: true });
        if (problems.length > 0) {
            throw new Error(`results.json is invalid:\n${problems.slice(0, 20).join("\n")}`);
        }
        results.complete = true;
        await save();
        const counts = {};
        for (const item of items) {
            counts[item.status] = (counts[item.status] ?? 0) + 1;
        }
        log(JSON.stringify({ project, items: items.length, seconds: (Date.now() - started) / 1000, counts }));
        return results;
    } finally {
        await Promise.all(browsers.map((b) => b.close()));
        server.close();
    }
}

const EMPTY = {
    flaky: false,
    baseline: null,
    capture: null,
    size: null,
    baselineSize: null,
    changedPixels: null,
    bbox: null,
    console: [],
};

const BASELINE_NAME = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?\.png$/;

async function writeResults(out, results) {
    const tmp = join(out, "results.json.tmp");
    await writeFile(tmp, `${JSON.stringify(results, null, 2)}\n`);
    await rename(tmp, join(out, "results.json"));
}
