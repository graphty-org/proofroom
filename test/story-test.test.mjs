import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { visualStoryTest } from "../capture/story-test.mjs";
import { validateResults } from "../trusted/lib/results.mjs";

import { tempDir } from "./helpers.mjs";
import { context, png, read, report, repo } from "./story-test-fakes.mjs";

describe("story tests' visual step", () => {
    it("records unchanged, changed (after a second render), unstable and failed stories as capture.mjs does", async () => {
        const root = repo({ "a--same.png": png(10), "a--moves.png": png(10), "a--wobbles.png": png(10) });
        const out = tempDir("story-test-out-");
        const v = visualStoryTest({ project: "graphty-element", out, root });
        const shoot = async (id, shots) => {
            const ctx = context(shots);
            await v.commands.visualPlan(ctx, { id, chromatic: {} });
            const first = await v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: ["log: one"] });
            return first.again ? v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] }) : first;
        };

        expect(await shoot("a--same", [png(10)])).toEqual({ status: "unchanged" });
        expect(await shoot("a--moves", [png(200), png(200)])).toEqual({ status: "changed" });
        expect(await shoot("a--wobbles", [png(200), png(100)])).toEqual({ status: "unstable" });
        expect(await shoot("a--fresh", [png(50), png(50)])).toEqual({ status: "new" });
        await v.commands.visualPlan(context([]), { id: "a--broken", chromatic: {} });
        await v.commands.visualFail(context([]), { id: "a--broken", modes: [null], reason: "play threw", console: [] });
        await v.commands.visualPlan(context([]), { id: "a--off", chromatic: { disableSnapshot: true } });

        await report(v, root, {
            files: ["a.stories.ts", "b.stories.ts", "c.stories.ts"],
            ran: {
                "a.stories.ts": ["a--same", "a--moves", "a--wobbles", "a--fresh", "a--broken", "a--off"],
                "c.stories.ts": [],
            },
            broken: ["c.stories.ts"],
        });
        const r = read(out);
        // Never complete on its own: only merge-results makes a capture the gate takes.
        expect(r.complete).toBe(false);
        // Every story file of the project, and only those this run loaded and ran (not the broken one).
        expect(r.partial).toEqual({
            shard: { index: 1, count: 1 },
            reported: true,
            missing: [],
            files: ["a.stories.ts", "b.stories.ts", "c.stories.ts"],
            ran: ["a.stories.ts"],
        });
        expect(validateResults(r)).toEqual([]);
        expect(Object.fromEntries(r.items.map((i) => [i.id, i.status]))).toEqual({
            "a--broken": "failed",
            "a--fresh": "new",
            "a--moves": "changed",
            "a--off": "excluded",
            "a--same": "unchanged",
            "a--wobbles": "unstable",
        });
        // The images the review page reads: the capture, the second of an unstable one, the baseline.
        expect(readFileSync(join(out, "a--moves.png"))).toEqual(png(200));
        expect(readFileSync(join(out, "second/a--wobbles.png"))).toEqual(png(100));
        expect(readFileSync(join(out, "baselines/a--moves.png"))).toEqual(png(10));
        expect(r.items.find((i) => i.id === "a--moves").console).toEqual(["log: one"]);
        expect(r.items.find((i) => i.id === "a--same").console).toEqual([]);
    });

    it("marks a partial unreported when a story test that ran never reached the visual step", async () => {
        const out = tempDir("story-test-out-");
        const root = repo({});
        const v = visualStoryTest({ project: "graphty-element", out, root });
        await report(v, root, { files: ["a.stories.ts"], ran: { "a.stories.ts": ["a--lost"] } });
        expect(read(out).partial).toMatchObject({ reported: false, missing: ["a--lost"] });
    });
});
