/**
 * Stories as tests, the Node side: a Storybook project's Vitest story tests take each story's
 * screenshot at the end of its test and compare it with the baseline, with capture.mjs's settings
 * and compare.mjs's code, and write the same results.json capture.mjs writes. Published as
 * `@graphty/visual-review/vitest`; the browser side is story-test-setup.mjs
 * (`@graphty/visual-review/vitest/setup`).
 *
 * Every run writes a partial result into its own directory (one per shard): a results.json that
 * is never `complete` (so the gate never takes it for a whole capture) and whose `partial` says
 * which shard it is and whether every story test that ran reached the visual step. `merge-results`
 * combines a project's partials into the capture the review page and the gate read.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { PNG } from "pngjs";

import { classify, readBaseline, sha256 } from "../trusted/lib/compare.mjs";
import { loadConfig, repoRoot } from "../trusted/lib/config.mjs";
import {
    CHROMIUM_ARGS,
    CLOCK_START,
    clip,
    EMPTY,
    fileName,
    hasBaselines,
    loadRenames,
    loadSettings,
    MAX_SHOT_HEIGHT,
    pinnedFonts,
    provenance,
    SCALE,
    storySettings,
    toolVersion,
    VIEWPORT,
} from "./capture.mjs";

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
        const most = (key) =>
            Math.max(...[b, d].flatMap((e) => [e[`scroll${key}`], e[`offset${key}`], e[`client${key}`]]));
        return { width: most("Width"), height: most("Height") };
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
 * than the viewport grows the page and the iframe to its scroll size first (so `vh` sees the grown
 * size, where capture.mjs's full-page shot keeps 900 px: a known parity limit).
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
 * The CSS of Storybook's own iframe.html (its layout classes among them), which Vitest's tester
 * page does not carry.
 * @param {string} cwd the Storybook project's directory, whose `storybook` package is read
 * @returns {string} the CSS of base-preview-head.html
 */
function storybookHead(cwd) {
    const pkg = createRequire(join(cwd, "package.json")).resolve("storybook/package.json");
    const html = readFileSync(join(pkg, "../assets/server/base-preview-head.html"), "utf8");
    return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

/**
 * Production semantics for a story-test Vitest project, as `build-storybook` builds what
 * capture.mjs shoots: spread into the project's config.
 */
export const PRODUCTION = { mode: "production", define: { "process.env.NODE_ENV": JSON.stringify("production") } };

/**
 * Everything one project's storybook Vitest project needs to shoot its stories.
 * @param {{ project: string, out: string, root?: string }} options the visual-review project, the
 *     directory this run's partial result goes to, and the repository root
 * @returns {{ viewport: object, providerOptions: object, commands: object, reporter: object }} for
 *     the Vitest project's `browser.viewport`, `playwright(...)`, `browser.commands` and the root
 *     config's `reporters`
 */
export function visualStoryTest({ project, out, root = repoRoot() }) {
    const config = loadConfig(root);
    const entry = config.projects[project];
    if (!entry) {
        throw new Error(`visual-review: no project ${project} in the config`);
    }
    const baselines = join(root, config.baselines, project);
    const fontconfig = config.fontconfig ? join(root, config.fontconfig) : null;
    for (const dir of ["second", "baselines"]) {
        mkdirSync(join(out, dir), { recursive: true });
    }
    const results = {
        version: 1,
        project,
        commit: null,
        complete: false,
        expected: 0,
        capturedAt: new Date().toISOString(),
        clock: { start: CLOCK_START, running: true },
        scale: SCALE,
        environment: { harness: "story-test", mode: "production", fonts: null, tool: toolVersion() },
        items: [],
    };
    let renames = new Map();
    const ready = Promise.all([
        provenance().then((p) => Object.assign(results, p)),
        hasBaselines(baselines).then((s) => (results.seeded = s)),
        loadRenames(baselines).then((r) => (renames = r)),
        fontconfig && pinnedFonts(fontconfig).then((f) => (results.environment.fonts = f)),
    ]);
    const planned = new Set();
    const pending = new Map();
    const save = () => {
        writeFileSync(join(out, "results.json.tmp"), `${JSON.stringify(results, null, 2)}\n`);
        renameSync(join(out, "results.json.tmp"), join(out, "results.json"));
    };
    const record = (item) => {
        results.items = results.items.filter((i) => i.file !== item.file);
        results.items.push(item);
        results.expected = results.items.length;
        save();
    };
    const settings = async (id, chromatic) => storySettings({ chromatic }, await loadSettings(baselines, id));

    /**
     * The baseline a story and mode is compared with: its own, or, renamed in renames.json while
     * it has none of its own, the old id's.
     * @param {string} id the story id
     * @param {string | null} mode the mode
     * @returns {Promise<{ baseline: Buffer | null, from: string | null }>} the bytes and the old id
     */
    const baselineOf = async (id, mode) => {
        const own = await readBaseline(join(baselines, fileName(id, mode)));
        const old = renames.get(id);
        const theirs = !own && old ? await readBaseline(join(baselines, fileName(old, mode))) : null;
        return theirs ? { baseline: theirs, from: old } : { baseline: own, from: null };
    };

    const finish = async (job, first, second, console) => {
        const { id, mode, file, baseline, from, s } = job;
        const r = classify({ baseline, first, second, threshold: s.threshold, includeAA: s.includeAA, moved: !!from });
        if (["changed", "moved", "new", "unstable"].includes(r.status)) {
            writeFileSync(join(out, file), r.flaky ? second : first);
        }
        if (r.status === "unstable") {
            writeFileSync(join(out, "second", file), second);
        }
        if (baseline && (r.status === "changed" || r.status === "unstable" || (from && r.baseline !== r.capture))) {
            writeFileSync(join(out, "baselines", file), baseline);
        }
        const lines = r.status === "unchanged" || r.status === "moved" ? [] : clip(console);
        record({
            id,
            mode,
            file,
            ...(from && { from }),
            ...r,
            threshold: s.threshold,
            includeAA: s.includeAA,
            reason: null,
            console: lines,
        });
        return r.status;
    };

    const commands = {
        visualHead: () => storybookHead(process.cwd()),
        visualPark: (ctx) => park(ctx.page),
        /**
         * What the browser side does for one story: its modes, the project's wait and the delay.
         * A story its settings exclude is recorded here and has no modes to shoot.
         * @param {unknown} _ctx the command's context
         * @param {{ id: string, chromatic: object }} story the story id and its parameters.chromatic
         * @returns {Promise<{ modes: object[], waitFor: object | null, delay: number }>} the plan
         */
        async visualPlan(_ctx, { id, chromatic }) {
            await ready;
            planned.add(id);
            const s = await settings(id, chromatic);
            if (!s.disableSnapshot) {
                return { modes: s.modes, waitFor: entry.waitFor ?? null, delay: s.delay };
            }
            for (const { name } of s.modes) {
                const file = fileName(id, name);
                // Excluded by its own parameters while it has a baseline: merge-results reports it removed.
                if (!(s.excludedByStory && (await readBaseline(join(baselines, file))))) {
                    record({
                        id,
                        mode: name,
                        file,
                        threshold: s.threshold,
                        includeAA: s.includeAA,
                        ...EMPTY,
                        status: "excluded",
                        reason: s.reason,
                    });
                }
            }
            return { modes: [], waitFor: null, delay: 0 };
        },
        /**
         * Shoots the mounted story in one mode. A first shot that differs from the baseline (or has
         * none) asks for a second render (`again`), as capture.mjs captures twice.
         * @param {{ page: import("playwright").Page, frame: () => Promise<import("playwright").Frame> }} ctx
         *     the command's context: vitest's page and the tester iframe
         * @param {{ id: string, mode: string | null, chromatic: object, console: string[] }} shot the
         *     story, its mode, its parameters.chromatic and the console lines since its render
         * @returns {Promise<{ status?: string, again?: boolean }>} the item's status, or a request
         *     for a second render
         */
        async visualShot(ctx, { id, mode, chromatic, console }) {
            const file = fileName(id, mode);
            results.environment.chromium ??= ctx.page.context().browser()?.version() ?? null;
            const png = await shootFrame(ctx.page, await ctx.frame());
            const held = pending.get(file);
            if (held) {
                pending.delete(file);
                return { status: await finish(held.job, held.first, png, [...held.console, ...console]) };
            }
            const job = { id, mode, file, ...(await baselineOf(id, mode)), s: await settings(id, chromatic) };
            const r = classify({
                baseline: job.baseline,
                first: png,
                threshold: job.s.threshold,
                includeAA: job.s.includeAA,
            });
            if (r.status === "changed" || r.status === "new") {
                pending.set(file, { job, first: png, console });
                return { again: true };
            }
            return { status: await finish(job, png, null, console) };
        },
        /**
         * Records a story and its modes as failed: a failed play, a render error, a console rule.
         * @param {unknown} _ctx the command's context
         * @param {{ id: string, modes: (string | null)[], reason: string, chromatic?: object,
         *     console: string[] }} failure the story, the modes it failed in, why, and its console
         * @returns {Promise<void>} once recorded
         */
        async visualFail(_ctx, { id, modes, reason, chromatic = {}, console }) {
            for (const mode of modes) {
                const file = fileName(id, mode);
                pending.delete(file);
                const { baseline } = await baselineOf(id, mode);
                const s = await settings(id, chromatic);
                record({
                    id,
                    mode,
                    file,
                    threshold: s.threshold,
                    includeAA: s.includeAA,
                    ...EMPTY,
                    baseline: baseline && sha256(baseline),
                    status: "failed",
                    reason: reason.slice(0, 2000) || "failed",
                    console: clip(console),
                });
            }
        },
    };

    let shard = { index: 1, count: 1 };
    const reporter = {
        onInit(vitest) {
            shard = vitest.config.shard ?? shard;
        },
        /**
         * Records the shard and whether every story test that ran went through the visual step.
         * @param {any[]} modules the run's test modules
         */
        onTestRunEnd(modules) {
            const ran = new Set();
            for (const m of modules) {
                for (const t of m.children.allTests()) {
                    const id = t.meta().storyId;
                    if (id && t.result().state !== "skipped") {
                        ran.add(id);
                    }
                }
            }
            const missing = [...ran].filter((id) => !planned.has(id)).sort();
            const reported = results.commit !== null && missing.length === 0 && pending.size === 0;
            results.partial = { shard, reported, missing };
            results.items.sort((a, b) => (a.file < b.file ? -1 : 1));
            save();
        },
    };

    return {
        viewport: VIEWPORT,
        providerOptions: {
            launchOptions: {
                args: CHROMIUM_ARGS,
                env: {
                    ...process.env,
                    ...(fontconfig && { FONTCONFIG_FILE: fontconfig, XDG_CACHE_HOME: join(out, ".font-cache") }),
                    TZ: "UTC",
                },
            },
            contextOptions: { viewport: VIEWPORT, deviceScaleFactor: SCALE, timezoneId: "UTC", locale: "en-US" },
        },
        commands,
        reporter,
    };
}
