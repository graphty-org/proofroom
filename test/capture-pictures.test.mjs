/*
 * What a capture set carries beyond its verdicts, so the review server need make nothing for it:
 * compare writes each changed pair's areas (the server's picture job finds the same), `run` writes
 * every list picture as WebP from capture's own Chromium (the server's picture, encoded smaller),
 * and capture records the renderer, which compare keeps beside the reference capture's. Retries
 * by `run` and by a test runner give one JUnit file, and none of the new fields changes what the
 * gate says, this package's or the old one's.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as oldConfig from "./fixtures/old-gate/trusted/lib/config.mjs";
import * as oldGate from "./fixtures/old-gate/trusted/gate.mjs";
import { run } from "../capture/capture.mjs";
import * as gate from "../trusted/gate.mjs";
import { collect } from "../trusted/lib/collect.mjs";
import { compareSnapshot, DEFAULT_THRESHOLD, pngSize, sha256 } from "../trusted/lib/compare.mjs";
import { compareRun } from "../trusted/lib/compare-run.mjs";
import * as config from "../trusted/lib/config.mjs";
import { factsOf, PAIR_KINDS, pictures } from "../trusted/lib/thumbs.mjs";

import { tempDir } from "./helpers.mjs";
import { countingServer, storybook as standIn } from "./stand-in-storybook.mjs";

/* global OffscreenCanvas, createImageBitmap -- read only inside the page */

/**
 * A light gray PNG with red rectangles.
 * @param {number} w its width
 * @param {number} h its height
 * @param {number[][]} rects each [x, y, width, height], drawn red
 * @returns {Buffer} the PNG
 */
function png(w, h, rects = []) {
    const img = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const red = rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
            img.data.set(red ? [220, 20, 20, 255] : [236, 236, 236, 255], (y * w + x) * 4);
        }
    }
    return PNG.sync.write(img);
}

const START = {
    type: "start",
    project: "app",
    commit: "c".repeat(40),
    headSha: null,
    pr: null,
    runId: 7,
    runAttempt: 1,
    local: null,
    capturedAt: "2026-10-26T00:00:00Z",
    clock: {},
    environment: {},
};

/**
 * Capture lines of PNGs, one `image` line per shot, in order (a file twice is a retry).
 * @param {[string, Buffer][]} shots each shot's file name and PNG
 * @param {object} [start] more fields of the start line
 * @yields {object} the start line, the image lines, the end line
 * @returns {AsyncGenerator<object>} the lines
 */
async function* linesOf(shots, start = {}) {
    yield { ...START, ...start };
    for (const [file, bytes] of shots) {
        yield {
            type: "image",
            project: "app",
            id: file.slice(0, -4),
            mode: null,
            file,
            sha256: sha256(bytes),
            size: pngSize(bytes),
            settings: { threshold: DEFAULT_THRESHOLD, includeAA: false, delay: 0 },
            console: [],
            bytes,
        };
    }
    yield { type: "end", project: "app", complete: true };
}

/**
 * Baselines in a new directory.
 * @param {Record<string, Buffer>} files each baseline's PNG by file name
 * @returns {string} the directory
 */
function baselinesOf(files) {
    const dir = tempDir("vr-bl-");
    for (const [name, bytes] of Object.entries(files)) {
        writeFileSync(join(dir, name), bytes);
    }
    return dir;
}

// Encodes as PNG where `run` encodes as WebP: the plumbing, without a browser.
const pngEncode = async (images) =>
    Object.fromEntries(Object.entries(images).map(([k, img]) => [k, PNG.sync.write(/** @type {any} */ (img))]));

const byFile = (r) => Object.fromEntries(r.items.map((i) => [i.file, i]));

/**
 * What the review server's picture job makes of an item's images in a capture directory.
 * @param {string} dir the capture directory
 * @param {object} item the item
 * @returns {ReturnType<typeof pictures>} the PNGs and, for a pair, what the job found
 */
const serverPictures = (dir, item) =>
    pictures({
        baseline: readFileSync(join(dir, "baselines", item.file)),
        capture: readFileSync(join(dir, item.file)),
        threshold: item.threshold,
        includeAA: item.includeAA,
    });

describe("compare", () => {
    it("writes each changed pair's areas, as the server's picture job finds them, and no pictures", async () => {
        const base = png(300, 200);
        const baselines = baselinesOf({ "a--two.png": base, "a--larger.png": base, "a--same.png": base });
        const out = tempDir("vr-out-");
        const { results } = await compareRun({
            project: "app",
            baselines,
            captures: tempDir("vr-cap-"),
            out,
            junit: null,
            lines: linesOf([
                ["a--two.png", png(300, 200, [[20, 20, 10, 10], [200, 150, 30, 20]])],
                ["a--larger.png", png(320, 220, [[100, 50, 5, 5]])],
                ["a--same.png", base],
                ["a--new.png", png(50, 50)],
            ]),
        });
        const items = byFile(results);
        expect(items["a--two.png"].status).toBe("changed");
        // Largest first.
        expect(items["a--two.png"].areas).toEqual([
            [190, 140, 50, 40],
            [10, 10, 30, 30],
        ]);
        for (const file of ["a--two.png", "a--larger.png"]) {
            expect(factsOf(items[file])).toEqual(serverPictures(out, items[file]).facts);
        }
        // Only a changed pair has areas.
        expect(items["a--same.png"].areas).toBeUndefined();
        expect(items["a--new.png"].areas).toBeUndefined();
        // Pictures are `run`'s: compare alone makes none.
        expect(results.items.every((i) => i.pictures === undefined)).toBe(true);
        expect(readdirSync(out).filter((f) => f.endsWith(".webp"))).toEqual([]);
    });

    it("given an encoder, writes the pictures of every item to decide, and an earlier attempt's go when it passes", async () => {
        const base = png(300, 200);
        const baselines = baselinesOf({ "a--flip.png": base, "a--changed.png": base, "a--gone.png": base });
        const out = tempDir("vr-out-");
        const encode = vi.fn(pngEncode);
        const { results } = await compareRun({
            project: "app",
            baselines,
            captures: tempDir("vr-cap-"),
            out,
            junit: null,
            encode,
            // As run does: a snapshot that passed keeps no image.
            prune: true,
            lines: linesOf([
                ["a--flip.png", png(300, 200, [[5, 5, 5, 5]])],
                ["a--changed.png", png(300, 200, [[5, 5, 5, 5]])],
                ["a--flip.png", base],
                ["a--new.png", png(40, 30)],
            ]),
        });
        const items = byFile(results);
        const named = (stem, kinds) => Object.fromEntries(kinds.map((k) => [k, `${stem}.${k}.webp`]));
        expect(items["a--changed.png"].pictures).toEqual(named("a--changed", PAIR_KINDS));
        expect(items["a--new.png"].pictures).toEqual(named("a--new", ["plain"]));
        // A removed baseline's plain picture, of the baseline.
        expect(items["a--gone.png"].pictures).toEqual(named("a--gone", ["plain"]));
        // The second attempt passed: its first attempt's pictures are gone with its image.
        expect(items["a--flip.png"]).toMatchObject({ status: "unchanged", attempts: [{ status: "changed" }] });
        expect(items["a--flip.png"].pictures).toBeUndefined();
        expect(readdirSync(out).filter((f) => f.startsWith("a--flip."))).toEqual([]);
        // Each picture is the server's for the same images.
        const pair = serverPictures(out, items["a--changed.png"]);
        for (const kind of PAIR_KINDS) {
            expect(readFileSync(join(out, `a--changed.${kind}.webp`)).equals(pair.images[kind]), kind).toBe(true);
        }
        // One encoder call per attempt that needs pictures.
        expect(encode).toHaveBeenCalledTimes(4);
    });

    it("keeps the capture's renderer and the reference capture's as the baselines'", async () => {
        const renderer = { name: "Chromium", version: "131.0.6778.33" };
        const baselines = baselinesOf({});
        const reference = tempDir("vr-ref-");
        await compareRun({
            project: "app",
            baselines,
            captures: tempDir("vr-cap-"),
            out: reference,
            junit: null,
            lines: linesOf([["a--one.png", png(10, 10)]], { renderer: { name: "Chromium", version: "128.0.6613.18" } }),
        });
        const out = tempDir("vr-out-");
        const { results } = await compareRun({
            project: "app",
            baselines,
            captures: tempDir("vr-cap-"),
            out,
            junit: null,
            reference,
            lines: linesOf([["a--one.png", png(10, 10)]], { renderer }),
        });
        expect(results.renderer).toEqual(renderer);
        expect(results.baselineRenderer).toEqual({ name: "Chromium", version: "128.0.6613.18" });
        // A capture that names none, against a reference that names none: neither field.
        const plain = await compareRun({
            project: "app",
            baselines,
            captures: tempDir("vr-out-"),
            out: tempDir("vr-out-"),
            junit: null,
            reference: tempDir("vr-none-"),
            lines: linesOf([["a--one.png", png(10, 10)]]),
        });
        expect(plain.results.renderer).toBeUndefined();
        expect(plain.results.baselineRenderer).toBeUndefined();
    });
});

describe("retries", () => {
    it("by run and by a test runner, through collect, give the same JUnit file", async () => {
        const base = png(30, 30);
        const flipped = png(30, 30, [[2, 2, 5, 5]]);
        const baselines = baselinesOf({ "flip.png": base, "same.png": base, "gone.png": base });

        // `run --retries 1`: the shot that did not pass is shot again, as a second line.
        const ran = tempDir("vr-run-");
        await compareRun({
            project: "app",
            baselines,
            captures: tempDir("vr-cap-"),
            out: ran,
            lines: linesOf([
                ["flip.png", flipped],
                ["same.png", base],
                ["flip.png", base],
            ]),
        });

        // A test runner's retry: the same snapshot judged twice, then the runs collected.
        const runs = tempDir("vr-runner-");
        const judge = (id, image) => compareSnapshot({ project: "app", baselines, id, image, out: runs });
        await judge("flip", flipped);
        await judge("same", base);
        await judge("flip", base);
        const collected = tempDir("vr-collected-");
        const merged = await collect({ project: "app", baselines, out: collected, dirs: [runs], whole: true });
        expect(merged.problems).toEqual([]);

        const junit = readFileSync(join(ran, "junit.xml"), "utf8");
        expect(junit).toMatch(/<testcase name="flip"[^>]*>\s*<flakyFailure/);
        expect(readFileSync(join(collected, "junit.xml"), "utf8")).toBe(junit);
    });
});

describe("the gate", () => {
    // The same capture without what compare and run add.
    const strip = (r) => {
        const copy = structuredClone(r);
        delete copy.renderer;
        delete copy.baselineRenderer;
        for (const i of copy.items) {
            delete i.areas;
            delete i.pictures;
        }
        return copy;
    };

    it.each([
        ["this package's gate", gate, config],
        ["the old package's gate", oldGate, oldConfig],
    ])("%s judges a capture with areas, pictures and renderers as the same capture without them", async (_, g, c) => {
        const base = png(40, 40);
        const baselines = baselinesOf({ "a--changed.png": base, "a--same.png": base });
        const judged = async (shots) => {
            const out = tempDir("vr-out-");
            const { results } = await compareRun({
                project: "app",
                baselines,
                captures: tempDir("vr-cap-"),
                out,
                junit: null,
                encode: pngEncode,
                lines: linesOf(shots, { renderer: { name: "Chromium", version: "131.0.6778.33" } }),
            });
            return results;
        };
        const cfg = c.normalizeConfig({ defaultBranch: "master", projects: { app: { storybook: "a" } } });
        const problems = (r) =>
            g.gateProblems({ config: cfg, seeded: new Set(["app"]), captures: { app: { attempt: 1, results: r } } });

        const failing = await judged([
            ["a--changed.png", png(40, 40, [[1, 1, 3, 3]])],
            ["a--same.png", base],
        ]);
        expect(failing.items.find((i) => i.file === "a--changed.png").areas).toHaveLength(1);
        expect(failing.renderer).toBeDefined();
        expect(problems(failing)).toEqual(problems(strip(failing)));
        expect(problems(failing).length).toBeGreaterThan(0);

        const passing = await judged([
            ["a--changed.png", base],
            ["a--same.png", base],
        ]);
        expect(problems(passing)).toEqual([]);
        expect(problems(strip(passing))).toEqual([]);
    });
});

describe("run", () => {
    let counter;
    let browser;
    beforeAll(async () => {
        vi.stubEnv("GITHUB_ACTIONS", "");
        process.env.FC_FONTATIONS = "1";
        counter = await countingServer();
        browser = await chromium.launch();
    });
    afterAll(async () => {
        vi.unstubAllEnvs();
        counter.close();
        await browser?.close();
    });

    /**
     * Decodes a WebP and a PNG in Chromium and measures how far apart their pixels are.
     * @param {Buffer} webp the WebP
     * @param {Buffer} asPng the PNG
     * @returns {Promise<{ webp: number[], png: number[], meanDiff: number }>} each one's size, and
     *     the mean difference per channel, 0 to 255
     */
    async function decodedApart(webp, asPng) {
        const page = await browser.newPage();
        try {
            return await page.evaluate(
                async ([a, b]) => {
                    const pixels = async (b64, type) => {
                        const blob = await (await fetch(`data:${type};base64,${b64}`)).blob();
                        const bitmap = await createImageBitmap(blob);
                        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                        const ctx = canvas.getContext("2d");
                        ctx.drawImage(bitmap, 0, 0);
                        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
                    };
                    const [x, y] = [await pixels(a, "image/webp"), await pixels(b, "image/png")];
                    let sum = 0;
                    for (let i = 0; i < Math.min(x.data.length, y.data.length); i++) {
                        sum += Math.abs(x.data[i] - y.data[i]);
                    }
                    return { webp: [x.width, x.height], png: [y.width, y.height], meanDiff: sum / x.data.length };
                },
                [webp.toString("base64"), asPng.toString("base64")],
            );
        } finally {
            await page.close();
        }
    }

    it("records the renderer and writes every list picture as WebP, the server's pictures made smaller", async () => {
        const sb = standIn(counter.url, undefined, ["demo--plain", "demo--small"]);
        const baselines = tempDir("vr-bl-");
        const go = (out, extra = {}) =>
            run({ project: "demo", storybook: sb, baselines, out, workers: 1, waitFor: null, log: () => {}, ...extra });

        const firstOut = tempDir("vr-out-");
        const { results: first } = await go(firstOut);
        expect(first.renderer).toEqual({ name: "Chromium", version: first.environment.chromium });
        expect(first.renderer.version).toMatch(/^\d+\.\d+\./);
        expect(first.baselineRenderer).toBeUndefined();
        const plain = byFile(first)["demo--plain.png"];
        expect(plain).toMatchObject({ status: "new", pictures: { plain: "demo--plain.plain.webp" } });
        const webp = readFileSync(join(firstOut, plain.pictures.plain));
        expect(webp.subarray(0, 4).toString("latin1")).toBe("RIFF");
        expect(webp.subarray(8, 12).toString("latin1")).toBe("WEBP");

        // The default branch's capture, as compare's reference, and demo--plain's baseline: its
        // capture with a red box drawn on it.
        writeFileSync(join(firstOut, "results.json"), JSON.stringify({ ...first, runId: 77 }));
        const img = PNG.sync.read(readFileSync(join(firstOut, "demo--plain.png")));
        for (let y = 300; y < 340; y++) {
            for (let x = 500; x < 560; x++) {
                img.data.set([220, 20, 20, 255], (y * img.width + x) * 4);
            }
        }
        writeFileSync(join(baselines, "demo--plain.png"), PNG.sync.write(img));

        const out = tempDir("vr-out-");
        const { results } = await go(out, { reference: firstOut });
        expect(results.baselineRenderer).toEqual(first.renderer);
        const items = byFile(results);
        const changed = items["demo--plain.png"];
        expect(changed.status).toBe("changed");
        expect(Object.keys(changed.pictures).sort()).toEqual([...PAIR_KINDS].sort());
        expect(items["demo--small.png"]).toMatchObject({
            status: "unseeded",
            pictures: { plain: "demo--small.plain.webp" },
        });
        // The areas and pictures the server would make of the same pair.
        const server = serverPictures(out, changed);
        expect(factsOf(changed)).toEqual(server.facts);
        expect(changed.areas).toHaveLength(1);
        let webpBytes = 0;
        let pngBytes = 0;
        for (const kind of PAIR_KINDS) {
            const made = readFileSync(join(out, changed.pictures[kind]));
            const apart = await decodedApart(made, server.images[kind]);
            expect(apart.webp, kind).toEqual(apart.png);
            expect(apart.meanDiff, kind).toBeLessThan(4);
            webpBytes += made.length;
            pngBytes += server.images[kind].length;
        }
        expect(webpBytes).toBeLessThan(pngBytes);
    });
});
