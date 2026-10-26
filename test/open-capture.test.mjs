/*
 * The test-runner pattern for a Storybook, end to end in Chromium against the stand-in Storybook
 * (stand-in-storybook.mjs): openCapture() lists and shoots the stories, assertSnapshot() judges
 * each shot, and collect makes the capture the page and the gate read.
 */

import { AssertionError } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openCapture } from "../capture/capture.mjs";
import { collect } from "../trusted/lib/collect.mjs";
import { assertSnapshot } from "../trusted/lib/compare.mjs";

import { tempDir } from "./helpers.mjs";
import { countingServer, demoRepo } from "./stand-in-storybook.mjs";

let counter;

beforeAll(async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    process.env.FC_FONTATIONS = "1";
    counter = await countingServer();
});
afterAll(() => {
    vi.unstubAllEnvs();
    counter.close();
});

describe("openCapture", () => {
    it("lists the stories and shoots each once; assertSnapshot judges each shot", async () => {
        const { repo, baselines } = demoRepo(counter.url);
        writeFileSync(join(baselines, "demo--gone.png"), Buffer.from("not read"));
        const cam = openCapture({
            project: "demo",
            root: repo,
            stories: ["demo--plain", "demo--broken", "demo--always-excluded"],
        });
        const out = tempDir("vr-open-out-");
        const verdicts = {};
        try {
            const stories = await cam.stories();
            expect(stories.map((s) => [s.file, s.type])).toEqual([
                ["demo--always-excluded.png", "excluded"],
                ["demo--broken.png", "image"],
                ["demo--plain.png", "image"],
            ]);
            counter.loads.clear();
            for (const story of stories) {
                try {
                    verdicts[story.id] = (await assertSnapshot({ ...(await cam.shoot(story)), out })).status;
                } catch (err) {
                    expect(err).toBeInstanceOf(AssertionError);
                    verdicts[story.id] = `${err.actual.status}: ${err.message}`;
                }
            }
        } finally {
            await cam.close();
        }
        expect(verdicts).toEqual({
            "demo--always-excluded": "excluded",
            "demo--broken": expect.stringMatching(/^failed: proofroom: demo\/demo--broken: /),
            "demo--plain": "new: proofroom: demo/demo--plain: new: no baseline",
        });
        // One shot per story, and none of the excluded one.
        expect(Object.fromEntries(counter.loads)).toEqual({ "demo--broken": 1, "demo--plain": 1 });

        // A stories filter leaves out the rest, so a run of it is collected only as the filter's,
        // and every other baseline reads removed: here, the one no story draws.
        const { results, problems } = await collect({ project: "demo", baselines, out: tempDir("vr-c-"), dirs: [out] });
        expect(problems).toEqual([]);
        expect(results.items.map((i) => [i.file, i.status])).toEqual([
            ["demo--always-excluded.png", "excluded"],
            ["demo--broken.png", "failed"],
            ["demo--gone.png", "removed"],
            ["demo--plain.png", "new"],
        ]);
    });
});
