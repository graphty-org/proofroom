// Measures the new review page's changes pane at 50 changes in headless Chromium: how long the
// page takes to build the pane from the list (the "changes-pane" measure the page records around
// each build), and what it asks the server for to show it. Not published, not run in CI.
//
// Usage: node bench/changes-pane.mjs [loads=20]

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { fiftyChanges, listAnswer } from "../test/next/fixtures.mjs";

const loads = Number(process.argv[2] ?? "20");
const PAGE = fileURLToPath(new URL("../trusted/page/next/", import.meta.url));
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css" };

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const list = listAnswer(fiftyChanges());
const asked = [];
page.on("request", (r) => asked.push(new URL(r.url()).pathname));
await page.route("**/api/session", (route) => route.fulfill({ json: { had: true } }));
await page.route("**/api/usage-setting", (route) => route.fulfill({ json: { on: false } }));
await page.route("**/api/prs*", (route) => route.fulfill({ json: list }));

const times = [];
let requests = null;
for (let i = 0; i < loads; i++) {
    asked.length = 0;
    await page.goto(`${origin}/next/#token=bench`);
    await page.locator(".chg").first().waitFor();
    // The last build is the one with the 50 changes in it.
    times.push(await page.evaluate(() => performance.getEntriesByName("changes-pane").at(-1).duration));
    requests ??= asked.filter((p) => p.startsWith("/api/") || /\.(png|webp)$/.test(p));
}
times.sort((a, b) => a - b);
console.log(`changes pane at 50 changes, ${loads} loads:`);
console.log(`  build: median ${times[Math.floor(times.length / 2)].toFixed(1)} ms, max ${times.at(-1).toFixed(1)} ms`);
console.log(`  requests to show it: ${requests.join(", ")}`);
await browser.close();
server.close();
