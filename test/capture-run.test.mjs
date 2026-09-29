/*
 * capture() end to end in Chromium, against a stand-in Storybook: a static index.json and an
 * iframe.html whose preview object answers what capture reads from a real one.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { capture, hasEmojiFont } from "../capture/capture.mjs";

const PARAMS = {
    "demo--plain": {},
    "demo--excluded-here": { chromatic: { disableSnapshot: true } },
    "demo--always-excluded": { chromatic: { disableSnapshot: true } },
    "demo--broken": {},
    "demo--small": {},
    "demo--late-font": {},
    "demo--tall": {},
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
} else if (id === "demo--tall") {
    // A story 2000 px tall, taller than the 900 px viewport.
    document.body.insertAdjacentHTML("beforeend",
        "<div style='position:absolute;left:0;top:0;width:10px;height:2000px;background:red'></div>");
} else {
    document.body.insertAdjacentHTML("beforeend", "<h1 style='font: 40px monospace'>" + (id ?? "preview") +
        (navigator.gpu ? " gpu" : " no-gpu") + "</h1>");
}
window.__STORYBOOK_PREVIEW__ = {
    storyStoreValue: {},
    currentRender: { phase: "completed" },
    extract: async () => Object.fromEntries(Object.entries(${JSON.stringify(PARAMS)}).map(([k, v]) => [k, { parameters: v }])),
};
</script></body></html>`;

function storybook() {
    const dir = mkdtempSync(join(tmpdir(), "vr-sb-"));
    const entries = Object.fromEntries(Object.keys(PARAMS).map((id) => [id, { id, type: "story" }]));
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
        const sb = storybook();
        const baselines = mkdtempSync(join(tmpdir(), "vr-bl-"));
        const run = (out) =>
            capture({ project: "demo", storybook: sb, baselines, out, workers: 2, waitFor: null, log: () => {} });

        const firstOut = mkdtempSync(join(tmpdir(), "vr-out-"));
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

        const second = await run(mkdtempSync(join(tmpdir(), "vr-out-")));
        expect(second.seeded).toBe(true);
        items = byFile(second);
        expect(items["demo--plain.png"].status).toBe("unchanged");
        expect(items["demo--excluded-here.png"]).toMatchObject({
            status: "removed",
            reason: "the story's parameters now set disableSnapshot",
        });
        expect(items["demo--always-excluded.png"].status).toBe("excluded");
        expect(second.expected).toBe(second.items.length);
    }, 120_000);

    it("marks a story with no baseline unseeded when it looks as in master's capture", async () => {
        const sb = storybook();
        const baselines = mkdtempSync(join(tmpdir(), "vr-bl-"));
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
        const master = mkdtempSync(join(tmpdir(), "vr-master-"));
        const masterResults = await run(master, { stories: ["demo--plain"] });
        writeFileSync(join(master, "results.json"), JSON.stringify({ ...masterResults, runId: 77 }));

        const pr = await run(mkdtempSync(join(tmpdir(), "vr-out-")), { reference: master, stories: ["demo--plain"] });
        expect(pr.reference).toBe(77);
        expect(pr.items.map((i) => [i.file, i.status])).toEqual([["demo--plain.png", "unseeded"]]);

        // A reference image that is not what master's results.json names is ignored: new.
        writeFileSync(join(master, "demo--plain.png"), "tampered");
        const tampered = await run(mkdtempSync(join(tmpdir(), "vr-out-")), {
            reference: master,
            stories: ["demo--plain"],
        });
        expect(tampered.items[0].status).toBe("new");
    }, 120_000);

    it("captures the whole canvas at scale 2, never cropped to the content", async () => {
        const sb = storybook();
        const run = async (story) => {
            const out = mkdtempSync(join(tmpdir(), "vr-out-"));
            const r = await capture({
                project: "demo",
                storybook: sb,
                baselines: mkdtempSync(join(tmpdir(), "vr-bl-")),
                out,
                workers: 1,
                waitFor: null,
                stories: [story],
                log: () => {},
            });
            return { size: r.items[0].size, png: PNG.sync.read(readFileSync(join(out, r.items[0].file))) };
        };
        // A small component sits in the full 1200 x 900 viewport, doubled.
        expect((await run("demo--small")).size).toEqual([1200 * 2, 900 * 2]);
        expect((await run("demo--plain")).size).toEqual([1200 * 2, 900 * 2]);
        // A story taller than the viewport is captured to its full scroll height.
        expect((await run("demo--tall")).size).toEqual([1200 * 2, 2000 * 2]);
        // The capture waits for the page's fonts: the box drawn at (400, 300) when they settle is in it.
        const { png } = await run("demo--late-font");
        const at = (405 * 2 + 305 * 2 * png.width) * 4;
        expect([...png.data.subarray(at, at + 3)]).toEqual([255, 0, 0]);
    }, 120_000);

    it("fails with a clear message when a baseline is a Git LFS pointer", async () => {
        const baselines = mkdtempSync(join(tmpdir(), "vr-bl-"));
        writeFileSync(
            join(baselines, "demo--plain.png"),
            `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 9\n`,
        );
        await expect(
            capture({
                project: "demo",
                storybook: storybook(),
                baselines,
                out: mkdtempSync(join(tmpdir(), "vr-out-")),
                workers: 1,
                waitFor: null,
                stories: ["demo--plain"],
                log: () => {},
            }),
        ).rejects.toThrow(/demo--plain.png: baseline is an LFS pointer; run git lfs pull/);
    }, 60_000);
});
