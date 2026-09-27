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
};

const IFRAME = `<!doctype html><html><body><script>
const id = new URLSearchParams(location.search).get("id");
if (id === "demo--broken") document.body.classList.add("sb-show-errordisplay");
document.body.insertAdjacentHTML("beforeend", "<h1 style='font: 40px monospace'>" + (id ?? "preview") +
    (navigator.gpu ? " gpu" : " no-gpu") + "</h1>");
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
});
