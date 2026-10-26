// Measures the review server's decisions at 3,000 stories, on the test suite's fixture repository:
// the in-process decision lookup right after a write, a whole decision request, the list
// request, and the list's size on the wire. Not published, not run in CI.
//
// Usage: npx vitest run --config bench/vitest.config.mjs

import { writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { it } from "vitest";

import { createApp } from "../trusted/lib/serve.mjs";
import { capturedItems, FIXTURE_CONFIG, isolateGit, makeRepo, onePr } from "../test/helpers.mjs";

const TOKEN = "t".repeat(43);
const N = 3000;
const PROJECT = "compact-mantine";

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const ms = (n) => `${n.toFixed(3)} ms`;

it(`decisions at ${N} stories`, async () => {
    isolateGit();
    const badge = capturedItems().find((i) => i.file === "badge--default.light.png");
    const items = Array.from({ length: N }, (_, i) => ({ ...badge, id: `m--s${i}`, file: `m--s${i}.light.png` }));
    const r = makeRepo();
    const tmp = join(r.repo, "tmp/visual-review");
    const results = { commit: r.head, headSha: r.head, complete: true, expected: N, items };
    const gh = onePr({ results: { "visual-compact-mantine-1": results } })(r);
    const box = {};
    const server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    box.app = createApp({ repo: r.repo, tmp, config: FIXTURE_CONFIG, token: TOKEN, origin, gh });
    const headers = { "x-review-token": TOKEN, origin, "content-type": "application/json" };
    const api = async (method, path, body) =>
        (await fetch(`${origin}${path}`, { method, headers, body: body && JSON.stringify(body) })).arrayBuffer();
    await api("GET", "/api/prs");
    const decided = (i) => [`${PROJECT}/${i.file}`, { decision: "accept", reason: null, hash: i.capture, base: null }];
    writeFileSync(join(tmp, "state/123.json"), JSON.stringify(Object.fromEntries(items.map(decided))));
    await api("GET", `/api/pr/123/${PROJECT}?rows=1`);

    const lookups = [];
    const requests = [];
    for (const item of items.slice(0, 40)) {
        for (const decision of [null, "accept"]) {
            const t0 = performance.now();
            await api("POST", "/api/decide", { id: "123", project: PROJECT, file: item.file, decision });
            requests.push(performance.now() - t0);
            const t1 = performance.now();
            box.app.decisionsOf("123").get(`${PROJECT}/${item.file}`);
            lookups.push(performance.now() - t1);
        }
    }
    const lists = [];
    for (let k = 0; k < 10; k++) {
        const t0 = performance.now();
        await api("GET", `/api/pr/123/${PROJECT}?rows=1`);
        lists.push(performance.now() - t0);
    }
    const size = (encoding) =>
        new Promise((resolve) =>
            get(
                `${origin}/api/pr/123/${PROJECT}?rows=1`,
                { headers: { "x-review-token": TOKEN, "accept-encoding": encoding } },
                (res) => {
                    let n = 0;
                    res.on("data", (c) => (n += c.length));
                    res.on("end", () => resolve(n));
                },
            ),
        );
    console.log(`${N} stories, all decided:`);
    console.log(`  decision lookup after a write, in process: ${ms(median(lookups))} median`);
    console.log(`  decision request (with its file write): ${ms(median(requests))} median`);
    console.log(`  list request: ${ms(median(lists))} median`);
    console.log(`  list on the wire: ${await size("gzip")} bytes gzipped, ${await size("identity")} plain`);
    await new Promise((resolve) => server.close(resolve));
    await box.app.idle();
});
