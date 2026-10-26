import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { visualStoryTest } from "../capture/story-test.mjs";
import { collect } from "../trusted/lib/collect.mjs";
import { parseResultLines } from "../trusted/lib/result-line.mjs";
import * as oldConfig from "./fixtures/old-gate/trusted/lib/config.mjs";
import * as oldGate from "./fixtures/old-gate/trusted/gate.mjs";

import { tempDir } from "./helpers.mjs";
import { context, png, report, repo } from "./story-test-fakes.mjs";

const PROJECT = "graphty-element";

/**
 * Every result line the adapter wrote into a directory.
 * @param {string} out the directory
 * @returns {object[]} the lines
 */
const linesIn = (out) =>
    readdirSync(out)
        .filter((f) => /^results-.*\.ndjson$/.test(f))
        .flatMap((f) => parseResultLines(readFileSync(join(out, f), "utf8")));

/**
 * The run files the adapter's reporter wrote.
 * @param {string} out the directory
 * @returns {object[]} the parsed run files
 */
const runsIn = (out) =>
    readdirSync(out)
        .filter((f) => /^run-.*\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(out, f), "utf8")));

/**
 * Plays one story's test as the browser side does: the plan, then a shot of each mode, again
 * while the adapter asks for another; each screenshot is the next of `shots`.
 * @param {object} v what visualStoryTest returned
 * @param {string} id the story id
 * @param {Buffer[]} shots the screenshots the page returns, in order
 * @returns {Promise<{ last: object, screenshots: number }>} the last shot's answer, and how many
 *     screenshots were taken
 */
async function storyTest(v, id, shots) {
    const ctx = context([...shots]);
    let screenshots = 0;
    const page = {
        ...ctx.page,
        screenshot: async (o) => {
            // The 1 x 1 shot is the throwaway one before every real shot.
            if (o.clip.width !== 1) {
                screenshots++;
            }
            return ctx.page.screenshot(o);
        },
    };
    const counting = { ...ctx, page };
    const plan = await v.commands.visualPlan(counting, { id, chromatic: {} });
    let last = null;
    for (const mode of plan.modes) {
        do {
            last = await v.commands.visualShot(counting, { id, mode: mode.name, chromatic: {}, console: ["log: one"] });
        } while (last.again);
    }
    return { last, screenshots };
}

describe("story tests' visual step", () => {
    it("shoots a story taller than the viewport in scrolled tiles, keeping its layout at the viewport", async () => {
        const root = repo({});
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: PROJECT, out, root });
        // 905 CSS px tall: the second tile is the document scrolled to its end (5 px), whose last
        // 5 px (10 device rows) are the rows below the first tile.
        const ctx = context([png(10, 2400, 1800), png(20, 2400, 1800)], { width: 1200, height: 905 });
        await v.commands.visualPlan(ctx, { id: "a--tall", chromatic: {} });
        const r = await v.commands.visualShot(ctx, { id: "a--tall", mode: null, chromatic: {}, console: [] });
        expect(r).toMatchObject({ status: "new", attempt: 1, again: false });
        const shot = PNG.sync.read(readFileSync(join(out, "a--tall.png")));
        expect([shot.width, shot.height]).toEqual([2400, 1810]);
        const gray = (y) => shot.data[y * 2400 * 4];
        expect([gray(0), gray(1799), gray(1800), gray(1809)]).toEqual([10, 10, 20, 20]);
    });

    it("never resizes the page, and stitches a story taller than one screenshot as capture.mjs does", async () => {
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: PROJECT, out, root: repo({}) });
        // 5,000 CSS px is 10,000 device px, over one screenshot: six tiles, encoded here, not by Chromium.
        const tile = png(50, 2400, 1800);
        const ctx = context(
            Array.from({ length: 6 }, () => tile),
            { width: 1200, height: 5000 },
        );
        await v.commands.visualPlan(ctx, { id: "a--tall", chromatic: {} });
        const first = await v.commands.visualShot(ctx, { id: "a--tall", mode: null, chromatic: {}, console: [] });
        expect(first).toMatchObject({ status: "new", again: false });
        // A viewport taller than the GPU's largest texture leaves the tab compositing another way.
        expect(ctx.viewports).toEqual([]);
    });

    it("judges each shot at once, one result line per snapshot, and collect makes the capture", async () => {
        const root = repo({ "a--same.png": png(10), "a--moves.png": png(10), "a--gone.png": png(10) });
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: PROJECT, out, root, fail: "errors" });

        expect((await storyTest(v, "a--same", [png(10)])).last).toMatchObject({ status: "unchanged", failure: null });
        expect((await storyTest(v, "a--moves", [png(200)])).last).toMatchObject({ status: "changed", failure: null });
        expect((await storyTest(v, "a--fresh", [png(50)])).last).toMatchObject({ status: "new", failure: null });
        await v.commands.visualPlan(context([]), { id: "a--broken", chromatic: {} });
        await v.commands.visualFail(context([]), { id: "a--broken", modes: [null], reason: "play threw", console: [] });
        await v.commands.visualPlan(context([]), { id: "a--off", chromatic: { disableSnapshot: true } });

        // Each line is on disk the moment its snapshot is judged.
        expect(linesIn(out).map((l) => [l.id, l.status, l.attempt])).toEqual([
            ["a--same", "unchanged", 1],
            ["a--moves", "changed", 1],
            ["a--fresh", "new", 1],
            ["a--broken", "failed", 1],
            ["a--off", "excluded", 1],
        ]);

        await report(v, root, {
            files: ["a.stories.ts", "b.stories.ts", "c.stories.ts"],
            ran: {
                "a.stories.ts": ["a--same", "a--moves", "a--fresh", "a--broken", "a--off"],
                // Docs only: no story test, which vitest reports as a skipped file.
                "b.stories.ts": [],
                "c.stories.ts": [],
            },
            broken: ["c.stories.ts"],
        });
        // Every story file of the project, and only those this run loaded and ran (not the broken one).
        expect(runsIn(out)).toEqual([
            expect.objectContaining({
                project: PROJECT,
                shard: { index: 1, count: 1 },
                reported: true,
                missing: [],
                files: ["a.stories.ts", "b.stories.ts", "c.stories.ts"],
                ran: ["a.stories.ts", "b.stories.ts"],
            }),
        ]);

        const merged = tempDir("story-test-merged-");
        const baselines = join(root, "visual-baselines", PROJECT);
        const { results, problems } = await collect({ project: PROJECT, baselines, out: merged, dirs: [out] });
        // A story file that failed to load leaves the capture incomplete, and no baseline removed.
        expect(problems).toEqual(["1 story files did not run or failed to load: c.stories.ts"]);
        expect(results.complete).toBe(false);
        expect(Object.fromEntries(results.items.map((i) => [i.id, i.status]))).toEqual({
            "a--broken": "failed",
            "a--fresh": "new",
            "a--moves": "changed",
            "a--off": "excluded",
            "a--same": "unchanged",
        });
        expect(results.items.every((i) => i.flaky === false)).toBe(true);
        // The images the review page reads: the capture and the baseline it was compared with.
        expect(readFileSync(join(merged, "a--moves.png"))).toEqual(png(200));
        expect(readFileSync(join(merged, "baselines/a--moves.png"))).toEqual(png(10));
        expect(results.items.find((i) => i.id === "a--moves").console).toEqual(["log: one"]);
        expect(results.items.find((i) => i.id === "a--same").console).toEqual([]);
    });

    it('fails a changed story\'s test with fail: "differences", and only records it with "errors"', async () => {
        const root = repo({ "a--moves.png": png(10) });
        const strict = visualStoryTest({ project: PROJECT, out: tempDir("story-test-out-"), root });
        const { last: failing } = await storyTest(strict, "a--moves", [png(200)]);
        expect(failing).toMatchObject({ status: "changed", again: false });
        expect(failing.failure).toBe(`proofroom: ${PROJECT}/a--moves: changed: 16 pixels differ`);

        const out = tempDir("story-test-out-");
        const lenient = visualStoryTest({ project: PROJECT, out, root, fail: "errors" });
        const { last: passing } = await storyTest(lenient, "a--moves", [png(200)]);
        expect(passing).toMatchObject({ status: "changed", failure: null });
        expect(linesIn(out).map((l) => [l.file, l.status])).toEqual([["a--moves.png", "changed"]]);
        expect(() => visualStoryTest({ project: PROJECT, out, root, fail: "never" })).toThrow(/fail must be/);
        expect(() => visualStoryTest({ project: PROJECT, out, root, retries: 21 })).toThrow(/retries must be/);
    });

    it("shoots a story once per attempt, and with retries 1 a one-shot difference is unchanged with two attempts", async () => {
        const root = repo({ "a--flip.png": png(10), "a--moves.png": png(10), "a--same.png": png(10) });
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: PROJECT, out, root, fail: "errors", retries: 1 });

        const same = await storyTest(v, "a--same", [png(10)]);
        expect([same.last.status, same.screenshots]).toEqual(["unchanged", 1]);
        const flip = await storyTest(v, "a--flip", [png(200), png(10)]);
        expect([flip.last.status, flip.last.attempt, flip.screenshots]).toEqual(["unchanged", 2, 2]);
        const moves = await storyTest(v, "a--moves", [png(200), png(200)]);
        expect([moves.last.status, moves.last.attempt, moves.screenshots]).toEqual(["changed", 2, 2]);
        await report(v, root, { files: ["a.stories.ts"], ran: { "a.stories.ts": ["a--same", "a--flip", "a--moves"] } });

        const merged = tempDir("story-test-merged-");
        const baselines = join(root, "visual-baselines", PROJECT);
        const { results, problems } = await collect({ project: PROJECT, baselines, out: merged, dirs: [out] });
        expect(problems).toEqual([]);
        expect(results.complete).toBe(true);
        const items = Object.fromEntries(results.items.map((i) => [i.id, i]));
        expect(items["a--flip"]).toMatchObject({ status: "unchanged", flaky: false });
        expect(items["a--flip"].attempts).toEqual([expect.objectContaining({ status: "changed" })]);
        expect(items["a--moves"].attempts).toEqual([expect.objectContaining({ status: "changed" })]);
        expect(items["a--same"].attempts).toBeUndefined();
        const xml = readFileSync(join(merged, "junit.xml"), "utf8");
        expect(xml).toMatch(/<testcase name="a--flip"[^>]*>\s*<flakyFailure/);
        expect(xml).toMatch(/<testcase name="a--moves"[^>]*>\s*<failure[\s\S]*?<rerunFailure/);

        // The old package's gate passes the collected capture of the stories that match.
        const cfg = oldConfig.normalizeConfig({ defaultBranch: "main", projects: { [PROJECT]: { storybook: "a" } } });
        const only = { ...results, items: [items["a--flip"], items["a--same"]], expected: 2 };
        expect(
            oldGate.gateProblems({
                config: cfg,
                seeded: new Set([PROJECT]),
                captures: { [PROJECT]: { attempt: 1, results: only } },
            }),
        ).toEqual([]);
    });

    it("marks a run unreported when a story test that ran never reached the visual step", async () => {
        const out = tempDir("story-test-out-");
        const root = repo({});
        const v = visualStoryTest({ project: PROJECT, out, root });
        await report(v, root, { files: ["a.stories.ts"], ran: { "a.stories.ts": ["a--lost"] } });
        expect(runsIn(out)).toEqual([expect.objectContaining({ reported: false, missing: ["a--lost"] })]);
    });

    it("counts a rerun of the failed story files into the same directory as later attempts", async () => {
        const root = repo({ "a--same.png": png(10), "b--flip.png": png(10) });
        const out = tempDir("story-test-out-");
        const files = ["a.stories.ts", "b.stories.ts"];
        const first = visualStoryTest({ project: PROJECT, out, root });
        expect((await storyTest(first, "a--same", [png(10)])).last.status).toBe("unchanged");
        expect((await storyTest(first, "b--flip", [png(200)])).last.failure).toMatch(/b--flip: changed/);
        await report(first, root, { files, ran: { "a.stories.ts": ["a--same"], "b.stories.ts": ["b--flip"] } });

        // The rerun runs only b.stories.ts, and this time it matches.
        const rerun = visualStoryTest({ project: PROJECT, out, root });
        expect((await storyTest(rerun, "b--flip", [png(10)])).last).toMatchObject({ status: "unchanged", attempt: 2 });
        await report(rerun, root, { files, ran: { "b.stories.ts": ["b--flip"] } });

        const baselines = join(root, "visual-baselines", PROJECT);
        const { results, problems } = await collect({ project: PROJECT, baselines, out: tempDir("m-"), dirs: [out] });
        expect(problems).toEqual([]);
        expect(Object.fromEntries(results.items.map((i) => [i.id, [i.status, i.attempts?.length ?? 0]]))).toEqual({
            "a--same": ["unchanged", 0],
            "b--flip": ["unchanged", 1],
        });
    });
});
