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
 * @returns {object} the context; its `viewports` lists every viewport the page was given, `clips` every
 *     clip it was shot with (but the 1 px throwaway), and `pages` the HTML of every page it opened
 */
export function context(shots, size = { width: 1200, height: 900 }) {
    const frameElement = { evaluate: async () => undefined, focus: async () => undefined };
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
    const clips = [];
    const pages = [];
    const page = {
        mouse: { move: async () => undefined },
        setViewportSize: async (v) => {
            viewports.push(v);
        },
        viewportSize: () => viewports.at(-1) ?? { width: 1200, height: 900 },
        // The next scripted viewport shot, cut to the clip as Chromium cuts it (at scale 2).
        screenshot: async (o) => {
            if (o.clip.width === 1) {
                return png(0);
            }
            clips.push(o.clip);
            return crop(shots.shift(), o.clip);
        },
        context: () => ({
            browser: () => ({ version: () => "1.0" }),
            // A page that draws its images 1:1 where their styles put them and shoots that, as Chromium
            // does; where no image is, the picture stays empty.
            newPage: async () => {
                let shown = null;
                return {
                    setViewportSize: async () => undefined,
                    setContent: async (html) => {
                        pages.push(html);
                        shown = compose(html);
                    },
                    evaluate: async () => undefined,
                    screenshot: async () => shown,
                    close: async () => undefined,
                };
            },
        }),
    };
    return { page, frame: async () => frame, viewports, clips, pages };
}

/**
 * A screenshot cut to a clip in CSS px, at scale 2.
 * @param {Buffer} shot the whole viewport's PNG
 * @param {{ x: number, y: number, width: number, height: number }} clip in CSS px
 * @returns {Buffer} the PNG of the clip
 */
function crop(shot, clip) {
    const image = PNG.sync.read(shot);
    if (clip.x === 0 && clip.y === 0 && clip.width * 2 >= image.width && clip.height * 2 >= image.height) {
        return shot;
    }
    const out = new PNG({ width: clip.width * 2, height: clip.height * 2 });
    PNG.bitblt(image, out, clip.x * 2, clip.y * 2, out.width, out.height, 0, 0);
    return PNG.sync.write(out);
}

/**
 * The picture a page of positioned images draws, at scale 2: the body's size, each image at its
 * left and top.
 * @param {string} html the page
 * @returns {Buffer} the PNG
 */
function compose(html) {
    const [, width, height] = /body\{[^}]*width:(\d+)px;height:(\d+)px/.exec(html);
    const out = new PNG({ width: Number(width) * 2, height: Number(height) * 2 });
    for (const [, left, top, b64] of html.matchAll(
        /left:(\d+)px;top:(\d+)px[^"]*" src="data:image\/png;base64,([^"]+)"/g,
    )) {
        const tile = PNG.sync.read(Buffer.from(b64, "base64"));
        PNG.bitblt(tile, out, 0, 0, tile.width, tile.height, Number(left) * 2, Number(top) * 2);
    }
    return PNG.sync.write(out);
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
