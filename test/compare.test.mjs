import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import { PNG } from "pngjs";
/* global requestAnimationFrame -- read only inside the page */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { capture, CHROMIUM_ARGS, run as runCapture, serve, storyUrl } from "../capture/capture.mjs";
import * as gate from "../trusted/gate.mjs";
import { classify, compareImages, isLfsPointer, readBaseline, sha256 } from "../trusted/lib/compare.mjs";
import { captureLines, compareRun, imageLines } from "../trusted/lib/compare-run.mjs";
import * as config from "../trusted/lib/config.mjs";
import { parseResultLines } from "../trusted/lib/result-line.mjs";
import { validateResults } from "../trusted/lib/results.mjs";
import { capture as oldCapture } from "./fixtures/capture-0.9/capture/capture.mjs";
import * as oldConfig from "./fixtures/old-gate/trusted/lib/config.mjs";
import * as oldGate from "./fixtures/old-gate/trusted/gate.mjs";

import { git, tempDir } from "./helpers.mjs";
import { countingServer, demoRepo, storybook } from "./stand-in-storybook.mjs";

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

/**
 * Encodes a width x height PNG filled with `fill` ([r, g, b]), then applies `edits`.
 * @param {number} width in pixels
 * @param {number} height in pixels
 * @param {number[]} fill the background colour
 * @param {(set: (x: number, y: number, rgb: number[]) => void) => void} [edits] paints pixels
 * @returns {Buffer} the encoded PNG
 */
function png(width, height, fill, edits) {
    const img = new PNG({ width, height });
    const set = (x, y, [r, g, b]) => img.data.set([r, g, b, 255], (y * width + x) * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            set(x, y, fill);
        }
    }
    edits?.(set);
    return PNG.sync.write(img);
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const OPTS = { threshold: 0.063, includeAA: false };

describe("compareImages", () => {
    it("reports equal bytes as unchanged without decoding them", () => {
        // A valid header over zeroed image data: decoding it would throw, so passing means the
        // hash alone decided (and the size came from the header).
        const bytes = png(8, 8, WHITE).fill(0, 33);
        expect(() => PNG.sync.read(bytes)).toThrow();
        const r = compareImages(bytes, Buffer.from(bytes), OPTS);
        expect(r).toMatchObject({ status: "unchanged", changedPixels: 0, bbox: null, size: [8, 8] });
        expect(r.baseline).toBe(sha256(bytes));
        expect(r.capture).toBe(r.baseline);
    });

    it("counts one pixel changed above the threshold and boxes it", () => {
        const base = png(8, 8, WHITE);
        const cap = png(8, 8, WHITE, (set) => set(3, 5, BLACK));
        expect(compareImages(base, cap, OPTS)).toMatchObject({
            status: "changed",
            changedPixels: 1,
            bbox: [3, 5, 1, 1],
            size: [8, 8],
            baselineSize: [8, 8],
        });
    });

    it("treats a change under the threshold as unchanged", () => {
        const base = png(8, 8, WHITE);
        const cap = png(8, 8, WHITE, (set) => set(3, 5, [250, 250, 250]));
        const r = compareImages(base, cap, OPTS);
        expect(r).toMatchObject({ status: "unchanged", changedPixels: 0, bbox: null });
        expect(r.capture).not.toBe(r.baseline);
    });

    it("pads different sizes to the larger one, top-left, and counts the padding", () => {
        const base = png(4, 4, WHITE);
        const cap = png(4, 6, WHITE);
        expect(compareImages(base, cap, OPTS)).toMatchObject({
            status: "changed",
            changedPixels: 8,
            bbox: [0, 4, 4, 2],
            size: [4, 6],
            baselineSize: [4, 4],
        });
        // Wider baseline, taller capture: everything outside the 3 x 3 overlap is padding.
        const r = compareImages(png(5, 3, WHITE), png(3, 5, WHITE), OPTS);
        expect(r).toMatchObject({ changedPixels: 25 - 9, bbox: [0, 0, 5, 5] });
    });

    it("ignores an anti-aliased edge pixel unless includeAA is set", () => {
        // A vertical black/white edge; the capture greys one pixel on it, as anti-aliasing does.
        const edge = (set) => {
            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 4; x++) {
                    set(x, y, BLACK);
                }
            }
        };
        const base = png(8, 8, WHITE, edge);
        const cap = png(8, 8, WHITE, (set) => {
            edge(set);
            set(4, 4, [128, 128, 128]);
        });
        expect(compareImages(base, cap, OPTS)).toMatchObject({ status: "unchanged", changedPixels: 0 });
        expect(compareImages(base, cap, { ...OPTS, includeAA: true })).toMatchObject({
            status: "changed",
            changedPixels: 1,
            bbox: [4, 4, 1, 1],
        });
    });
});

describe("classify", () => {
    const base = png(8, 8, WHITE);
    const a = png(8, 8, WHITE, (set) => set(1, 1, BLACK));
    const b = png(8, 8, WHITE, (set) => set(6, 6, BLACK));

    it("capture equal to the baseline is unchanged", () => {
        expect(classify({ baseline: base, first: Buffer.from(base), ...OPTS })).toMatchObject({
            status: "unchanged",
            flaky: false,
        });
    });

    it("a capture that differs is changed, or new without a baseline, judged from that one capture", () => {
        expect(classify({ baseline: base, first: a, ...OPTS })).toMatchObject({
            status: "changed",
            flaky: false,
            changedPixels: 1,
            bbox: [1, 1, 1, 1],
            capture: sha256(a),
        });
        expect(classify({ baseline: null, first: a, ...OPTS })).toMatchObject({
            status: "new",
            flaky: false,
            baseline: null,
            capture: sha256(a),
            size: [8, 8],
            baselineSize: null,
        });
    });

    it("takes no second capture and never says unstable", () => {
        // A second image, as callers once passed, changes nothing.
        expect(classify({ baseline: base, first: a, second: Buffer.from(base), ...OPTS })).toMatchObject({
            status: "changed",
            flaky: false,
        });
        expect(classify({ baseline: null, first: a, second: b, ...OPTS })).toMatchObject({ status: "new" });
    });

    it("a baseline with no story is removed", () => {
        expect(classify({ baseline: base, first: null, ...OPTS })).toMatchObject({
            status: "removed",
            flaky: false,
            baseline: sha256(base),
            capture: null,
            baselineSize: null,
        });
    });

    it("no baseline and the same as master's capture is unseeded; different from it is new", () => {
        expect(classify({ baseline: null, first: a, reference: Buffer.from(a), ...OPTS })).toMatchObject({
            status: "unseeded",
            baseline: null,
            capture: sha256(a),
            size: [8, 8],
        });
        expect(classify({ baseline: null, first: a, reference: b, ...OPTS })).toMatchObject({ status: "new" });
        // A reference never applies where a baseline exists: the baseline decides.
        expect(classify({ baseline: base, first: a, reference: a, ...OPTS })).toMatchObject({ status: "changed" });
    });

    it("a renamed story that looks as its old id's baseline is moved; one that differs is changed", () => {
        const moved = { baseline: base, moved: true, ...OPTS };
        expect(classify({ ...moved, first: Buffer.from(base) })).toMatchObject({ status: "moved", flaky: false });
        expect(classify({ ...moved, first: a })).toMatchObject({ status: "changed", changedPixels: 1 });
    });
});

describe("Git LFS pointers", () => {
    const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 687\n`;

    it("tells a pointer file from a PNG", () => {
        expect(isLfsPointer(Buffer.from(POINTER))).toBe(true);
        expect(isLfsPointer(png(8, 8, WHITE))).toBe(false);
        expect(isLfsPointer(Buffer.alloc(0))).toBe(false);
    });

    it("refuses a baseline that is a pointer, reads a PNG, and returns null for none", async () => {
        const dir = tempDir("vr-lfs-");
        writeFileSync(join(dir, "pointer.png"), POINTER);
        writeFileSync(join(dir, "real.png"), png(8, 8, WHITE));
        await expect(readBaseline(join(dir, "pointer.png"))).rejects.toThrow(
            /pointer.png: baseline is an LFS pointer; run git lfs pull/,
        );
        expect(await readBaseline(join(dir, "real.png"))).toEqual(png(8, 8, WHITE));
        expect(await readBaseline(join(dir, "missing.png"))).toBeNull();
    });
});

describe("the compare command on a directory of images", () => {
    it("reads each file from the side that has it, prints a result line for each, and writes the results", () => {
        const dir = tempDir("vr-compare-cli-");
        git(dir, "init", "-q", "-b", "main");
        git(dir, "-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-q", "--allow-empty", "-m", "init");
        const baselines = join(dir, "baselines");
        const captures = join(dir, "captures");
        mkdirSync(baselines);
        mkdirSync(captures);
        writeFileSync(join(baselines, "same.png"), png(4, 4, WHITE));
        writeFileSync(join(captures, "same.png"), png(4, 4, WHITE));
        writeFileSync(join(baselines, "gone.png"), png(4, 4, BLACK));
        writeFileSync(join(captures, "added.png"), png(4, 4, BLACK));
        const r = spawnSync(process.execPath, [CLI, "compare", "--baselines", baselines, "--captures", captures], {
            cwd: dir,
            encoding: "utf8",
        });
        const lines = parseResultLines(r.stdout);
        expect(r.status).toBe(1);
        expect(lines.map((l) => [l.file, l.status, l.passed])).toEqual([
            ["added.png", "new", false],
            ["same.png", "unchanged", true],
            ["gone.png", "removed", false],
        ]);
        expect(JSON.parse(r.stderr.trim().split("\n").at(-1))).toEqual({
            project: "images",
            summary: { new: 1, unchanged: 1, removed: 1 },
        });
        expect(parseResultLines(readFileSync(join(captures, "results.ndjson"), "utf8"))).toEqual(lines);
        const results = JSON.parse(readFileSync(join(captures, "results.json"), "utf8"));
        expect(validateResults(results)).toEqual([]);
        expect(results.items.map((i) => [i.file, i.status])).toEqual([
            ["added.png", "new"],
            ["gone.png", "removed"],
            ["same.png", "unchanged"],
        ]);
        expect(readFileSync(join(captures, "junit.xml"), "utf8")).toContain('<testsuite name="images" tests="3"');
        // The removed baseline is kept beside the results for the page; the images stay where they were.
        expect(readFileSync(join(captures, "baselines", "gone.png")).equals(png(4, 4, BLACK))).toBe(true);
        expect(readFileSync(join(captures, "same.png")).equals(png(4, 4, WHITE))).toBe(true);

        const pass = spawnSync(
            process.execPath,
            [CLI, "compare", "--baselines", baselines, "--captures", captures, "--no-fail"],
            { cwd: dir, encoding: "utf8" },
        );
        expect(pass.status).toBe(0);
    });
});

describe("compare and run on a Storybook", () => {
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
    beforeEach(() => {
        counter.loads.clear();
        counter.wobbles.left = 0;
    });

    const quiet = { waitFor: null, log: () => {} };
    // Runs capture() to its end; the tests read the files it writes.
    const captureAll = async (options) => {
        const lines = capture({ ...quiet, ...options });
        while (!(await lines.next()).done) {
            // Next line.
        }
    };

    it("judges a directory of images made by a plain Playwright script as it judges capture's output", async () => {
        const sb = storybook(counter.url);
        const baselines = tempDir("vr-bl-");
        // A baseline that differs from demo--small, so the item has pixels to count.
        writeFileSync(join(baselines, "demo--small.png"), png(2400, 1800, WHITE));

        const fromCapture = tempDir("vr-out-");
        await captureAll({
            project: "demo",
            storybook: sb,
            baselines,
            out: fromCapture,
            workers: 1,
            stories: ["demo--small"],
        });
        const viaLines = await compareRun({
            project: "demo",
            baselines,
            captures: fromCapture,
            out: tempDir("vr-cmp-"),
            lines: captureLines(fromCapture),
            log: () => {},
        });

        // Any tool's screenshot: Playwright alone, the story's iframe at the same size.
        const plain = tempDir("vr-plain-");
        const [server, base] = await serve(sb);
        const browser = await chromium.launch({ args: CHROMIUM_ARGS });
        try {
            const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
            await page.goto(`${base}${storyUrl("demo--small", null)}`);
            // Chromium has no screenshot to give before the page's first frame.
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            await page.screenshot({ path: join(plain, "demo--small.png"), fullPage: true });
        } finally {
            await browser.close();
            server.close();
        }
        const viaDir = await compareRun({
            project: "images",
            baselines,
            captures: plain,
            out: tempDir("vr-cmp-"),
            lines: imageLines({ project: "images", captures: plain, threshold: 0.063, includeAA: false }),
            log: () => {},
        });

        expect(viaLines.results.items).toHaveLength(1);
        expect(viaLines.results.items[0]).toMatchObject({ file: "demo--small.png", status: "changed" });
        expect(viaDir.results.items).toEqual(viaLines.results.items);
    });

    it("capture --ndjson | compare --stdin prints a result line before the capture's end line reaches it", async () => {
        const { repo } = demoRepo(counter.url);
        const out = join(repo, "out");
        const shoot = spawn(
            process.execPath,
            [CLI, "capture", "--project", "demo", "--out", out, "--ndjson", "--stories", "demo--plain,demo--small"],
            { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
        );
        const judge = spawn(process.execPath, [CLI, "compare", "--project", "demo", "--captures", out, "--stdin"], {
            cwd: repo,
            stdio: ["pipe", "pipe", "pipe"],
        });
        // The order things happened in: each capture line read, each line handed to compare,
        // each result line compare printed.
        const events = [];
        const held = [];
        let released = false;
        const release = () => {
            released = true;
            for (const line of held.splice(0)) {
                events.push(`gave ${JSON.parse(line).type}`);
                judge.stdin.write(`${line}\n`);
            }
            if (events.includes("capture ended")) {
                judge.stdin.end();
            }
        };
        let images = 0;
        createInterface({ input: shoot.stdout }).on("line", (line) => {
            const { type } = JSON.parse(line);
            events.push(`read ${type}`);
            // Everything after the first image waits until compare has printed a result.
            if (released || type === "start" || (type === "image" && images++ === 0)) {
                events.push(`gave ${type}`);
                judge.stdin.write(`${line}\n`);
            } else {
                held.push(line);
            }
        });
        const results = [];
        createInterface({ input: judge.stdout }).on("line", (line) => {
            results.push(JSON.parse(line));
            events.push(`result ${JSON.parse(line).file}`);
            if (!released) {
                // results.json is written once, at the end, not after each snapshot.
                events.push(existsSync(join(out, "results.json")) ? "results.json early" : "no results.json yet");
                release();
            }
        });
        const exited = (child) => new Promise((r) => child.on("close", (code) => r(code)));
        const shot = await exited(shoot);
        events.push("capture ended");
        if (released) {
            judge.stdin.end();
        }
        expect(shot).toBe(0);
        expect(await exited(judge)).toBe(1);

        const firstResult = events.findIndex((e) => e.startsWith("result "));
        expect(firstResult).toBeGreaterThan(-1);
        // The first result came while compare had seen one image and no end line.
        expect(events.slice(0, firstResult).filter((e) => e.startsWith("gave "))).toEqual(["gave start", "gave image"]);
        expect(events.indexOf("gave end")).toBeGreaterThan(firstResult);
        expect(events).toContain("no results.json yet");
        expect(results.map((r) => [r.file, r.status]).sort()).toEqual([
            ["demo--plain.png", "new"],
            ["demo--small.png", "new"],
        ]);
        expect(JSON.parse(readFileSync(join(out, "results.json"), "utf8")).complete).toBe(true);
    });

    it("writes the results.json of 0.9's capture, item for item, and both gates judge it the same", async () => {
        const sb = storybook(counter.url);
        // A first capture to seed baselines from: unchanged, changed, removed, newly excluded, a
        // rename that moved, a rename to no story, and the rest new.
        const seedOut = tempDir("vr-out-");
        await captureAll({ project: "demo", storybook: sb, baselines: tempDir("vr-bl-"), out: seedOut, workers: 2 });
        const baselines = tempDir("vr-bl-");
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "demo--plain.png"));
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "demo--small.png"));
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "demo--gone.png"));
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "demo--excluded-here.png"));
        copyFileSync(join(seedOut, "demo--tall.png"), join(baselines, "old--tall.png"));
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "old--lost.png"));
        writeFileSync(
            join(baselines, "renames.json"),
            JSON.stringify([
                { from: "old--tall", to: "demo--tall" },
                { from: "old--lost", to: "demo--nowhere" },
            ]),
        );
        const options = { project: "demo", storybook: sb, baselines, workers: 2, ...quiet };
        const before = await oldCapture({ ...options, out: tempDir("vr-old-") });
        const { results: after } = await runCapture({ ...options, out: tempDir("vr-new-") });

        const statuses = Object.fromEntries(after.items.map((i) => [i.file, i.status]));
        expect(statuses).toMatchObject({
            "demo--plain.png": "unchanged",
            "demo--small.png": "changed",
            "demo--gone.png": "removed",
            "demo--excluded-here.png": "removed",
            "demo--tall.png": "moved",
            "demo--nowhere.png": "failed",
            "demo--late-font.png": "new",
            "demo--broken.png": "failed",
            "demo--always-excluded.png": "excluded",
        });
        expect(after.items.some((i) => i.status === "unstable")).toBe(false);
        const withoutFlaky = (items) => items.map((i) => ({ ...i, flaky: undefined }));
        expect(withoutFlaky(after.items)).toEqual(withoutFlaky(before.items));
        expect(after.items.every((i) => i.flaky === false)).toBe(true);
        for (const key of ["version", "project", "seeded", "reference", "complete", "expected", "scale"]) {
            expect(after[key], key).toEqual(before[key]);
        }

        // This package's gate and the old one say the same about the two files.
        for (const [g, c] of [
            [gate, config],
            [oldGate, oldConfig],
        ]) {
            const cfg = c.normalizeConfig({ defaultBranch: "main", projects: { demo: { storybook: "a" } } });
            const problems = (results) =>
                g.gateProblems({ config: cfg, seeded: new Set(["demo"]), captures: { demo: { attempt: 1, results } } });
            expect(problems(after)).toEqual(problems(before));
            expect(problems(after).length).toBeGreaterThan(0);
        }
    });

    it("run --retries 1 shoots a snapshot that did not pass once more, and records both attempts", async () => {
        const sb = storybook(counter.url);
        const baselines = tempDir("vr-bl-");
        const options = { project: "demo", storybook: sb, baselines, workers: 2, ...quiet };
        const seedOut = tempDir("vr-out-");
        const stories = ["demo--wobbly", "demo--small", "demo--plain"];
        await captureAll({ ...options, out: seedOut, stories });
        copyFileSync(join(seedOut, "demo--wobbly.png"), join(baselines, "demo--wobbly.png"));
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "demo--plain.png"));
        // demo--small never looks like this: it differs on every shot.
        copyFileSync(join(seedOut, "demo--plain.png"), join(baselines, "demo--small.png"));
        counter.loads.clear();

        // demo--wobbly differs on its first shot and matches on its second.
        counter.wobbles.left = 1;
        const out = tempDir("vr-out-");
        const printed = [];
        const { results, passed } = await runCapture({
            ...options,
            out,
            stories,
            retries: 1,
            print: (line) => printed.push(line),
        });
        const items = Object.fromEntries(results.items.map((i) => [i.file, i]));
        expect(items["demo--wobbly.png"]).toMatchObject({ status: "unchanged", flaky: false });
        expect(items["demo--wobbly.png"].attempts).toEqual([
            expect.objectContaining({ status: "changed", capture: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        ]);
        expect(items["demo--small.png"]).toMatchObject({ status: "changed" });
        expect(items["demo--small.png"].attempts).toEqual([expect.objectContaining({ status: "changed" })]);
        expect(items["demo--plain.png"].status).toBe("unchanged");
        expect(items["demo--plain.png"].attempts).toBeUndefined();
        expect(passed).toBe(false);
        // One shot per attempt: twice for the two that did not pass at first, once for the other.
        expect(Object.fromEntries(counter.loads)).toEqual({ "demo--wobbly": 2, "demo--small": 2, "demo--plain": 1 });
        // A result line per attempt, numbered.
        expect(printed.map((l) => [l.file, l.attempt, l.passed]).sort()).toEqual([
            ["demo--plain.png", 1, true],
            ["demo--small.png", 1, false],
            ["demo--small.png", 2, false],
            ["demo--wobbly.png", 1, false],
            ["demo--wobbly.png", 2, true],
        ]);
        // The images of the last attempt only: the wobbly story matched, so none is kept for it.
        expect(readdirSync(out).filter((f) => f.endsWith(".png"))).toEqual(["demo--small.png"]);
        expect(readdirSync(join(out, "baselines"))).toEqual(["demo--small.png"]);
        // JUnit holds both attempts, and calls nothing flaky by itself.
        const xml = readFileSync(join(out, "junit.xml"), "utf8");
        expect(xml).toMatch(/<testcase name="demo--wobbly"[^>]*>\s*<flakyFailure/);
        expect(xml).toMatch(/<testcase name="demo--small"[^>]*>\s*<failure[\s\S]*?<rerunFailure/);

        // The old gate passes the snapshot that matched on its second shot.
        const cfg = oldConfig.normalizeConfig({ defaultBranch: "main", projects: { demo: { storybook: "a" } } });
        const only = { ...results, items: [items["demo--wobbly.png"], items["demo--plain.png"]], expected: 2 };
        expect(
            oldGate.gateProblems({
                config: cfg,
                seeded: new Set(["demo"]),
                captures: { demo: { attempt: 1, results: only } },
            }),
        ).toEqual([]);
    });

    it("run exits 1 when a snapshot did not pass, 0 with --no-fail, and 2 when the tool fails", async () => {
        const { repo, baselines } = demoRepo(counter.url);
        // Not spawnSync: the stand-in Storybook's counting server answers from this process.
        const go = (...extra) =>
            cli(["run", "--project", "demo", "--out", join(repo, "out"), "--stories", "demo--plain", ...extra], repo);
        const failing = await go();
        expect(failing.status).toBe(1);
        expect(parseResultLines(failing.stdout).map((l) => [l.file, l.status])).toEqual([["demo--plain.png", "new"]]);
        expect((await go("--no-fail")).status).toBe(0);
        copyFileSync(join(repo, "out", "demo--plain.png"), join(baselines, "demo--plain.png"));
        expect((await go()).status).toBe(0);
        writeFileSync(
            join(baselines, "demo--plain.png"),
            `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 9\n`,
        );
        const broken = await go("--no-fail");
        expect(broken.status).toBe(2);
        expect(broken.stderr).toMatch(/proofroom run: .*demo--plain.png: baseline is an LFS pointer; run git lfs pull/);
    });
});
