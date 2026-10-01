import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { downloadCaptures, newestMasterCapture, withRetries } from "../trusted/lib/github.mjs";
import { createApp, thumbnail } from "../trusted/lib/serve.mjs";
import { PNG } from "pngjs";
import {
    copyFixture,
    FIXTURE,
    FIXTURE_CONFIG,
    fakeGh,
    git,
    isolateGit,
    job,
    makeRepo,
    onePr,
    pushCommit,
    registerOnMaster,
    testPasskey,
    withMoved,
} from "./helpers.mjs";

beforeAll(isolateGit);

const TOKEN = "t".repeat(43);

let server;
afterEach(() => server?.close());

/**
 * Starts the app on a random port.
 * @param {object} options passed to createApp; `repo` defaults to a fresh repository
 * @returns {Promise<object>} `api(method, path, body, headers)` plus the repository
 */
async function start(options = {}) {
    const r = options.repo ? options : makeRepo();
    const repo = options.repo ?? r.repo;
    const tmp = join(repo, "tmp/visual-review");
    const box = {};
    server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    box.app = createApp({ repo, tmp, config: FIXTURE_CONFIG, token: TOKEN, origin, ...options, gh: options.gh(r) });
    const api = async (method, path, body, headers = {}) => {
        const res = await fetch(`${origin}${path}`, {
            method,
            headers: { "x-review-token": TOKEN, origin, "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const type = res.headers.get("content-type") ?? "";
        return {
            status: res.status,
            type,
            body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
        };
    };
    return { ...r, repo, origin, api, tmp };
}

/**
 * Waits for the running Finish to end, as the page does.
 * @param {object} s the started app
 * @returns {Promise<object | null>} the ended job
 */
async function endedJob(s) {
    for (;;) {
        const { job } = (await s.api("GET", "/api/finish-status")).body;
        if (!job?.running) {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/**
 * Starts a Finish and waits for it to end.
 * @param {object} s the started app
 * @param {string} id the target
 * @returns {Promise<{ begun: object, job: object | null }>} the start's response and the ended job
 */
async function finishJob(s, id) {
    const begun = await s.api("POST", "/api/finish", { id });
    return { begun, job: await endedJob(s) };
}

describe("serve: pull requests", () => {
    it("lists every open pull request, with counts per project, and one without a CI run as waiting", async () => {
        const s = await start({
            gh: (r) =>
                fakeGh({
                    prs: [
                        { number: 123, head: r.head, branch: "feature" },
                        { number: 124, head: "4".repeat(40), branch: "no-run" },
                    ],
                    runs: { [r.head]: { id: 1000, head: r.head } },
                    jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
                    artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                }),
        });
        const { status, body } = await s.api("GET", "/api/prs");
        expect(status).toBe(200);
        expect(body.targets.map((t) => t.id)).toEqual(["123", "124"]);
        expect(body.targets[1].projects[0].problem).toBe("waiting for CI on 4444444444");
        const [pr] = body.targets;
        expect(pr).toMatchObject({ pr: 123, runId: 1000, branch: "feature", mergeMasterFirst: false });
        const cm = pr.projects.find((p) => p.project === "compact-mantine");
        expect(cm).toMatchObject({
            problem: null,
            counts: { changed: 2, new: 1, removed: 1, unstable: 1, failed: 1, unchanged: 1 },
            reviewable: 6,
            decided: 0,
        });
    });

    it("shows capture failed with the job's log when the visual job failed or uploaded nothing", async () => {
        const s = await start({
            gh: onePr({
                jobs: { 1000: [job("compact-mantine", "failure"), job("graphty-element")] },
                artifacts: { 1000: ["visual-compact-mantine-1"] },
            }),
        });
        const { body } = await s.api("GET", "/api/prs");
        const [cm, ge] = ["compact-mantine", "graphty-element"].map((p) =>
            body.targets[0].projects.find((x) => x.project === p),
        );
        expect(cm).toMatchObject({ problem: "capture failed", logUrl: "https://gh/job/compact-mantine" });
        expect(ge).toMatchObject({ problem: "capture failed", logUrl: "https://gh/job/graphty-element" });
    });

    it("shows an incomplete capture as N of M stories", async () => {
        const s = await start({
            gh: (r) =>
                onePr({
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head, complete: false, expected: 20 },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                })(r),
        });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets[0].projects.find((p) => p.project === "compact-mantine").problem).toBe(
            "incomplete: 7 of 20 stories",
        );
    });

    it("shows the newest attempt's artifact", async () => {
        const s = await start({
            gh: (r) =>
                onePr({
                    runs: { [r.head]: { id: 1000, head: r.head, attempt: 2 } },
                    artifacts: {
                        1000: ["visual-compact-mantine-1", "visual-compact-mantine-2", "visual-graphty-element-1"],
                    },
                    results: {
                        "visual-compact-mantine-1": { headSha: r.head },
                        "visual-compact-mantine-2": { headSha: r.head, runAttempt: 2 },
                        "visual-graphty-element-1": { headSha: r.head },
                    },
                })(r),
        });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.results.runAttempt).toBe(2);
    });

    it("badges a pull request that lacks master's newest baseline commit", async () => {
        const r = makeRepo();
        pushCommit(r.remote, "master", "visual-baselines/compact-mantine/other.png");
        const s = await start({ ...r, gh: onePr() });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets[0].mergeMasterFirst).toBe(true);
    });

    it("returns a project's items and its decisions", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const { status, body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(status).toBe(200);
        expect(body.items).toHaveLength(7);
        expect(body.acceptable).toBe(true);
        expect(body.decisions).toEqual({});
    });
});

describe("serve: master", () => {
    const master = (r) =>
        fakeGh({
            runsById: { 2000: { id: 2000, head: r.master, attempt: 1 } },
            runs: { [r.master]: { id: 2999, head: r.master } },
            jobs: { 2000: [job("compact-mantine"), job("graphty-element")] },
            artifacts: {
                2000: ["visual-compact-mantine-1", "visual-graphty-element-1"],
                2999: ["visual-compact-mantine-1"],
            },
            results: {
                "visual-compact-mantine-1": { commit: r.master, headSha: null, pr: null, runId: 2000 },
                "visual-graphty-element-1": { commit: r.master, headSha: null, pr: null, runId: 2000 },
            },
        });

    it("shows the run given with --master-run and no other", async () => {
        const s = await start({ gh: master, masterRun: 2000 });
        const { body } = await s.api("GET", "/api/prs");
        const target = body.targets.find((t) => t.id === "master");
        expect(target).toMatchObject({ pr: null, runId: 2000, commit: s.master });
        expect(target.projects.map((p) => p.project)).toEqual(["compact-mantine", "graphty-element"]);
    });

    it("refuses Accept for a project that is not seeded from master", async () => {
        const p = FIXTURE_CONFIG.projects;
        const config = {
            ...FIXTURE_CONFIG,
            projects: { ...p, "graphty-element": { ...p["graphty-element"], seedFromDefaultBranch: false } },
        };
        const s = await start({ gh: master, masterRun: 2000, config });
        await s.api("GET", "/api/prs");
        const decide = (project, file) =>
            s.api("POST", "/api/decide", { id: "master", project, file, decision: "accept" });
        expect((await decide("graphty-element", "graph--basic.png")).status).toBe(403);
        expect((await decide("compact-mantine", "badge--default.light.png")).status).toBe(200);
        const { body } = await s.api("GET", "/api/pr/master/graphty-element");
        expect(body.acceptable).toBe(false);
    });
});

describe("serve: images", () => {
    it("serves a capture and a baseline whose hashes match results.json", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const cap = await s.api("GET", "/api/img/123/compact-mantine/capture/button--primary.dark.png");
        expect(cap.status).toBe(200);
        expect(cap.type).toBe("image/png");
        expect(cap.body.equals(readFileSync(join(FIXTURE, "compact-mantine/button--primary.dark.png")))).toBe(true);
        const base = await s.api("GET", "/api/img/123/compact-mantine/baseline/card--legacy.png");
        expect(base.status).toBe(200);
    });

    it("refuses any path outside the downloaded artifact", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        for (const path of ["..%2Fresults.json", "..%2F..%2F..%2Fpackage.json", "results.json", "%2Fetc%2Fpasswd"]) {
            expect((await s.api("GET", `/api/img/123/compact-mantine/capture/${path}`)).status).toBe(404);
        }
        const raw = await new Promise((resolve) => {
            const port = new URL(s.origin).port;
            request(
                {
                    port,
                    path: "/api/img/123/compact-mantine/capture/../../../etc/passwd",
                    headers: { "x-review-token": TOKEN },
                },
                resolve,
            ).end();
        });
        expect(raw.statusCode).toBe(404);
    });

    it("refuses an image whose bytes differ from results.json's hash", async () => {
        const s = await start({ gh: onePr() });
        const { body } = await s.api("GET", "/api/prs");
        const dir = join(s.tmp, `1000-1/compact-mantine`);
        expect(body.targets[0].runAttempt).toBe(1);
        writeFileSync(join(dir, "badge--default.light.png"), "tampered");
        writeFileSync(join(dir, "baselines/card--legacy.png"), "tampered");
        expect((await s.api("GET", "/api/img/123/compact-mantine/capture/badge--default.light.png")).status).toBe(409);
        expect((await s.api("GET", "/api/img/123/compact-mantine/baseline/card--legacy.png")).status).toBe(409);
    });
});

describe("serve: access", () => {
    it("refuses an /api request without the session token", async () => {
        const s = await start({ gh: onePr() });
        expect((await s.api("GET", "/api/prs", undefined, { "x-review-token": "wrong" })).status).toBe(401);
        const bare = await fetch(`${s.origin}/api/prs`);
        expect(bare.status).toBe(401);
    });

    it("serves the page without the token", async () => {
        const s = await start({ gh: onePr() });
        const page = await fetch(`${s.origin}/`);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
        expect(await page.text()).toContain("review.js");
    });

    it("refuses a state-changing request from a foreign origin", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const decision = {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        };
        expect((await s.api("POST", "/api/decide", decision, { origin: "https://evil.example" })).status).toBe(403);
        expect((await s.api("POST", "/api/finish", { id: "123" }, { origin: "https://evil.example" })).status).toBe(
            403,
        );
    });

    it("answers Finish only to POST", async () => {
        const s = await start({ gh: onePr() });
        expect((await s.api("GET", "/api/finish")).status).toBe(405);
        expect((await s.api("PUT", "/api/finish", { id: "123" })).status).toBe(405);
    });
});

describe("serve: renamed stories", () => {
    it("counts a moved item as needing a decision, serves its capture as its baseline, and accepts it", async () => {
        const s = await start({ gh: withMoved });
        const prs = await s.api("GET", "/api/prs");
        const cm = prs.body.targets[0].projects.find((p) => p.project === "compact-mantine");
        expect(cm.counts.moved).toBe(1);
        expect(cm.reviewable).toBe(6);
        const capture = readFileSync(join(FIXTURE, "compact-mantine/slider--sizes.png"));
        const base = await s.api("GET", "/api/img/123/compact-mantine/baseline/slider--sizes.png");
        expect(base.status).toBe(200);
        expect(base.body.equals(capture)).toBe(true);
        const decide = { id: "123", project: "compact-mantine", file: "slider--sizes.png", decision: "accept" };
        expect((await s.api("POST", "/api/decide", decide)).status).toBe(200);
        const item = (await s.api("GET", "/api/pr/123/compact-mantine")).body.items.find(
            (i) => i.file === "slider--sizes.png",
        );
        expect(item).toMatchObject({ status: "moved", from: "old-slider--sizes" });
    });
});

describe("serve: decisions and Finish", () => {
    it("keeps decisions in memory and refuses Accept on an unstable item", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const decide = (file, decision, reason) =>
            s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision, reason });
        expect((await decide("tooltip--hover.png", "accept")).status).toBe(409);
        expect((await decide("tooltip--hover.png", "exclude", "races")).status).toBe(200);
        expect((await decide("badge--default.light.png", "reject")).status).toBe(400);
        expect((await decide("badge--default.light.png", "accept")).status).toBe(200);
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({
            "tooltip--hover.png": { decision: "exclude", reason: "races" },
            "badge--default.light.png": { decision: "accept", reason: null },
        });
        const prs = await s.api("GET", "/api/prs");
        expect(prs.body.targets[0].projects[0].decided).toBe(2);
        expect((await decide("badge--default.light.png", null)).status).toBe(200);
        expect(Object.keys((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions)).toEqual([
            "tooltip--hover.png",
        ]);
    });

    it("finishes across every project in one commit, clears the accepts and keeps the rejects", async () => {
        // Finish says in the server's log when it starts, ends and fails.
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        onTestFinished(() => {
            out.mockRestore();
            err.mockRestore();
        });
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        });
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "graphty-element",
            file: "graph--basic.png",
            decision: "accept",
        });
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "slider--sizes.png",
            decision: "reject",
            reason: "thumb moved",
        });
        const { begun, job } = await finishJob(s, "123");
        expect(begun.status).toBe(202);
        expect(job.error).toBeNull();
        const body = job.result;
        expect(body.rejects).toBe(1);
        expect(git(s.remote, "rev-parse", "feature")).toBe(body.commit);
        expect(git(s.remote, "rev-parse", "feature~1")).toBe(s.head);
        const rejected = { "slider--sizes.png": { decision: "reject", reason: "thumb moved", posted: true } };
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toEqual(rejected);
        // A second Finish has nothing new to post.
        expect((await finishJob(s, "123")).job.error).toBe("nothing decided");
        expect(out.mock.calls.map(([line]) => line)).toEqual([
            "visual-review: Finish of #123 started: 3 decisions, 4 undecided",
            `visual-review: Finish of #123 done: commit ${body.commit}, 1 rejects`,
            "visual-review: Finish of #123 started: 0 decisions, 6 undecided",
        ]);
        expect(err.mock.calls.map(([line]) => line)).toEqual(["visual-review: Finish of #123 failed: nothing decided"]);
    });

    it("runs Finish in the background, reports its step, and refuses a second one and new decisions", async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        let reached;
        const atStatus = new Promise((resolve) => (reached = resolve));
        const s = await start({
            gh: (r) => {
                const gh = onePr()(r);
                return async (args, input) => {
                    if (args[1]?.includes("/statuses/")) {
                        reached();
                        await gate;
                    }
                    return gh(args, input);
                };
            },
        });
        await s.api("GET", "/api/prs");
        const decide = (file) =>
            s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision: "accept" });
        await decide("badge--default.light.png");
        expect((await s.api("GET", "/api/finish-status")).body.job).toBeNull();
        const begun = await s.api("POST", "/api/finish", { id: "123" });
        expect(begun.status).toBe(202);
        expect(begun.body.job).toMatchObject({ id: 1, target: "123", pr: 123, running: true });
        await atStatus;
        expect((await s.api("GET", "/api/finish-status")).body.job).toMatchObject({
            running: true,
            step: "posting the status",
        });
        const again = await s.api("POST", "/api/finish", { id: "123" });
        expect(again).toMatchObject({ status: 409, body: { error: "a Finish is already running" } });
        expect((await decide("button--primary.dark.png")).status).toBe(409);
        release();
        const job = await endedJob(s);
        expect(job).toMatchObject({ id: 1, running: false, step: null, error: null });
        expect(job.result.commit).toBe(git(s.remote, "rev-parse", "feature"));
        expect((await decide("button--primary.dark.png")).status).toBe(200);
    });

    it("reports the signing key the server's environment gives git", async () => {
        const s = await start({ gh: onePr() });
        const saved = { ...process.env };
        Object.assign(process.env, {
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "user.signingkey",
            GIT_CONFIG_VALUE_0: "/keys/agent.pub",
            GIT_CONFIG_KEY_1: "commit.gpgsign",
            GIT_CONFIG_VALUE_1: "yes",
        });
        try {
            const { body } = await s.api("GET", "/api/prs");
            expect(body.targets[0].signer).toMatchObject({
                signs: true,
                key: "/keys/agent.pub",
                keyFrom: "command line:",
                fromEnv: true,
            });
        } finally {
            for (const k of Object.keys(process.env).filter((k) => k.startsWith("GIT_CONFIG_"))) {
                delete process.env[k];
            }
            Object.assign(process.env, saved);
        }
    });

    it("keeps the decisions and returns git's stderr when the commit fails", async () => {
        const s = await start({ gh: onePr() });
        git(s.repo, "config", "gpg.ssh.program", "false");
        git(
            s.repo,
            "config",
            "user.signingkey",
            "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderKeyNeverUsedBecauseTheProgramFails",
        );
        git(s.repo, "config", "gpg.format", "ssh");
        git(s.repo, "config", "commit.gpgsign", "true");
        await s.api("GET", "/api/prs");
        await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        });
        const { job } = await finishJob(s, "123");
        expect(job.error).toContain("failed to write commit object");
        expect(git(s.remote, "rev-parse", "feature")).toBe(s.head);
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).body.decisions).toHaveProperty(
            "badge--default.light.png",
        );
    });
});

describe("serve: local results", () => {
    it("serves a results directory given with --results as one local preview, never master or a seed", async () => {
        const r = makeRepo();
        const dir = join(r.dir, "local");
        copyFixture("compact-mantine", join(dir, "compact-mantine"), { pr: null, runId: null, runAttempt: null });
        const s = await start({ ...r, gh: () => async () => "", results: dir });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets).toHaveLength(1);
        expect(body.targets[0]).toMatchObject({ id: "local", local: true, pr: null, branch: null });
        expect(body.targets[0].title).toMatch(/^local preview of /);
        expect((await s.api("GET", "/api/img/local/compact-mantine/capture/button--primary.dark.png")).status).toBe(
            200,
        );
    });

    it("takes no decision and no Finish on a local preview", async () => {
        const r = makeRepo();
        const s = await start({ ...r, gh: () => async () => "", results: FIXTURE });
        await s.api("GET", "/api/prs");
        const decide = (file, decision, reason) =>
            s.api("POST", "/api/decide", { id: "local", project: "compact-mantine", file, decision, reason });
        const refused = await decide("badge--default.light.png", "accept");
        expect(refused.status).toBe(403);
        expect(refused.body.error).toMatch(/local preview/);
        expect((await decide("card--legacy.png", "exclude", "noisy")).status).toBe(403);
        expect((await decide("card--legacy.png", "reject", "keep it")).status).toBe(403);
        expect((await s.api("GET", "/api/pr/local/compact-mantine")).body.acceptable).toBe(false);
        expect((await s.api("POST", "/api/finish", { id: "local" })).status).toBe(403);
    });
});

describe("serve: review extras", () => {
    const decide = (s, file, decision, reason, project = "compact-mantine") =>
        s.api("POST", "/api/decide", { id: "123", project, file, decision, reason });

    it("resumes decisions after a restart, dropping any whose image changed", async () => {
        const r = makeRepo();
        const first = await start({ ...r, gh: onePr() });
        await first.api("GET", "/api/prs");
        await decide(first, "badge--default.light.png", "accept");
        await decide(first, "card--legacy.png", "reject", "keep the card");
        server.close();
        const file = join(first.tmp, "state/123.json");
        const saved = JSON.parse(readFileSync(file, "utf8"));
        expect(saved["compact-mantine/badge--default.light.png"].hash).toMatch(/^545ffef5/);
        // The removed card's hash is its baseline's; a different hash means a different image.
        saved["compact-mantine/card--legacy.png"].hash = "0".repeat(64);
        writeFileSync(file, JSON.stringify(saved));
        const second = await start({ ...r, gh: onePr() });
        await second.api("GET", "/api/prs");
        const { body } = await second.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({ "badge--default.light.png": { decision: "accept", reason: null } });
    });

    it("never reverses a decision without an explicit Undo, and needs a reason for every reject", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        expect((await decide(s, "badge--default.light.png", "reject", "  ")).status).toBe(400);
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        // The same decision again is harmless; a different one is refused until Undo.
        expect((await decide(s, "badge--default.light.png", "accept")).status).toBe(200);
        const flipped = await decide(s, "badge--default.light.png", "reject", "too dark");
        expect(flipped.status).toBe(409);
        expect(flipped.body.error).toMatch(/already accepted: Undo it first/);
        expect((await decide(s, "badge--default.light.png", null)).status).toBe(200);
        expect((await decide(s, "badge--default.light.png", "reject", "too dark")).status).toBe(200);
    });

    it("accepts the undecided items of one component only", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const one = await s.api("POST", "/api/accept-all", {
            id: "123",
            project: "compact-mantine",
            component: "badge",
        });
        expect(one.body).toEqual({ accepted: 1, unpublished: 1 });
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(Object.keys(body.decisions)).toEqual(["badge--default.light.png"]);
    });

    it("posts one commit status when Finish completes, none per decision", async () => {
        const posted = [];
        const s = await start({ gh: onePr({ posted }), startCommand: "cd /repo && node serve" });
        await s.api("GET", "/api/prs");
        await decide(s, "badge--default.light.png", "accept");
        await decide(s, "slider--sizes.png", "reject", "thumb moved");
        expect(posted).toEqual([]);
        const body = (await finishJob(s, "123")).job.result;
        const statuses = posted.filter((p) => p.path.includes("/statuses/"));
        expect(statuses).toEqual([
            {
                path: `repos/{owner}/{repo}/statuses/${body.commit}`,
                body: {
                    state: "failure",
                    context: "Visual review",
                    description: "Reviewed: 1 accepted, 1 rejected, 0 excluded, 5 left undecided",
                },
            },
        ]);
        expect((await s.api("GET", "/api/target/123")).body.startCommand).toBe("cd /repo && node serve");
    });

    it("accepts every undecided acceptable item of a project and counts them as not opened", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        await decide(s, "slider--sizes.png", "reject", "too tall");
        const all = await s.api("POST", "/api/accept-all", { id: "123", project: "compact-mantine" });
        expect(all).toMatchObject({ status: 200, body: { accepted: 3 } });
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toEqual({
            "slider--sizes.png": { decision: "reject", reason: "too tall" },
            "button--primary.dark.png": { decision: "accept", reason: null, bulk: true },
            "badge--default.light.png": { decision: "accept", reason: null, bulk: true },
            "card--legacy.png": { decision: "accept", reason: null, bulk: true },
        });
        // Deciding an item one by one means it was opened.
        await decide(s, "card--legacy.png", "accept");
        const target = (await s.api("GET", "/api/target/123")).body;
        expect(target.projects.map((p) => [p.project, p.notOpened, p.undecided])).toEqual([
            ["compact-mantine", 2, 2],
            ["graphty-element", 0, 1],
        ]);
    });

    it("accepts a story with no baseline yet, one by one or all at once", async () => {
        const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        const items = fixture.items.map((i) =>
            i.file === "badge--default.light.png" ? { ...i, status: "unseeded" } : i,
        );
        const s = await start({
            gh: (r) =>
                onePr({ results: { "visual-compact-mantine-1": { commit: r.head, headSha: r.head, items } } })(r),
        });
        await s.api("GET", "/api/prs");
        const one = await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "accept",
        });
        expect(one.status).toBe(200);
        const all = await s.api("POST", "/api/accept-all", { id: "123", project: "compact-mantine" });
        expect(all.body).toEqual({ accepted: 3, unpublished: 4 });
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions["badge--default.light.png"]).toMatchObject({ decision: "accept" });
        const target = (await s.api("GET", "/api/target/123")).body.projects[0];
        expect(target).toMatchObject({ counts: { unseeded: 1 }, reviewable: 6, undecided: 2 });
    });

    it("flags an item whose earlier accept on this branch was replaced by master's baseline", async () => {
        const r = makeRepo();
        const record = (to) => ({
            version: 1,
            pr: 123,
            items: [
                { path: "visual-baselines/compact-mantine/button--primary.dark.png", from: null, to },
                {
                    path: "visual-baselines/compact-mantine/slider--sizes.png",
                    from: null,
                    to: "a3e01202b9e6b1844c02b3c217681ba2c7e8123fbc470e63320118c7dcb9a614",
                },
            ],
        });
        git(r.repo, "checkout", "-q", "feature");
        const reviews = join(r.repo, "visual-baselines/reviews");
        mkdirSync(reviews, { recursive: true });
        writeFileSync(join(reviews, "20260101T000000Z-pr123.json"), JSON.stringify(record("0".repeat(64))));
        writeFileSync(join(reviews, "20260102T000000Z-pr123.json"), JSON.stringify(record("e".repeat(64))));
        writeFileSync(join(reviews, "20260103T000000Z-pr999.json"), JSON.stringify({ ...record(null), pr: 999 }));
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "records");
        git(r.repo, "push", "-q", "origin", "feature");
        r.head = git(r.repo, "rev-parse", "HEAD");
        git(r.repo, "checkout", "-q", "master");
        const s = await start({ ...r, gh: onePr() });
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        const flagged = body.items.filter((i) => i.reReview).map((i) => i.file);
        expect(flagged).toEqual(["button--primary.dark.png"]);
    });
});

describe("serve: what the page waits on", () => {
    const decide = (s, file, decision, reason, project = "compact-mantine") =>
        s.api("POST", "/api/decide", { id: "123", project, file, decision, reason });
    const until = async (check) => {
        for (let i = 0; i < 300; i++) {
            const value = await check();
            if (value) {
                return value;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("timed out");
    };

    it("answers the cached list at once, with the refresh's step while one runs", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        const s = await start({
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if ((args[1] ?? "").includes("/pulls?")) {
                        await held;
                    }
                    return inner(args, input);
                };
            },
        });
        const first = (await s.api("GET", "/api/prs?cached=1")).body;
        expect(first.targets).toBeNull();
        expect(first.refreshing).toMatchObject({ step: "listing pull requests" });
        expect(first.defaultBranch).toBe("master");
        release();
        const loaded = await until(async () => {
            const b = (await s.api("GET", "/api/prs?cached=1")).body;
            return b.targets && b;
        });
        expect(loaded.targets.map((t) => t.id)).toEqual(["123"]);
        expect(loaded.refreshing).toBeNull();
        expect(loaded.updatedAt).toBeLessThanOrEqual(loaded.now);
        // ?refresh=1 starts one in the background and answers with the cache meanwhile.
        const again = (await s.api("GET", "/api/prs?refresh=1")).body;
        expect(again.targets.map((t) => t.id)).toEqual(["123"]);
        expect(again.refreshing).not.toBeNull();
    });

    it("lists captures still downloading as downloading, and fills them in when they land", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        const s = await start({
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (args[0] === "run") {
                        await held;
                    }
                    return inner(args, input);
                };
            },
        });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets[0].downloading).toBe(true);
        expect(body.targets[0].projects.map((p) => [p.downloading, p.problem])).toEqual([
            [true, null],
            [true, null],
        ]);
        release();
        const landed = await until(async () => {
            const t = (await s.api("GET", "/api/prs?cached=1")).body.targets[0];
            return !t.downloading && t;
        });
        expect(landed.projects.find((p) => p.project === "compact-mantine")).toMatchObject({
            downloading: false,
            problem: null,
            reviewable: 6,
        });
    });

    it("serves a grid thumbnail no wider than 400 pixels, made once", async () => {
        const wide = new PNG({ width: 1000, height: 500 });
        for (let i = 0; i < 1000 * 500; i++) {
            wide.data.set(i % 1000 < 500 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
        }
        const small = PNG.sync.read(thumbnail(PNG.sync.write(wide)));
        expect([small.width, small.height]).toEqual([400, 200]);
        expect([...small.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
        expect([...small.data.slice(399 * 4, 400 * 4)]).toEqual([0, 0, 255, 255]);

        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        const thumb = await s.api("GET", "/api/thumb/123/compact-mantine/capture/button--primary.dark.png");
        expect(thumb.type).toBe("image/png");
        expect(PNG.sync.read(thumb.body).width).toBeLessThanOrEqual(400);
        expect(readdirSync(join(s.tmp, "thumbs"))).toHaveLength(1);
        expect((await s.api("GET", "/api/thumb/123/compact-mantine/capture/nope.png")).status).toBe(404);
    });

    it("states what Finish would do, and refuses a Finish whose decisions changed since", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        expect((await decide(s, "badge--default.light.png", "accept", "intended")).body.unpublished).toBe(1);
        await decide(s, "slider--sizes.png", "reject", "too tall");
        await decide(s, "tooltip--hover.png", "exclude", "races");
        const { body } = await s.api("GET", "/api/target/123?finish=1");
        expect(body.unpublished).toBe(3);
        expect(body.finish).toMatchObject({
            accepts: 1,
            rejects: 1,
            excludes: 1,
            acceptNotes: 1,
            notes: [
                { decision: "accept", project: "compact-mantine", file: "badge--default.light.png", note: "intended" },
                { decision: "reject", project: "compact-mantine", file: "slider--sizes.png", note: "too tall" },
            ],
            status: { state: "failure" },
            unloaded: [],
        });
        expect(body.finish.undecided).toEqual([
            { project: "compact-mantine", undecided: 3 },
            { project: "graphty-element", undecided: 1 },
        ]);
        await decide(s, "card--legacy.png", "accept");
        const refused = await s.api("POST", "/api/finish", { id: "123", digest: body.finish.digest });
        expect(refused).toMatchObject({
            status: 409,
            body: { error: "Decisions changed since this sheet opened: check the summary again." },
        });
    });

    it("fills each project in as its own download lands, counting them", async () => {
        let release;
        const held = new Promise((resolve) => (release = resolve));
        const s = await start({
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (args[0] === "run" && args[4] === "visual-graphty-element-1") {
                        await held;
                    }
                    return inner(args, input);
                };
            },
        });
        await s.api("GET", "/api/prs");
        const half = await until(async () => {
            const t = (await s.api("GET", "/api/prs?cached=1")).body.targets[0];
            return t.download?.done === 1 && t;
        });
        expect(half.downloading).toBe(true);
        expect(half.download).toMatchObject({ done: 1, total: 2, startedAt: expect.any(Number) });
        expect(half.projects.map((p) => [p.project, p.downloading, p.reviewable])).toEqual([
            ["compact-mantine", false, 6],
            ["graphty-element", true, 0],
        ]);
        // The landed project opens while the other is still downloading.
        expect((await s.api("GET", "/api/pr/123/compact-mantine")).status).toBe(200);
        release();
        await until(async () => !(await s.api("GET", "/api/prs?cached=1")).body.targets[0].downloading);
    });

    it("needs the owner's approval of the previewed record for a Finish that commits", async () => {
        const key = testPasskey();
        const r = makeRepo();
        registerOnMaster(r, [key.entry]);
        const s = await start({ ...r, gh: onePr() });
        const listed = (await s.api("GET", "/api/prs")).body.targets[0];
        expect(listed.passkey).toEqual({
            required: true,
            keys: [{ id: key.entry.id, label: "test key", rpId: "localhost" }],
            problem: null,
            waiting: null,
        });
        await decide(s, "badge--default.light.png", "accept", "intended");
        await decide(s, "slider--sizes.png", "reject", "too tall");
        const { finish: f } = (await s.api("GET", "/api/target/123?finish=1")).body;
        expect(f.signing.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const post = (approval) => s.api("POST", "/api/finish", { id: "123", digest: f.digest, approval });
        expect((await post(undefined)).body.error).toMatch(/needs your passkey/);
        expect((await post(key.sign(f.signing.hash, { uv: false }))).body.error).toMatch(
            /approval was refused: .*without user verification/,
        );
        expect((await post(testPasskey().sign(f.signing.hash))).body.error).toMatch(/not registered/);
        const begun = await post(key.sign(f.signing.hash));
        expect(begun.status).toBe(202);
        const job = await endedJob(s);
        expect(job.error).toBeNull();
        const name = git(s.remote, "ls-tree", "--name-only", "feature", "visual-baselines/reviews/").split("\n")[0];
        const record = JSON.parse(git(s.remote, "show", `feature:${name}`));
        expect(record).toMatchObject({ version: 2, approval: { credentialId: key.entry.id } });
        expect(record.rejects).toHaveLength(1);
    });

    it("runs a Finish with only rejects without a passkey", async () => {
        const r = makeRepo();
        registerOnMaster(r, [testPasskey().entry]);
        const s = await start({ ...r, gh: onePr() });
        await s.api("GET", "/api/prs");
        await decide(s, "slider--sizes.png", "reject", "too tall");
        const { finish: f } = (await s.api("GET", "/api/target/123?finish=1")).body;
        expect(f.signing).toBeNull();
        expect((await s.api("POST", "/api/finish", { id: "123", digest: f.digest })).status).toBe(202);
        expect((await endedJob(s)).error).toBeNull();
    });

    it("opens the pull request that registers a passkey, and says it is waiting", async () => {
        const s = await start({ gh: onePr() });
        await s.api("GET", "/api/prs");
        expect((await s.api("GET", "/api/target/123")).body.passkey).toMatchObject({ required: false, waiting: null });
        const { entry } = testPasskey("dev.example.com");
        expect((await s.api("POST", "/api/passkey", { entry: { id: "x" } })).status).toBe(409);
        const opened = await s.api("POST", "/api/passkey", { entry });
        expect(opened).toMatchObject({ status: 200, body: { pullRequest: "https://gh/pull/650" } });
        const branch = git(s.remote, "branch", "--list", "visual/passkey-*").replace("*", "").trim();
        expect(JSON.parse(git(s.remote, "show", `${branch}:visual-review.passkeys.json`))).toEqual([entry]);
        expect((await s.api("GET", "/api/target/123")).body.passkey.waiting).toBe(650);
    });
});

describe("newestMasterCapture", () => {
    it("downloads the newest master run's complete capture, skipping runs without one", async () => {
        const r = makeRepo();
        const gh = fakeGh({
            masterRuns: [
                { id: 3000, head: "3".repeat(40) },
                { id: 2000, head: "2".repeat(40) },
                { id: 1000, head: r.master },
            ],
            artifacts: { 3000: [], 2000: ["visual-compact-mantine-1"], 1000: ["visual-compact-mantine-1"] },
            results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null, runId: 2000 } },
        });
        const tmp = join(r.dir, "reference");
        const dir = await newestMasterCapture(gh, "compact-mantine", tmp, FIXTURE_CONFIG);
        expect(dir).toBe(join(tmp, "2000-1", "compact-mantine"));
        expect(JSON.parse(readFileSync(join(dir, "results.json"), "utf8")).runId).toBe(2000);
    });

    it("skips a master commit with no run", async () => {
        const r = makeRepo();
        const gh = fakeGh({
            masterRuns: [
                { id: null, head: "4".repeat(40) },
                { id: 2000, head: r.master },
            ],
            artifacts: { 2000: ["visual-compact-mantine-1"] },
            results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null, runId: 2000 } },
        });
        const tmp = join(r.dir, "reference");
        expect(await newestMasterCapture(gh, "compact-mantine", tmp, FIXTURE_CONFIG)).toBe(
            join(tmp, "2000-1", "compact-mantine"),
        );
    });

    it("finds nothing when no master run has a complete capture", async () => {
        const r = makeRepo();
        const gh = fakeGh({
            masterRuns: [{ id: 2000, head: r.master }],
            artifacts: { 2000: ["visual-compact-mantine-1"] },
            results: { "visual-compact-mantine-1": { commit: r.master, pr: null, headSha: null, complete: false } },
        });
        expect(await newestMasterCapture(gh, "compact-mantine", join(r.dir, "reference"), FIXTURE_CONFIG)).toBeNull();
    });
});

describe("downloadCaptures", () => {
    const setup = () => {
        const r = makeRepo();
        const inner = fakeGh({ artifacts: { 1000: ["visual-compact-mantine-1"] } });
        const calls = [];
        return { r, inner, calls, tmp: join(r.dir, "downloads"), run: { id: 1000 } };
    };

    it("downloads a run once when two refreshes ask for it at the same time", async () => {
        const { inner, calls, tmp, run } = setup();
        const gh = async (args, input) => {
            if (args[0] === "run") {
                calls.push(args);
                // Extraction takes a while: the second caller arrives while the first is mid-way.
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return inner(args, input);
        };
        const [a, b] = await Promise.all([
            downloadCaptures(gh, run, ["compact-mantine"], tmp),
            downloadCaptures(gh, run, ["compact-mantine"], tmp),
        ]);
        expect(calls).toHaveLength(1);
        expect(a).toEqual(b);
        expect(existsSync(join(a["compact-mantine"].dir, "results.json"))).toBe(true);
        expect(readdirSync(join(tmp, "1000-1"))).toEqual(["compact-mantine"]);
    });

    it("leaves no directory behind when a download is interrupted, and retries next time", async () => {
        const { inner, tmp, run } = setup();
        const failing = async (args, input) => {
            if (args[0] === "run") {
                // Half-extracted, then gh dies: results.json (written last) never arrives.
                writeFileSync(join(args[6], "button--primary.png"), "partial");
                throw new Error("error extracting zip archive");
            }
            return inner(args, input);
        };
        const failed = await downloadCaptures(failing, run, ["compact-mantine"], tmp);
        expect(failed["compact-mantine"]).toEqual({ dir: null, attempt: 1, error: "error extracting zip archive" });
        expect(readdirSync(join(tmp, "1000-1"))).toEqual([]);

        const out = await downloadCaptures(inner, run, ["compact-mantine"], tmp);
        expect(existsSync(join(out["compact-mantine"].dir, "results.json"))).toBe(true);
    });

    it("replaces a leftover directory that has no results.json", async () => {
        const { inner, tmp, run } = setup();
        const dir = join(tmp, "1000-1", "compact-mantine");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "button--primary.png"), "partial");
        await downloadCaptures(inner, run, ["compact-mantine"], tmp);
        expect(existsSync(join(dir, "results.json"))).toBe(true);
    });
});

describe("network failures", () => {
    const NET = "error connecting to productionresultssa0.blob.core.windows.net\ncheck your internet connection";
    let logged;
    beforeEach(() => {
        logged = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => logged.mockRestore());
    const lines = () => logged.mock.calls.map(([line]) => line.split("\n")[0]);

    it("retries a gh call that failed on the network, then returns its answer", async () => {
        let calls = 0;
        const gh = withRetries(async () => {
            if (++calls <= 2) {
                throw new Error(NET);
            }
            return "ok";
        }, [0, 0, 0]);
        expect(await gh(["run", "download", "1"])).toBe("ok");
        expect(calls).toBe(3);
        expect(lines()).toEqual([
            "visual-review: gh run download 1 failed; retrying in 0 s: error connecting to productionresultssa0.blob.core.windows.net",
            "visual-review: gh run download 1 failed; retrying in 0 s: error connecting to productionresultssa0.blob.core.windows.net",
        ]);
    });

    it("gives up after the last delay", async () => {
        let calls = 0;
        const gh = withRetries(async () => {
            calls++;
            throw new Error("HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/pulls)");
        }, [0, 0]);
        await expect(gh(["api", "x"])).rejects.toThrow("HTTP 502");
        expect(calls).toBe(3);
    });

    it.each([
        ["a 4xx", ["api", "x"], "HTTP 404: Not Found (https://api.github.com/x)"],
        ["a missing artifact", ["run", "download", "1"], "no artifact matches any of the names or patterns provided"],
        ["a write", ["api", "x", "--input", "-"], NET],
    ])("does not retry %s", async (_, args, message) => {
        let calls = 0;
        const gh = withRetries(async () => {
            calls++;
            throw new Error(message);
        }, [0, 0, 0]);
        await expect(gh(args)).rejects.toThrow(message.split("\n")[0]);
        expect(calls).toBe(1);
        expect(lines()).toEqual([`visual-review: gh ${args.join(" ")} failed: ${message.split("\n")[0]}`]);
    });

    it("shows a project whose download failed, loads the others, and retries it on the next request", async () => {
        let down = true;
        const s = await start({
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    if (down && args[0] === "run" && args[4] === "visual-compact-mantine-1") {
                        throw new Error(NET);
                    }
                    return inner(args, input);
                };
            },
        });
        const first = (await s.api("GET", "/api/prs")).body.targets[0].projects;
        expect(first.find((p) => p.project === "compact-mantine").problem).toBe(
            "download failed: error connecting to productionresultssa0.blob.core.windows.net; reload the page to retry",
        );
        expect(first.find((p) => p.project === "graphty-element")).toMatchObject({ problem: null, reviewable: 1 });

        down = false;
        const second = (await s.api("GET", "/api/prs")).body.targets[0].projects;
        expect(second.find((p) => p.project === "compact-mantine")).toMatchObject({ problem: null, reviewable: 6 });
    });

    it("starts downloading at startup, and a request during it shares that refresh", async () => {
        const calls = [];
        const s = await start({
            warm: true,
            gh: (r) => {
                const inner = onePr()(r);
                return async (args, input) => {
                    calls.push(args.slice(0, 2).join(" "));
                    if (args[0] === "run") {
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    return inner(args, input);
                };
            },
        });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets.map((t) => t.id)).toEqual(["123"]);
        expect(calls.filter((c) => c === "run download")).toHaveLength(2);
        expect(calls.filter((c) => c.startsWith("api repos/{owner}/{repo}/pulls"))).toHaveLength(1);
    });

    // Pull request #123 loads; #124's CI run cannot be read; master run 2000 loads.
    const twoPrsAndMaster = (fail) => (r) => {
        const inner = fakeGh({
            prs: [
                { number: 123, head: r.head, branch: "feature" },
                { number: 124, head: "4".repeat(40), branch: "other" },
            ],
            runs: { [r.head]: { id: 1000, head: r.head } },
            runsById: { 2000: { id: 2000, head: r.master } },
            jobs: { 1000: [job("compact-mantine"), job("graphty-element")], 2000: [job("compact-mantine")] },
            artifacts: { 1000: ["visual-compact-mantine-1"], 2000: ["visual-compact-mantine-1"] },
        });
        return async (args, input) => {
            if (fail(args[1] ?? "")) {
                throw new Error("error connecting to api.github.com");
            }
            return inner(args, input);
        };
    };

    it("shows one pull request that cannot be loaded as failed, and loads the rest and master", async () => {
        const s = await start({ masterRun: 2000, gh: twoPrsAndMaster((path) => path.includes("head_sha=4444")) });
        const { status, body } = await s.api("GET", "/api/prs");
        expect(status).toBe(200);
        const byId = Object.fromEntries(body.targets.map((t) => [t.id, t]));
        expect(Object.keys(byId).sort()).toEqual(["123", "124", "master"]);
        expect(byId["124"]).toMatchObject({ pr: 124, runId: null, branch: "other" });
        expect(byId["124"].projects.map((p) => p.problem)).toEqual([
            "failed to load: error connecting to api.github.com; reload the page to retry",
            "failed to load: error connecting to api.github.com; reload the page to retry",
        ]);
        expect(byId["123"].projects.find((p) => p.project === "compact-mantine").problem).toBeNull();
        expect(byId.master.projects.find((p) => p.project === "compact-mantine").problem).toBeNull();
    });

    it("still loads master when the list of pull requests cannot be read", async () => {
        const s = await start({ masterRun: 2000, gh: twoPrsAndMaster((path) => path.includes("/pulls?")) });
        const { status, body } = await s.api("GET", "/api/prs");
        expect(status).toBe(200);
        expect(body.targets.map((t) => t.id)).toEqual(["master"]);
        expect(lines()).toContain("visual-review: pull requests not listed: error connecting to api.github.com");
    });
});
