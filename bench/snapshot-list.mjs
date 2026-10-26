// Measures the new review page's snapshot list in headless Chromium at 300 and 3,000 snapshots:
// how long the list takes from the start of its build to its first frame (the
// "snapshot-list-frame" measure the page records), how long a jump to the last row takes to scroll
// and lay out, and how many pictures the first screen asks for. Not published, not run in CI.
//
// Usage: node bench/snapshot-list.mjs [loads=10]

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { chromium } from "playwright";

import { listAnswer, project, rowsAnswer, target } from "../test/next/fixtures.mjs";

const loads = Number(process.argv[2] ?? "10");
const PAGE = fileURLToPath(new URL("../trusted/page/next/", import.meta.url));
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css" };
const picture = (() => {
    const png = new PNG({ width: 400, height: 156 });
    png.data.fill(160);
    return PNG.sync.write(png);
})();

// The page's own files; the API is answered by the browser's routes below.
const server = createServer(async (req, res) => {
    const name = new URL(req.url, "http://x").pathname.replace(/^\/next\/?/, "") || "index.html";
    try {
        const body = await readFile(join(PAGE, name));
        res.writeHead(200, { "content-type": TYPES[name.split(".").pop()] ?? "text/plain" }).end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

process.env.FC_FONTATIONS = "1";
const browser = await chromium.launch();
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

for (const n of [300, 3000]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const list = listAnswer([target(9000, { projects: [project("graphty-element", { reviewable: n })] })]);
    let pictures = 0;
    await page.route("**/api/session", (route) => route.fulfill({ json: { had: true } }));
    await page.route("**/api/usage-setting", (route) => route.fulfill({ json: { on: false } }));
    await page.route("**/api/prs*", (route) => route.fulfill({ json: list }));
    await page.route("**/api/pr/**", (route) => route.fulfill({ json: rowsAnswer("graphty-element", n) }));
    await page.route("**/api/pic/**", (route) => {
        pictures++;
        return route.fulfill({ status: 200, contentType: "image/png", body: picture });
    });
    const frames = [];
    const jumps = [];
    let first = null;
    for (let i = 0; i < loads; i++) {
        pictures = 0;
        await page.goto(`${origin}/next/#token=bench&change=9000`);
        await page.locator("#snap-list .srow").first().waitFor();
        await page.waitForFunction(() => performance.getEntriesByName("snapshot-list-frame").length > 0);
        frames.push(await page.evaluate(() => performance.getEntriesByName("snapshot-list-frame").at(-1).duration));
        first ??= pictures;
        jumps.push(
            await page.evaluate(() => {
                const rows = globalThis.document.querySelectorAll("#snap-list .srow");
                const t0 = performance.now();
                rows[rows.length - 1].scrollIntoView({ block: "nearest" });
                rows[rows.length - 1].getBoundingClientRect();
                return performance.now() - t0;
            }),
        );
    }
    console.log(`snapshot list at ${n.toLocaleString("en-US")} snapshots, ${loads} loads:`);
    console.log(
        `  build to first frame: median ${median(frames).toFixed(1)} ms, max ${Math.max(...frames).toFixed(1)} ms`,
    );
    console.log(
        `  jump to the last row: median ${median(jumps).toFixed(1)} ms, max ${Math.max(...jumps).toFixed(1)} ms`,
    );
    console.log(`  pictures asked for by the first screen: ${first}`);
    await page.close();
}
await browser.close();
server.close();
