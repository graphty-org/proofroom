/**
 * The story source: a built Storybook. `build()` runs the project's build command, `stories()`
 * lists the story ids in its index.json, `url()` is one story's iframe URL, and `serve()` serves
 * the built directory on 127.0.0.1 for the renderer to open. `preview` and `rendered` are what
 * the renderer runs in Storybook's pages: how to read every story's parameters, and how to tell
 * that a story has drawn.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";

/* global document -- read only inside the page */

/**
 * The iframe URL of one story, relative to the Storybook root. `chromatic=true` makes
 * `isChromatic()` true inside the stories.
 * @param {string} id the story id
 * @param {Record<string, string> | null} globals the mode's Storybook globals
 * @returns {string} the relative URL
 */
export function storyUrl(id, globals) {
    const url = `iframe.html?id=${encodeURIComponent(id)}&viewMode=story&chromatic=true`;
    if (!globals) {
        return url;
    }
    return `${url}&globals=${Object.entries(globals)
        .map(([k, v]) => `${k}:${v}`)
        .join(";")}`;
}

/**
 * The story ids in a Storybook index.json, docs entries left out.
 * @param {{ entries: Record<string, { id: string, type: string }> }} index the parsed index.json
 * @returns {string[]} the ids, sorted
 */
export const storyIds = (index) =>
    Object.values(index.entries)
        .filter((e) => e.type === "story")
        .map((e) => e.id)
        .sort();

const TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".map": "application/json",
    ".wasm": "application/wasm",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".ico": "image/x-icon",
};

/**
 * Serves a directory on 127.0.0.1 at a port the OS picks.
 * @param {string} dir the directory to serve
 * @returns {Promise<[import("node:http").Server, string]>} the server and its base URL
 */
export function serve(dir) {
    const server = createServer(async (req, res) => {
        try {
            let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
            if (p === "/") {
                p = "/index.html";
            }
            const f = join(dir, p);
            if ((await stat(f)).isDirectory()) {
                throw new Error("directory");
            }
            res.writeHead(200, { "Content-Type": TYPES[extname(f)] ?? "application/octet-stream" });
            res.end(await readFile(f));
        } catch {
            res.writeHead(404);
            res.end("not found");
        }
    });
    return new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r([server, `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}/`]),
        ),
    );
}

/**
 * Builds a project's Storybook with the config's `build` command, run by the shell in `cwd`.
 * @param {string | null} command the project's `build` setting; null builds nothing
 * @param {string} cwd the repository
 * @returns {Promise<void>} once it is built; rejects with the command's stderr when it fails
 */
export async function build(command, cwd) {
    if (command) {
        await promisify(execFile)("sh", ["-c", command], { cwd, maxBuffer: 64 << 20 });
    }
}

/**
 * The story ids of a built Storybook, from its index.json.
 * @param {string} dir the built Storybook
 * @returns {Promise<string[]>} the ids, sorted
 */
export const stories = async (dir) => storyIds(JSON.parse(await readFile(join(dir, "index.json"), "utf8")));

/**
 * One story's full iframe URL.
 * @param {string} base the served Storybook's base URL
 * @param {string} id the story id
 * @param {Record<string, string> | null} globals the mode's Storybook globals
 * @returns {string} the URL
 */
export const url = (base, id, globals) => base + storyUrl(id, globals);

/**
 * Storybook's preview page, for the renderer's probe: the page, whether it has loaded its stories,
 * and every story's `parameters.chromatic` (through JSON, so functions and class instances never
 * cross into Node).
 */
export const preview = Object.freeze({
    url: (base) => `${base}iframe.html`,
    ready: () => /** @type {any} */ (globalThis).__STORYBOOK_PREVIEW__?.storyStoreValue,
    read: async () => {
        const all = await /** @type {any} */ (globalThis).__STORYBOOK_PREVIEW__.extract();
        const params = {};
        for (const [id, story] of Object.entries(all)) {
            params[id] = {
                chromatic: JSON.parse(JSON.stringify(/** @type {any} */ (story).parameters?.chromatic ?? {})),
            };
        }
        return params;
    },
});

/**
 * How the renderer tells, in a story's page, that Storybook drew it: `phase` is false until the
 * render ended, then how it ended ("errored" while Storybook's error screen shows); `failed` are
 * the endings that fail the story; `error` reads the error screen's message and stack (a play
 * function's failed expect included).
 */
export const rendered = Object.freeze({
    phase: () => {
        if (document.body.classList.contains("sb-show-errordisplay")) {
            return "errored";
        }
        const p = /** @type {any} */ (globalThis).__STORYBOOK_PREVIEW__?.currentRender?.phase;
        return ["completed", "afterEach", "finished", "errored", "aborted"].includes(p) && p;
    },
    failed: ["errored", "aborted"],
    error: () => ["error-message", "error-stack"].map((id) => document.getElementById(id)?.textContent?.trim() ?? ""),
});
