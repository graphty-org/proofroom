import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    fileName,
    hasBaselines,
    hasEmojiFont,
    loadSettings,
    pinnedFonts,
    serve,
    storyIds,
    storySettings,
    storyUrl,
} from "../capture/capture.mjs";

describe("storyUrl", () => {
    it("opens the story alone with the chromatic flag", () => {
        expect(storyUrl("button--primary", null)).toBe("iframe.html?id=button--primary&viewMode=story&chromatic=true");
    });

    it("adds a mode's globals", () => {
        expect(storyUrl("button--primary", { theme: "dark" })).toBe(
            "iframe.html?id=button--primary&viewMode=story&chromatic=true&globals=theme:dark",
        );
        expect(storyUrl("a--b", { theme: "light", direction: "rtl" })).toBe(
            "iframe.html?id=a--b&viewMode=story&chromatic=true&globals=theme:light;direction:rtl",
        );
    });
});

describe("storyIds", () => {
    it("keeps stories, drops docs entries, and sorts", () => {
        const index = {
            v: 5,
            entries: {
                "b--two": { id: "b--two", type: "story" },
                "b--docs": { id: "b--docs", type: "docs" },
                "a--one": { id: "a--one", type: "story" },
            },
        };
        expect(storyIds(index)).toEqual(["a--one", "b--two"]);
    });
});

describe("fileName", () => {
    it("is <id>.png without a mode and <id>.<mode>.png with one", () => {
        expect(fileName("a--one", null)).toBe("a--one.png");
        expect(fileName("a--one", "dark")).toBe("a--one.dark.png");
    });
});

describe("storySettings", () => {
    it("defaults with no chromatic parameters", () => {
        expect(storySettings({}, null)).toEqual({
            disableSnapshot: false,
            excludedByStory: false,
            reason: null,
            delay: 0,
            threshold: 0.063,
            includeAA: false,
            modes: [{ name: null, globals: null }],
        });
    });

    it("reads disableSnapshot, delay, diffThreshold, diffIncludeAntiAliasing and modes", () => {
        const s = storySettings(
            {
                chromatic: {
                    disableSnapshot: true,
                    delay: 500,
                    diffThreshold: 0.25,
                    diffIncludeAntiAliasing: true,
                    modes: { light: { theme: "light" }, dark: { theme: "dark" }, rtl: { disable: true } },
                },
            },
            null,
        );
        expect(s).toEqual({
            disableSnapshot: true,
            excludedByStory: true,
            reason: "disableSnapshot in the story's parameters",
            delay: 500,
            threshold: 0.25,
            includeAA: true,
            modes: [
                { name: "light", globals: { theme: "light" } },
                { name: "dark", globals: { theme: "dark" } },
            ],
        });
    });

    it("lets the settings file override the parameters", () => {
        const s = storySettings(
            { chromatic: { delay: 500, diffThreshold: 0.25, modes: { light: { theme: "light" } } } },
            { disableSnapshot: true, reason: "unstable seed", delay: 0, diffThreshold: 0.1, modes: {} },
        );
        expect(s).toEqual({
            disableSnapshot: true,
            excludedByStory: false,
            reason: "unstable seed",
            delay: 0,
            threshold: 0.1,
            includeAA: false,
            modes: [{ name: null, globals: null }],
        });
    });
});

describe("baselines directory", () => {
    let dir;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "capture-test-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("is seeded only when it holds a baseline PNG", async () => {
        expect(await hasBaselines(join(dir, "missing"))).toBe(false);
        await writeFile(join(dir, "a--one.json"), "{}");
        expect(await hasBaselines(dir)).toBe(false);
        await writeFile(join(dir, "a--one.png"), "");
        expect(await hasBaselines(dir)).toBe(true);
    });

    it("loads a story's settings file, or null", async () => {
        expect(await loadSettings(dir, "a--one")).toBeNull();
        await writeFile(join(dir, "a--one.json"), JSON.stringify({ delay: 100 }));
        expect(await loadSettings(dir, "a--one")).toEqual({ delay: 100 });
    });
});

describe("serve", () => {
    let dir;
    let server;
    let base;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "serve-"));
        await writeFile(join(dir, "index.html"), "<p>home</p>");
        await writeFile(join(dir, "iframe.html"), "<p>story</p>");
        [server, base] = await serve(dir);
    });

    afterEach(async () => {
        server.close();
        await rm(dir, { recursive: true, force: true });
    });

    it("serves a file with its type, and the index at the root", async () => {
        expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        const story = await fetch(`${base}iframe.html?id=a--b`);
        expect(story.status).toBe(200);
        expect(story.headers.get("content-type")).toBe("text/html");
        expect(await story.text()).toBe("<p>story</p>");
        expect(await (await fetch(base)).text()).toBe("<p>home</p>");
    });

    it("answers 404 for a missing file and does not climb out of the directory", async () => {
        expect((await fetch(`${base}missing.js`)).status).toBe(404);
        expect((await fetch(`${base}..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    });
});

describe("pinnedFonts", () => {
    let dir;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "vr-fonts-"));
        await mkdir(join(dir, "fonts"));
        await writeFile(
            join(dir, "fonts.conf"),
            '<?xml version="1.0"?><fontconfig><dir prefix="relative">fonts</dir></fontconfig>',
        );
        await writeFile(join(dir, "fonts", "a.ttf"), "not really a font");
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("fingerprints every file beside the fonts.conf, and the fingerprint follows their content", async () => {
        const first = await pinnedFonts(join(dir, "fonts.conf"));
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(await pinnedFonts(join(dir, "fonts.conf"))).toBe(first);
        await writeFile(join(dir, "fonts", "a.ttf"), "another font");
        expect(await pinnedFonts(join(dir, "fonts.conf"))).not.toBe(first);
    });

    it("refuses a font that is still a Git LFS pointer, and a missing fonts.conf", async () => {
        await writeFile(join(dir, "fonts", "b.ttf"), "version https://git-lfs.github.com/spec/v1\noid sha256:00\n");
        await expect(pinnedFonts(join(dir, "fonts.conf"))).rejects.toThrow(
            /fonts\/b\.ttf .* Git LFS pointer.*git lfs pull/,
        );
        await expect(pinnedFonts(join(dir, "missing.conf"))).rejects.toThrow(/does not exist/);
    });

    it("asks the pinned configuration, not the machine, whether a font draws emoji", () => {
        // This directory has no font at all, so whatever the machine has, the answer is no.
        expect(hasEmojiFont({ ...process.env, FONTCONFIG_FILE: join(dir, "fonts.conf") })).toBe(false);
    });
});
