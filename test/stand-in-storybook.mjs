/*
 * A stand-in Storybook for the capture tests: a static index.json and an iframe.html whose preview
 * object answers what capture reads from a real one. Every story load is counted by a small server
 * of the test's own (a synchronous request from the page, so it lands before the story renders),
 * and the story demo--wobbly draws whatever that server says, so a test can make it differ on one
 * shot and match on the next.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { CONFIG_FILE } from "../trusted/lib/config.mjs";
import { tempDir } from "./helpers.mjs";

export const PARAMS = {
    "demo--plain": {},
    "demo--excluded-here": { chromatic: { disableSnapshot: true } },
    "demo--always-excluded": { chromatic: { disableSnapshot: true } },
    "demo--broken": {},
    "demo--small": {},
    "demo--late-font": {},
    "demo--tall": {},
    "demo--wobbly": {},
    "demo--focus": {},
};

const iframe = (counter) => `<!doctype html><html><body><script>
const id = new URLSearchParams(location.search).get("id");
let drawn = "settled";
if (id) {
    const x = new XMLHttpRequest();
    x.open("GET", "${counter}load?id=" + id, false);
    x.send();
    drawn = x.responseText;
}
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
} else if (id === "demo--wobbly") {
    // A box whose place the counting server decides: "settled" or "wobble".
    const left = drawn === "wobble" ? 300 : 100;
    document.body.insertAdjacentHTML("beforeend",
        "<div style='position:absolute;left:" + left + "px;top:100px;width:40px;height:40px;background:blue'></div>");
} else {
    document.body.insertAdjacentHTML("beforeend", "<h1 style='font: 40px monospace'>" + (id ?? "preview") +
        (navigator.gpu ? " gpu" : " no-gpu") + "</h1>");
}
window.__STORYBOOK_PREVIEW__ = {
    storyStoreValue: {},
    // demo--play-threw (not in PARAMS, so only a test that names it captures it): a play function that
    // threw, which Storybook ends "finished" with no error screen, its channel keeping the exception event.
    currentRender: { phase: id === "demo--play-threw" ? "finished" : "completed" },
    channel: { last: (type) => id === "demo--play-threw" && type === "playFunctionThrewException"
        ? [{ name: "AssertionError", message: "expected 1 to be 2",
            stack: "AssertionError: expected 1 to be 2\\n    at play (demo.stories.ts:9:3)" }]
        : undefined },
    extract: async () => Object.fromEntries(Object.entries(${JSON.stringify(PARAMS)}).map(([k, v]) => [k, { parameters: v }])),
};
</script></body></html>`;

/**
 * Starts the counting server: it counts each story's loads and tells demo--wobbly what to draw.
 * @returns {Promise<{ url: string, loads: Map<string, number>, wobbles: { left: number },
 *     close: () => void }>} its base URL, the loads by story id, how many of demo--wobbly's next
 *     loads draw "wobble" (each one used up), and a way to stop it
 */
export async function countingServer() {
    const loads = new Map();
    const wobbles = { left: 0 };
    const server = createServer((req, res) => {
        const id = new URL(req.url, "http://x").searchParams.get("id");
        loads.set(id, (loads.get(id) ?? 0) + 1);
        let answer = "settled";
        if (id === "demo--wobbly" && wobbles.left > 0) {
            wobbles.left--;
            answer = "wobble";
        }
        res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
        res.end(answer);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    return { url: `http://127.0.0.1:${port}/`, loads, wobbles, close: () => server.close() };
}

/**
 * Writes the stand-in Storybook.
 * @param {string} counter the counting server's base URL
 * @param {string} [dir] where to write it (default: a new temporary directory)
 * @param {string[]} [ids] the stories its index lists (default: every one)
 * @returns {string} its directory
 */
export function storybook(counter, dir = tempDir("vr-sb-"), ids = Object.keys(PARAMS)) {
    mkdirSync(dir, { recursive: true });
    const entries = Object.fromEntries(ids.map((id) => [id, { id, type: "story" }]));
    entries["demo--docs"] = { id: "demo--docs", type: "docs" };
    writeFileSync(join(dir, "index.json"), JSON.stringify({ entries }));
    writeFileSync(join(dir, "iframe.html"), iframe(counter));
    return dir;
}

/**
 * A git repository whose config has one project, demo, with the stand-in Storybook at
 * storybook-static/ and its baselines at visual-baselines/demo/.
 * @param {string} counter the counting server's base URL
 * @returns {{ repo: string, baselines: string }} the repository and the project's baselines
 */
export function demoRepo(counter) {
    const repo = tempDir("vr-demo-repo-");
    const run = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    writeFileSync(
        join(repo, CONFIG_FILE),
        JSON.stringify({ projects: { demo: { storybook: "storybook-static", workers: 2 } } }, null, 2),
    );
    storybook(counter, join(repo, "storybook-static"));
    run("add", "-A");
    run("-c", "user.name=Owner", "-c", "user.email=owner@example.com", "commit", "-q", "-m", "init");
    const baselines = join(repo, "visual-baselines", "demo");
    mkdirSync(baselines, { recursive: true });
    return { repo, baselines };
}
