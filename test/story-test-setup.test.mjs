/*
 * The browser side of the vitest adapter (story-test-setup.mjs), installed with stand-in hooks
 * and a stand-in page, and driven through the adapter's real Node commands: whether a story test
 * fails, and how often a story is rendered again for its retries.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installVisualStoryTest } from "../capture/story-test-setup.mjs";
import { visualStoryTest } from "../capture/story-test.mjs";
import { parseResultLines } from "../trusted/lib/result-line.mjs";

import { tempDir } from "./helpers.mjs";
import { context, png, repo } from "./story-test-fakes.mjs";

const PROJECT = "graphty-element";
const saved = { console: { ...console } };

afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(console, saved.console);
    for (const m of ["getEntries", "getEntriesByType", "getEntriesByName"]) {
        delete performance[m];
    }
});

/** The page globals the browser side touches, as small stand-ins. */
function stubPage() {
    const classList = { add: () => undefined, remove: () => undefined };
    vi.stubGlobal("document", {
        documentElement: {},
        body: { classList },
        head: { append: () => undefined },
        createElement: () => ({}),
        fonts: { ready: Promise.resolve() },
        querySelectorAll: () => [],
        getElementById: () => null,
    });
    vi.stubGlobal("location", { href: "http://localhost/iframe.html" });
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    vi.stubGlobal("localStorage", { clear: () => undefined });
    vi.stubGlobal("sessionStorage", { clear: () => undefined });
    vi.stubGlobal("indexedDB", { databases: async () => [] });
    vi.stubGlobal("requestAnimationFrame", (cb) => queueMicrotask(cb));
    vi.stubGlobal("addEventListener", () => undefined);
    vi.stubGlobal("globalProjectAnnotations", {});
}

/**
 * Installs the browser side over the adapter's commands, then runs one story test's hooks.
 * @param {object} options the adapter's options (`fail`, `retries`)
 * @param {Buffer[]} shots the screenshots the page returns, in order
 * @returns {Promise<{ error: unknown, renders: number, lines: object[] }>} what the story test's
 *     afterEach hooks threw (null when nothing), how often the story was rendered again, and the
 *     result lines written
 */
async function storyTest(options, shots) {
    stubPage();
    const out = tempDir("story-setup-out-");
    const root = repo({ "a--moves.png": png(10) });
    const v = visualStoryTest({ project: PROJECT, out, root, ...options });
    const ctx = context([...shots]);
    const commands = {
        visualHead: async () => "",
        visualPark: async () => undefined,
        visualPlan: (a) => v.commands.visualPlan(ctx, a),
        visualShot: (a) => v.commands.visualShot(ctx, a),
        visualFail: (a) => v.commands.visualFail(ctx, a),
    };
    const hooks = { after: [] };
    installVisualStoryTest({
        beforeEach: (fn) => (hooks.before = fn),
        afterEach: (fn) => hooks.after.push(fn),
        commands,
    });
    let renders = 0;
    const story = { id: "a--moves", parameters: {}, globals: {}, run: async () => renders++ };
    await hooks.before();
    let error = null;
    try {
        // As Vitest runs them (sequence.hooks "stack"): the last registered first, until one throws.
        for (const after of hooks.after.toReversed()) {
            await after({ story, task: { result: { state: "pass" } } });
        }
    } catch (err) {
        error = err;
    }
    const lines = readdirSync(out)
        .filter((f) => /^results-.*\.ndjson$/.test(f))
        .flatMap((f) => parseResultLines(readFileSync(join(out, f), "utf8")));
    return { error, renders, lines };
}

describe("the browser side of story tests", () => {
    it('fails a changed story\'s test with fail: "differences"', async () => {
        const { error, renders, lines } = await storyTest({}, [png(200)]);
        expect(error?.message).toBe(`proofroom: ${PROJECT}/a--moves: changed: 16 pixels differ`);
        expect(renders).toBe(0);
        expect(lines.map((l) => [l.status, l.attempt])).toEqual([["changed", 1]]);
    });

    it('passes a changed story\'s test with fail: "errors", which still records it', async () => {
        const { error, lines } = await storyTest({ fail: "errors" }, [png(200)]);
        expect(error).toBeNull();
        expect(lines.map((l) => [l.status, l.attempt])).toEqual([["changed", 1]]);
    });

    it("renders the story again once per retry, each shot one attempt", async () => {
        const flip = await storyTest({ fail: "errors", retries: 1 }, [png(200), png(10)]);
        expect([flip.error, flip.renders]).toEqual([null, 1]);
        expect(flip.lines.map((l) => [l.status, l.attempt])).toEqual([
            ["changed", 1],
            ["unchanged", 2],
        ]);
        const moves = await storyTest({ retries: 2 }, [png(200), png(200), png(200)]);
        expect(moves.renders).toBe(2);
        expect(moves.error?.message).toMatch(/changed: 16 pixels differ/);
        expect(moves.lines.map((l) => l.attempt)).toEqual([1, 2, 3]);
    });
});
