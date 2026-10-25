import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeResults } from "../capture/merge-results.mjs";
import { blockingOn, promotion, storyVerdict } from "../capture/story-outcomes.mjs";
import { visualStoryTest } from "../capture/story-test.mjs";
import { loadConfig } from "../trusted/lib/config.mjs";

import { tempDir } from "./helpers.mjs";
import { context, png, read, report, repo } from "./story-test-fakes.mjs";

const TEST = { file: "", name: "Stories > Wobbles" };

/**
 * Plans and shoots one story as the browser side does: a second shot when the first differs.
 * @param {any} v visualStoryTest()
 * @param {string} root the repository root
 * @param {string} id the story id
 * @param {Buffer[]} shots the page's screenshots, in order
 * @returns {Promise<object>} the last visualShot answer
 */
async function shoot(v, root, id, shots) {
    const ctx = context(shots);
    await v.commands.visualPlan(ctx, { id, chromatic: {}, test: { ...TEST, file: join(root, "a.stories.ts") } });
    const first = await v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] });
    return first.again ? v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] }) : first;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("story outcomes", () => {
    it("is off unless VISUAL_REVIEW_BLOCKING=1", () => {
        expect(blockingOn({})).toBe(false);
        expect(blockingOn({ VISUAL_REVIEW_BLOCKING: "true" })).toBe(false);
        expect(blockingOn({ VISUAL_REVIEW_BLOCKING: "1" })).toBe(true);
    });

    it("catches a planted unstable story, keeps it on record after a retry that settles, and fails only a blocking run", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const root = repo({ "a--wobbles.png": png(10) });
        const out = tempDir("story-outcomes-");
        const files = ["a.stories.ts"];

        // The first run: two shots disagree, so the story is unstable, loudly.
        const first = visualStoryTest({ project: "graphty-element", out, root });
        expect(await shoot(first, root, "a--wobbles", [png(200), png(100)])).toEqual({ status: "unstable" });
        await report(first, root, { files, ran: { "a.stories.ts": ["a--wobbles"] } });
        expect(log).toHaveBeenCalledWith(expect.stringContaining("[UNSTABLE] graphty-element: a--wobbles.png"));
        expect(read(out).items[0]).toMatchObject({
            status: "unstable",
            test: { file: "a.stories.ts", name: "Stories > Wobbles" },
        });

        // The retry (tools/test-quarantine.mjs runs the failed file once more) settles.
        const retry = visualStoryTest({ project: "graphty-element", out, root });
        expect(await shoot(retry, root, "a--wobbles", [png(10)])).toEqual({ status: "unchanged" });
        await report(retry, root, { files, ran: { "a.stories.ts": ["a--wobbles"] } });
        const results = read(out);
        expect(results.items[0]).toMatchObject({
            status: "unchanged",
            unstableFirst: true,
            test: { file: "a.stories.ts", name: "Stories > Wobbles" },
        });

        const off = storyVerdict(results, { blocking: false });
        expect(off.code).toBe(0);
        expect(off.lines).toEqual([
            "visual-review: [UNSTABLE] graphty-element: a--wobbles.png drew two different pictures on the same inputs",
        ]);

        const on = storyVerdict(results, { blocking: true });
        expect(on.code).toBe(1);
        expect(on.lines[1]).toContain("[NEW-FLAKY] graphty-element: a--wobbles.png");

        // On the quarantine list (the same { file, name } its JUnit report gives): loud, but it passes.
        const quarantine = [{ file: "a.stories.ts", name: "Stories > Wobbles", family: "graphty-element-storybook" }];
        const excused = storyVerdict(results, { blocking: true, quarantine, gh: true });
        expect(excused.code).toBe(0);
        expect(excused.lines).toEqual([
            "::warning::[UNSTABLE] graphty-element: a--wobbles.png drew two different pictures on the same inputs",
            "::warning::[QUARANTINED] graphty-element: a--wobbles.png is quarantined, so it does not fail the run",
        ]);
    });

    it("fails a run for a planted broken story only with the switch on", async () => {
        const root = repo({});
        const out = tempDir("story-outcomes-");
        const v = visualStoryTest({ project: "graphty-element", out, root });
        await v.commands.visualPlan(context([]), { id: "a--broken", chromatic: {} });
        await v.commands.visualFail(context([]), {
            id: "a--broken",
            modes: [null],
            reason: "the story never settled\nat waitForStableFrame",
            console: [],
        });
        await report(v, root, { files: ["a.stories.ts"], ran: { "a.stories.ts": ["a--broken"] } });
        const results = read(out);

        const off = storyVerdict(results, { blocking: false });
        expect(off).toMatchObject({ code: 0 });
        expect(off.lines).toEqual([
            "visual-review: [BROKEN] graphty-element: a--broken.png: the story never settled (report only)",
        ]);
        const on = storyVerdict(results, { blocking: true, gh: true });
        expect(on.code).toBe(1);
        expect(on.lines).toEqual(["::error::[BROKEN] graphty-element: a--broken.png: the story never settled"]);
    });

    it("sets the promotion flag for a changed picture only with the switch on", async () => {
        const root = repo({ "a--moves.png": png(10), "a--same.png": png(10) });
        const part = tempDir("story-outcomes-part-");
        const v = visualStoryTest({ project: "graphty-element", out: part, root });
        expect(await shoot(v, root, "a--moves", [png(200), png(200)])).toEqual({ status: "changed" });
        expect(await shoot(v, root, "a--same", [png(10)])).toEqual({ status: "unchanged" });
        await report(v, root, { files: ["a.stories.ts"], ran: { "a.stories.ts": ["a--moves", "a--same"] } });
        const baselines = join(root, loadConfig(root).baselines, "graphty-element");

        for (const blocking of [false, true]) {
            const out = tempDir("story-outcomes-merged-");
            const { results, problems } = await mergeResults({
                project: "graphty-element",
                baselines,
                out,
                dirs: [part],
                blocking,
            });
            expect(problems).toEqual([]);
            expect(read(out).promotion).toEqual({ blocking, blocked: blocking, files: ["a--moves.png"] });
            const verdict = storyVerdict(results, { blocking });
            // A changed picture blocks promotion, never the run: approving it is the owner's.
            expect(verdict.code).toBe(0);
            expect(verdict.lines.some((l) => l.includes("[PROMOTION]"))).toBe(blocking);
        }
        expect(promotion({ items: [{ status: "unchanged", file: "x.png" }] }, true).blocked).toBe(false);
    });
});
