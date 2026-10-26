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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

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
    pinnedFonts,
    provenance,
    SCALE,
    SHOT,
    shootTiles,
    storySettings,
    toolVersion,
    twoFrames,
    VIEWPORT,
} from "./capture.mjs";
import { unstableLine } from "./story-outcomes.mjs";

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
    const view = { x: 0, y: 0, ...VIEWPORT };
    if (size.width <= VIEWPORT.width && size.height <= VIEWPORT.height) {
        return page.screenshot({ ...SHOT, clip: { ...view, ...size } });
    }
    return shootTiles(page, frame, size, VIEWPORT);
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
 * filter), and those this run loaded and ran: merge-results checks the shards ran every file once,
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
 * The partial an earlier run left in `out`, when it is one of this project.
 * @param {string} out the run's directory
 * @param {string} project the visual-review project
 * @returns {any | null} its results.json, or null
 */
function earlierRun(out, project) {
    const file = join(out, "results.json");
    if (!existsSync(file)) {
        return null;
    }
    try {
        const r = JSON.parse(readFileSync(file, "utf8"));
        return r.project === project && r.partial ? r : null;
    } catch {
        return null;
    }
}

/**
 * Whether an earlier partial is from this same run (its retry): the same commit, CI run and
 * attempt, and locally the same uncommitted changes. A new run of the same commit gets a new
 * directory (CI's is fresh; a local run removes it first).
 * @param {any} a the earlier results
 * @param {any} b this run's results, after provenance
 * @returns {boolean} whether they are one run
 */
const sameRun = (a, b) =>
    a.commit === b.commit &&
    a.runId === b.runId &&
    a.runAttempt === b.runAttempt &&
    (a.local?.diff ?? null) === (b.local?.diff ?? null);

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
    const before = earlierRun(out, project);
    const ready = Promise.all([
        provenance().then((p) => Object.assign(results, p)),
        hasBaselines(baselines).then((s) => (results.seeded = s)),
        loadRenames(baselines).then((r) => (renames = r)),
        fontconfig && pinnedFonts(fontconfig).then((f) => (results.environment.fonts = f)),
    ]).then(() => {
        // The retry of the failed story files (tools/test-quarantine.mjs) writes into the same
        // directory: it keeps the first run's items and replaces only those it shoots again.
        if (before && sameRun(before, results)) {
            results.items = before.items;
            results.expected = results.items.length;
            results.retried = (before.retried ?? 0) + 1;
        }
    });
    const planned = new Set();
    const pending = new Map();
    const save = () => {
        writeFileSync(join(out, "results.json.tmp"), `${JSON.stringify(results, null, 2)}\n`);
        renameSync(join(out, "results.json.tmp"), join(out, "results.json"));
    };
    // Each story's test, as its JUnit report names it, so a quarantine entry can be matched to its items.
    const tests = new Map();
    const record = (item) => {
        const earlier = results.items.find((i) => i.file === item.file);
        // A story unstable before its retry stays on record as unstable, whatever the retry drew.
        if (item.status !== "unstable" && (earlier?.status === "unstable" || earlier?.unstableFirst)) {
            item.unstableFirst = true;
        }
        const test = tests.get(item.id) ?? earlier?.test;
        if (test) {
            item.test = test;
        }
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

    const finish = async (job, first, second, logged) => {
        const { id, mode, file, baseline, from, s } = job;
        const r = classify({ baseline, first, second, threshold: s.threshold, includeAA: s.includeAA, moved: !!from });
        if (["changed", "moved", "new", "unstable"].includes(r.status)) {
            writeFileSync(join(out, file), r.flaky ? second : first);
        }
        if (r.status === "unstable") {
            console.log(`visual-review: ${unstableLine(project, { file })}`);
            writeFileSync(join(out, "second", file), second);
        } else {
            // A first run's unstable shot of this story, now settled on the retry.
            rmSync(join(out, "second", file), { force: true });
        }
        if (baseline && (r.status === "changed" || r.status === "unstable" || (from && r.baseline !== r.capture))) {
            writeFileSync(join(out, "baselines", file), baseline);
        }
        const lines = r.status === "unchanged" || r.status === "moved" ? [] : clip(logged);
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
         * @param {{ id: string, chromatic: object, test?: { file: string, name: string } }} story the
         *     story id, its parameters.chromatic, and its test (absolute file, full name)
         * @returns {Promise<{ modes: object[], waitFor: object | null, delay: number }>} the plan
         */
        async visualPlan(_ctx, { id, chromatic, test }) {
            await ready;
            planned.add(id);
            if (test?.file && test.name) {
                tests.set(id, { file: relative(root, test.file).replaceAll("\\", "/"), name: test.name });
            }
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
            // Still the project's wait: a story left mid-render goes on in the page after its test,
            // and its late console lines (a disposed scene) would fail the story after it.
            return { modes: [], waitFor: entry.waitFor ?? null, delay: 0 };
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
    let vitest = null;
    const isOurs = (p) => p.config?.browser?.commands?.visualShot === commands.visualShot;
    const reporter = {
        onInit(v) {
            vitest = v;
            shard = v.config.shard ?? shard;
        },
        /**
         * Records the shard and whether every story test that ran went through the visual step.
         * @param {any[]} modules the run's test modules
         * @returns {Promise<void>} once the partial is written
         */
        async onTestRunEnd(modules) {
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
            const reported = results.commit !== null && missing.length === 0 && pending.size === 0;
            const files = await storyFiles(vitest, modules, isOurs, root);
            const kept = results.retried ? before?.partial : null;
            if (kept) {
                // A retry ran only the failed files: the first run's files ran too.
                files.ran = [...new Set([...kept.ran, ...files.ran])].sort((a, b) => a.localeCompare(b));
                missing.unshift(...kept.missing.filter((id) => !planned.has(id)));
            }
            results.partial = { shard, reported: reported && (!kept || kept.reported), missing, ...files };
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
