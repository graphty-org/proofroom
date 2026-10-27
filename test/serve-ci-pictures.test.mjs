/**
 * A capture that arrives with its pictures and areas (`proofroom run` wrote them): the server lists
 * each changed pair's areas from the item and answers every picture, Zoom Auto's too, from the
 * capture's files, with no picture job at all. And the comparison report of a change, as a JUnit
 * file to save.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareImages } from "../trusted/lib/compare.mjs";
import { junitXml } from "../trusted/lib/junit.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { autoKind, createPool, PAIR_KINDS, pictures } from "../trusted/lib/thumbs.mjs";
import { fakeAdapters } from "./fakes/adapters.mjs";
import { copyFixture, FIXTURE_CONFIG, makeRepo } from "./helpers.mjs";

const TOKEN = "t".repeat(43);

const servers = [];
afterEach(async () => {
    for (const { server, app } of servers.splice(0)) {
        await new Promise((resolve) => server.close(() => resolve()));
        await app.idle();
    }
});

/**
 * The server on a random port over local captures, with a picture queue that counts its jobs.
 * @param {string} results the directory holding each project's capture
 * @returns {Promise<{ get: (path: string) => Promise<{ status: number, type: string, headers: Headers,
 *     body: any }>, app: any, jobs: object[] }>} a GET, the app and the jobs its queue started
 */
async function start(results) {
    const r = makeRepo();
    const jobs = [];
    const box = {};
    const server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    box.app = createApp({
        repo: r.repo,
        tmp: join(r.repo, "tmp/visual-review"),
        config: FIXTURE_CONFIG,
        token: TOKEN,
        origin,
        results,
        pictures: createPool(async (job) => {
            jobs.push(job);
            return pictures(job);
        }, 1),
        ...fakeAdapters(),
    });
    servers.push({ server, app: box.app });
    const get = async (path) => {
        const res = await fetch(`${origin}${path}`, { headers: { "x-review-token": TOKEN, origin } });
        const type = res.headers.get("content-type") ?? "";
        const body = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
        return { status: res.status, type, headers: res.headers, body };
    };
    return { get, app: box.app, jobs };
}

// The statuses whose items the list pictures (the fixture's unstable story is an old capture's pair).
const PICTURED = new Set(["changed", "new", "removed", "unstable"]);
const isPair = (i) => i.baseline && i.capture && i.baseline !== i.capture;

/**
 * The fixture capture as `run` would write it: each pictured item's areas (of a pair) and its
 * pictures, as files beside its images, each holding its own name so a test can tell them apart.
 * @param {string} root where the capture goes, as `<root>/compact-mantine`
 * @returns {{ dir: string, results: object }} the capture's directory and results.json
 */
function capturedByRun(root) {
    const { dir, results } = copyFixture("compact-mantine", join(root, "compact-mantine"), {
        pr: null,
        runId: null,
        runAttempt: null,
    });
    for (const item of results.items.filter((i) => PICTURED.has(i.status))) {
        const stem = item.file.slice(0, -4);
        const kinds = isPair(item) ? PAIR_KINDS : ["plain"];
        item.pictures = Object.fromEntries(kinds.map((k) => [k, `${stem}.${k}.webp`]));
        for (const name of Object.values(item.pictures)) {
            writeFileSync(join(dir, name), name);
        }
        if (isPair(item)) {
            const r = compareImages(
                readFileSync(join(dir, "baselines", item.file)),
                readFileSync(join(dir, item.file)),
                { threshold: item.threshold, includeAA: item.includeAA, areas: true, moved: true },
            );
            item.areas = r.areas;
        }
    }
    writeFileSync(join(dir, "results.json"), JSON.stringify(results));
    return { dir, results };
}

describe("serve: a capture run made", () => {
    it("lists the areas compare wrote and answers every picture from its files, with no picture job", async () => {
        const root = join(makeRepo().dir, "local");
        const { dir, results } = capturedByRun(root);
        const s = await start(root);
        const list = await s.get("/api/prs");
        expect(list.status).toBe(200);
        const id = list.body.targets[0].id;
        const rows = await s.get(`/api/pr/${encodeURIComponent(id)}/compact-mantine?rows=1`);
        expect(rows.status).toBe(200);
        const byFile = new Map(rows.body.items.map((i) => [i.file, i]));

        for (const item of results.items.filter((i) => PICTURED.has(i.status))) {
            const row = byFile.get(item.file);
            if (isPair(item)) {
                // What the server's own job would have found for this pair.
                const job = pictures({
                    baseline: readFileSync(join(dir, "baselines", item.file)),
                    capture: readFileSync(join(dir, item.file)),
                    threshold: item.threshold,
                    includeAA: item.includeAA,
                });
                expect(row.areas, item.file).toEqual({
                    crop: job.facts.crop,
                    zoom: job.facts.zoom,
                    count: job.facts.areas,
                });
                for (const kind of [...PAIR_KINDS, "auto"]) {
                    const pic = await s.get(`/api/pic/${row.pic}-${kind}`);
                    const want = kind === "auto" ? autoKind(job.facts) : kind;
                    expect(pic.status, `${item.file} ${kind}`).toBe(200);
                    expect(pic.type).toBe("image/webp");
                    expect(pic.body.toString(), `${item.file} ${kind}`).toBe(item.pictures[want]);
                    expect(pic.headers.get("cache-control")).toContain("immutable");
                }
            } else {
                const pic = await s.get(`/api/pic/${row.pic}-plain`);
                expect(pic.status, item.file).toBe(200);
                expect(pic.body.toString()).toBe(item.pictures.plain);
            }
        }
        await s.app.idle();
        // Server pictures for a capture run made: none.
        expect(s.jobs).toEqual([]);
    });

    it("marks a row whose earlier attempts saw another status or image, and only that row, as attempts disagree", async () => {
        const root = join(makeRepo().dir, "local");
        const { dir, results } = capturedByRun(root);
        const [same, otherStatus, otherImage] = results.items.filter((i) => i.capture && i.baseline);
        const attempt = (item, edit = {}) => ({
            status: item.status,
            capture: item.capture,
            changedPixels: item.changedPixels,
            reason: null,
            console: [],
            ...edit,
        });
        same.attempts = [attempt(same)];
        otherStatus.attempts = [
            attempt(otherStatus, { status: otherStatus.status === "changed" ? "unstable" : "changed" }),
        ];
        otherImage.attempts = [attempt(otherImage, { capture: "f".repeat(64) })];
        writeFileSync(join(dir, "results.json"), JSON.stringify(results));
        const s = await start(root);
        const id = (await s.get("/api/prs")).body.targets[0].id;
        const rows = await s.get(`/api/pr/${encodeURIComponent(id)}/compact-mantine?rows=1`);
        expect(rows.status).toBe(200);
        const disagree = rows.body.items.filter((i) => i.disagree).map((i) => i.file);
        expect(disagree.sort()).toEqual([otherStatus.file, otherImage.file].sort());
    });

    it("answers a change's comparison report as a JUnit file to save, one suite per project", async () => {
        const root = join(makeRepo().dir, "local");
        const { results } = capturedByRun(root);
        const s = await start(root);
        const id = (await s.get("/api/prs")).body.targets[0].id;
        const report = await s.get(`/api/junit/${encodeURIComponent(id)}`);
        expect(report.status).toBe(200);
        expect(report.type).toBe("application/xml; charset=utf-8");
        const name = `proofroom-${String(id).replace(/[^A-Za-z0-9-]/g, "-")}.junit.xml`;
        expect(report.headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
        expect(report.body.toString()).toBe(junitXml([["compact-mantine", results.items]]));

        const missing = await s.get("/api/junit/no-such-change");
        expect(missing.status).toBe(404);
    });
});
