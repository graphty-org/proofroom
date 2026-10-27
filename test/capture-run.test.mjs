/*
 * capture() and run() end to end in Chromium, against the stand-in Storybook
 * (stand-in-storybook.mjs). Capture shoots and records; run judges each line as it lands.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { chromium } from "playwright";

/* global document, requestAnimationFrame -- read only inside the page */

import {
    capture,
    CHROMIUM_ARGS,
    hasEmojiFont,
    MAX_SHOT_HEIGHT,
    run as runCapture,
    screenshotWholePage,
} from "../capture/capture.mjs";
import { readBaseline, sha256 } from "../trusted/lib/compare.mjs";
import { parseResultLines } from "../trusted/lib/result-line.mjs";

import { tempDir } from "./helpers.mjs";
import { countingServer, PARAMS, storybook as standIn } from "./stand-in-storybook.mjs";

// Every read of a baseline image goes through this spy, so a test can count them.
vi.mock("../trusted/lib/compare.mjs", async (original) => {
    const actual = await original();
    return { ...actual, readBaseline: vi.fn(actual.readBaseline) };
});

const byFile = (r) => Object.fromEntries(r.items.map((i) => [i.file, i]));

let counter;
const storybook = (ids) => standIn(counter.url, undefined, ids);

beforeAll(async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    process.env.FC_FONTATIONS = "1";
    counter = await countingServer();
});
afterAll(() => {
    vi.unstubAllEnvs();
    counter.close();
});
beforeEach(() => {
    counter.loads.clear();
    counter.wobbles.left = 0;
});

/**
 * Runs capture() to its end.
 * @param {object} options capture()'s options
 * @returns {Promise<object[]>} every line it yielded
 */
async function captureAll(options) {
    const lines = [];
    for await (const line of capture({ waitFor: null, log: () => {}, ...options })) {
        lines.push(line);
    }
    return lines;
}

/**
 * Captures and compares, as `proofroom run` does.
 * @param {object} options run()'s options
 * @returns {Promise<object>} the results.json written
 */
async function run(options) {
    const { results } = await runCapture({ waitFor: null, log: () => {}, ...options });
    return results;
}

describe("capture", () => {
    it("writes every image and one line per snapshot, shoots each story once and reads no baseline", async () => {
        const baselines = tempDir("vr-bl-");
        // A baseline for every story: capture must not read one.
        for (const id of Object.keys(PARAMS)) {
            writeFileSync(join(baselines, `${id}.png`), "not read");
        }
        vi.mocked(readBaseline).mockClear();
        const out = tempDir("vr-out-");
        const lines = await captureAll({ project: "demo", storybook: storybook(), baselines, out, workers: 2 });

        expect(readBaseline).not.toHaveBeenCalled();
        expect(lines[0]).toMatchObject({
            type: "start",
            project: "demo",
            stories: Object.keys(PARAMS).sort(),
            only: null,
        });
        expect(lines.at(-1)).toEqual({ type: "end", project: "demo", complete: true });
        const snapshots = lines.slice(1, -1);
        // One line per snapshot, docs entries left out.
        expect(snapshots.map((l) => l.file).sort()).toEqual(
            Object.keys(PARAMS)
                .map((id) => `${id}.png`)
                .sort(),
        );
        const types = Object.fromEntries(snapshots.map((l) => [l.id, l.type]));
        expect(types).toMatchObject({
            "demo--plain": "image",
            "demo--excluded-here": "excluded",
            "demo--broken": "failed",
        });
        expect(snapshots.find((l) => l.id === "demo--excluded-here")).toMatchObject({
            byStory: true,
            reason: "disableSnapshot in the story's parameters",
        });
        // Every image is on disk, named by its line, with the bytes the line carries.
        const images = snapshots.filter((l) => l.type === "image");
        expect(images).toHaveLength(6);
        for (const line of images) {
            const bytes = readFileSync(join(out, line.file));
            expect(bytes.equals(line.bytes)).toBe(true);
            expect(sha256(bytes)).toBe(line.sha256);
            expect(line.settings).toEqual({ threshold: 0.063, includeAA: false, delay: 0 });
        }
        // capture.ndjson holds the same lines, without the bytes.
        const onDisk = readFileSync(join(out, "capture.ndjson"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        expect(onDisk).toEqual(
            JSON.parse(JSON.stringify(lines, (key, value) => (key === "bytes" ? undefined : value))),
        );
        // Each story that is shot is loaded exactly once; the excluded ones never.
        const shot = Object.keys(PARAMS).filter((id) => !PARAMS[id].chromatic?.disableSnapshot);
        expect(Object.fromEntries(counter.loads)).toEqual(Object.fromEntries(shot.map((id) => [id, 1])));
    });

    it("reports a failed render as failed with its reason and console, and does not shoot it again", async () => {
        const lines = await captureAll({
            project: "demo",
            storybook: storybook(),
            baselines: tempDir("vr-bl-"),
            out: tempDir("vr-out-"),
            workers: 1,
            stories: ["demo--broken"],
        });
        expect(lines[0].only).toEqual(["demo--broken"]);
        expect(lines[1]).toMatchObject({
            type: "failed",
            file: "demo--broken.png",
            sha256: null,
            reason: "story render errored",
            // Storybook's error screen: the message and the stack, for the errors list.
            console: ["expected 1 to be 2", "AssertionError: expected 1 to be 2", "    at play (demo.stories.ts:9:3)"],
        });
        expect(counter.loads.get("demo--broken")).toBe(1);
    });

    it("captures the whole canvas at scale 2, never cropped to the content", async () => {
        // The four stories in one capture: one browser, as a project's run has.
        const out = tempDir("vr-out-");
        const lines = await captureAll({
            project: "demo",
            storybook: storybook(),
            baselines: tempDir("vr-bl-"),
            out,
            workers: 1,
            stories: ["demo--small", "demo--plain", "demo--tall", "demo--late-font"],
        });
        const size = Object.fromEntries(lines.filter((l) => l.type === "image").map((l) => [l.file, l.size]));
        // A small component sits in the full 1200 x 900 viewport, doubled.
        expect(size["demo--small.png"]).toEqual([1200 * 2, 900 * 2]);
        expect(size["demo--plain.png"]).toEqual([1200 * 2, 900 * 2]);
        // A story taller than the viewport is captured to its full scroll height.
        expect(size["demo--tall.png"]).toEqual([1200 * 2, 1000 * 2]);
        // The capture waits for the page's fonts: the box drawn at (400, 300) when they settle is in it.
        const png = PNG.sync.read(readFileSync(join(out, "demo--late-font.png")));
        const at = (405 * 2 + 305 * 2 * png.width) * 4;
        expect([...png.data.subarray(at, at + 3)]).toEqual([255, 0, 0]);
    });

    it("gives the story's frame the focus, so a control its play function focused shows it", async () => {
        const out = tempDir("vr-out-");
        await captureAll({
            project: "demo",
            storybook: storybook(["demo--focus"]),
            baselines: tempDir("vr-bl-"),
            out,
            workers: 1,
        });
        const png = PNG.sync.read(readFileSync(join(out, "demo--focus.png")));
        const rgb = (x, y) => {
            const at = (x * 2 + y * 2 * png.width) * 4;
            return [...png.data.subarray(at, at + 3)];
        };
        // The play function's focused input, and the story had the focus from its start.
        expect(rgb(110, 110)).toEqual([0, 0, 255]);
        expect(rgb(210, 110)).toEqual([0, 0, 255]);
    });

    it("launches every browser with GPU rasterization off, so text renders the same each time", async () => {
        expect(CHROMIUM_ARGS).toContain("--disable-gpu-rasterization");
        const launch = vi.spyOn(chromium, "launch");
        try {
            await captureAll({
                project: "demo",
                storybook: storybook(),
                baselines: tempDir("vr-bl-"),
                out: tempDir("vr-out-"),
                workers: 2,
                stories: ["demo--plain"],
            });
            expect(launch).toHaveBeenCalledTimes(2);
            for (const [options] of launch.mock.calls) {
                expect(options.args).toContain("--disable-gpu-rasterization");
            }
        } finally {
            launch.mockRestore();
        }
    });
});

describe("run", () => {
    it("classifies new, unchanged, excluded, failed, and a story newly excluded by its parameters", async () => {
        // Only the stories this test checks: the tall and late-font fixtures are other tests', and
        // capturing them too doubled this test's work, which on a loaded 4-core runner
        // took it past the suite's 60 s limit (#3768).
        const sb = storybook([
            "demo--plain",
            "demo--excluded-here",
            "demo--always-excluded",
            "demo--broken",
            "demo--small",
        ]);
        const baselines = tempDir("vr-bl-");
        const go = (out) => run({ project: "demo", storybook: sb, baselines, out, workers: 2 });

        const firstOut = tempDir("vr-out-");
        const first = await go(firstOut);
        expect(first.seeded).toBe(false);
        expect(first.complete).toBe(true);
        expect(first.environment.gpu).toBe(false);
        let items = byFile(first);
        expect(items["demo--plain.png"].status).toBe("new");
        expect(items["demo--excluded-here.png"].status).toBe("excluded");
        expect(items["demo--broken.png"]).toMatchObject({ status: "failed", reason: "story render errored" });
        expect(items["demo--broken.png"].console).toEqual([
            "expected 1 to be 2",
            "AssertionError: expected 1 to be 2",
            "    at play (demo.stories.ts:9:3)",
        ]);
        expect(first.scale).toBe(2);
        // Recorded so an empty-box emoji in a capture can be traced to the machine.
        expect(first.environment.emojiFont).toBe(hasEmojiFont());
        expect(items["demo--docs.png"]).toBeUndefined();
        // Every item is written for older gates, which require flaky.
        expect(first.items.every((i) => i.flaky === false)).toBe(true);

        // Seed: demo--plain's capture, and a baseline for a story the pull request now excludes.
        mkdirSync(baselines, { recursive: true });
        copyFileSync(join(firstOut, "demo--plain.png"), join(baselines, "demo--plain.png"));
        copyFileSync(join(firstOut, "demo--plain.png"), join(baselines, "demo--excluded-here.png"));

        const secondOut = tempDir("vr-out-");
        const second = await go(secondOut);
        expect(second.seeded).toBe(true);
        items = byFile(second);
        expect(items["demo--plain.png"].status).toBe("unchanged");
        expect(items["demo--excluded-here.png"]).toMatchObject({
            status: "removed",
            reason: "the story's parameters now set disableSnapshot",
        });
        expect(items["demo--always-excluded.png"].status).toBe("excluded");
        expect(second.expected).toBe(second.items.length);
        // The images an item needs, and no more: an unchanged story's capture is not kept, a
        // removed one's baseline is.
        expect(readdirSync(secondOut)).not.toContain("demo--plain.png");
        expect(readdirSync(secondOut)).toContain("demo--small.png");
        expect(readdirSync(join(secondOut, "baselines"))).toEqual(["demo--excluded-here.png"]);
        // One result line per snapshot, in results.ndjson, and the JUnit file.
        const lines = parseResultLines(readFileSync(join(secondOut, "results.ndjson"), "utf8"));
        expect(lines.map((l) => l.file).sort()).toEqual(second.items.map((i) => i.file));
        expect(readFileSync(join(secondOut, "junit.xml"), "utf8")).toContain('<testsuite name="demo"');
    });

    it("marks a story with no baseline unseeded when it looks as in master's capture", async () => {
        const sb = storybook();
        const baselines = tempDir("vr-bl-");
        const go = (out, extra) => run({ project: "demo", storybook: sb, baselines, out, workers: 1, ...extra });
        // Master's capture: demo--plain is new there.
        const master = tempDir("vr-master-");
        const masterResults = await go(master, { stories: ["demo--plain"] });
        writeFileSync(join(master, "results.json"), JSON.stringify({ ...masterResults, runId: 77 }));

        const prOut = tempDir("vr-out-");
        const pr = await go(prOut, { reference: master, stories: ["demo--plain"] });
        expect(pr.reference).toBe(77);
        expect(pr.items.map((i) => [i.file, i.status])).toEqual([["demo--plain.png", "unseeded"]]);

        // A reference whose item is already unseeded serves as well as a new one, so the status
        // does not alternate between master runs.
        writeFileSync(join(prOut, "results.json"), JSON.stringify({ ...pr, runId: 78 }));
        const next = await go(tempDir("vr-out-"), { reference: prOut, stories: ["demo--plain"] });
        expect(next.reference).toBe(78);
        expect(next.items.map((i) => [i.file, i.status])).toEqual([["demo--plain.png", "unseeded"]]);

        // A reference image that is not what master's results.json names is ignored: new.
        writeFileSync(join(master, "demo--plain.png"), "tampered");
        const tampered = await go(tempDir("vr-out-"), { reference: master, stories: ["demo--plain"] });
        expect(tampered.items[0].status).toBe("new");
    });

    it("compares a renamed story with its old id's baseline and reports a broken rename", async () => {
        const sb = storybook();
        const seedOut = tempDir("vr-out-");
        const go = (out, baselines) => run({ project: "demo", storybook: sb, baselines, out, workers: 2 });
        // The seed needs only the two pictures copied below: capturing every story here doubled
        // this test's time on a loaded runner (#3768).
        await run({
            project: "demo",
            storybook: sb,
            baselines: tempDir("vr-bl-"),
            out: seedOut,
            workers: 2,
            stories: ["demo--plain", "demo--tall"],
        });

        // Baselines under old ids: one that looks the same as its new story, one that does not,
        // one whose rename names no story, and one renamed from an id that is still a story (which
        // is no move, so it does nothing).
        const baselines = tempDir("vr-bl-");
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "old--plain.png"));
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "old--small.png"));
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "old--lost.dark.png"));
        copyFileSync(join(seedOut, "demo--tall.png"), join(baselines, "demo--tall.png"));
        writeFileSync(
            join(baselines, "renames.json"),
            JSON.stringify([
                { from: "old--plain", to: "demo--plain" },
                { from: "old--small", to: "demo--small" },
                { from: "old--lost", to: "demo--nowhere" },
                { from: "demo--tall", to: "demo--late-font" },
            ]),
        );
        const out = tempDir("vr-out-");
        const r = await go(out, baselines);
        const items = byFile(r);
        expect(items["demo--plain.png"]).toMatchObject({ status: "moved", from: "old--plain" });
        // The page shows a moved item's capture as its baseline too, so the capture is uploaded.
        expect(readFileSync(join(out, "demo--plain.png")).equals(readFileSync(join(seedOut, "demo--plain.png")))).toBe(
            true,
        );
        expect(items["demo--small.png"]).toMatchObject({ status: "changed", from: "old--small" });
        expect(items["demo--nowhere.dark.png"]).toMatchObject({
            status: "failed",
            from: "old--lost",
            reason: "renames.json renames old--lost to demo--nowhere, but the Storybook has no story demo--nowhere: fix renames.json",
        });
        expect(items["demo--late-font.png"]).toMatchObject({ status: "new" });
        expect(items["demo--late-font.png"].from).toBeUndefined();
        expect(items["demo--tall.png"]).toMatchObject({ status: "unchanged" });
        // Neither old id's baseline is reported removed, and no item of a story that was not
        // renamed carries from.
        expect(r.items.filter((i) => i.status === "removed")).toEqual([]);
        expect(
            r.items
                .filter((i) => i.from)
                .map((i) => i.file)
                .sort(),
        ).toEqual(["demo--nowhere.dark.png", "demo--plain.png", "demo--small.png"]);
        expect(r.expected).toBe(r.items.length);
    });

    it("refuses a renames file that is not a list of distinct renames", async () => {
        const baselines = tempDir("vr-bl-");
        writeFileSync(join(baselines, "renames.json"), JSON.stringify([{ from: "a--b", to: "a--b" }]));
        await expect(
            run({ project: "demo", storybook: storybook(), baselines, out: tempDir("vr-out-"), workers: 1 }),
        ).rejects.toThrow(/renames.json: entry 0 must be/);
    });

    it("fails with a clear message when a baseline is a Git LFS pointer", async () => {
        const baselines = tempDir("vr-bl-");
        writeFileSync(
            join(baselines, "demo--plain.png"),
            `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 9\n`,
        );
        await expect(
            run({
                project: "demo",
                storybook: storybook(),
                baselines,
                out: tempDir("vr-out-"),
                workers: 1,
                stories: ["demo--plain"],
            }),
        ).rejects.toThrow(/demo--plain.png: baseline is an LFS pointer; run git lfs pull/);
    });
});

describe("screenshotWholePage", () => {
    // Bands 100 CSS px tall, each its own red value, so a row of the image names the band it shows.
    // The page is 100 CSS px wide: the PNGs stay small, so the test pays for the slicing, not for
    // encoding megapixels.
    const bands = (n) =>
        `<body style="margin:0">${Array.from({ length: n }, (_, i) => `<div style="height:100px;background:rgb(${i * 5},0,0)"></div>`).join("")}</body>`;
    const redAt = (png, y) => png.data[(y * png.width + 10) * 4];

    let browser;
    beforeAll(async () => {
        browser = await chromium.launch({ args: CHROMIUM_ARGS });
    });
    afterAll(async () => {
        await browser?.close();
    });

    async function withPage(html, use) {
        // A context of its own, as capture has: the screenshot opens a second page in it.
        const context = await browser.newContext({ viewport: { width: 100, height: 900 }, deviceScaleFactor: 2 });
        const page = await context.newPage();
        try {
            await page.setContent(html);
            // As capture does: a screenshot before the page's first frame fails in Chromium.
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            return await use(page);
        } finally {
            await context.close();
        }
    }

    it("draws the same pixels as Playwright's full-page screenshot on a page without text", async () => {
        await withPage(bands(40), async (page) => {
            const ours = PNG.sync.read(await screenshotWholePage(page));
            const own = PNG.sync.read(await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true }));
            expect([ours.width, ours.height]).toEqual([200, 8000]);
            expect([own.width, own.height]).toEqual([200, 8000]);
            expect(ours.data.equals(own.data)).toBe(true);
        });
    });

    it("draws the bottom of a page taller than the limit, not a copy of its top", async () => {
        // 4,200 CSS px is 8,400 device px: two slices, the second 208 px.
        await withPage(bands(42), async (page) => {
            const png = PNG.sync.read(await screenshotWholePage(page));
            expect([png.width, png.height]).toEqual([200, 8400]);
            expect(MAX_SHOT_HEIGHT).toBe(8192);
            // Every band, both sides of the seam and the last row included, is where the page has it.
            for (const y of [0, 199, 200, 8191, 8192, 8199, 8200, 8399]) {
                expect(redAt(png, y), `row ${y}`).toBe(Math.floor(y / 200) * 5);
            }
        });
    });

    it("keeps the page's loaded height within the limit: text is not laid out again", async () => {
        // Chromium's capture beyond the viewport laid text out again: 11px monospace with
        // line-height: normal went from 21 CSS px a row to 20 (#1982). Tiles never capture beyond
        // the viewport, so these 150 rows stay 3,160 CSS px and the image ends on the red block.
        const rows = Array.from(
            { length: 150 },
            (_, i) => `<div style="padding:4px 6px;font:11px monospace">${i}</div>`,
        );
        const html = `<body style="margin:0">${rows.join("")}<div style="height:10px;background:rgb(200,0,0)"></div></body>`;
        await withPage(html, async (page) => {
            const png = PNG.sync.read(await screenshotWholePage(page));
            const height = await page.evaluate(() => document.documentElement.scrollHeight);
            expect(height).toBe(150 * 21 + 10);
            expect([png.width, png.height]).toEqual([200, height * 2]);
            expect(redAt(png, png.height - 1)).toBe(200);
            expect(redAt(png, png.height - 20)).toBe(200);
            expect(redAt(png, png.height - 21)).toBe(255);
        });
    });

    it("keeps the page's loaded height beyond the limit: the label stays 21 px", async () => {
        // The label is 21 CSS px on load and stays so (#1976, #1982): the page is 4,221 CSS px.
        const label = `<div style="padding:4px 6px;font:600 11px ui-monospace, monospace">ak</div>`;
        await withPage(`<!doctype html>${bands(42).replace('<body style="margin:0">', `$&${label}`)}`, async (page) => {
            const png = PNG.sync.read(await screenshotWholePage(page));
            expect([png.width, png.height]).toEqual([200, 8442]);
            // The label 21 px tall, the bands below it, and the last band down to the last row.
            expect(redAt(png, 42)).toBe(0);
            expect(redAt(png, 8441)).toBe(41 * 5);
        });
    });
});
