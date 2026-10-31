/*
 * capture() end to end in Chromium, against a stand-in Storybook: a static index.json and an
 * iframe.html whose preview object answers what capture reads from a real one.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { chromium } from "playwright";

/* global document, requestAnimationFrame -- read only inside the page */

import {
    capture,
    CHROMIUM_ARGS,
    hasEmojiFont,
    MAX_SHOT_HEIGHT,
    needsSecondShot,
    screenshotWholePage,
} from "../capture/capture.mjs";

import { tempDir } from "./helpers.mjs";

const PARAMS = {
    "demo--plain": {},
    "demo--excluded-here": { chromatic: { disableSnapshot: true } },
    "demo--always-excluded": { chromatic: { disableSnapshot: true } },
    "demo--broken": {},
    "demo--play-threw": {},
    "demo--small": {},
    "demo--late-font": {},
    "demo--tall": {},
    "demo--focus": {},
};

const IFRAME = `<!doctype html><html><body><script>
const id = new URLSearchParams(location.search).get("id");
if (id === "demo--broken") {
    document.body.classList.add("sb-show-errordisplay");
    document.body.insertAdjacentHTML("beforeend", "<h1 id='error-message'>expected 1 to be 2</h1>" +
        "<pre id='error-stack'>AssertionError: expected 1 to be 2\\n    at play (demo.stories.ts:9:3)</pre>");
} else if (id === "demo--late-font") {
    // Stands in for a web font that arrives after the render: the box appears only when
    // document.fonts.ready settles, half a second later.
    const late = new Promise((resolve) => setTimeout(() => {
        document.body.insertAdjacentHTML("beforeend",
            "<div style='position:absolute;left:400px;top:300px;width:10px;height:10px;background:red'></div>");
        resolve();
    }, 500));
    Object.defineProperty(document.fonts, "ready", { get: () => late });
    document.body.insertAdjacentHTML("beforeend",
        "<div style='position:absolute;left:100px;top:100px;width:10px;height:10px;background:red'></div>");
} else if (id === "demo--small") {
    // A 50 x 20 box at (100, 100): far smaller than the viewport.
    document.body.insertAdjacentHTML("beforeend",
        "<div style='position:absolute;left:100px;top:100px;width:50px;height:20px;background:red'></div>");
} else if (id === "demo--focus") {
    // A story that starts with the page's focus draws a blue box at (200, 100), as a story
    // reading document.hasFocus() would differ; then a play function focuses a control, and the
    // input turns blue only while it has the focus.
    if (document.hasFocus()) {
        document.body.insertAdjacentHTML("beforeend",
            "<div style='position:absolute;left:200px;top:100px;width:20px;height:20px;background:#00f'></div>");
    }
    document.head.insertAdjacentHTML("beforeend",
        "<style>input{position:absolute;left:100px;top:100px;width:50px;height:20px;border:0;outline:0;background:#fff}input:focus{background:#00f}</style>");
    document.body.insertAdjacentHTML("beforeend", "<input>");
    document.querySelector("input").focus();
} else if (id === "demo--tall") {
    // A story 1000 px tall, taller than the 900 px viewport: two tiles, the fewest a tall story takes.
    document.body.insertAdjacentHTML("beforeend",
        "<div style='position:absolute;left:0;top:0;width:10px;height:1000px;background:red'></div>");
} else {
    document.body.insertAdjacentHTML("beforeend", "<h1 style='font: 40px monospace'>" + (id ?? "preview") +
        (navigator.gpu ? " gpu" : " no-gpu") + "</h1>");
}
window.__STORYBOOK_PREVIEW__ = {
    storyStoreValue: {},
    // A play function that threw: Storybook ends the render "finished" with no error screen, and
    // its channel keeps the exception event it emitted.
    currentRender: { phase: id === "demo--play-threw" ? "finished" : "completed" },
    channel: { last: (type) => id === "demo--play-threw" && type === "playFunctionThrewException"
        ? [{ name: "AssertionError", message: "expected 1 to be 2",
            stack: "AssertionError: expected 1 to be 2\\n    at play (demo.stories.ts:9:3)" }]
        : undefined },
    extract: async () => Object.fromEntries(Object.entries(${JSON.stringify(PARAMS)}).map(([k, v]) => [k, { parameters: v }])),
};
</script></body></html>`;

function storybook(ids = Object.keys(PARAMS)) {
    const dir = tempDir("vr-sb-");
    const entries = Object.fromEntries(ids.map((id) => [id, { id, type: "story" }]));
    entries["demo--docs"] = { id: "demo--docs", type: "docs" };
    writeFileSync(join(dir, "index.json"), JSON.stringify({ entries }));
    writeFileSync(join(dir, "iframe.html"), IFRAME);
    return dir;
}

const byFile = (r) => Object.fromEntries(r.items.map((i) => [i.file, i]));

beforeAll(() => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    process.env.FC_FONTATIONS = "1";
});
afterAll(() => vi.unstubAllEnvs());

describe("capture", () => {
    it("classifies new, unchanged, excluded, failed, and a story newly excluded by its parameters", async () => {
        // Only the stories this test checks: the tall, late-font and small fixtures are other
        // tests', and capturing them too doubled this test's work, which on a loaded 4-core runner
        // took it past the suite's 60 s limit (#3768).
        const sb = storybook(["demo--plain", "demo--excluded-here", "demo--always-excluded", "demo--broken"]);
        const baselines = tempDir("vr-bl-");
        const run = (out) =>
            capture({ project: "demo", storybook: sb, baselines, out, workers: 2, waitFor: null, log: () => {} });

        const firstOut = tempDir("vr-out-");
        const first = await run(firstOut);
        expect(first.seeded).toBe(false);
        expect(first.complete).toBe(true);
        expect(first.environment.gpu).toBe(false);
        let items = byFile(first);
        expect(items["demo--plain.png"].status).toBe("new");
        expect(items["demo--excluded-here.png"].status).toBe("excluded");
        expect(items["demo--broken.png"]).toMatchObject({ status: "failed", reason: "story render errored" });
        // Storybook's error screen: the message and the stack, for the errors list.
        expect(items["demo--broken.png"].console).toEqual([
            "expected 1 to be 2",
            "AssertionError: expected 1 to be 2",
            "    at play (demo.stories.ts:9:3)",
        ]);
        expect(first.scale).toBe(2);
        // Recorded so an empty-box emoji in a capture can be traced to the machine.
        expect(first.environment.emojiFont).toBe(hasEmojiFont());
        expect(items["demo--docs.png"]).toBeUndefined();

        // Seed: demo--plain's capture, and a baseline for a story the pull request now excludes.
        mkdirSync(baselines, { recursive: true });
        copyFileSync(join(firstOut, "demo--plain.png"), join(baselines, "demo--plain.png"));
        copyFileSync(join(firstOut, "demo--plain.png"), join(baselines, "demo--excluded-here.png"));

        const second = await run(tempDir("vr-out-"));
        expect(second.seeded).toBe(true);
        items = byFile(second);
        expect(items["demo--plain.png"].status).toBe("unchanged");
        expect(items["demo--excluded-here.png"]).toMatchObject({
            status: "removed",
            reason: "the story's parameters now set disableSnapshot",
        });
        expect(items["demo--always-excluded.png"].status).toBe("excluded");
        expect(second.expected).toBe(second.items.length);
    });

    it("records a story whose play function threw as failed, without a picture", async () => {
        const sb = storybook(["demo--play-threw"]);
        const out = tempDir("vr-out-");
        const r = await capture({
            project: "demo",
            storybook: sb,
            baselines: tempDir("vr-bl-"),
            out,
            workers: 1,
            waitFor: null,
            log: () => {},
        });
        const item = byFile(r)["demo--play-threw.png"];
        expect(item).toMatchObject({ status: "failed", reason: "play function failed" });
        expect(item.console).toEqual([
            "expected 1 to be 2",
            "AssertionError: expected 1 to be 2",
            "    at play (demo.stories.ts:9:3)",
        ]);
        expect(existsSync(join(out, "demo--play-threw.png"))).toBe(false);
    });

    it("marks a story with no baseline unseeded when it looks as in master's capture", async () => {
        const sb = storybook();
        const baselines = tempDir("vr-bl-");
        const run = (out, extra) =>
            capture({
                project: "demo",
                storybook: sb,
                baselines,
                out,
                workers: 1,
                waitFor: null,
                log: () => {},
                ...extra,
            });
        // Master's capture: demo--plain is new there, captured twice and stable.
        const master = tempDir("vr-master-");
        const masterResults = await run(master, { stories: ["demo--plain"] });
        writeFileSync(join(master, "results.json"), JSON.stringify({ ...masterResults, runId: 77 }));

        const prOut = tempDir("vr-out-");
        const pr = await run(prOut, { reference: master, stories: ["demo--plain"] });
        expect(pr.reference).toBe(77);
        expect(pr.items.map((i) => [i.file, i.status])).toEqual([["demo--plain.png", "unseeded"]]);

        // A reference whose item is already unseeded serves as well as a new one, so the status
        // does not alternate between master runs.
        writeFileSync(join(prOut, "results.json"), JSON.stringify({ ...pr, runId: 78 }));
        const next = await run(tempDir("vr-out-"), { reference: prOut, stories: ["demo--plain"] });
        expect(next.reference).toBe(78);
        expect(next.items.map((i) => [i.file, i.status])).toEqual([["demo--plain.png", "unseeded"]]);

        // A reference image that is not what master's results.json names is ignored: new.
        writeFileSync(join(master, "demo--plain.png"), "tampered");
        const tampered = await run(tempDir("vr-out-"), {
            reference: master,
            stories: ["demo--plain"],
        });
        expect(tampered.items[0].status).toBe("new");
    });

    it("shoots a changed story once when it is byte for byte master's capture of a changed story", async () => {
        expect(needsSecondShot("new", "a", "a")).toBe(true);
        expect(needsSecondShot("changed", "a", undefined)).toBe(true);
        expect(needsSecondShot("changed", "a", "b")).toBe(true);
        expect(needsSecondShot("changed", "a", "a")).toBe(false);
        expect(needsSecondShot("unchanged", "a", undefined)).toBe(false);

        const sb = storybook();
        const baselines = tempDir("vr-bl-");
        const run = (out, extra) =>
            capture({
                project: "demo",
                storybook: sb,
                baselines,
                out,
                workers: 1,
                waitFor: null,
                log: () => {},
                ...extra,
            });
        // demo--plain's baseline is demo--small's picture, so it is changed here and on master.
        const small = tempDir("vr-out-");
        await run(small, { stories: ["demo--small"] });
        copyFileSync(join(small, "demo--small.png"), join(baselines, "demo--plain.png"));
        const master = tempDir("vr-master-");
        const masterResults = await run(master, { stories: ["demo--plain"] });
        expect(masterResults.items[0].status).toBe("changed");
        writeFileSync(join(master, "results.json"), JSON.stringify({ ...masterResults, runId: 77 }));

        const pr = await run(tempDir("vr-out-"), { reference: master, stories: ["demo--plain"] });
        expect(pr.items.map((i) => [i.file, i.status, i.capture])).toEqual([
            ["demo--plain.png", "changed", masterResults.items[0].capture],
        ]);
    });

    it("compares a renamed story with its old id's baseline and reports a broken rename", async () => {
        const sb = storybook();
        const seedOut = tempDir("vr-out-");
        const run = (out, baselines) =>
            capture({ project: "demo", storybook: sb, baselines, out, workers: 2, waitFor: null, log: () => {} });
        // The seed needs only the two pictures copied below: capturing every story here doubled
        // this test's time on a loaded runner (#3768).
        await capture({
            project: "demo",
            storybook: sb,
            baselines: tempDir("vr-bl-"),
            out: seedOut,
            workers: 2,
            waitFor: null,
            log: () => {},
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
        const r = await run(out, baselines);
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
            capture({
                project: "demo",
                storybook: storybook(),
                baselines,
                out: tempDir("vr-out-"),
                workers: 1,
                waitFor: null,
                log: () => {},
            }),
        ).rejects.toThrow(/renames.json: entry 0 must be/);
    });

    it("captures the whole canvas at scale 2, never cropped to the content", async () => {
        // The four stories in one capture: one browser, as a project's run has.
        const out = tempDir("vr-out-");
        const r = await capture({
            project: "demo",
            storybook: storybook(),
            baselines: tempDir("vr-bl-"),
            out,
            workers: 1,
            waitFor: null,
            stories: ["demo--small", "demo--plain", "demo--tall", "demo--late-font"],
            log: () => {},
        });
        const items = byFile(r);
        // A small component sits in the full 1200 x 900 viewport, doubled.
        expect(items["demo--small.png"].size).toEqual([1200 * 2, 900 * 2]);
        expect(items["demo--plain.png"].size).toEqual([1200 * 2, 900 * 2]);
        // A story taller than the viewport is captured to its full scroll height.
        expect(items["demo--tall.png"].size).toEqual([1200 * 2, 1000 * 2]);
        // The capture waits for the page's fonts: the box drawn at (400, 300) when they settle is in it.
        const png = PNG.sync.read(readFileSync(join(out, "demo--late-font.png")));
        const at = (405 * 2 + 305 * 2 * png.width) * 4;
        expect([...png.data.subarray(at, at + 3)]).toEqual([255, 0, 0]);
    });

    it("gives the story's frame the focus, so a control its play function focused shows it", async () => {
        const out = tempDir("vr-out-");
        await capture({
            project: "demo",
            storybook: storybook(["demo--focus"]),
            baselines: tempDir("vr-bl-"),
            out,
            workers: 1,
            waitFor: null,
            log: () => {},
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
            await capture({
                project: "demo",
                storybook: storybook(),
                baselines: tempDir("vr-bl-"),
                out: tempDir("vr-out-"),
                workers: 2,
                waitFor: null,
                stories: ["demo--plain"],
                log: () => {},
            });
            expect(launch).toHaveBeenCalledTimes(2);
            for (const [options] of launch.mock.calls) {
                expect(options.args).toContain("--disable-gpu-rasterization");
            }
        } finally {
            launch.mockRestore();
        }
    });

    it("renders the whole page at the capture scale, not only while a screenshot is taken", async () => {
        expect(CHROMIUM_ARGS).toContain("--force-device-scale-factor=2");
        // No deviceScaleFactor on the context: the browser itself must render at 2x, so its layers
        // are never rasterized at 1x between shots (#4374).
        const browser = await chromium.launch({ args: CHROMIUM_ARGS });
        try {
            // viewport: null, so Playwright emulates no scale: what is measured is the browser's own.
            const page = await browser.newPage({ viewport: null });
            await page.setContent('<body style="margin:0"><div style="height:100px"></div></body>');
            // A screenshot before the page's first frame fails in Chromium.
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            expect(await page.evaluate(() => globalThis.devicePixelRatio)).toBe(2);
            const shot = PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 100 } }));
            expect([shot.width, shot.height]).toEqual([200, 200]);
        } finally {
            await browser.close();
        }
    });

    it("fails with a clear message when a baseline is a Git LFS pointer", async () => {
        const baselines = tempDir("vr-bl-");
        writeFileSync(
            join(baselines, "demo--plain.png"),
            `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 9\n`,
        );
        await expect(
            capture({
                project: "demo",
                storybook: storybook(),
                baselines,
                out: tempDir("vr-out-"),
                workers: 1,
                waitFor: null,
                stories: ["demo--plain"],
                log: () => {},
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
        // the viewport, so these 150 rows keep their loaded 20.5 CSS px (laid out at the forced 2x),
        // 3,085 CSS px in all, and the image ends on the red block.
        const rows = Array.from(
            { length: 150 },
            (_, i) => `<div style="padding:4px 6px;font:11px monospace">${i}</div>`,
        );
        const html = `<body style="margin:0">${rows.join("")}<div style="height:10px;background:rgb(200,0,0)"></div></body>`;
        await withPage(html, async (page) => {
            const png = PNG.sync.read(await screenshotWholePage(page));
            const height = await page.evaluate(() => document.documentElement.scrollHeight);
            expect(height).toBe(150 * 20.5 + 10);
            expect([png.width, png.height]).toEqual([200, height * 2]);
            expect(redAt(png, png.height - 1)).toBe(200);
            expect(redAt(png, png.height - 20)).toBe(200);
            expect(redAt(png, png.height - 21)).toBe(255);
        });
    });

    it("keeps the page's loaded height beyond the limit: the label stays 20.5 px", async () => {
        // The label is 20.5 CSS px on load at the forced 2x and stays so (#1976, #1982): the page is
        // 4,220.5 CSS px, 8,441 device rows, in an image of the measured 4,221 CSS px.
        // ponytail: the window scrolls only to whole CSS px (scrollHeight 4,220), so the page's last
        // device row is never on screen and stays transparent, as rows the frame never scrolls to do.
        const label = `<div style="padding:4px 6px;font:600 11px ui-monospace, monospace">ak</div>`;
        await withPage(`<!doctype html>${bands(42).replace('<body style="margin:0">', `$&${label}`)}`, async (page) => {
            const png = PNG.sync.read(await screenshotWholePage(page));
            expect([png.width, png.height]).toEqual([200, 8442]);
            // The label 41 device rows tall, the bands below it, and the last band down to the last
            // row the window scrolls to.
            expect(redAt(png, 42)).toBe(0);
            expect(redAt(png, 8439)).toBe(41 * 5);
        });
    });

    it("keeps the pinned monospace font on a page taller than the viewport", async () => {
        // Chromium's capture beyond the viewport re-resolved the generic `monospace` from the pinned
        // fontconfig's DejaVu Sans Mono to Liberation Mono (#3472). The pinned configuration, read
        // over the host's /usr/share/fonts: visual-fonts/fonts/ is Git LFS, absent in a test checkout,
        // and is a snapshot of the CI runner's /usr/share/fonts.
        const fontsDir = join(import.meta.dirname, "../../visual-fonts");
        const cache = mkdtempSync(join(tmpdir(), "visual-review-fonts-"));
        const conf = join(cache, "fonts.conf");
        writeFileSync(
            conf,
            readFileSync(join(fontsDir, "fonts.conf"), "utf8")
                .replace('<dir prefix="relative">fonts</dir>', "<dir>/usr/share/fonts</dir>")
                .replace('prefix="relative">conf.d<', `>${join(fontsDir, "conf.d")}<`),
        );
        const env = { ...process.env, FONTCONFIG_FILE: conf, XDG_CACHE_HOME: cache };
        const pinned = await chromium.launch({ args: CHROMIUM_ARGS, env });
        try {
            const context = await pinned.newContext({ viewport: { width: 100, height: 900 }, deviceScaleFactor: 2 });
            const page = await context.newPage();
            await page.setContent(
                `<!doctype html><body style="margin:0"><pre style="font:13px monospace">ak</pre>${bands(20).slice(24)}`,
            );
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            await screenshotWholePage(page);
            const cdp = await context.newCDPSession(page);
            await cdp.send("DOM.enable");
            await cdp.send("CSS.enable");
            const { root } = await cdp.send("DOM.getDocument");
            const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "pre" });
            const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
            expect(fonts.map((f) => f.familyName)).toEqual(["DejaVu Sans Mono"]);
        } finally {
            await pinned.close();
        }
    });
});
