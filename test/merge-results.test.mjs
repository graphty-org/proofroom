import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { mergeResults } from "../capture/merge-results.mjs";
import { visualStoryTest } from "../capture/story-test.mjs";

import { tempDir } from "./helpers.mjs";
import { context, png, read, report, repo } from "./story-test-fakes.mjs";

describe("merge-results", () => {
    it("merges shards into one capture, reports unshot baselines removed, and refuses a missing shard", async () => {
        const root = repo({ "a--one.png": png(10), "a--gone.png": png(10) });
        const baselines = join(root, "visual-baselines/graphty-element");
        const files = ["a.stories.ts", "b.stories.ts"];
        const shard = async (index, id, shot, count = 2) => {
            const out = tempDir("story-test-shard-");
            const v = visualStoryTest({ project: "graphty-element", out, root });
            const ctx = context([shot, shot]);
            await v.commands.visualPlan(ctx, { id, chromatic: {} });
            const first = await v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] });
            if (first.again) {
                await v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] });
            }
            await report(v, root, { shard: { index, count }, files, ran: { [`${id[0]}.stories.ts`]: [id] } });
            return out;
        };
        const one = await shard(1, "a--one", png(10));
        const two = await shard(2, "b--two", png(70));

        const out = tempDir("story-test-merged-");
        const merged = await mergeResults({ project: "graphty-element", baselines, out, dirs: [one, two] });
        expect(merged.problems).toEqual([]);
        expect(read(out).complete).toBe(true);
        expect(merged.results.items.map((i) => [i.id, i.status])).toEqual([
            ["a--gone", "removed"],
            ["a--one", "unchanged"],
            ["b--two", "new"],
        ]);
        expect(readFileSync(join(out, "b--two.png"))).toEqual(png(70));

        const half = await mergeResults({ project: "graphty-element", baselines, out: tempDir("m-"), dirs: [one] });
        expect(half.problems).toEqual([
            "shard 2 of 2: missing",
            "1 story files did not run or failed to load: b.stories.ts",
        ]);
        expect(half.results.complete).toBe(false);
        const twice = await mergeResults({
            project: "graphty-element",
            baselines,
            out: tempDir("m-"),
            dirs: [one, one, two],
        });
        expect(twice.problems).toContain("shard 1 of 2: 2 partials");
        expect(twice.problems).toContain("story files ran in more than one partial: a.stories.ts");

        // A run of only some story files is not a whole capture: the rest would read as removed.
        const filtered = await shard(1, "a--one", png(10), 1);
        const some = await mergeResults({
            project: "graphty-element",
            baselines,
            out: tempDir("m-"),
            dirs: [filtered],
        });
        expect(some.problems).toEqual(["1 story files did not run or failed to load: b.stories.ts"]);
        expect(some.results.complete).toBe(false);
        expect(some.results.items.map((i) => i.status)).toEqual(["unchanged"]);
    });
});
