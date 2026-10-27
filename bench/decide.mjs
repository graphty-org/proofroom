// Measures Accept on the new review page in headless Chromium, at 5, 300 and 3,000 changed
// snapshots of 1200 x 900: from the A key press to the next undecided snapshot drawn (the
// "viewer-drawn" mark the page records), once that snapshot's diff was worked out ahead, with the
// diffs each press waited for on the main thread. Not published, not run in CI.
//
// Usage: node bench/decide.mjs [presses=10]

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { chromium } from "playwright";

import { listAnswer, project, rowsAnswer, target } from "../test/next/fixtures.mjs";

const presses = Number(process.argv[2] ?? "10");
const ROOT = fileURLToPath(new URL("../trusted/", import.meta.url));
const TYPES = { html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css" };
// The page's files as the review server serves them; the API is answered by the browser's routes.
const FILES = { "/spot.js": "page/spot.js", "/pixelmatch.mjs": "vendor/pixelmatch.mjs" };
const fileOf = (path) => {
    if (FILES[path]) {
        return FILES[path];
    }
    if (path.startsWith("/viewer/")) {
        return `page${path}`;
    }
    const name = path.replace(/^\/next\/?/, "") || "index.html";
    return `page/next/${name}`;
};
const server = createServer(async (req, res) => {
    const file = fileOf(new URL(req.url, "http://x").pathname);
    try {
        const body = await readFile(join(ROOT, file));
        res.writeHead(200, { "content-type": TYPES[file.split(".").pop()] ?? "text/plain" }).end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// A story-sized pair: the new image differs from the baseline in a few areas.
const W = 1200;
const H = 900;
function picture(changed) {
    const png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) {
        const x = i % W;
        const y = Math.floor(i / W);
        const v = (x * 7 + y * 3) % 256;
        png.data.set([v, 255 - v, (x ^ y) & 255, 255], i * 4);
    }
    if (changed) {
        for (const [x0, y0] of [
            [100, 100],
            [700, 500],
            [1000, 120],
        ]) {
            for (let y = y0; y < y0 + 60; y++) {
                for (let x = x0; x < x0 + 90; x++) {
                    png.data.set([220, 30, 30, 255], (y * W + x) * 4);
                }
            }
        }
    }
    return PNG.sync.write(png);
}
const BASELINE = picture(false);
const CAPTURE = picture(true);

process.env.FC_FONTATIONS = "1";
const browser = await chromium.launch();
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

console.log("Accept to the next snapshot drawn, prefetched, 1200 x 900 images:");
for (const n of [5, 300, 3000]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const list = listAnswer([
        target(9000, { projects: [project("graphty-element", { reviewable: n })] }),
        target(9001),
    ]);
    const rows = rowsAnswer("graphty-element", n, () => "changed");
    await page.route("**/api/session", (route) => route.fulfill({ json: { had: true } }));
    await page.route("**/api/usage-setting", (route) => route.fulfill({ json: { on: false } }));
    await page.route("**/api/prs*", (route) => route.fulfill({ json: list }));
    await page.route("**/api/pr/**", (route) => route.fulfill({ json: rows }));
    await page.route("**/api/pic/**", (route) => route.fulfill({ status: 404 }));
    await page.route("**/api/decide", (route) => route.fulfill({ json: { ok: true, unpublished: 0 } }));
    await page.route("**/api/blob/**", (route) =>
        route.fulfill({
            status: 200,
            contentType: "image/png",
            body: route.request().url().split("/").pop().startsWith("b") ? CAPTURE : BASELINE,
        }),
    );
    const counts = () => page.evaluate('import("/viewer/stage.js").then((m) => ({ ...m.diffCounts }))');
    // The first snapshot drawn after a time: Accept moves to the next undecided row in list order.
    const drawnAfter = (t) =>
        page.waitForFunction((after) => {
            const m = performance.getEntriesByName("viewer-drawn").find((e) => e.startTime > after);
            return m ? { file: m.detail, at: m.startTime } : null;
        }, t);
    // Ready: the snapshot's images drawn a quarter second ago, and the diffs worked out ahead answered.
    const ready = async (file) => {
        await page.waitForFunction((f) => globalThis.document.getElementById("stage")?.dataset.ready === f, file);
        await page.waitForFunction('import("/viewer/stage.js").then((m) => m.diffCounts.done === m.diffCounts.worker)');
    };
    await page.goto(`${origin}/next/#token=bench&change=9000`);
    let shown = await (await drawnAfter(0)).jsonValue();
    const times = [];
    let waited = 0;
    for (let i = 1; i < Math.min(n, presses + 1); i++) {
        await ready(shown.file);
        const before = (await counts()).waited;
        const t0 = await page.evaluate(() => performance.now());
        await page.keyboard.press("KeyA");
        shown = await (await drawnAfter(t0)).jsonValue();
        times.push(shown.at - t0);
        waited += (await counts()).waited - before;
    }
    console.log(
        `  ${n} snapshots: median ${median(times).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms, ${times.length} presses, ${waited} diffs waited for`,
    );
    await page.close();
}
await browser.close();
server.close();
