// Measures the new review page's viewer in headless Chromium on 40 changed snapshots of 1200 x 900:
// a cold open (a click on a row whose diff was not worked out ahead, to its images drawn: the
// "viewer-drawn" mark the page records) and Right to the next snapshot once its diff was worked
// out ahead, with the diffs each one waited for. Not published, not run in CI.
//
// Usage: node bench/viewer.mjs [presses=20]

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { chromium } from "playwright";

import { listAnswer, project, rowsAnswer, target } from "../test/next/fixtures.mjs";

const presses = Number(process.argv[2] ?? "20");
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const list = listAnswer([
    target(9000, { projects: [project("graphty-element", { reviewable: 40 })] }),
    target(9001),
]);
const rows = rowsAnswer("graphty-element", 40, () => "changed");
await page.route("**/api/session", (route) => route.fulfill({ json: { had: true } }));
await page.route("**/api/usage-setting", (route) => route.fulfill({ json: { on: false } }));
await page.route("**/api/prs*", (route) => route.fulfill({ json: list }));
await page.route("**/api/pr/**", (route) => route.fulfill({ json: rows }));
await page.route("**/api/pic/**", (route) => route.fulfill({ status: 404 }));
await page.route("**/api/blob/**", (route) =>
    route.fulfill({
        status: 200,
        contentType: "image/png",
        body: route.request().url().split("/").pop().startsWith("b") ? CAPTURE : BASELINE,
    }),
);
const counts = () => page.evaluate('import("/viewer/stage.js").then((m) => ({ ...m.diffCounts }))');
const drawnAt = (file) =>
    page.waitForFunction(
        (f) => performance.getEntriesByName("viewer-drawn").find((m) => m.detail === f)?.startTime ?? null,
        file,
    );
const settled = () =>
    page.waitForFunction(
        'import("/viewer/stage.js").then((m) => m.diffCounts.done === m.diffCounts.worker && m.diffCounts.worker > 0)',
    );
const keyOf = (n) => `graphty-element/${rows.items[n - 1].file}`;

await page.goto(`${origin}/next/#token=bench&change=9000`);
await (await drawnAt(keyOf(1))).jsonValue();
await settled();

// Cold: a row far from the one on screen, so nothing worked it out ahead.
const cold = [];
for (const n of [20, 30, 12]) {
    const before = (await counts()).waited;
    const t0 = await page.evaluate(() => performance.now());
    await page.locator(`.srow[data-snap="${keyOf(n)}"]`).click();
    cold.push((await (await drawnAt(keyOf(n))).jsonValue()) - t0);
    console.log(`  cold open of #${n}: waited for ${(await counts()).waited - before} diff`);
    await settled();
}
// Prefetched: Right, after the worker answered the diffs worked out ahead.
const warm = [];
let waited = 0;
let at = 12;
for (let i = 0; i < presses && at < 40; i++) {
    const before = (await counts()).waited;
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.press("ArrowRight");
    at++;
    warm.push((await (await drawnAt(keyOf(at))).jsonValue()) - t0);
    waited += (await counts()).waited - before;
    await settled();
}
console.log("viewer, 1200 x 900 images:");
console.log(`  cold open to drawn: median ${median(cold).toFixed(1)} ms, max ${Math.max(...cold).toFixed(1)} ms`);
console.log(
    `  Right to drawn, prefetched: median ${median(warm).toFixed(1)} ms, max ${Math.max(...warm).toFixed(1)} ms, ${warm.length} presses, ${waited} diffs waited for`,
);
await browser.close();
server.close();
