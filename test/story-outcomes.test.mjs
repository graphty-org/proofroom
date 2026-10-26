import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeResults } from "../capture/merge-results.mjs";
import { blockingOn, promotion, quarantineEntries, storyVerdict } from "../capture/story-outcomes.mjs";
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

        // Settled on its retry: flaky, loud, and it passes with the switch on too, as a test that fails and
        // then passes on its retry does in tools/test-quarantine.mjs.
        const flakyLines = [
            "visual-review: [UNSTABLE] graphty-element: a--wobbles.png drew two different pictures on the same inputs",
            "visual-review: [FLAKY] graphty-element: a--wobbles.png settled on its retry, so it does not fail the run",
        ];
        for (const blocking of [false, true]) {
            const verdict = storyVerdict(results, { blocking });
            expect(verdict.code).toBe(0);
            expect(verdict.lines.slice(0, 2)).toEqual(flakyLines);
        }
    });

    it("gives a story unstable at first whose retry broke one verdict, [BROKEN], never [FLAKY] too", () => {
        const item = { file: "a--b.png", status: "failed", reason: "play threw", unstableFirst: true };
        for (const blocking of [false, true]) {
            const { lines, code } = storyVerdict({ project: "p", items: [item] }, { blocking });
            expect(lines.filter((l) => l.includes("[FLAKY]"))).toEqual([]);
            expect(lines.filter((l) => l.includes("[BROKEN]"))).toHaveLength(1);
            expect(code).toBe(blocking ? 1 : 0);
        }
    });

    it("fails a blocking run for a story still unstable after its retry, unless an unexpired entry quarantines it", async () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const root = repo({ "a--wobbles.png": png(10) });
        const out = tempDir("story-outcomes-");
        const files = ["a.stories.ts"];
        for (const shots of [
            [png(200), png(100)],
            [png(300), png(100)],
        ]) {
            const v = visualStoryTest({ project: "graphty-element", out, root });
            expect(await shoot(v, root, "a--wobbles", shots)).toEqual({ status: "unstable" });
            await report(v, root, { files, ran: { "a.stories.ts": ["a--wobbles"] } });
        }
        const results = read(out);
        expect(results.items[0].status).toBe("unstable");

        expect(storyVerdict(results, { blocking: false }).code).toBe(0);
        const on = storyVerdict(results, { blocking: true, gh: true });
        expect(on.code).toBe(1);
        expect(on.lines[1]).toBe(
            "::error::[UNSTABLE] graphty-element: a--wobbles.png is still unstable after its retry and not quarantined",
        );

        // On the quarantine list (the same { file, name } its JUnit report gives): loud, but it passes.
        const entry = { file: "a.stories.ts", name: "Stories > Wobbles", family: "graphty-element-storybook" };
        const listed = quarantineEntries({ quarantine: [{ ...entry, expires: "2999-01-01" }] });
        const excused = storyVerdict(results, { blocking: true, quarantine: listed, gh: true });
        expect(excused.code).toBe(0);
        expect(excused.lines).toEqual([
            "::warning::[UNSTABLE] graphty-element: a--wobbles.png drew two different pictures on the same inputs",
            "::warning::[QUARANTINED] graphty-element: a--wobbles.png is quarantined, so it does not fail the run",
            "::warning::[PROMOTION] graphty-element: 1 picture(s) wait for the owner's approval",
        ]);

        // An expired entry no longer counts, as tools/test-quarantine.mjs drops it too.
        const expired = quarantineEntries({ quarantine: [{ ...entry, expires: "2000-01-01" }] });
        expect(expired).toEqual([]);
        expect(storyVerdict(results, { blocking: true, quarantine: expired }).code).toBe(1);
    });

    it("reads only well-formed, unexpired quarantine entries and refuses a file of another shape", () => {
        const ok = { file: "a.stories.ts", name: "Stories > A" };
        expect(
            quarantineEntries(
                {
                    quarantine: [
                        ok,
                        { ...ok, expires: "2026-10-26" },
                        { ...ok, expires: "2026-10-25" },
                        { file: "a.stories.ts" },
                        null,
                    ],
                },
                "2026-10-26",
            ),
        ).toEqual([ok, { ...ok, expires: "2026-10-26" }]);
        expect(() => quarantineEntries([ok])).toThrow(/quarantine: \[/);
        expect(() => quarantineEntries({ entries: [ok] })).toThrow(/quarantine: \[/);
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
        expect(on.lines).toEqual([
            "::error::[BROKEN] graphty-element: a--broken.png: the story never settled",
            // a broken story has no approved picture either, so promotion waits too
            "::warning::[PROMOTION] graphty-element: 1 picture(s) wait for the owner's approval",
        ]);
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
        expect(promotion({ items: [{ status: "excluded", file: "x.png" }] }, true).blocked).toBe(false);
        // Every picture that is not exactly the approved one waits for the owner: a renamed story, one with no
        // baseline yet, an unstable one and a broken one too.
        for (const status of ["changed", "new", "removed", "moved", "unseeded", "unstable", "failed"]) {
            expect(promotion({ items: [{ status, file: "x.png" }] }, true), status).toEqual({
                blocking: true,
                blocked: true,
                files: ["x.png"],
            });
        }
    });
});
