/**
 * The renderer: Playwright Chromium. `open()` starts a browser with capture's switches, `shoot()`
 * renders one story URL in a fresh context and screenshots the whole canvas, and `close()` stops
 * the browser. The page helpers below (whole-page and tiled screenshots, pinned fixed elements)
 * are shared with the story tests (story-test.mjs), which shoot through vitest's own page.
 */

import { chromium } from "playwright";
import { PNG } from "pngjs";

/* global document, getComputedStyle, requestAnimationFrame, OffscreenCanvas, ImageData, FileReader -- read only inside the page */

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
 * Starts a browser with capture's switches.
 * @param {{ env?: NodeJS.ProcessEnv }} [options] the environment it runs in
 * @returns {Promise<import("playwright").Browser>} the browser
 */
export const open = ({ env = process.env } = {}) => chromium.launch({ args: CHROMIUM_ARGS, env });

/**
 * Stops a browser open() started.
 * @param {import("playwright").Browser} browser the browser
 * @returns {Promise<void>} once it is closed
 */
export const close = (browser) => browser.close();

/** The quality of the list pictures `run` encodes as WebP: 2.7 times smaller than PNG, measured. */
export const WEBP_QUALITY = 0.85;

/**
 * The renderer's name and version, as capture records them in its start line.
 * @param {import("playwright").Browser} browser a browser open() started
 * @returns {{ name: string, version: string }} such as { name: "Chromium", version: "143.0.7499.4" }
 */
export const rendererOf = (browser) => ({ name: "Chromium", version: browser.version() });

/**
 * A WebP encoder in one page of `browser`: each picture's RGBA pixels drawn on a canvas and encoded
 * by Chromium's own WebP encoder (about 9 ms for a 400-pixel-wide picture).
 * @param {import("playwright").Browser} browser a browser open() started
 * @returns {Promise<{ encode: (images: Record<string, { width: number, height: number, data: Uint8Array }>)
 *     => Promise<Record<string, Buffer>>, close: () => Promise<void> }>} encode() gives each
 *     picture's WebP file, by the same keys; close() closes the page
 */
export async function webpEncoder(browser) {
    const page = await browser.newPage();
    return {
        async encode(images) {
            const input = Object.entries(images).map(([kind, img]) => ({
                kind,
                w: img.width,
                h: img.height,
                b64: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString("base64"),
            }));
            const out = await page.evaluate(
                async ({ list, quality }) => {
                    const encoded = {};
                    for (const { kind, w, h, b64 } of list) {
                        const raw = await (await fetch(`data:application/octet-stream;base64,${b64}`)).arrayBuffer();
                        const canvas = new OffscreenCanvas(w, h);
                        canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(raw), w, h), 0, 0);
                        const blob = await canvas.convertToBlob({ type: "image/webp", quality });
                        if (blob.type !== "image/webp") {
                            throw new Error(`this browser encodes no WebP (it gave ${blob.type})`);
                        }
                        const url = await new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(String(reader.result));
                            reader.readAsDataURL(blob);
                        });
                        encoded[kind] = url.slice(url.indexOf(",") + 1);
                    }
                    return encoded;
                },
                { list: input, quality: WEBP_QUALITY },
            );
            return Object.fromEntries(Object.entries(out).map(([k, b64]) => [k, Buffer.from(b64, "base64")]));
        },
        close: () => page.close(),
    };
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
        // Playwright's clock, which shoot() installs after this script runs, turns
        // requestAnimationFrame into a timer: a frame waited on through it can end before
        // Chromium drew any, and a screenshot then fails with "Unable to capture screenshot".
        // Capture's own waits for a drawn frame use the real one, kept here.
        Object.defineProperty(globalThis, "__proofroomFrame", { value: requestAnimationFrame.bind(globalThis) });
    });
    return context;
}

/**
 * Loads one page, waits until the story source says it is ready, and reads what the story source
 * asks of it (Storybook's preview and its stories' parameters), plus what the page says about the
 * renderer.
 * @param {import("playwright").Browser} browser the browser
 * @param {string} url the page
 * @param {{ ready: () => unknown, read: () => unknown }} source in the page: whether it is ready,
 *     and what to read once it is (plain data)
 * @returns {Promise<{ value: any, renderer: string | null, gpu: boolean }>} what was read, the
 *     WebGL renderer and whether WebGPU is there
 */
export async function probe(browser, url, { ready, read }) {
    const context = await newContext(browser);
    try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load", timeout: RENDER_TIMEOUT });
        await page.waitForFunction(ready, null, { timeout: RENDER_TIMEOUT });
        const value = await page.evaluate(read);
        const facts = await page.evaluate(() => {
            const gl = document.createElement("canvas").getContext("webgl");
            const info = gl?.getExtension("WEBGL_debug_renderer_info");
            let renderer = null;
            if (gl) {
                renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
            }
            return { renderer, gpu: "gpu" in navigator };
        });
        return { value, ...facts };
    } finally {
        await context.close();
    }
}

/**
 * Renders one story and mode in a fresh context and screenshots it.
 * @param {import("playwright").Browser} browser the browser
 * @param {string} url the story's full URL
 * @param {{ delay: number, waitFor: { selector: string, method: string, failOnConsole: string |
 *     null } | null, rendered: { phase: () => string | false, failed: string[], error: () => string[] } }} options
 *     the story's delay; what to wait for after the render: the promise `method` returns on every
 *     element matching `selector`, failing the story when a console line contains
 *     `failOnConsole`; and how the story source tells, in the story's page, that it drew
 *     (`phase` is false until it ended, then how; `failed` lists the endings that are failures,
 *     and `error` reads what the page shows about one)
 * @returns {Promise<{ png: Buffer | null, reason: string | null, console: string[] }>} the PNG,
 *     or a reason it failed; a failure's console holds the rest of its message and any stack
 */
export async function shoot(browser, url, { delay, waitFor, rendered }) {
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
            .waitForFunction(rendered.phase, null, { timeout: RENDER_TIMEOUT })
            .then((h) => h.jsonValue());
        if (rendered.failed.includes(phase)) {
            const shown = await frame.evaluate(rendered.error);
            return fail([`story render ${phase}`, ...shown].join("\n"));
        }
        // A web font the story uses is fetched only once text needs it, which can be after the
        // render completed; a capture taken before it arrives draws the fallback face, so the
        // text and anything placed beside the text differ from a later capture.
        // Wait for every font in use, then for one frame drawn with them.
        await frame.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((r) => /** @type {any} */ (globalThis).__proofroomFrame(() => r()));
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
export const SHOT = /** @type {const} */ ({ animations: "disabled", caret: "hide" });

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
    if (size.width <= vp.width && size.height <= vp.height) {
        return page.screenshot({ ...SHOT, clip: { x: 0, y: 0, ...size } });
    }
    return shootTiles(page, frame, size, vp);
}

/**
 * Waits for two frames drawn in the tester iframe.
 * @param {import("playwright").Page | import("playwright").Frame} frame the tester iframe, or the page itself
 * @returns {Promise<void>} once they are drawn
 */
export const twoFrames = (frame) => frame.evaluate(twoFramesInPage);

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
 * @returns {Promise<{ x: number, y: number }>} where it scrolled to, the window's and the body's scroll added
 */
async function scrollFrame(frame, x, y) {
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
    await frame.evaluate(imagesInPage);
    await twoFrames(frame);
    return at;
}

/**
 * The stitched picture as Chromium's own screenshot encodes it, so its bytes are what
 * capture.mjs's one full-page screenshot holds: shown 1:1 in a page of its own size and shot. A
 * picture taller than one screenshot is encoded as capture.mjs stitches its slices.
 * @param {import("playwright").Page} page vitest's page, whose context opens the new page
 * @param {PNG} image the stitched picture, at SCALE device px per CSS px
 * @param {{ width: number, height: number }} size in CSS px
 * @returns {Promise<Buffer>} the PNG
 */
async function encodeAsChromium(page, image, size) {
    const png = PNG.sync.write(image, { filterType: 4 });
    if (image.height > MAX_SHOT_HEIGHT) {
        return png;
    }
    const shown = await page.context().newPage();
    try {
        await shown.setViewportSize(size);
        await shown.setContent(
            `<style>html,body{margin:0}img{display:block;width:${size.width}px;height:${size.height}px}</style>` +
                `<img src="data:image/png;base64,${png.toString("base64")}">`,
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
export async function shootTiles(page, frame, size, vp) {
    const view = { x: 0, y: 0, ...vp };
    const out = new PNG({ width: size.width * SCALE, height: size.height * SCALE });
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
                const tile = PNG.sync.read(await page.screenshot({ ...SHOT, clip: view }));
                const [x, y] = [left - at.x, top - at.y];
                w = Math.min(vp.width - x, size.width - left);
                h = Math.min(vp.height - y, size.height - top);
                if (w > 0 && h > 0) {
                    PNG.bitblt(tile, out, x * SCALE, y * SCALE, w * SCALE, h * SCALE, left * SCALE, top * SCALE);
                }
            }
        }
    } finally {
        await scrollFrame(frame, 0, 0);
        await frame.evaluate(pinFixedInPage, true);
    }
    return encodeAsChromium(page, out, size);
}
