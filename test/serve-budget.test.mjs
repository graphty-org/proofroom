/**
 * The disk budget: over it, a refresh evicts the full images and pictures of whole changes (the
 * finished and nothing-to-decide ones first, then the least recently opened), never results.json or
 * the decisions, so every row keeps its counts; opening an evicted change downloads it again while
 * the code host keeps it, and says the images are gone once it does not.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { evict, evictionOrder, OPENED_KEEP_MS, sizes } from "../trusted/lib/budget.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { copyFixture, fakeGh, FIXTURE_CONFIG, git, job, makeRepo, tempDir, until } from "./helpers.mjs";

// Every walk of a work directory: a read of its root, by any app in this file.
const walks = vi.hoisted(() => ({ roots: [] }));
vi.mock("node:fs/promises", async (importOriginal) => {
    const fs = /** @type {typeof import("node:fs/promises")} */ (await importOriginal());
    const readdir = (path, ...rest) => {
        if (String(path).endsWith("tmp/visual-review")) {
            walks.roots.push(String(path));
        }
        return fs.readdir(path, ...rest);
    };
    return { ...fs, default: { ...fs, readdir }, readdir };
});

const TOKEN = "t".repeat(43);
const HOUR = 60 * 60000;
// One project, whose fixture's only story is new: a run that captured none has nothing to decide.
const PROJECTS = ["graphty-element"];
const CONFIG = { ...FIXTURE_CONFIG, projects: { "graphty-element": FIXTURE_CONFIG.projects["graphty-element"] } };
// Bytes added to each downloaded project, so a change's images dwarf the few bytes the list
// files change by between two walks.
const PAD = 200000;

const servers = [];
afterEach(async () => {
    for (const { server, app } of servers.splice(0)) {
        await new Promise((resolve) => server.close(() => resolve()));
        await app.idle();
    }
});

/**
 * Three pull requests, each with a finished run: #1 has nothing to decide, #2
 * and #3 have changes to review. Counts every download by run, and answers the artifacts of the
 * runs in `expired` as deleted by GitHub.
 * @param {{ head: string, master: string }} r the repository
 * @param {string[]} [jobsFor] the projects with a capture job (only PROJECTS have an artifact)
 * @returns {{ gh: Function, downloads: Map<number, number>, expired: Set<number> }} the runner
 */
function threePrs(r, jobsFor = PROJECTS) {
    const heads = { 1: r.head, 2: r.master, 3: "3".repeat(40) };
    const runs = Object.fromEntries(Object.entries(heads).map(([n, head]) => [head, { id: 1000 + Number(n), head }]));
    const base = fakeGh({
        prs: Object.entries(heads).map(([n, head]) => ({ number: Number(n), head, branch: "feature" })),
        runs,
        jobs: Object.fromEntries([1001, 1002, 1003].map((id) => [id, jobsFor.map((p) => job(p))])),
        artifacts: Object.fromEntries([1001, 1002, 1003].map((id) => [id, PROJECTS.map((p) => `visual-${p}-1`)])),
    });
    const downloads = new Map();
    const expired = new Set();
    const gh = async (args, input) => {
        if (args[0] === "run" && args[1] === "download") {
            const run = Number(args[2]);
            downloads.set(run, (downloads.get(run) ?? 0) + 1);
            const project = /^visual-(.+)-\d+$/.exec(args[4])[1];
            const head = heads[run - 1000];
            // #1 captured no story: nothing to decide.
            copyFixture(project, args[6], {
                commit: head,
                headSha: head,
                pr: run - 1000,
                runId: run,
                ...(run === 1001 && { items: [], expected: 0 }),
            });
            writeFileSync(join(args[6], "pad.bin"), Buffer.alloc(PAD));
            return "";
        }
        const m = /actions\/runs\/(\d+)\/artifacts/.exec(args[1] ?? "");
        if (m && expired.has(Number(m[1]))) {
            const names = PROJECTS.map((p) => `visual-${p}-1`);
            return JSON.stringify({ artifacts: names.map((name) => ({ name, expired: true, size_in_bytes: 1000 })) });
        }
        return base(args, input);
    };
    return { gh, downloads, expired };
}

/**
 * Starts the app on a random port.
 * @param {object} r the repository (makeRepo)
 * @param {Function} gh the gh runner
 * @param {number} diskBudget the budget, in GB
 * @param {object} [config] the repository's settings
 * @returns {Promise<{ api: Function, app: any }>} `api(method, path, body)` and the handler
 */
async function start(r, gh, diskBudget, config = CONFIG) {
    const tmp = join(r.repo, "tmp/visual-review");
    const box = {};
    const server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    box.app = createApp({ repo: r.repo, tmp, config: { ...config, diskBudget }, token: TOKEN, origin, gh });
    servers.push({ server, app: box.app });
    const api = async (method, path, body) => {
        const res = await fetch(`${origin}${path}`, {
            method,
            headers: { "x-review-token": TOKEN, origin, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = (res.headers.get("content-type") ?? "").includes("json");
        return { status: res.status, body: json ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    return { api, app: box.app };
}

const runDir = (tmp, run, project) => join(tmp, `${run}-1`, project);
// The bytes a run's downloads hold beside their results.json, as eviction counts them.
const imageBytes = async (tmp, run) => {
    let n = 0;
    for (const [path, size] of await sizes(join(tmp, `${run}-1`))) {
        if (!/[/\\](results\.json|gh[/\\].*)$/.test(path)) {
            n += size;
        }
    }
    return n;
};
const counts = (t) => t.projects.map((p) => [p.project, p.reviewable, p.decided, p.undecided, p.counts]);
const pngs = (dir) => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".png"));

/**
 * Loads the three pull requests with no budget to speak of, decides one image on #2, and waits
 * for every picture: what the budget then measures.
 * @param {string[]} [jobsFor] see threePrs
 * @param {object} [config] see start
 * @returns {Promise<object>} the repository, its tmp directory, the runner, the list as loaded
 */
async function loaded(jobsFor = PROJECTS, config = CONFIG) {
    const r = makeRepo();
    const tmp = join(r.repo, "tmp/visual-review");
    const fake = threePrs(r, jobsFor);
    const s = await start(r, fake.gh, 1000, config);
    await s.api("GET", "/api/prs");
    const decide = { id: "2", project: "graphty-element", file: "graph--basic.png", decision: "accept" };
    expect((await s.api("POST", "/api/decide", decide)).status).toBe(200);
    // Every row's pictures, made in the background, and the walk after the refresh.
    await s.app.idle();
    const before = (await s.api("GET", "/api/prs?cached=1")).body;
    expect(before.disk.budget).toBe(1000e9);
    expect(before.disk.used).toBeGreaterThan(3 * PAD);
    return { r, tmp, fake, before };
}

// When each change was last opened, as the server keeps it.
const openedAgo = (tmp, ago) => {
    mkdirSync(join(tmp, "state"), { recursive: true });
    const now = Date.now();
    writeFileSync(
        join(tmp, "state/opened.json"),
        JSON.stringify(Object.fromEntries(Object.entries(ago).map(([id, ms]) => [id, now - ms]))),
    );
};

describe("evictionOrder", () => {
    it("puts changes that need nothing first, then the least recently opened, and skips kept ones", () => {
        const now = 10 * HOUR;
        const c = (id, needsYou, ago, keep = false) => ({ id, needsYou, openedAt: now - ago, keep });
        const order = evictionOrder(
            [
                c("a", true, 3 * HOUR),
                c("b", false, 2 * HOUR),
                c("c", true, 5 * HOUR),
                c("open", true, OPENED_KEEP_MS - 1),
                c("pinned", false, 9 * HOUR, true),
                c("never", true, now),
            ],
            now,
        );
        expect(order).toEqual(["b", "never", "c", "a"]);
    });
});

describe("evict", () => {
    it("removes everything but results.json, the markers and GitHub's answers, and counts the bytes", async () => {
        const dir = join(tempDir("budget-"), "1-1", "web");
        copyFixture("compact-mantine", dir);
        mkdirSync(join(dir, "gh"));
        writeFileSync(join(dir, "gh/answer.json"), "{}");
        const files = await sizes(dir);
        const expected = [...files]
            .filter(([p]) => !/results\.json$|answer\.json$/.test(p))
            .reduce((n, [, b]) => n + b, 0);
        // One pass over the walk, however many entries go: a walk of the whole work directory
        // holds every other capture's files too.
        let visited = 0;
        const counted = new (class extends Map {
            *[Symbol.iterator]() {
                for (const e of super[Symbol.iterator]()) {
                    visited++;
                    yield e;
                }
            }
        })(files);
        expect(readdirSync(dir).length).toBeGreaterThan(2);
        expect(evict(dir, counted, 5)).toBe(expected);
        expect(visited).toBe(files.size);
        expect(readdirSync(dir).sort()).toEqual(["evicted.json", "gh", "results.json"]);
    });
});

describe("the disk budget", () => {
    it("evicts the change with nothing to decide first, then the least recently opened, keeping every count", async () => {
        const { r, tmp, fake, before } = await loaded();
        const [b1, b2] = [await imageBytes(tmp, 1001), await imageBytes(tmp, 1002)];
        // #1 was opened most recently of the three, yet goes first: it needs nothing.
        openedAgo(tmp, { 1: 1.5 * HOUR, 2: 3 * HOUR, 3: 2 * HOUR });
        // Over by more than #1 holds and less than #1 and #2 together.
        const budget = (before.disk.used - b1 - b2 / 2) / 1e9;
        const s = await start(r, fake.gh, budget);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        const after = (await s.api("GET", "/api/prs?cached=1")).body;
        for (const run of [1001, 1002]) {
            for (const p of PROJECTS) {
                expect(readdirSync(runDir(tmp, run, p)).sort()).toEqual(["evicted.json", "results.json"]);
            }
        }
        expect(pngs(join(tmp, "1003-1")).length).toBeGreaterThan(0);
        const by = (list, id) => list.targets.find((t) => t.id === id);
        expect(by(after, "1").evicted).toEqual({ bytes: b1, deleted: false });
        expect(by(after, "2").evicted).toEqual({ bytes: b2, deleted: false });
        expect(by(after, "3").evicted).toBeNull();
        for (const id of ["1", "2", "3"]) {
            expect(counts(by(after, id))).toEqual(counts(by(before, id)));
        }
        expect(by(after, "2").projects[0].decided).toBe(1);
        expect(after.disk.used).toBeLessThanOrEqual(budget * 1e9);
        // An evicted change's images answer that they are not on disk, and never count as damaged.
        expect((await s.api("GET", "/api/img/2/graphty-element/capture/graph--basic.png")).status).toBe(410);
        expect(existsSync(join(runDir(tmp, 1002, "graphty-element"), "results.json"))).toBe(true);
        // A refresh never downloads an evicted change again on its own.
        const asked = fake.downloads.get(1002);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        expect(fake.downloads.get(1002)).toBe(asked);
    });

    it("never evicts a change opened in the last hour, and takes the others' pictures with them", async () => {
        const { r, tmp, fake } = await loaded();
        const thumbs = () => pngs(join(tmp, "thumbs")).length;
        expect(thumbs()).toBeGreaterThan(0);
        openedAgo(tmp, { 1: 5 * HOUR, 2: 4 * HOUR, 3: 30 * 60000 });
        let s = await start(r, fake.gh, 1e-9);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        const list = (await s.api("GET", "/api/prs?cached=1")).body;
        expect(list.targets.map((t) => [t.id, t.evicted !== null])).toEqual([
            ["1", true],
            ["2", true],
            ["3", false],
        ]);
        // #3 shows every image the others did: their pictures stay for it.
        expect(thumbs()).toBeGreaterThan(0);
        // Once #3 was opened long ago, it goes too, and every picture with it.
        openedAgo(tmp, { 1: 5 * HOUR, 2: 4 * HOUR, 3: 3 * HOUR });
        s = await start(r, fake.gh, 1e-9);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        expect((await s.api("GET", "/api/prs?cached=1")).body.targets.every((t) => t.evicted !== null)).toBe(true);
        expect(thumbs()).toBe(0);
    });

    it("downloads an evicted change again when it is opened, with its decisions as they were", async () => {
        const { r, tmp, fake } = await loaded();
        openedAgo(tmp, { 1: 5 * HOUR, 2: 4 * HOUR, 3: 3 * HOUR });
        const s = await start(r, fake.gh, 1e-9);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        const asked = fake.downloads.get(1002);
        const open = () => s.api("GET", "/api/pr/2/graphty-element?rows=1");
        const first = await open();
        expect(first.status).toBe(202);
        expect(first.body.downloading).toBe(true);
        const rows = await until(async () => {
            const a = await open();
            return a.status === 200 && a.body;
        });
        expect(rows.items.length).toBeGreaterThan(0);
        // Downloaded once.
        expect(fake.downloads.get(1002)).toBe(asked + 1);
        expect(existsSync(join(runDir(tmp, 1002, "graphty-element"), "evicted.json"))).toBe(false);
        expect(pngs(runDir(tmp, 1002, "graphty-element")).length).toBeGreaterThan(0);
        const t = (await s.api("GET", "/api/prs?cached=1")).body.targets.find((x) => x.id === "2");
        expect(t.evicted).toBeNull();
        expect(t.projects[0].decided).toBe(1);
        expect((await s.api("GET", "/api/img/2/graphty-element/capture/graph--basic.png")).status).toBe(200);
    });

    it("downloads an evicted change again whichever project the page asks about", async () => {
        // compact-mantine, listed first, has a capture job but no artifact: never evicted.
        const { r, tmp, fake } = await loaded(["compact-mantine", ...PROJECTS], FIXTURE_CONFIG);
        openedAgo(tmp, { 1: 5 * HOUR, 2: 4 * HOUR, 3: 3 * HOUR });
        const s = await start(r, fake.gh, 1e-9, FIXTURE_CONFIG);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        const t = (await s.api("GET", "/api/prs?cached=1")).body.targets.find((x) => x.id === "2");
        expect(t.projects.map((p) => p.project)).toEqual(["compact-mantine", "graphty-element"]);
        expect(t.evicted).not.toBeNull();
        const asked = fake.downloads.get(1002);
        const first = await s.api("GET", "/api/pr/2/compact-mantine?rows=1");
        expect(first.status).toBe(202);
        await until(async () => (await s.api("GET", "/api/pr/2/graphty-element?rows=1")).status === 200);
        expect(fake.downloads.get(1002)).toBe(asked + 1);
        expect((await s.api("GET", "/api/prs?cached=1")).body.targets.find((x) => x.id === "2").evicted).toBeNull();
    });

    it("downloads a decided change's images again before Finish reads them", async () => {
        const { r, tmp, fake } = await loaded();
        openedAgo(tmp, { 1: 5 * HOUR, 2: 4 * HOUR, 3: 3 * HOUR });
        const s = await start(r, fake.gh, 1e-9);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        const listed = () => s.api("GET", "/api/prs?cached=1").then((a) => a.body.targets.find((x) => x.id === "2"));
        const was = await listed();
        expect(was.evicted).not.toBeNull();
        expect(was.unpublished).toBe(1);
        const asked = fake.downloads.get(1002);
        for (const route of ["/api/finish-prepare", "/api/finish"]) {
            expect(await s.api("POST", route, { id: "2" })).toEqual({
                status: 409,
                body: { error: "Images not on disk: downloading them again; Finish once they are in" },
            });
        }
        await until(async () => (await listed()).evicted === null);
        expect(fake.downloads.get(1002)).toBe(asked + 1);
        expect(pngs(runDir(tmp, 1002, "graphty-element")).length).toBeGreaterThan(0);
        expect((await listed()).unpublished).toBe(1);
        // Asked to Finish, the change stays on disk for the next hour, whatever the budget.
        await s.api("GET", "/api/prs");
        await s.app.idle();
        expect((await listed()).evicted).toBeNull();
    });

    it("never writes images into an evicted directory when it is loaded again", async () => {
        const { r, tmp, fake } = await loaded();
        openedAgo(tmp, { 1: 5 * HOUR, 2: 4 * HOUR, 3: 3 * HOUR });
        let s = await start(r, fake.gh, 1e-9);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        const held = () => [1001, 1002, 1003].map((run) => readdirSync(runDir(tmp, run, "graphty-element")).sort());
        expect(held()).toEqual([1, 2, 3].map(() => ["evicted.json", "results.json"]));
        // The default branch gains a baseline every change is compared with, and the server restarts.
        const dir = join(r.repo, "visual-baselines/graphty-element");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "extra--x.png"), readFileSync("test/fixtures/results/graphty-element/graph--basic.png"));
        git(r.repo, "add", "-A", "visual-baselines");
        git(r.repo, "commit", "-q", "-m", "test: extra baseline");
        git(r.repo, "push", "-q", "origin", "HEAD:master");
        git(r.repo, "update-ref", "refs/remotes/origin/master", "HEAD");
        s = await start(r, fake.gh, 1e-9);
        await s.api("GET", "/api/prs?cached=1");
        await s.api("GET", "/api/prs");
        await s.app.idle();
        expect(held()).toEqual([1, 2, 3].map(() => ["evicted.json", "results.json"]));
        // The new baseline is counted as removed in every change all the same.
        const list = (await s.api("GET", "/api/prs?cached=1")).body;
        expect(list.targets.every((t) => t.evicted !== null)).toBe(true);
        expect(list.disk.used).toBeLessThan(PAD);
    });

    it("walks the work directory once per refresh, after it, and never for a request", async () => {
        const r = makeRepo();
        const s = await start(r, threePrs(r).gh, 1000);
        walks.roots.length = 0;
        await s.api("GET", "/api/prs");
        await s.app.idle();
        expect(walks.roots.length).toBe(1);
        for (let i = 0; i < 5; i++) {
            await s.api("GET", "/api/prs?cached=1");
            await s.api("GET", "/api/pr/2/graphty-element?rows=1");
            await s.api("GET", "/api/img/2/graphty-element/capture/graph--basic.png");
        }
        await s.app.idle();
        expect(walks.roots.length).toBe(1);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        expect(walks.roots.length).toBe(2);
    });

    it("says the images are gone once the code host deleted them, and keeps the counts", async () => {
        const { r, tmp, fake, before } = await loaded();
        openedAgo(tmp, { 1: 5 * HOUR, 2: 4 * HOUR, 3: 3 * HOUR });
        const s = await start(r, fake.gh, 1e-9);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        // GitHub deleted run 1002's artifacts; the answers kept from before are dropped with them.
        fake.expired.add(1002);
        rmSync(join(tmp, "1002-1/gh"), { recursive: true, force: true });
        await s.api("GET", "/api/prs");
        await s.app.idle();
        const t = (await s.api("GET", "/api/prs?cached=1")).body.targets.find((x) => x.id === "2");
        expect(t.evicted.deleted).toBe(true);
        expect(counts(t)).toEqual(counts(before.targets.find((x) => x.id === "2")));
        const asked = fake.downloads.get(1002);
        const open = await s.api("GET", "/api/pr/2/graphty-element?rows=1");
        expect(open).toEqual({ status: 410, body: { error: "Images deleted by the code host: capture again" } });
        expect(fake.downloads.get(1002)).toBe(asked);
    });

    it("says the images are gone once the kept artifact list's expiry date has passed", async () => {
        const { r, tmp, fake } = await loaded();
        openedAgo(tmp, { 1: 5 * HOUR, 2: 4 * HOUR, 3: 3 * HOUR });
        const s = await start(r, fake.gh, 1e-9);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        // GitHub's answer kept from the first download: not expired then, and its date now passed.
        const keptDir = join(tmp, "1002-1/gh");
        let rewritten = 0;
        for (const name of readdirSync(keptDir)) {
            const answer = JSON.parse(readFileSync(join(keptDir, name), "utf8"));
            if (Array.isArray(answer.artifacts)) {
                for (const a of answer.artifacts) {
                    Object.assign(a, { expired: false, expires_at: new Date(Date.now() - HOUR).toISOString() });
                }
                writeFileSync(join(keptDir, name), JSON.stringify(answer));
                rewritten++;
            }
        }
        expect(rewritten).toBeGreaterThan(0);
        await s.api("GET", "/api/prs");
        await s.app.idle();
        const t = (await s.api("GET", "/api/prs?cached=1")).body.targets.find((x) => x.id === "2");
        expect(t.evicted.deleted).toBe(true);
        expect(fake.expired.size).toBe(0);
    });
});
