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
 * @param {number} [width] in px
 * @param {number} [height] in px
 * @returns {Buffer} the PNG
 */
export function png(shade, width = 4, height = 4) {
    const image = new PNG({ width, height });
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
 * @param {{ width: number, height: number }} [size] the story's size, in CSS px, as the page measures it
 * @returns {object} the context; its `viewports` lists every viewport the page was given, and its
 *     `styles` the style properties set on the tester iframe
 */
export function context(shots, size = { width: 1200, height: 900 }) {
    // The tester iframe: runs what the harness evaluates on it, and records the style it is given.
    const styles = {};
    const frameElement = {
        style: { setProperty: (name, value) => (styles[name] = value) },
        evaluate: async (fn) => fn(frameElement),
        focus: async () => undefined,
    };
    const frame = {
        // scrollTo goes no further than the document's size allows; measuring reads scroll sizes.
        evaluate: async (fn, arg) => {
            const text = fn.toString();
            if (text.includes("scrollTo")) {
                return { x: Math.min(arg[0], size.width - 1200), y: Math.min(arg[1], size.height - 900) };
            }
            return text.includes("scroll") ? size : undefined;
        },
        frameElement: async () => frameElement,
    };
    const viewports = [];
    const page = {
        mouse: { move: async () => undefined },
        setViewportSize: async (v) => {
            viewports.push(v);
        },
        screenshot: async (o) => (o.clip.width === 1 ? png(0) : shots.shift()),
        context: () => ({
            browser: () => ({ version: () => "1.0" }),
            // A page that shows an image and shoots it back unchanged, as Chromium does at 1:1.
            newPage: async () => {
                let shown = null;
                return {
                    setViewportSize: async () => undefined,
                    setContent: async (html) => {
                        shown = Buffer.from(/base64,([^"]+)/.exec(html)[1], "base64");
                    },
                    evaluate: async () => undefined,
                    screenshot: async () => shown,
                    close: async () => undefined,
                };
            },
        }),
    };
    return { page, frame: async () => frame, viewports, styles };
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
    state: () => (broken ? "failed" : ids.length > 0 ? "passed" : "skipped"),
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
