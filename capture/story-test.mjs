/**
 * Stories as tests, the Node side: a Storybook project's Vitest story tests take each story's
 * screenshot at the end of its test, with capture.mjs's settings, and judge it with
 * compareSnapshot() (proofroom/compare), one snapshot at a time. Published as `proofroom/vitest`;
 * the browser side is story-test-setup.mjs (`proofroom/vitest/setup`).
 *
 * Every run writes its result lines and a run file into its own directory (one per shard);
 * `proofroom collect` combines a project's directories into the capture the review page and the
 * gate read.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

import { assertPassed, compareSnapshot } from "../trusted/lib/compare.mjs";
import { fileName, loadSettings, provenance, storySettings, toolVersion } from "../trusted/lib/compare-run.mjs";
import { loadConfig, repoRoot } from "../trusted/lib/config.mjs";
import { MAX_ATTEMPTS } from "../trusted/lib/results.mjs";
import { CHROMIUM_ARGS, CLOCK_START, pinnedFonts, SCALE, SHOT, shootTiles, twoFrames, VIEWPORT } from "./capture.mjs";

/** Test runs this process wrote a run file for, which name the run files. */
let runs = 0;

/* global document -- read only inside the page */

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
 * A play function's real pointer stays where it last was and hovers whatever is under it;
 * capture.mjs's page never had a pointer. Moved off the page, it hovers nothing.
 * @param {import("playwright").Page} page the page
 * @returns {Promise<void>} once it moved
 */
const park = (page) => page.mouse.move(-1, -1);

/**
 * The tester iframe's whole document, as capture.mjs's screenshotWholePage shoots iframe.html:
 * a throwaway shot, two frames, measure, then the outer page clipped to the iframe, which sits at
 * the top left at scale 1 when the page's viewport is the iframe's size. A story taller or wider
 * than the viewport is shot in viewport-sized tiles, scrolling the iframe's document to each and
 * stitching them, so its layout keeps the 1200 x 900 viewport (its `vh` units too), as
 * capture.mjs's full-page shot does; growing the frame instead made `vh` follow it.
 * @param {import("playwright").Page} page vitest's orchestrator page
 * @param {import("playwright").Frame} frame the tester iframe
 * @returns {Promise<Buffer>} the PNG
 */
async function shootFrame(page, frame) {
    await park(page);
    await page.screenshot({ ...SHOT, clip: { x: 0, y: 0, width: 1, height: 1 } });
    await twoFrames(frame);
    const size = await measure(frame);
    await frame.evaluate(scrollLikeTopFrame, true);
    try {
        await twoFrames(frame);
        const view = { x: 0, y: 0, ...VIEWPORT };
        if (size.width <= VIEWPORT.width && size.height <= VIEWPORT.height) {
            return await page.screenshot({ ...SHOT, clip: { ...view, ...size } });
        }
        return await shootTiles(page, frame, size, VIEWPORT);
    } finally {
        await frame.evaluate(scrollLikeTopFrame, false);
    }
}

/**
 * Makes the tester iframe's document scrollable by one pixel below everything it draws, or takes
 * that back. iframe.html, the top frame capture.mjs shoots, always scrolls on the compositor, so
 * Chromium draws its `position: fixed` elements (a popover, a menu, a toast) in layers of their
 * own, apart from the scrolling page; an iframe whose content fits does not scroll, so it drew
 * them into the page's layer and their blurred shadows came out one level darker. The pixel is
 * added after the frame was measured and lies outside every shot; headless Chromium draws no
 * scrollbar, so nothing moves.
 * @param {boolean} on add the pixel, or remove it
 * @returns {void}
 */
function scrollLikeTopFrame(on) {
    const ID = "visual-review-scroll-pixel";
    document.getElementById(ID)?.remove();
    if (on) {
        const pixel = document.createElement("div");
        pixel.id = ID;
        const root = document.documentElement;
        pixel.style.cssText = `position:absolute;left:0;top:${Math.max(root.scrollHeight, root.clientHeight)}px;width:1px;height:1px;visibility:hidden`;
        root.append(pixel);
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
 * The story test files of the projects this harness shoots in, all of them (before sharding or any
 * filter), and those this run loaded and ran: collect checks the shards ran every file once,
 * as capture.mjs shoots every story of the built Storybook's index.
 * @param {any} vitest the Vitest instance, from the reporter's onInit
 * @param {any[]} modules the run's test modules
 * @param {(project: any) => boolean} isOurs whether a Vitest project runs the visual step
 * @param {string} root the repository root, which the paths are relative to
 * @returns {Promise<{ files: string[], ran: string[] }>} repository-relative paths, sorted
 */
async function storyFiles(vitest, modules, isOurs, root) {
    const projects = (vitest?.projects ?? []).filter(isOurs);
    const rel = (file) => relative(root, file).replaceAll("\\", "/");
    const globbed = await Promise.all(projects.map((p) => p.globTestFiles()));
    const files = globbed.flatMap((g) => g.testFiles).map(rel);
    // A story file whose stories are all docs (no story test at all) loaded too: vitest reports it skipped.
    const empty = (m) => m.state() === "skipped" && [...m.children.allTests()].length === 0;
    const loaded = (m) => (["passed", "failed"].includes(m.state()) || empty(m)) && m.errors().length === 0;
    const ran = modules.filter((m) => projects.includes(m.project) && loaded(m)).map((m) => rel(m.moduleId));
    const sort = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b));
    return { files: sort(files), ran: sort(ran) };
}

/**
 * Production semantics for a story-test Vitest project, as `build-storybook` builds what
 * capture.mjs shoots and capture.mjs's static server serves it: spread into the project's config.
 * `appType: "mpa"` answers a path that is no file with a 404, as that server does, where Vite's
 * default (`spa`) answers it with index.html and a 200, so a story that fetches a missing file
 * reads HTML instead of being refused.
 */
export const PRODUCTION = {
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    appType: "mpa",
};

/**
 * Everything one project's storybook Vitest project needs to shoot its stories.
 *
 * Each story's shot is judged at once by compareSnapshot() (proofroom/compare), which appends its
 * result line to `<out>/results-<pid>-<thread>.ndjson` and keeps the images the review page needs.
 * At the end of the run the reporter writes `<out>/run-<pid>-<n>.json`: which shard ran, the project's
 * story files and those it ran, and whether every story test that ran reached the visual step.
 * `proofroom collect` turns the shards' directories into the capture the page and the gate read. A
 * rerun of the failed story files into the same directory adds its own lines and run file; a
 * snapshot it shoots again is simply its next attempt.
 * @param {{ project: string, out: string, root?: string, fail?: "differences" | "errors",
 *     retries?: number }} options the proofroom project, the directory this run's results go to,
 *     the repository root; `fail` is when a story test fails: `"differences"` (default) when a
 *     snapshot did not pass, `"errors"` only when the story could not be shot or the tool failed;
 *     `retries` (default 0) shoots a snapshot that did not pass again inside the same story test,
 *     up to that many times, each shot one attempt
 * @returns {{ viewport: object, providerOptions: object, commands: object, reporter: object }} for
 *     the Vitest project's `browser.viewport`, `playwright(...)`, `browser.commands` and the root
 *     config's `reporters`
 */
export function visualStoryTest({ project, out, root = repoRoot(), fail = "differences", retries = 0 }) {
    if (!["differences", "errors"].includes(fail)) {
        throw new Error(`proofroom: fail must be "differences" or "errors", not ${JSON.stringify(fail)}`);
    }
    if (!(Number.isInteger(retries) && retries >= 0 && retries <= MAX_ATTEMPTS)) {
        throw new Error(`proofroom: retries must be an integer from 0 to ${MAX_ATTEMPTS}`);
    }
    const config = loadConfig(root);
    const entry = config.projects[project];
    if (!entry) {
        throw new Error(`proofroom: no project ${project} in the config`);
    }
    const baselines = join(root, config.baselines, project);
    const fontconfig = config.fontconfig ? join(root, config.fontconfig) : null;
    mkdirSync(join(out, "baselines"), { recursive: true });
    const header = {
        project,
        commit: null,
        capturedAt: new Date().toISOString(),
        clock: { start: CLOCK_START, running: true },
        scale: SCALE,
        environment: { harness: "story-test", mode: "production", fonts: null, tool: toolVersion() },
    };
    const ready = Promise.all([
        provenance().then((p) => Object.assign(header, p)),
        fontconfig && pinnedFonts(fontconfig).then((f) => (header.environment.fonts = f)),
    ]);
    const planned = new Set();
    // Snapshots their own parameters now exclude while they have a baseline: collect says why they are removed.
    const excluded = new Set();
    // Shots of each snapshot in the story test running now, for `retries`.
    const shots = new Map();
    const settings = async (id, chromatic) => storySettings({ chromatic }, await loadSettings(baselines, id));
    const judge = (id, mode, s, more) =>
        compareSnapshot({
            project,
            baselines,
            id,
            mode,
            settings: { threshold: s.threshold, includeAA: s.includeAA },
            out,
            ...more,
        });

    const commands = {
        visualHead: () => storybookHead(process.cwd()),
        /**
         * Moves the pointer off the page and gives the tester iframe the focus: iframe.html is its
         * page's only document, so it has the focus a story's play gives an element, and the focus
         * ring that shows it. Then a Shift press: every story shares the tester iframe, and a real
         * click in an earlier story leaves Chromium's input modality on "mouse", which hides the
         * focus ring of a script focus() (a dialog's autofocus); capture.mjs loads each story fresh,
         * where that ring shows, and a key press puts the modality back to that.
         * @param {{ page: import("playwright").Page, frame: () => Promise<import("playwright").Frame> }} ctx
         *     the command's context
         * @returns {Promise<void>} once done
         */
        async visualPark(ctx) {
            await park(ctx.page);
            await (await (await ctx.frame()).frameElement()).focus();
            await ctx.page.keyboard.press("Shift");
        },
        /**
         * What the browser side does for one story: its modes, the project's wait and the delay.
         * A story its settings exclude is recorded here and has no modes to shoot, only the wait.
         * @param {unknown} _ctx the command's context
         * @param {{ id: string, chromatic: object }} story the story id and its parameters.chromatic
         * @returns {Promise<{ modes: object[], waitFor: object | null, delay: number }>} the plan
         */
        async visualPlan(_ctx, { id, chromatic }) {
            await ready;
            planned.add(id);
            const s = await settings(id, chromatic);
            for (const { name } of s.modes) {
                shots.delete(fileName(id, name));
            }
            if (!s.disableSnapshot) {
                return { modes: s.modes, waitFor: entry.waitFor ?? null, delay: s.delay };
            }
            for (const { name } of s.modes) {
                // Excluded by its own parameters while it has a baseline: collect reports it removed.
                if (!(await judge(id, name, s, { type: "excluded", reason: s.reason, byStory: s.excludedByStory }))) {
                    excluded.add(fileName(id, name));
                }
            }
            // Still the project's wait: a story left mid-render goes on in the page after its test,
            // and its late console lines (a disposed scene) would fail the story after it.
            return { modes: [], waitFor: entry.waitFor ?? null, delay: 0 };
        },
        /**
         * Shoots the mounted story in one mode and judges the shot. A snapshot that did not pass
         * asks for another render (`again`) while the story test has retries left; the last shot's
         * failure, with `fail: "differences"`, comes back as `failure`, the message of
         * assertSnapshot()'s error, which the browser side throws once every mode is shot.
         * @param {{ page: import("playwright").Page, frame: () => Promise<import("playwright").Frame> }} ctx
         *     the command's context: vitest's page and the tester iframe
         * @param {{ id: string, mode: string | null, chromatic: object, console: string[] }} shot the
         *     story, its mode, its parameters.chromatic and the console lines since its render
         * @returns {Promise<{ status: string, attempt: number, again: boolean, failure: string | null }>}
         *     the snapshot's status and attempt, whether to shoot it again, and why its test fails
         */
        async visualShot(ctx, { id, mode, chromatic, console }) {
            const file = fileName(id, mode);
            header.environment.chromium ??= ctx.page.context().browser()?.version() ?? null;
            const image = await shootFrame(ctx.page, await ctx.frame());
            const tries = (shots.get(file) ?? 0) + 1;
            shots.set(file, tries);
            const line = await judge(id, mode, await settings(id, chromatic), { image, console });
            const again = !line.passed && tries <= retries;
            let failure = null;
            if (!again && fail === "differences") {
                try {
                    assertPassed(line);
                } catch (err) {
                    failure = err.message;
                }
            }
            return { status: line.status, attempt: line.attempt, again, failure };
        },
        /**
         * Records a story and its modes as failed: a failed play, a render error, a console rule.
         * @param {unknown} _ctx the command's context
         * @param {{ id: string, modes: (string | null)[], reason: string, chromatic?: object,
         *     console: string[] }} failure the story, the modes it failed in, why, and its console
         * @returns {Promise<void>} once recorded
         */
        async visualFail(_ctx, { id, modes, reason, chromatic = {}, console }) {
            const s = await settings(id, chromatic);
            for (const mode of modes) {
                await judge(id, mode, s, { type: "failed", reason: reason.slice(0, 2000) || "failed", console });
            }
        },
    };

    let shard = { index: 1, count: 1 };
    let vitest = null;
    const isOurs = (p) => p.config?.browser?.commands?.visualShot === commands.visualShot;
    const reporter = {
        onInit(v) {
            vitest = v;
            shard = v.config.shard ?? shard;
        },
        /**
         * Writes this run's run file: the shard, its story files, and whether every story test
         * that ran went through the visual step.
         * @param {any[]} modules the run's test modules
         * @returns {Promise<void>} once the run file is written
         */
        async onTestRunEnd(modules) {
            await ready;
            const ran = new Set();
            for (const m of modules) {
                for (const t of m.children.allTests()) {
                    const id = t.meta().storyId;
                    if (id && t.result().state !== "skipped") {
                        ran.add(id);
                    }
                }
            }
            const missing = [...ran].filter((id) => !planned.has(id)).sort((a, b) => a.localeCompare(b));
            const files = await storyFiles(vitest, modules, isOurs, root);
            const run = {
                ...header,
                shard,
                reported: header.commit !== null && missing.length === 0,
                missing,
                excluded: [...excluded].sort((a, b) => a.localeCompare(b)),
                ...files,
            };
            // A file of its own per test run, so a rerun into the same directory (watch mode) keeps the earlier run's.
            const runFile = join(out, `run-${process.pid}-${++runs}.json`);
            writeFileSync(`${runFile}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
            renameSync(`${runFile}.tmp`, runFile);
            planned.clear();
            excluded.clear();
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
