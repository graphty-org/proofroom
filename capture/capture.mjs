/**
 * Capture: screenshot every story of one built Storybook and classify each against its baseline.
 *
 * Serves storybook-static on 127.0.0.1, reads the story list from index.json and every story's
 * `parameters.chromatic` from the preview's own `extract()`, then opens each story and mode in a
 * fresh browser context: a fixed start time, SwiftShader WebGL, a 1200 x 900 viewport at device
 * scale factor 2, as Chromatic captures. Each PNG is cropped to the story's rendered content (every
 * visible element, portals included) plus a 32 px margin; a canvas project keeps the viewport and
 * its full width, and is cropped only in height, never past the viewport. It waits
 * for Storybook's render (play functions included) and, for graphty-element, for
 * `waitForStableFrame()`; a story that errors or never settles is `failed`, never a picture,
 * after one retry in a new context, so a single timeout on a busy runner does not block a pull
 * request. WebGPU is removed from every page (`navigator.gpu` is deleted before any script runs):
 * no Chromium switch hides it, and whether an adapter request fails differs by host, so without
 * this graphty-element's CPU or GPU path would depend on the machine.
 * Anything that differs from its baseline, or has none, is captured once more in a new context,
 * so a real change, an unstable story and a one-off flake are told apart (see compare.mjs).
 *
 * The output directory gets results.json (rewritten after every item; `complete: true` only at
 * the end), the first capture of every changed, new and unstable item, `second/<file>` for the
 * second capture of an unstable one, and `baselines/<file>`: the baseline each changed, unstable
 * and removed item was compared with.
 *
 * With `reference`, a directory holding master's newest capture of the project (CI downloads it
 * on pull requests), a story with no baseline whose capture matches master's is `unseeded`, not
 * `new`: seeding is per story, so a story nobody has accepted yet does not block every pull
 * request, only one that changes it.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
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
/** CSS pixels kept around the story's content box. */
const MARGIN = 32;
const RENDER_TIMEOUT = 30_000;
const CHROMIUM_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
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
 * @param {{ delay: number, stableFrame: boolean, canvas: boolean }} options as for shootOnce
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
 * @param {{ delay: number, stableFrame: boolean, canvas: boolean }} options the story's delay,
 *     whether to wait for every graphty-element's stable frame, and whether the project draws on
 *     a canvas (see contentClip)
 * @returns {Promise<{ png: Buffer | null, reason: string | null, console: string[] }>} the PNG,
 *     or a reason it failed; a failure's console holds the rest of its message and any stack
 */
async function shootOnce(browser, url, { delay, stableFrame, canvas }) {
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
        // A fixed start that keeps running: setFixedTime would freeze Date.now(), which hangs
        // graphty-element's input playback and recording, both timed with it.
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
        // text, the crop and anything placed beside the text all differ from a later capture.
        // Wait for every font in use, then for one frame drawn with them.
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((r) => requestAnimationFrame(() => r()));
            await document.fonts.ready;
        });
        if (stableFrame) {
            await page.evaluate(async () => {
                const graphs = [...document.querySelectorAll("graphty-element")];
                await Promise.all(graphs.map((g) => /** @type {any} */ (g).waitForStableFrame()));
                await new Promise((r) => requestAnimationFrame(() => r()));
            });
            if (lines.some((l) => l.includes("Graph settled timeout"))) {
                return fail("Graph settled timeout");
            }
        }
        if (delay > 0) {
            await page.waitForTimeout(delay);
        }
        const box = await page.evaluate(contentClip, { margin: MARGIN, canvas });
        const beyond = box.x + box.width > VIEWPORT.width || box.y + box.height > VIEWPORT.height;
        const png = await page.screenshot({ animations: "disabled", caret: "hide", clip: box, fullPage: beyond });
        return { png, reason: null, console: lines };
    } catch (e) {
        return fail(e.message);
    } finally {
        await context.close();
    }
}

/**
 * Runs in the page: the box to screenshot, in CSS pixels. It is the union of the story's ink:
 * each text run's own box, each replaced element (image, SVG, canvas, form control), and each
 * element that paints something of its own (a background other than the page's, a border, a
 * shadow, an outline). A block that only lays out -- the story root, a full-width wrapper --
 * adds nothing, so a single button is cropped to the button. Portals (tooltips, popovers) are
 * elements of the body too and count. Every box is cut to the ancestors whose overflow clips it
 * (so rows a scroll area hides do not stretch it; a fixed element escapes them). Then `margin`
 * is added, within the page. A canvas project (`canvas`) keeps the viewport: its full width, and
 * the ink's height plus the margin, never past the viewport, because a capture beyond it could
 * resize the canvas, which clears it. A story with no ink keeps the whole viewport.
 * @param {{ margin: number, canvas: boolean }} options the margin and whether it is a canvas project
 * @returns {{ x: number, y: number, width: number, height: number }} the clip
 */
function contentClip({ margin, canvas }) {
    const root = document.documentElement;
    const W = canvas ? window.innerWidth : Math.max(root.scrollWidth, window.innerWidth);
    const H = canvas ? window.innerHeight : Math.max(root.scrollHeight, window.innerHeight);
    const transparent = (c) => c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c);
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const pageBg = transparent(bodyBg) ? window.getComputedStyle(root).backgroundColor : bodyBg;
    const REPLACED = new Set(["IMG", "SVG", "svg", "CANVAS", "VIDEO", "IFRAME", "INPUT", "TEXTAREA", "SELECT", "HR"]);
    const paints = (st) =>
        (!transparent(st.backgroundColor) && st.backgroundColor !== pageBg) ||
        st.backgroundImage !== "none" ||
        st.boxShadow !== "none" ||
        (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0) ||
        ["Top", "Right", "Bottom", "Left"].some(
            (side) =>
                st[`border${side}Style`] !== "none" &&
                parseFloat(st[`border${side}Width`]) > 0 &&
                !transparent(st[`border${side}Color`]),
        );
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (r, c) => {
        const [l, t, rr, b] = [
            Math.max(r.left, c[0]),
            Math.max(r.top, c[1]),
            Math.min(r.right, c[2]),
            Math.min(r.bottom, c[3]),
        ];
        if (rr > l && b > t) {
            x0 = Math.min(x0, l + window.scrollX);
            y0 = Math.min(y0, t + window.scrollY);
            x1 = Math.max(x1, rr + window.scrollX);
            y1 = Math.max(y1, b + window.scrollY);
        }
    };
    const ALL = [-Infinity, -Infinity, Infinity, Infinity];
    // Walks the tree with the clip its ancestors impose, as [left, top, right, bottom].
    const visit = (parent, clipBox) => {
        for (const e of parent.children) {
            const style = window.getComputedStyle(e);
            if (style.display === "none") {
                continue;
            }
            const r = e.getBoundingClientRect();
            const c = style.position === "fixed" ? ALL : clipBox;
            if (style.visibility !== "hidden" && parseFloat(style.opacity) > 0) {
                if (REPLACED.has(e.tagName) || paints(style)) {
                    add(r, c);
                }
                for (const node of e.childNodes) {
                    if (node.nodeType === 3 && node.textContent.trim() !== "") {
                        const range = document.createRange();
                        range.selectNodeContents(node);
                        for (const tr of range.getClientRects()) {
                            add(tr, c);
                        }
                    }
                }
            }
            const clipsX = style.overflowX !== "visible";
            const clipsY = style.overflowY !== "visible";
            const inner = [
                clipsX ? Math.max(c[0], r.left) : c[0],
                clipsY ? Math.max(c[1], r.top) : c[1],
                clipsX ? Math.min(c[2], r.right) : c[2],
                clipsY ? Math.min(c[3], r.bottom) : c[3],
            ];
            visit(e, inner);
            // A web component draws inside its shadow root: graphty-element's canvas lives there.
            if (e.shadowRoot) {
                visit(e.shadowRoot, inner);
            }
        }
    };
    visit(document.body, ALL);
    if (x1 <= x0 || y1 <= y0) {
        return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    }
    const left = canvas ? 0 : Math.max(0, Math.floor(x0 - margin));
    const right = canvas ? W : Math.min(W, Math.ceil(x1 + margin));
    const top = Math.max(0, Math.floor(y0 - margin));
    const bottom = Math.min(H, Math.ceil(y1 + margin));
    if (right <= left || bottom <= top) {
        return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
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
 *     stableFrame: boolean, canvas?: boolean, reference?: string | null, stories?: string[] | null,
 *     log?: (line: string) => void }} options `stableFrame` waits for every graphty-element's
 *     `waitForStableFrame()`; `canvas` keeps the viewport (see contentClip); `reference` is master's capture (see above); `stories` keeps only
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
    stableFrame,
    canvas = false,
    reference = null,
    stories = null,
    log = console.log,
}) {
    const started = Date.now();
    await mkdir(join(out, "baselines"), { recursive: true });
    await mkdir(join(out, "second"), { recursive: true });
    const ids = storyIds(JSON.parse(await readFile(join(storybook, "index.json"), "utf8"))).filter(
        (id) => !stories || stories.some((p) => id.startsWith(p)),
    );
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
                    jobs.push({ ...common, url: base + storyUrl(id, mode.globals), delay: s.delay });
                }
            }
        }
        const gone = stories ? [] : [...existing].filter((f) => !planned.has(f) && BASELINE_NAME.test(f));

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
                tool: git("-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "HEAD"),
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
            const { url, delay, ...common } = job;
            const baseline = await readBaseline(join(baselines, job.file));
            const reference = baseline ? null : (refs.images.get(job.file) ?? null);
            const opts = { threshold: job.threshold, includeAA: job.includeAA, reference };
            const failed = (shot, prefix = "") => ({
                ...common,
                ...EMPTY,
                baseline: baseline && sha256(baseline),
                status: "failed",
                reason: prefix + shot.reason,
                console: clip(shot.console),
            });
            const first = await shoot(browser, url, { delay, stableFrame, canvas });
            if (!first.png) {
                return failed(first);
            }
            let result = classify({ baseline, first: first.png, ...opts });
            let second = null;
            if (result.status === "changed" || result.status === "new") {
                second = await shoot(browser, url, { delay, stableFrame, canvas });
                if (!second.png) {
                    return failed(second, "second capture: ");
                }
                result = classify({ baseline, first: first.png, second: second.png, ...opts });
            }
            const { status } = result;
            if (["changed", "new", "unseeded", "unstable"].includes(status)) {
                await writeFile(join(out, job.file), first.png);
            }
            if (status === "unstable") {
                await writeFile(join(out, "second", job.file), second.png);
            }
            if (baseline && (status === "changed" || status === "unstable")) {
                await writeFile(join(out, "baselines", job.file), baseline);
            }
            const lines = status === "unchanged" ? [] : clip([...first.console, ...(second?.console ?? [])]);
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
