import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { visualStoryTest } from "../capture/story-test.mjs";
import { compareSnapshot } from "../trusted/lib/compare.mjs";
import { collect } from "../trusted/lib/collect.mjs";

import { git, tempDir } from "./helpers.mjs";
import { context, png, read, report, repo } from "./story-test-fakes.mjs";

const PROJECT = "graphty-element";
const CLI = new URL("../trusted/cli.mjs", import.meta.url).pathname;

/**
 * Runs the command line without blocking this process.
 * @param {string[]} args its arguments
 * @param {string} cwd where it runs
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>} how it ended and what it printed
 */
function cli(args, cwd) {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    const out = { stdout: "", stderr: "" };
    child.stdout.on("data", (d) => (out.stdout += d));
    child.stderr.on("data", (d) => (out.stderr += d));
    return new Promise((r) => child.on("close", (status) => r({ status, ...out })));
}

describe("collect", () => {
    it("collects shards into one capture, reports unshot baselines removed, and refuses a missing shard", async () => {
        const root = repo({ "a--one.png": png(10), "a--gone.png": png(10) });
        const baselines = join(root, "visual-baselines", PROJECT);
        const files = ["a.stories.ts", "b.stories.ts"];
        const shard = async (index, id, shot, count = 2) => {
            const out = tempDir("story-test-shard-");
            const v = visualStoryTest({ project: PROJECT, out, root, fail: "errors" });
            const ctx = context([shot]);
            await v.commands.visualPlan(ctx, { id, chromatic: {} });
            await v.commands.visualShot(ctx, { id, mode: null, chromatic: {}, console: [] });
            await report(v, root, { shard: { index, count }, files, ran: { [`${id[0]}.stories.ts`]: [id] } });
            return out;
        };
        const one = await shard(1, "a--one", png(10));
        const two = await shard(2, "b--two", png(70));

        const out = tempDir("story-test-merged-");
        const merged = await collect({ project: PROJECT, baselines, out, dirs: [one, two] });
        expect(merged.problems).toEqual([]);
        expect(read(out).complete).toBe(true);
        expect(merged.results.items.map((i) => [i.id, i.status])).toEqual([
            ["a--gone", "removed"],
            ["a--one", "unchanged"],
            ["b--two", "new"],
        ]);
        expect(readFileSync(join(out, "b--two.png"))).toEqual(png(70));
        expect(readFileSync(join(out, "junit.xml"), "utf8")).toMatch(/<testcase name="b--two"/);

        // A story its own parameters now exclude, while it has a baseline: removed, and why, as compare says.
        const off = tempDir("story-test-shard-");
        const v = visualStoryTest({ project: PROJECT, out: off, root, fail: "errors" });
        await v.commands.visualPlan(context([]), { id: "a--gone", chromatic: { disableSnapshot: true } });
        await report(v, root, { shard: { index: 1, count: 2 }, files, ran: { "a.stories.ts": ["a--gone"] } });
        const dropped = await collect({ project: PROJECT, baselines, out: tempDir("m-"), dirs: [off, two] });
        expect(dropped.problems).toEqual([]);
        expect(dropped.results.items.map((i) => [i.id, i.status, i.reason])).toEqual([
            ["a--gone", "removed", "the story's parameters now set disableSnapshot"],
            ["a--one", "removed", null],
            ["b--two", "new", null],
        ]);

        const half = await collect({ project: PROJECT, baselines, out: tempDir("m-"), dirs: [one] });
        expect(half.problems).toEqual([
            "shard 2 of 2: missing",
            "1 story files did not run or failed to load: b.stories.ts",
        ]);
        expect(half.results.complete).toBe(false);
        const twice = await collect({ project: PROJECT, baselines, out: tempDir("m-"), dirs: [one, one, two] });
        expect(twice.problems).toContain("shard 1 of 2: 2 directories");
        expect(twice.problems).toContain("story files ran in more than one shard: a.stories.ts");

        // A run of only some story files is not a whole capture: the rest would read as removed.
        const filtered = await shard(1, "a--one", png(10), 1);
        const some = await collect({ project: PROJECT, baselines, out: tempDir("m-"), dirs: [filtered] });
        expect(some.problems).toEqual(["1 story files did not run or failed to load: b.stories.ts"]);
        expect(some.results.complete).toBe(false);
        expect(some.results.items.map((i) => i.status)).toEqual(["unchanged"]);
    });

    it("refuses one snapshot in two shards, and a shard whose run did not finish", async () => {
        const root = repo({ "a--one.png": png(10) });
        const baselines = join(root, "visual-baselines", PROJECT);
        const files = ["a.stories.ts"];
        const shard = async (index, finish = true) => {
            const out = tempDir("story-test-shard-");
            const v = visualStoryTest({ project: PROJECT, out, root, fail: "errors" });
            const ctx = context([png(10)]);
            await v.commands.visualPlan(ctx, { id: "a--one", chromatic: {} });
            await v.commands.visualShot(ctx, { id: "a--one", mode: null, chromatic: {}, console: [] });
            if (finish) {
                await report(v, root, { shard: { index, count: 2 }, files, ran: { "a.stories.ts": ["a--one"] } });
            }
            return out;
        };
        const [one, two] = [await shard(1), await shard(2)];
        const both = await collect({ project: PROJECT, baselines, out: tempDir("m-"), dirs: [one, two] });
        expect(both.problems).toContain(`a--one.png is in ${one} and ${two}`);
        expect(both.results.complete).toBe(false);

        const unfinished = await shard(2, false);
        const cut = await collect({ project: PROJECT, baselines, out: tempDir("m-"), dirs: [one, unfinished] });
        expect(cut.problems).toContain(`${unfinished}: no run file: its run did not finish`);
        expect(cut.results.complete).toBe(false);
    });

    it("collects the result lines of any runner, the last attempt of each snapshot as its item", async () => {
        const baselines = tempDir("vr-bl-");
        writeFileSync(join(baselines, "same.png"), png(10));
        writeFileSync(join(baselines, "flip.png"), png(10));
        writeFileSync(join(baselines, "gone.png"), png(10));
        const out = tempDir("vr-runs-");
        const judge = (id, image) => compareSnapshot({ project: "app", baselines, id, image, out });
        await judge("same", png(10));
        expect(await judge("flip", png(90))).toMatchObject({ status: "changed", attempt: 1, passed: false });
        expect(await judge("flip", png(10))).toMatchObject({ status: "unchanged", attempt: 2, passed: true });

        const repoDir = repo({});
        git(repoDir, "init", "-q");
        git(repoDir, "commit", "-q", "--allow-empty", "-m", "start");
        const into = join(tempDir("vr-collected-"), "app");
        const args = ["--project", "app", "--baselines", baselines, "--out", into, out];
        // Nothing in the directory says the runner finished: it may have stopped early or been filtered.
        const unsure = await cli(["collect", ...args], repoDir);
        expect(unsure.status).toBe(1);
        expect(unsure.stderr).toMatch(/nothing says its run finished.*--whole/);
        expect(read(into).complete).toBe(false);
        expect(read(into).items.map((i) => i.status)).not.toContain("removed");

        const run = await cli(["collect", ...args, "--whole"], repoDir);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        const results = read(into);
        expect(results.complete).toBe(true);
        expect(results.items.map((i) => [i.file, i.status, i.attempts?.length ?? 0])).toEqual([
            ["flip.png", "unchanged", 1],
            ["gone.png", "removed", 0],
            ["same.png", "unchanged", 0],
        ]);
        expect(readFileSync(join(into, "junit.xml"), "utf8")).toMatch(/<testcase name="flip"[^>]*>\s*<flakyFailure/);
        // The old name still runs it, until 1.0.0.
        const old = await cli(
            ["merge-results", ...args, "--whole"],
            repoDir,
        );
        expect(old.status).toBe(0);
        expect(JSON.parse(old.stdout)).toEqual({ project: "app", items: 3, complete: true });
    });

    it("checks an openCapture() plan: a planned snapshot with no result is refused, a filter reports nothing removed", async () => {
        const baselines = tempDir("vr-bl-");
        writeFileSync(join(baselines, "same.png"), png(10));
        writeFileSync(join(baselines, "gone.png"), png(10));
        const out = tempDir("vr-runs-");
        await compareSnapshot({ project: "app", baselines, id: "same", image: png(10), out });
        const plan = (p) => writeFileSync(join(out, "plan-1-0-1.json"), JSON.stringify({ project: "app", ...p }));
        const statuses = (r) => r.results.items.map((i) => [i.file, i.status]);

        plan({ only: null, files: ["same.png", "never.png"], closed: true });
        const stopped = await collect({ project: "app", baselines, out: tempDir("m-"), dirs: [out] });
        expect(stopped.problems).toEqual(["1 planned snapshots have no result (a filtered or stopped run): never.png"]);
        expect(stopped.results.complete).toBe(false);
        expect(statuses(stopped)).toEqual([["same.png", "unchanged"]]);

        plan({ only: null, files: ["same.png"], closed: true });
        const whole = await collect({ project: "app", baselines, out: tempDir("m-"), dirs: [out] });
        expect(whole.problems).toEqual([]);
        expect(statuses(whole)).toEqual([
            ["gone.png", "removed"],
            ["same.png", "unchanged"],
        ]);

        plan({ only: ["same"], files: ["same.png"], closed: true });
        const some = await collect({ project: "app", baselines, out: tempDir("m-"), dirs: [out] });
        expect(some.problems).toEqual([]);
        expect(statuses(some)).toEqual([["same.png", "unchanged"]]);
    });

    it("says why a baseline is removed when compareSnapshot() saw its story's own parameters exclude it", async () => {
        const baselines = tempDir("vr-bl-");
        writeFileSync(join(baselines, "off.png"), png(10));
        const out = tempDir("vr-runs-");
        const line = await compareSnapshot({
            project: "app",
            baselines,
            id: "off",
            type: "excluded",
            byStory: true,
            reason: "disableSnapshot in the story's parameters",
            out,
        });
        expect(line).toBeNull();
        const { results, problems } = await collect({ project: "app", baselines, out: tempDir("m-"), dirs: [out], whole: true });
        expect(problems).toEqual([]);
        expect(results.items).toEqual([
            expect.objectContaining({ file: "off.png", status: "removed", reason: "the story's parameters now set disableSnapshot" }),
        ]);
    });
});
