/**
 * Capture: screenshot every story of one built Storybook and classify each against its baseline.
 *
 * Serves storybook-static on 127.0.0.1, reads the story list from index.json and every story's
 * `parameters.chromatic` from the preview's own `extract()`, then opens each story and mode in a
 * fresh browser context: a fixed start time, SwiftShader WebGL, a 1200 x 900 viewport at device
 * scale factor 2, as Chromatic captures. Each PNG is the whole canvas, never cropped to the content:
 * the full page of the story iframe, which is the viewport unless the story overflows it, however
 * tall (see screenshotWholePage). It waits
 * for Storybook's render (play functions included) and, when the project's config names a
 * `waitFor` (an element selector and a method returning a promise, such as graphty-element's
 * `waitForStableFrame()`), for that; a story that errors or never settles is `failed`, never a picture,
 * after one retry in a new context, so a single timeout on a busy runner does not block a pull
 * request. WebGPU is removed from every page (`navigator.gpu` is deleted before any script runs):
 * no Chromium switch hides it, and whether an adapter request fails differs by host, so without
 * this a component with a CPU and a GPU path would draw whichever the machine offers.
 * Anything that differs from its baseline, or has none, is captured once more in a new context,
 * so a real change, an unstable story and a one-off flake are told apart (see compare.mjs), unless it is
 * byte for byte the reference's capture of a story the reference found changed too (needsSecondShot).
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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { PNG } from "pngjs";

import { classify, DEFAULT_THRESHOLD, readBaseline, sha256 } from "../trusted/lib/compare.mjs";
import { validateResults } from "../trusted/lib/results.mjs";

/* global document, getComputedStyle, requestAnimationFrame -- read only inside the page */

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
/**
 * The environment every capture browser launches with: this process's, then `extra`, in UTC, and
 * always with FC_FONTATIONS=1. Chromium 143 sets that variable itself from a font thread while a
 * D-Bus thread may be reading the environment; when the setenv has to grow the array, glibc frees
 * the old one under the reader and the browser dies at launch with SIGSEGV (only at some
 * environment sizes, so it comes and goes). Presetting it makes Chromium's setenv an in-place
 * overwrite. The full analysis is in the monorepo's vitest.base.mjs (2026-09-25).
 * @param {Record<string, string>} [extra] variables to add, such as the pinned fonts'
 * @returns {Record<string, string | undefined>} the launch environment
 */
export const chromiumEnv = (extra = {}) => ({ ...process.env, ...extra, TZ: "UTC", FC_FONTATIONS: "1" });
const MAX_CONSOLE = 100;
const MAX_LINE = 2000;

/**
 * The iframe URL of one story, relative to the Storybook root. `chromatic=true` makes
 * `isChromatic()` true inside the stories. `query` (VISUAL_REVIEW_STORY_QUERY, such as
 * `features=all`) is appended as is, so a Storybook that reads its own URL parameters can be
 * captured in another configuration and compared with the same baselines.
 * @param {string} id the story id
 * @param {Record<string, string> | null} globals the mode's Storybook globals
 * @param {string} [query] extra query parameters, without a leading `&`
 * @returns {string} the relative URL
 */
export function storyUrl(id, globals, query = process.env.VISUAL_REVIEW_STORY_QUERY ?? "") {
    const extra = query ? "&" + query : "";
    const url = `iframe.html?id=${encodeURIComponent(id)}&viewMode=story&chromatic=true${extra}`;
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
 * The story ids `--stories` selects: an entry that is a whole story id selects that story alone, any other
 * entry every id starting with it. CI passes whole ids, and as prefixes `labels-p-1` also captured
 * `labels-p-10` to `labels-p-19`, which ran one graph-io-fidelity bin at 1.6 times its plan (#3448).
 * @param {string[]} ids every story id
 * @param {string[] | undefined} stories the entries, or none for every story
 * @returns {string[]} the selected ids
 */
export const selectStoryIds = (ids, stories) => {
    if (!stories) {
        return ids;
    }
    const whole = new Set(stories.filter((p) => ids.includes(p)));
    return ids.filter((id) => whole.has(id) || stories.some((p) => !whole.has(p) && id.startsWith(p)));
};

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
        // The story loads in a same-origin iframe of the viewport's size, as in Storybook's own UI
        // and the story tests: Chromium draws text in an iframe up to one color level differently
        // from a top-level page, so a top-level shot never matched the story tests' picture.
        const wrapper = new URL("__visual-review-frame.html", url).href;
        await page.route(wrapper, (route) =>
            route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><style>html,body{margin:0}</style><iframe style="border:0;position:absolute;left:0;top:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px"></iframe>`,
            }),
        );
        await page.goto(wrapper, { waitUntil: "load", timeout: RENDER_TIMEOUT });
        // The empty frame takes the focus before the story loads in it, as the story had when it
        // was the page itself and as story-test.mjs's visualPark focuses the tester iframe before
        // the play function. Focusing it after the story loaded would blur a control a play
        // function already focused.
        const element = await page.waitForSelector("iframe");
        await element.focus();
        const frame = await element.contentFrame();
        await frame.goto(url, { waitUntil: "load", timeout: RENDER_TIMEOUT });
        const phase = await frame
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
            const shown = await frame.evaluate(() =>
                ["error-message", "error-stack"].map((id) => document.getElementById(id)?.textContent?.trim() ?? ""),
            );
            return fail([`story render ${phase}`, ...shown].join("\n"));
        }
        // A web font the story uses is fetched only once text needs it, which can be after the
        // render completed; a capture taken before it arrives draws the fallback face, so the
        // text and anything placed beside the text differ from a later capture.
        // Wait for every font in use, then for one frame drawn with them.
        await frame.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((r) => requestAnimationFrame(() => r()));
            await document.fonts.ready;
        });
        if (waitFor) {
            await frame.evaluate(
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
        const png = await screenshotWholePage(page, frame);
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

/** What every screenshot is taken with. */
const SHOT = /** @type {const} */ ({ animations: "disabled", caret: "hide" });

/**
 * Makes a story iframe's document scrollable by one pixel below everything it draws, or takes
 * that back. A top frame (iframe.html shot as the page) always scrolls on the compositor, so
 * Chromium draws its `position: fixed` elements (a popover, a menu, a toast) in layers of their
 * own, apart from the scrolling page; an iframe whose content fits does not scroll, so it drew
 * them into the page's layer and their blurred shadows came out one level darker. The pixel is
 * added after the frame was measured and lies outside every shot; headless Chromium draws no
 * scrollbar, so nothing moves.
 *
 * A scrolling document gets a layer of its own, and an iframe's is transparent where the top frame's
 * is white (its base background), so the anti-aliased edges of a rounded border were blended onto
 * transparency and came out one level off. A document that paints no background of its own (html
 * and body both transparent) gets the top frame's white while the pixel is there.
 * @param {boolean} on add the pixel, or remove it
 * @returns {void}
 */
function scrollLikeTopFrame(on) {
    const ID = "visual-review-scroll-pixel";
    const MARK = "visualReviewBase";
    const root = document.documentElement;
    document.getElementById(ID)?.remove();
    if (MARK in root.dataset) {
        root.style.backgroundColor = root.dataset[MARK];
        delete root.dataset[MARK];
    }
    if (on) {
        const clear = (el) => {
            const style = document.defaultView.getComputedStyle(el);
            return style.backgroundImage === "none" && /^rgba\(.*,\s*0\)$|^transparent$/.test(style.backgroundColor);
        };
        if (clear(root) && (!document.body || clear(document.body))) {
            root.dataset[MARK] = root.style.backgroundColor;
            root.style.backgroundColor = "white";
        }
        const pixel = document.createElement("div");
        pixel.id = ID;
        pixel.style.cssText = `position:absolute;left:0;top:${Math.max(root.scrollHeight, root.clientHeight)}px;width:1px;height:1px;visibility:hidden`;
        root.append(pixel);
    }
}

/**
 * A screenshot of the whole page, however big. A page within the viewport is one screenshot of
 * its size; a bigger one is shot in viewport-sized tiles (see shootTiles), never with Chromium's
 * beyond-viewport capture, which drew a story's `monospace` text in another font.
 * @param {import("playwright").Page} page the page, at device scale factor SCALE
 * @param {import("playwright").Page | import("playwright").Frame} [frame] the document to shoot: the
 *     page itself, or a viewport-sized iframe at the page's top left
 * @returns {Promise<Buffer>} the PNG
 */
export async function screenshotWholePage(page, frame = page) {
    // A throwaway screenshot and two frames first: a story that redraws on a screenshot (Cytoscape's
    // canvases) is done redrawing before the real one.
    await page.screenshot({ ...SHOT, clip: { x: 0, y: 0, width: 1, height: 1 } });
    await frame.evaluate(twoFramesInPage);
    const size = await frame.evaluate(() => {
        const [b, d] = [document.body, document.documentElement];
        const most = (key) =>
            Math.max(...[b, d].flatMap((e) => [e[`scroll${key}`], e[`offset${key}`], e[`client${key}`]]));
        return { width: most("Width"), height: most("Height") };
    });
    const vp = page.viewportSize();
    const inFrame = frame !== page;
    if (inFrame) {
        await frame.evaluate(scrollLikeTopFrame, true);
        await frame.evaluate(twoFramesInPage);
    }
    try {
        if (size.width <= vp.width && size.height <= vp.height) {
            return await page.screenshot({ ...SHOT, clip: { x: 0, y: 0, ...size } });
        }
        return await shootTiles(page, frame, size, vp);
    } finally {
        if (inFrame) {
            await frame.evaluate(scrollLikeTopFrame, false);
        }
    }
}

/**
 * Waits for two frames drawn in the tester iframe.
 * @param {import("playwright").Page | import("playwright").Frame} frame the tester iframe, or the page itself
 * @returns {Promise<void>} once they are drawn
 */
const twoFrames = (frame) => frame.evaluate(twoFramesInPage);

/**
 * In the page: waits for two frames to be drawn.
 * @returns {Promise<void>} once they are drawn
 */
function twoFramesInPage() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/**
 * In the page: waits until every image in the document has loaded and decoded, or failed. A lazy
 * image loads now: one outside the viewport would never load, and its decode() would never settle.
 * @returns {Promise<void>} once they have
 */
function imagesInPage() {
    for (const img of document.images) {
        if (img.loading === "lazy") {
            img.loading = "eager";
        }
    }
    return Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))).then(() => undefined);
}

/**
 * Scrolls the tester iframe's document, as near to (x, y) as it goes, and waits for what came
 * into view (a lazy image) and two frames. A page whose html and body are `overflow: hidden` and
 * `height: 100%` (an app's stylesheet) scrolls the window little or not at all: its overflow
 * scrolls inside the body, so the body scrolls by what the window could not, and the elements
 * pinFixedInPage pinned are moved with the document.
 * @param {import("playwright").Page | import("playwright").Frame} frame the tester iframe, or the page itself
 * @param {number} x in CSS px
 * @param {number} y in CSS px
 * @param {boolean} [settle] whether to wait for what came into view; not when nothing is shot after it
 * @returns {Promise<{ x: number, y: number }>} where it scrolled to, the window's and the body's scroll added
 */
async function scrollFrame(frame, x, y, settle = true) {
    const at = await frame.evaluate(
        ([left, top]) => {
            globalThis.scrollTo(left, top);
            const { body, scrollingElement } = document;
            // The body scrolls whatever the window could not (none of it on a page that scrolls the
            // window). In quirks mode the body IS the window's scroller: scrolling it again would undo
            // the window's scroll, and its scrollTop would count that scroll twice.
            const own = body !== scrollingElement;
            if (own) {
                body.scrollTo(left - globalThis.scrollX, top - globalThis.scrollY);
            }
            const at = {
                x: globalThis.scrollX + (own ? body.scrollLeft : 0),
                y: globalThis.scrollY + (own ? body.scrollTop : 0),
            };
            // A pinned element's containing block does not move when the body scrolls: put it where
            // the document scrolled to (at) shows it, as a full-page shot does.
            for (const [el, , docTop, docLeft] of globalThis.__visualReviewPinned ?? []) {
                const now = el.getBoundingClientRect();
                const move = (name, by) =>
                    el.style.setProperty(name, `${Number.parseFloat(el.style[name]) + by}px`, "important");
                move("top", docTop - at.y - now.top);
                move("left", docLeft - at.x - now.left);
            }
            return at;
        },
        [x, y],
    );
    if (settle) {
        await frame.evaluate(imagesInPage);
        await twoFrames(frame);
    }
    return at;
}

/**
 * The tiles stitched into one picture, encoded as Chromium's own screenshot encodes it, so its bytes
 * are what capture.mjs's one full-page screenshot holds: each tile is shown 1:1 where it belongs in a
 * page of the picture's size, and that page is shot. Chromium decodes the tiles and stitches them,
 * so this process never decodes or encodes a PNG: at four workers, pngjs doing that work on the one
 * Node thread every worker shares made each story about twice as slow. A picture taller than one
 * screenshot is stitched with pngjs instead, as capture.mjs stitches its slices.
 * @param {import("playwright").Page} page the page whose context opens the new page (vitest's page, in a story test)
 * @param {{ png: Buffer, left: number, top: number, width: number, height: number }[]} tiles each tile's PNG at SCALE
 *     device px per CSS px, and where it goes in CSS px
 * @param {{ width: number, height: number }} size the picture's size in CSS px
 * @returns {Promise<Buffer>} the PNG
 */
async function stitchAsChromium(page, tiles, size) {
    if (size.height * SCALE > MAX_SHOT_HEIGHT) {
        const out = new PNG({ width: size.width * SCALE, height: size.height * SCALE });
        for (const t of tiles) {
            const tile = PNG.sync.read(t.png);
            PNG.bitblt(tile, out, 0, 0, t.width * SCALE, t.height * SCALE, t.left * SCALE, t.top * SCALE);
        }
        return PNG.sync.write(out, { filterType: 4 });
    }
    const shown = await page.context().newPage();
    try {
        await shown.setViewportSize(size);
        const imgs = tiles.map(
            (t) =>
                `<img style="left:${t.left}px;top:${t.top}px;width:${t.width}px;height:${t.height}px" ` +
                `src="data:image/png;base64,${t.png.toString("base64")}">`,
        );
        await shown.setContent(
            // The body holds the picture's size: absolute images give it none, and a page whose
            // viewport did not take the size (a story test's) is shot to its document's size.
            `<style>html,body{margin:0}body{position:relative;width:${size.width}px;height:${size.height}px}` +
                `img{display:block;position:absolute}</style>${imgs.join("")}`,
        );
        await shown.evaluate(imagesInPage);
        return await shown.screenshot({ ...SHOT, clip: { x: 0, y: 0, ...size } });
    } finally {
        await shown.close();
    }
}

/**
 * In the page, at scroll (0, 0): pins every position: fixed element (in open shadow roots too)
 * where it is, as position: absolute, and makes every position: sticky one static, so scrolled
 * tiles draw each once, where a full-page shot draws it, instead of once per tile. Or, with
 * `undo`, puts their own styles back.
 * @param {boolean} undo whether to put the styles back
 * @returns {void}
 */
export function pinFixedInPage(undo) {
    const key = "__visualReviewPinned";
    const stickyKey = "__visualReviewUnstuck";
    if (undo) {
        for (const [el, css] of [...(globalThis[key] ?? []), ...(globalThis[stickyKey] ?? [])]) {
            el.style.cssText = css;
        }
        delete globalThis[key];
        delete globalThis[stickyKey];
        return;
    }
    const all = [];
    const walk = (root) => {
        for (const el of root.querySelectorAll("*")) {
            all.push(el);
            if (el.shadowRoot) {
                walk(el.shadowRoot);
            }
        }
    };
    walk(document);
    // A sticky element sticks to each scrolled tile's top; a full-page shot never scrolls, so it
    // stays where the flow puts it at scroll (0, 0): position static draws it there, once.
    const sticky = all.filter((el) => getComputedStyle(el).position === "sticky");
    const fixed = all.filter((el) => getComputedStyle(el).position === "fixed");
    const rects = fixed.map((el) => el.getBoundingClientRect());
    // Each one's own style, and where it sits in the document (the page is at scroll (0, 0)).
    globalThis[key] = fixed.map((el, i) => [el, el.style.cssText, rects[i].top, rects[i].left]);
    globalThis[stickyKey] = sticky.map((el) => [el, el.style.cssText]);
    for (const el of sticky) {
        el.style.setProperty("position", "static", "important");
    }
    for (const [i, el] of fixed.entries()) {
        const r = rects[i];
        const set = (name, value) => el.style.setProperty(name, value, "important");
        set("position", "absolute");
        set("box-sizing", "border-box");
        set("width", `${r.width}px`);
        set("height", `${r.height}px`);
        set("margin", "0");
        set("right", "auto");
        set("bottom", "auto");
        set("top", `${r.top}px`);
        set("left", `${r.left}px`);
        // The element's containing block is now its positioned ancestor, not the viewport.
        const now = el.getBoundingClientRect();
        set("top", `${2 * r.top - now.top}px`);
        set("left", `${2 * r.left - now.left}px`);
    }
}

/**
 * A page bigger than the viewport, shot in viewport-sized tiles: `frame`'s document is scrolled to
 * each tile, `page` is shot clipped to the viewport at its top left, and the tiles are stitched.
 * The layout keeps the viewport (its `vh` units too), and fixed elements are pinned in
 * the document so each is drawn once. Never Chromium's beyond-viewport capture (Playwright's
 * `fullPage` on a page that overflows): it re-resolves generic font families, so a story's
 * `monospace` text switched from the pinned fontconfig's DejaVu Sans Mono to Liberation Mono.
 * @param {import("playwright").Page} page the page to shoot
 * @param {import("playwright").Page | import("playwright").Frame} frame the document to scroll: the
 *     page itself, or an iframe at the page's top left at scale 1
 * @param {{ width: number, height: number }} size the document's whole size in CSS pixels
 * @param {{ width: number, height: number }} vp the size of the document's viewport (the iframe's,
 *     for a frame), shot from the page's top left
 * @returns {Promise<Buffer>} the PNG
 */
async function shootTiles(page, frame, size, vp) {
    const tiles = [];
    try {
        // Inside the try, so a failure still puts every style back (an undo of nothing does nothing).
        await frame.evaluate(pinFixedInPage, false);
        // Each tile copies only what it holds from where the frame actually scrolled to, and the next
        // tile starts where it ended: a frame that scrolls short of the measured size (its scrollable
        // height is less than the full-page size) must not have its clip read past the screenshot.
        // ponytail: rows the frame never scrolls to stay transparent, so they show up as a diff.
        for (let top = 0, h = 1; top < size.height && h > 0; top += h) {
            for (let left = 0, w = 1; left < size.width && w > 0; left += w) {
                // No further than the measured size's end: a body that overflows past the document
                // (All Components, by 16 px) must not scroll the rows a full-page shot cuts off.
                const at = await scrollFrame(
                    frame,
                    Math.max(0, Math.min(left, size.width - vp.width)),
                    Math.max(0, Math.min(top, size.height - vp.height)),
                );
                const [x, y] = [left - at.x, top - at.y];
                w = Math.min(vp.width - x, size.width - left);
                h = Math.min(vp.height - y, size.height - top);
                // Only the part of the viewport this tile adds: the last row of tiles often adds a few
                // rows, and a whole-viewport shot of it was most of a tile's cost for nothing.
                if (w > 0 && h > 0) {
                    const png = await page.screenshot({ ...SHOT, clip: { x, y, width: w, height: h } });
                    tiles.push({ png, left, top, width: w, height: h });
                }
            }
        }
    } finally {
        // Back where the story was; the next screenshot (screenshotWholePage's) waits for its own frames.
        await scrollFrame(frame, 0, 0, false);
        await frame.evaluate(pinFixedInPage, true);
    }
    return stitchAsChromium(page, tiles, size);
}

/**
 * Which build of this tool captured: the commit of its source checkout when it runs from one
 * (a monorepo that develops it), else the installed package's name and version.
 * @returns {string} a commit sha, or `@graphty/visual-review@<version>`
 */
export function toolVersion() {
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

export const clip = (lines) => lines.slice(0, MAX_CONSOLE).map((l) => l.slice(0, MAX_LINE));

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 }).trim();

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
        // The commit checked out and captured: in a called workflow given another ref (a full run of
        // an older master commit), GITHUB_SHA is the caller's commit, not this one.
        commit: git("rev-parse", "HEAD"),
        headSha: event.pull_request?.head?.sha ?? null,
        pr: event.pull_request?.number ?? null,
        runId: Number(process.env.GITHUB_RUN_ID),
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        local: null,
    };
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
 * Reads an earlier capture's images of stories that had no baseline, to compare new captures with.
 * Only complete, valid results are used, and only `new` items (captured twice and stable) whose
 * file hashes to the capture results.json names.
 * @param {string | null} dir the earlier capture's directory, or null
 * @returns {Promise<{ images: Map<string, Buffer>, changed: Map<string, string>, runId: number | null }>} images by
 *     file name, and the capture hash of each story it found changed
 */
async function loadReference(dir) {
    const images = new Map();
    // file -> capture hash of every story the reference found changed on both of its captures
    const changed = new Map();
    let results = null;
    try {
        results = dir ? JSON.parse(await readFile(join(dir, "results.json"), "utf8")) : null;
    } catch {
        // No reference downloaded: every story without a baseline is new.
    }
    if (!results || validateResults(results).length > 0 || !results.complete) {
        return { images, changed, runId: null };
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
    for (const item of results.items.filter((i) => i.status === "changed")) {
        changed.set(item.file, item.capture);
    }
    return { images, changed, runId: results.runId };
}

/**
 * Whether a capture is shot once more, to tell a real change from a one-off flake and an unstable story: a
 * `new` one always, a `changed` one unless it is byte for byte the reference's capture of a story the reference
 * also found changed. That story was then drawn the same way on two runs already (the default branch's and this
 * one), so it is neither a flake nor unstable; on a pull request it is every story the default branch changed
 * since its baselines were last approved, which would otherwise be shot twice in every pull request.
 * @param {string} status the first capture's status
 * @param {string} hash the first capture's sha256
 * @param {string | undefined} referenceHash the reference's capture hash of a story it found changed
 * @returns {boolean} whether to shoot again
 */
export function needsSecondShot(status, hash, referenceHash) {
    return status === "new" || (status === "changed" && hash !== referenceHash);
}

/**
 * Captures one project.
 * @param {{ project: string, storybook: string, baselines: string, out: string, workers: number,
 *     waitFor?: object | null, reference?: string | null, stories?: string[] | null,
 *     fontconfig?: string | null, log?: (line: string) => void }} options `fontconfig` is the
 *     absolute path of the fonts.conf every browser draws with (the config's `fontconfig`), null for
 *     the host's fonts; `waitFor` is the project's config entry (see
 *     shootOnce); `reference` is the default branch's capture (see above); `stories` keeps only
 *     the stories selectStoryIds() picks (a whole id, or every id starting with a prefix), and then no
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
    fontconfig = null,
    log = console.log,
}) {
    const started = Date.now();
    // Pinned fonts: only the committed directory, and a font cache of this run's own (only for the
    // browsers: Playwright finds its Chromium under XDG_CACHE_HOME).
    const fonts = fontconfig ? await pinnedFonts(fontconfig) : null;
    const fontEnv = fontconfig
        ? { FONTCONFIG_FILE: fontconfig, XDG_CACHE_HOME: await mkdtemp(join(tmpdir(), "visual-review-fonts-")) }
        : {};
    await mkdir(join(out, "baselines"), { recursive: true });
    await mkdir(join(out, "second"), { recursive: true });
    const allIds = storyIds(JSON.parse(await readFile(join(storybook, "index.json"), "utf8")));
    const ids = selectStoryIds(allIds, stories);
    const renames = await loadRenames(baselines);
    const refs = await loadReference(reference);
    const [server, base] = await serve(storybook);
    // One browser per worker: every page of a browser shares its one GPU process, so with
    // SwiftShader a busy WebGL page on one worker stalls the others' renders and screenshots.
    const browsers = await Promise.all(
        Array.from({ length: Math.max(1, workers) }, () =>
            chromium.launch({ args: CHROMIUM_ARGS, env: chromiumEnv(fontEnv) }),
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

        const emojiFont = hasEmojiFont({ ...process.env, ...fontEnv });
        if (emojiFont === false) {
            const where = fontconfig ? `in ${fontconfig}` : "on this machine";
            log(
                `warning: no font ${where} draws emoji (fc-list ` +
                    ":charset=1f680 found none), so every emoji in a story is captured as an empty box; " +
                    "add one, such as Noto Color Emoji",
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
                fonts,
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
            if (needsSecondShot(result.status, sha256(first.png), refs.changed.get(job.file))) {
                second = await shoot(browser, url, { delay, waitFor });
                if (!second.png) {
                    return failed(second, "second capture: ");
                }
                result = classify({ baseline, first: first.png, second: second.png, firstResult: result, ...opts });
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
                        const why = item.reason ? `: ${item.reason}` : "";
                        log(`${item.status} ${item.file}${why}`);
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
        if (fontEnv.XDG_CACHE_HOME) {
            await rm(fontEnv.XDG_CACHE_HOME, { recursive: true, force: true });
        }
    }
}

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
