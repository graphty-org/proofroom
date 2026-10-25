/**
 * Fakes for the story tests' visual step (story-test.mjs): PNGs, a repository with baselines, the
 * command context of a page whose screenshots are scripted, and the test modules a reporter gets.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

import { CONFIG_FILE } from "../trusted/lib/config.mjs";

import { ROOT, tempDir } from "./helpers.mjs";

/**
 * A solid PNG, as the page's screenshot would return it.
 * @param {number} shade the gray level of every pixel
 * @returns {Buffer} the PNG
 */
export function png(shade) {
    const image = new PNG({ width: 4, height: 4 });
    image.data.fill(shade);
    for (let i = 3; i < image.data.length; i += 4) {
        image.data[i] = 255;
    }
    return PNG.sync.write(image);
}

/**
 * A repository root with this repository's config (no pinned fonts) and graphty-element baselines.
 * @param {Record<string, Buffer>} baselines file name to bytes
 * @returns {string} the root
 */
export function repo(baselines) {
    const root = tempDir("story-test-");
    const config = JSON.parse(readFileSync(join(ROOT, CONFIG_FILE), "utf8"));
    delete config.fontconfig;
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(config));
    const dir = join(root, config.baselines, "graphty-element");
    mkdirSync(dir, { recursive: true });
    for (const [file, bytes] of Object.entries(baselines)) {
        writeFileSync(join(dir, file), bytes);
    }
    return root;
}

/**
 * The command context a Vitest browser command gets, with a page whose every screenshot is the
 * next of `shots`.
 * @param {Buffer[]} shots the screenshots, in order
 * @returns {object} the context
 */
export function context(shots) {
    const frameElement = { evaluate: async () => undefined };
    const frame = {
        evaluate: async (fn) => (fn.toString().includes("scroll") ? { width: 1200, height: 900 } : undefined),
        frameElement: async () => frameElement,
    };
    const page = {
        mouse: { move: async () => undefined },
        setViewportSize: async () => undefined,
        screenshot: async (o) => (o.clip.width === 1 ? png(0) : shots.shift()),
        context: () => ({ browser: () => ({ version: () => "1.0" }) }),
    };
    return { page, frame: async () => frame };
}

/**
 * One test module as a Vitest reporter gets it at the end of a run.
 * @param {object} project the Vitest project it belongs to
 * @param {string} moduleId its absolute path
 * @param {string[]} ids the story ids whose tests ran in it
 * @param {boolean} broken whether it failed to load (a collection error)
 * @returns {object} the module
 */
const testModule = (project, moduleId, ids, broken) => ({
    project,
    moduleId,
    state: () => (broken ? "failed" : "passed"),
    errors: () => (broken ? [{ message: "SyntaxError" }] : []),
    children: {
        allTests: () => ids.map((storyId) => ({ meta: () => ({ storyId }), result: () => ({ state: "passed" }) })),
    },
});

/**
 * Runs the harness's reporter as Vitest would at the end of a run of its story project.
 * @param {object} v what visualStoryTest returned
 * @param {string} root the repository root
 * @param {object} run the shard (`shard`), every story file of the project (`files`), the story
 *     ids that ran per file (`ran`) and the files that failed to load (`broken`)
 * @returns {Promise<void>} once the partial is written
 */
export async function report(v, root, run) {
    const { shard = { index: 1, count: 1 }, files = [], ran = {}, broken = [] } = run;
    const project = {
        config: { browser: { commands: v.commands } },
        globTestFiles: async () => ({ testFiles: files.map((f) => join(root, f)) }),
    };
    const other = { config: {}, globTestFiles: async () => ({ testFiles: [join(root, "other.test.ts")] }) };
    v.reporter.onInit({ config: { shard }, projects: [project, other] });
    const modules = Object.entries(ran).map(([f, ids]) => testModule(project, join(root, f), ids, broken.includes(f)));
    await v.reporter.onTestRunEnd([...modules, testModule(other, join(root, "other.test.ts"), [], false)]);
}

export const read = (dir) => JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
