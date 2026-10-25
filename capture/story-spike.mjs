/**
 * SPIKE (issue #3389), not the harness: screenshots taken inside a Storybook project's Vitest
 * story tests, written as a results.json that `visual-review parity` compares with capture.mjs's
 * capture of the built Storybook. It answers one question -- can a shot of Vitest's tester iframe
 * hold the same bytes as capture.mjs's shot of Storybook's iframe.html -- in dev and production
 * mode. The real harness (`@graphty/visual-review/vitest`, issue #3471) is built after it.
 *
 * Node side: the browser options that match capture.mjs's context and the `visualSpikeShot`
 * command. The browser side is story-spike-setup.mjs.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PNG } from "pngjs";

import { classify, readBaseline } from "../trusted/lib/compare.mjs";
import { CHROMIUM_ARGS, fileName, loadSettings, MAX_SHOT_HEIGHT, pinnedFonts, storySettings } from "./capture.mjs";

const VIEWPORT = { width: 1200, height: 900 };
const SCALE = 2;
const SHOT = /** @type {const} */ ({ animations: "disabled", caret: "hide" });

/* global document, requestAnimationFrame -- read only inside the page */

/**
 * The size a full-page screenshot of the frame's document would have, as capture.mjs measures it.
 * @param {import("playwright").Frame} frame the tester iframe
 * @returns {Promise<{ width: number, height: number }>} in CSS px
 */
const measure = (frame) =>
    frame.evaluate(() => {
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
/**
 * Waits for two frames drawn in the tester iframe.
 * @param {import("playwright").Frame} frame the tester iframe
 * @returns {Promise<void>} once they are drawn
 */
const twoFrames = (frame) =>
    frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/**
 * A play function's real pointer stays where it last was and hovers whatever is under it;
 * capture.mjs's page never had a pointer. Moved off the page, it hovers nothing.
 * @param {import("playwright").Page} page the page
 * @returns {Promise<void>} once it moved
 */
const park = (page) => page.mouse.move(-1, -1);

/**
 * The outer page's top left `size`, in slices of at most MAX_SHOT_HEIGHT device px stitched with
 * the same PNG filter as capture.mjs's screenshotWholePage, or as one shot when it fits.
 * @param {import("playwright").Page} page the page
 * @param {{ width: number, height: number }} size in CSS px
 * @returns {Promise<Buffer>} the PNG
 */
async function sliced(page, size) {
    const [width, height] = [size.width * SCALE, size.height * SCALE];
    if (height <= MAX_SHOT_HEIGHT) {
        return page.screenshot({ ...SHOT, clip: { x: 0, y: 0, ...size } });
    }
    const out = new PNG({ width, height });
    for (let top = 0; top < height; top += MAX_SHOT_HEIGHT) {
        const rows = Math.min(MAX_SHOT_HEIGHT, height - top);
        const clip = { x: 0, y: top / SCALE, width: size.width, height: rows / SCALE };
        PNG.sync.read(await page.screenshot({ ...SHOT, clip })).data.copy(out.data, top * width * 4);
    }
    return PNG.sync.write(out, { filterType: 4 });
}

/**
 * Sizes the box vitest scales the tester iframe in, which the iframe fills.
 * @param {import("playwright").Frame} frame the tester iframe
 * @param {{ width: number, height: number }} size in CSS px
 * @returns {Promise<void>} once it is set
 */
const sizeFrame = async (frame, size) =>
    (await frame.frameElement()).evaluate((el, s) => {
        el.parentElement.style.width = `${s.width}px`;
        el.parentElement.style.height = `${s.height}px`;
    }, size);

/**
 * The tester iframe's whole document, as capture.mjs's screenshotWholePage shoots iframe.html:
 * a throwaway shot, two frames, measure, then the outer page clipped to the iframe, which sits at
 * the top left at scale 1 when the page's viewport is the iframe's size. A story taller or wider
 * than the viewport grows the page and the iframe to its scroll size first. That is where this
 * shot cannot match capture.mjs's: a full-page shot of a top-level page keeps the viewport, so
 * `vh` and lazy loading see 900 px, while a grown iframe is a taller viewport. (Scrolling the
 * iframe and stitching keeps `vh` but loads what is lazily loaded on scroll: also different.)
 * @param {import("playwright").Page} page vitest's orchestrator page
 * @param {import("playwright").Frame} frame the tester iframe
 * @returns {Promise<Buffer>} the PNG
 */
async function shootFrame(page, frame) {
    await park(page);
    await page.screenshot({ ...SHOT, clip: { x: 0, y: 0, width: 1, height: 1 } });
    await twoFrames(frame);
    const size = await measure(frame);
    const grow = size.width > VIEWPORT.width || size.height > VIEWPORT.height;
    if (grow) {
        await page.setViewportSize(size);
        await sizeFrame(frame, size);
        await twoFrames(frame);
    }
    try {
        return await sliced(page, size);
    } finally {
        if (grow) {
            await sizeFrame(frame, VIEWPORT);
            await page.setViewportSize(VIEWPORT);
        }
    }
}

/**
 * Everything one project's storybook Vitest project needs for the spike.
 * @param {{ root: string, project: string, out: string, mode: string, fontconfig: string }} options
 *     the repository root, the visual-review project, where results.json and the PNGs go, the
 *     Vite mode under test, and the pinned fonts.conf
 * @returns {{ viewport: object, providerOptions: object, commands: object }} for the Vitest
 *     project's `browser.viewport`, `playwright(...)` and `browser.commands`
 */
export function storySpike({ root, project, out, mode, fontconfig }) {
    const baselines = join(root, "visual-baselines", project);
    mkdirSync(out, { recursive: true });
    const results = {
        version: 1,
        project,
        commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        headSha: null,
        pr: null,
        runId: null,
        runAttempt: null,
        local: null,
        seeded: true,
        complete: false,
        expected: 0,
        capturedAt: new Date().toISOString(),
        clock: { start: "2026-01-01T12:00:00Z", running: true },
        scale: SCALE,
        environment: { harness: "story-spike", mode, fonts: null },
        items: [],
    };
    // A project with several modes runs once per mode into the same directory: keep the others.
    try {
        results.items = JSON.parse(readFileSync(join(out, "results.json"), "utf8")).items;
    } catch {
        // the first run into this directory
    }
    const fonts = pinnedFonts(fontconfig).then((f) => (results.environment.fonts = f));
    return {
        viewport: VIEWPORT,
        providerOptions: {
            launchOptions: {
                args: CHROMIUM_ARGS,
                env: {
                    ...process.env,
                    FONTCONFIG_FILE: fontconfig,
                    XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "story-spike-fonts-")),
                    TZ: "UTC",
                },
            },
            contextOptions: { viewport: VIEWPORT, deviceScaleFactor: SCALE, timezoneId: "UTC", locale: "en-US" },
        },
        commands: {
            /**
             * Parks the pointer before a story renders, so it never starts out hovered.
             * @param {{ page: import("playwright").Page }} ctx the command's context
             * @returns {Promise<void>} once it moved
             */
            visualSpikePark: (ctx) => park(ctx.page),
            /**
             * The styles of Storybook's own iframe.html (its layout classes among them), which
             * Vitest's tester page does not carry.
             * @returns {string} the CSS of base-preview-head.html, from the project's Storybook
             */
            visualSpikeHead() {
                const pkg = createRequire(join(process.cwd(), "package.json")).resolve("storybook/package.json");
                const file = join(dirname(pkg), "assets/server/base-preview-head.html");
                const html = readFileSync(file, "utf8");
                return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
            },
            /**
             * Shoots the mounted story and records it against its baseline.
             * @param {{ page: import("playwright").Page, frame: () => Promise<import("playwright").Frame> }} ctx
             *     the command's context: vitest's page and the tester iframe
             * @param {{ id: string, mode: string | null, chromatic: object, served: string }} story the
             *     story id, its mode, its parameters.chromatic and how the page was served
             * @returns {Promise<string>} the item's status
             */
            async visualSpikeShot(ctx, { id, mode, chromatic, served }) {
                await fonts;
                results.environment.served = served;
                const file = fileName(id, mode);
                const s = storySettings({ chromatic }, await loadSettings(baselines, id));
                const png = await shootFrame(ctx.page, await ctx.frame());
                writeFileSync(join(out, file), png);
                const baseline = await readBaseline(join(baselines, file));
                const r = classify({ baseline, first: png, threshold: s.threshold, includeAA: s.includeAA });
                results.items = results.items.filter((i) => i.file !== file);
                results.items.push({
                    id,
                    mode,
                    file,
                    ...r,
                    threshold: s.threshold,
                    includeAA: s.includeAA,
                    reason: null,
                    console: [],
                });
                results.expected = results.items.length;
                writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
                return r.status;
            },
        },
    };
}
