/*
 * capture() end to end in Chromium, against a stand-in Storybook: a static index.json and an
 * iframe.html whose preview object answers what capture reads from a real one.
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { capture } from "../capture/capture.mjs";

const PARAMS = {
    "demo--plain": {},
    "demo--excluded-here": { chromatic: { disableSnapshot: true } },
    "demo--always-excluded": { chromatic: { disableSnapshot: true } },
    "demo--broken": {},
    "demo--small": {},
    "demo--late-font": {},
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
    // A 50 x 20 box at (100, 100), and a 10 x 10 portal-like box at (300, 40) outside it.
    document.body.insertAdjacentHTML("beforeend",
        // A full-width wrapper with nothing of its own to paint does not widen the crop.
        "<div style='position:absolute;left:0;top:0;width:100%;height:600px'>" +
        "<div style='position:absolute;left:100px;top:100px;width:50px;height:20px;background:red'></div></div>" +
        "<div style='position:fixed;left:300px;top:40px;width:10px;height:10px;background:blue'></div>" +
        // Rows clipped by a scroll area do not count past the area's own box.
        "<div style='position:absolute;left:120px;top:60px;width:20px;height:40px;overflow:auto'>" +
        "<div style='height:2000px;background:green'></div></div>");
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
            capture({ project: "demo", storybook: sb, baselines, out, workers: 2, stableFrame: false, log: () => {} });

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
                stableFrame: false,
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

    it("captures at scale 2, cropped to the content plus 32 px, or the full width for a canvas project", async () => {
        const sb = storybook();
        const run = async (canvas, story = "demo--small") => {
            const out = mkdtempSync(join(tmpdir(), "vr-out-"));
            const r = await capture({
                project: "demo",
                storybook: sb,
                baselines: mkdtempSync(join(tmpdir(), "vr-bl-")),
                out,
                workers: 1,
                stableFrame: false,
                canvas,
                stories: [story],
                log: () => {},
            });
            return r.items[0].size;
        };
        // Content spans x 100..310 and y 40..120; with the margin 68..342 and 8..152, doubled.
        expect(await run(false)).toEqual([(342 - 68) * 2, (152 - 8) * 2]);
        // A canvas project keeps the viewport's full width and crops only the height.
        expect(await run(true)).toEqual([1200 * 2, (152 - 8) * 2]);
        // The capture waits for the page's fonts: the box drawn when they settle is in it.
        expect(await run(false, "demo--late-font")).toEqual([(442 - 68) * 2, (342 - 68) * 2]);
        // A block-level heading is cropped to its text, not to the block's full width.
        const [width] = await run(false, "demo--plain");
        expect(width).toBeGreaterThan(200);
        expect(width).toBeLessThan(1200);
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
                stableFrame: false,
                stories: ["demo--plain"],
                log: () => {},
            }),
        ).rejects.toThrow(/demo--plain.png: baseline is an LFS pointer; run git lfs pull/);
    }, 60_000);
});
