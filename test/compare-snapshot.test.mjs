/*
 * compareSnapshot() and assertSnapshot(): one snapshot judged with compare's own code, one result
 * line appended per call, and Node's own AssertionError for a snapshot that did not pass.
 */

import { AssertionError } from "node:assert";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertSnapshot, compareSnapshot } from "../trusted/lib/compare.mjs";
import { CONFIG_FILE } from "../trusted/lib/config.mjs";
import { parseResultLines } from "../trusted/lib/result-line.mjs";

import { git, tempDir } from "./helpers.mjs";
import { png } from "./story-test-fakes.mjs";

/**
 * A baselines directory holding these files.
 * @param {Record<string, Buffer | string>} files file name to contents
 * @returns {string} the directory
 */
function baselinesWith(files) {
    const dir = tempDir("vr-snap-bl-");
    for (const [name, bytes] of Object.entries(files)) {
        writeFileSync(join(dir, name), bytes);
    }
    return dir;
}

describe("compareSnapshot", () => {
    it("returns the result line, counts attempts in memory without out, and never throws for a difference", async () => {
        const baselines = baselinesWith({ "a--one.png": png(10), "a--one.dark.png": png(10) });
        const first = await compareSnapshot({ baselines, id: "a--one", image: png(10) });
        expect(first).toMatchObject({
            project: "images",
            file: "a--one.png",
            status: "unchanged",
            attempt: 1,
            passed: true,
        });
        const second = await compareSnapshot({ baselines, id: "a--one", image: png(90) });
        expect(second).toMatchObject({ status: "changed", attempt: 2, passed: false, changedPixels: 16 });
        // A mode is its own snapshot, and an image can be a path.
        const path = join(tempDir("vr-snap-img-"), "shot.png");
        writeFileSync(path, png(10));
        expect(await compareSnapshot({ baselines, id: "a--one", mode: "dark", image: path })).toMatchObject({
            file: "a--one.dark.png",
            status: "unchanged",
            attempt: 1,
        });
        expect(await compareSnapshot({ baselines, id: "a--new", image: png(10) })).toMatchObject({ status: "new" });
        // The threshold: everything differs by 80 of 255 levels, under a threshold of 0.9.
        const loose = await compareSnapshot({ baselines, id: "a--one", image: png(90), settings: { threshold: 0.9 } });
        expect(loose.status).toBe("unchanged");
        // The image can be openCapture()'s whole shot: { ...story, image: await cam.shoot(story) }.
        const story = { type: "image", project: "images", id: "a--one", mode: null, file: "a--one.png", baselines };
        const shot = { ...story, image: png(10), console: ["log: hi"] };
        expect(await compareSnapshot({ ...story, image: shot })).toMatchObject({ status: "unchanged", passed: true });
    });

    it("appends one line per call to its own file in out, and keeps only the images the review needs", async () => {
        const baselines = baselinesWith({ "a--same.png": png(10), "a--moves.png": png(10) });
        const out = tempDir("vr-snap-out-");
        await compareSnapshot({ baselines, id: "a--same", image: png(10), out });
        await compareSnapshot({ baselines, id: "a--moves", image: png(200), out });
        const files = readdirSync(out).filter((f) => f.endsWith(".ndjson"));
        expect(files).toEqual([expect.stringMatching(/^results-\d+-\d+\.ndjson$/)]);
        const lines = parseResultLines(readFileSync(join(out, files[0]), "utf8"));
        expect(lines.map((l) => [l.file, l.status, l.attempt])).toEqual([
            ["a--same.png", "unchanged", 1],
            ["a--moves.png", "changed", 1],
        ]);
        expect(readdirSync(out).filter((f) => f.endsWith(".png"))).toEqual(["a--moves.png"]);
        expect(readFileSync(join(out, "baselines", "a--moves.png"))).toEqual(png(10));

        // Another process's line for the same snapshot (a runner that retries in a new worker)
        // makes this call the next attempt; calls at once for one directory never share one.
        const theirs = { ...lines[1], attempt: 2 };
        writeFileSync(join(out, "results-1-0.ndjson"), `${JSON.stringify(theirs)}\n`);
        const together = await Promise.all([
            compareSnapshot({ baselines, id: "a--moves", image: png(10), out }),
            compareSnapshot({ baselines, id: "a--same", image: png(10), out }),
        ]);
        expect(together.map((l) => [l.file, l.attempt])).toEqual([
            ["a--moves.png", 3],
            ["a--same.png", 2],
        ]);
        // The capture of a snapshot that now matches is not kept.
        expect(readdirSync(out).filter((f) => f.endsWith(".png"))).toEqual([]);
    });

    it("reads a project's baselines and settings files from the config, and PROOFROOM_OUT", async () => {
        const root = tempDir("vr-snap-repo-");
        git(root, "init", "-q");
        writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ projects: { web: { storybook: "sb" } } }));
        const dir = join(root, "visual-baselines", "web");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "a--one.png"), png(10));
        writeFileSync(join(dir, "a--one.json"), JSON.stringify({ diffThreshold: 0.9 }));
        writeFileSync(join(dir, "a--off.json"), JSON.stringify({ disableSnapshot: true, reason: "a clock" }));
        const out = tempDir("vr-snap-env-");
        process.env.PROOFROOM_OUT = out;
        try {
            expect(await compareSnapshot({ project: "web", root, id: "a--one", image: png(90) })).toMatchObject({
                project: "web",
                status: "unchanged",
                threshold: 0.9,
            });
            expect(await compareSnapshot({ project: "web", root, id: "a--off", image: png(90) })).toMatchObject({
                status: "excluded",
                reason: "a clock",
                passed: true,
            });
            // The settings file is approved with the baselines: a test's own settings never beat it.
            const tight = { threshold: 0, includeAA: true };
            expect(await compareSnapshot({ project: "web", root, id: "a--off", image: png(90), settings: tight })).toMatchObject(
                { status: "excluded", reason: "a clock" },
            );
            expect(await compareSnapshot({ project: "web", root, id: "a--one", image: png(90), settings: tight })).toMatchObject(
                { status: "unchanged", threshold: 0.9 },
            );
        } finally {
            delete process.env.PROOFROOM_OUT;
        }
        expect(readdirSync(out).filter((f) => f.endsWith(".ndjson"))).toHaveLength(1);
        await expect(compareSnapshot({ project: "nope", root, id: "a--one", image: png(1) })).rejects.toThrow(
            /no project nope/,
        );
    });

    it("throws only for a failure of the tool: an LFS pointer, a bad id, no baselines", async () => {
        const baselines = baselinesWith({
            "a--lfs.png": `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 9\n`,
        });
        await expect(compareSnapshot({ baselines, id: "a--lfs", image: png(1) })).rejects.toThrow(/LFS pointer/);
        await expect(compareSnapshot({ baselines, id: "../up", image: png(1) })).rejects.toThrow(/not a capture line/);
        await expect(compareSnapshot({ id: "a--one", image: png(1) })).rejects.toThrow(/project or a baselines/);
        // No image: the snapshot could not be shot, which is a result, not a throw.
        expect(await compareSnapshot({ baselines, id: "a--none", reason: "render timed out" })).toMatchObject({
            status: "failed",
            reason: "render timed out",
            passed: false,
        });
    });
});

describe("assertSnapshot", () => {
    it("returns a passing line and throws Node's AssertionError, with the line as actual, for one that did not pass", async () => {
        const baselines = baselinesWith({ "a--one.png": png(10) });
        expect(await assertSnapshot({ baselines, id: "a--one", image: png(10) })).toMatchObject({ passed: true });
        const err = await assertSnapshot({ baselines, id: "a--one", image: png(90) }).catch((e) => e);
        expect(err).toBeInstanceOf(AssertionError);
        expect(err.message).toBe("proofroom: images/a--one: changed: 16 pixels differ");
        expect(err.actual).toMatchObject({ file: "a--one.png", status: "changed", attempt: 2 });
        // An excluded snapshot is skipped, never a failure.
        expect(await assertSnapshot({ baselines, id: "a--off", type: "excluded", reason: "off" })).toMatchObject({
            status: "excluded",
        });
    });
});
