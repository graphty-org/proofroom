/*
 * One test per confirmed failure scenario of the review server, Finish, the gate and the config,
 * each named after its scenario. A scenario the code still gets wrong is `it.fails`: the suite
 * stays green, and the fix that makes the scenario behave flips its test to a plain it().
 * The page's scenarios are in fault-scenarios.page.test.mjs.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { newestResults } from "../trusted/gate.mjs";
import { finish } from "../trusted/lib/accept.mjs";
import { normalizeConfig } from "../trusted/lib/config.mjs";
import { downloadCaptures, visualJobs, withRetries } from "../trusted/lib/github.mjs";
import { sessionToken } from "../trusted/lib/serve.mjs";
import { storySettings } from "../capture/capture.mjs";
import { hooks } from "./fault-hooks.mjs";
import { captureLog, endedJob, injector, startApp, world } from "./faults.mjs";
import { CONFIG, copyFixture, FIXTURE, git, isolateGit, job, makeRepo, pushCommit } from "./helpers.mjs";

vi.mock("node:fs", async (importOriginal) => (await import("./fault-hooks.mjs")).faultyFs(await importOriginal()));
vi.mock("../trusted/lib/github.mjs", async (importOriginal) =>
    (await import("./fault-hooks.mjs")).faultyGithub(await importOriginal()),
);

isolateGit();

const NET = "error connecting to productionresultssa0.blob.core.windows.net\ncheck your internet connection";
const NOW = new Date("2026-09-27T15:04:05Z");
const OTHER = "4".repeat(40);
// graphty-element's capture: bytes and a hash that differ from every compact-mantine capture.
const OTHER_PNG = join(FIXTURE, "graphty-element/graph--basic.png");
const OTHER_HASH = "a0a220a4d92cbdfe3bb07d7738c2e818e473cf5bf0c666202897a4177c92c7d9";
const BUTTON_BASELINE = join(FIXTURE, "compact-mantine/baselines/button--primary.dark.png");
const BUTTON_BASELINE_HASH = "c87ce8a8f8e6fd0e5d6098ddc41c417ce182e564a60184474890dd3d93cf1135";
const CM_ITEMS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items;

let servers = [];
let log = null;
afterEach(async () => {
    injector().uninstall();
    log?.restore();
    log = null;
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
});

/**
 * Starts the app on `r` over the fake GitHub `w`, with gh's retries as the CLI has them.
 * @param {{ repo: string }} r the repository
 * @param {{ gh: Function }} w the fake GitHub
 * @param {object} [options] more createApp options (another gh, tmp, token)
 * @returns {Promise<object>} the started server
 */
async function serve(r, w, options = {}) {
    const s = await startApp(r, { gh: withRetries(w.gh, [0, 0, 0]), ...options });
    servers.push(s);
    return s;
}

const decide = (s, project, file, decision, reason = null, id = "123") =>
    s.api("POST", "/api/decide", { id, project, file, decision, reason });
const saved = (s, id = "123") => JSON.parse(readFileSync(join(s.tmp, "state", `${id}.json`), "utf8"));
const finishJob = async (s, id = "123") => {
    const begun = await s.api("POST", "/api/finish", { id });
    return begun.status === 202 ? endedJob(s) : begun.body;
};
const projectOf = (body, id, project) =>
    body.targets.find((t) => t.id === id)?.projects.find((p) => p.project === project);
const within = (ms, promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

/**
 * A second pull request, #124 on branch `other`, with CI run 1001 capturing both projects.
 * @param {object} w the fake GitHub
 * @param {string} [head] its head
 * @param {string} [branch] its branch
 */
function addPr124(w, head = OTHER, branch = "other") {
    w.data.prs.push({ number: 124, head, branch });
    w.data.runs[head] = { id: 1001, attempt: 1 };
    w.data.jobs[1001] = [job("compact-mantine"), job("graphty-element")];
    w.data.artifacts[1001] = ["visual-compact-mantine-1", "visual-graphty-element-1"];
}

/**
 * Finish called directly, on pull request #123 with both projects captured at its head.
 * @param {object} [config] the settings
 * @returns {object} the repository, the projects and `run(decisions, target)`
 */
function finishSetup(config = CONFIG) {
    const r = makeRepo();
    const at = { commit: r.head, headSha: r.head };
    const projects = {
        "compact-mantine": copyFixture("compact-mantine", join(r.dir, "art/compact-mantine"), at),
        "graphty-element": copyFixture("graphty-element", join(r.dir, "art/graphty-element"), at),
    };
    const gh = async () => JSON.stringify({ html_url: "https://gh/pull/9" });
    const run = (decisions, target = { pr: 123, branch: "feature" }) =>
        finish({ repo: r.repo, gh, target, projects, decisions, now: NOW, config });
    return { ...r, projects, run };
}
const accept = (file, project = "compact-mantine") => ({ project, file, decision: "accept", reason: null });

describe("decisions across runs, attempts and restarts", () => {
    it("Saved decisions are erased when a project has no results the first time a run is summarized (CI still running, or one download failed)", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        expect((await decide(s, "compact-mantine", "slider--sizes.png", "reject", "thumb moved")).status).toBe(200);
        // A new run on the same head, still capturing: no artifact yet.
        w.data.runs[r.head] = { id: 2000, attempt: 1, status: "in_progress", conclusion: null };
        w.data.jobs[2000] = [job("compact-mantine", null), job("graphty-element", null)];
        w.data.artifacts[2000] = [];
        await s.api("GET", "/api/prs");
        // The run completes, with the same images.
        w.data.runs[r.head] = { id: 2000, attempt: 1 };
        w.data.jobs[2000] = [job("compact-mantine"), job("graphty-element")];
        w.data.artifacts[2000] = ["visual-compact-mantine-1", "visual-graphty-element-1"];
        await s.api("GET", "/api/prs");
        expect((await decide(s, "graphty-element", "graph--basic.png", "accept")).status).toBe(200);
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions["slider--sizes.png"]).toMatchObject({ decision: "reject", reason: "thumb moved" });
        expect(saved(s)["compact-mantine/slider--sizes.png"]).toMatchObject({ decision: "reject" });
    });

    it("Saved decisions are erased when a project has no results the first time a run is summarized (one download failed after a restart)", async () => {
        const r = makeRepo();
        const w = world(r);
        const first = await serve(r, w);
        await first.api("GET", "/api/prs");
        expect((await decide(first, "compact-mantine", "slider--sizes.png", "reject", "thumb moved")).status).toBe(200);
        await first.close();
        // The restarted server downloads again, and the network drops through every retry.
        rmSync(join(first.tmp, "1000-1"), { recursive: true, force: true });
        // The first attempt and its three retries fail: one page load's worth.
        const inj = injector({
            rules: [1, 2, 3, 4].map((nth) => ({
                on: "gh",
                match: "run download 1000 -n visual-compact-mantine-1",
                nth,
                kind: "network",
            })),
        });
        const second = await serve(r, w, { gh: withRetries(inj.gh(w.gh), [0, 0, 0]) });
        const res = await second.api("GET", "/api/prs");
        expect(projectOf(res.body, "123", "compact-mantine").problem).toMatch(/^download failed/);
        const reloaded = await second.api("GET", "/api/prs");
        expect(projectOf(reloaded.body, "123", "compact-mantine").problem).toBeNull();
        expect((await decide(second, "graphty-element", "graph--basic.png", "accept")).status).toBe(200);
        expect(saved(second)["compact-mantine/slider--sizes.png"]).toMatchObject({ decision: "reject" });
    });

    it("A re-run attempt reuses decisions taken on the previous attempt's images, restamps them with the new hashes, and Finish commits bytes nobody saw", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        expect((await decide(s, "compact-mantine", "badge--default.light.png", "accept")).status).toBe(200);
        // The visual job is re-run, and attempt 2 captured the badge differently.
        w.data.runs[r.head] = { id: 1000, attempt: 2 };
        w.data.artifacts[1000].push("visual-compact-mantine-2");
        w.data.results["visual-compact-mantine-2"] = {
            items: CM_ITEMS.map((i) => (i.file === "badge--default.light.png" ? { ...i, capture: OTHER_HASH } : i)),
        };
        w.data.files["visual-compact-mantine-2"] = { "badge--default.light.png": OTHER_PNG };
        await s.api("GET", "/api/prs");
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.results.runAttempt).toBe(2);
        expect(body.decisions["badge--default.light.png"]).toBeUndefined();
        expect((await decide(s, "compact-mantine", "button--primary.dark.png", "accept")).status).toBe(200);
        expect(saved(s)["compact-mantine/badge--default.light.png"]?.hash).not.toBe(OTHER_HASH);
        const j = await finishJob(s);
        const files = git(r.remote, "show", "--name-only", "--format=", "feature");
        expect(j.error ?? "").not.toMatch(/badge/);
        expect(files).not.toContain("visual-baselines/compact-mantine/badge--default.light.png");
    });

    it("A re-run attempt reuses decisions taken on the previous attempt's images, restamps them with the new hashes, and Finish commits bytes nobody saw (the new attempt lacks a decided item)", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        expect((await decide(s, "compact-mantine", "badge--default.light.png", "accept")).status).toBe(200);
        w.data.runs[r.head] = { id: 1000, attempt: 2 };
        w.data.artifacts[1000].push("visual-compact-mantine-2");
        const items = CM_ITEMS.filter((i) => i.file !== "badge--default.light.png");
        w.data.results["visual-compact-mantine-2"] = { items, expected: items.length };
        await s.api("GET", "/api/prs");
        const res = await decide(s, "compact-mantine", "button--primary.dark.png", "accept");
        expect(res).toMatchObject({ status: 200 });
    });

    it("The page shows an earlier run's cached images while decisions are recorded against the server's current run", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        const shown = CM_ITEMS.find((i) => i.file === "button--primary.dark.png").capture;
        // Another tab loads the list: the server moves to run 1001, whose button differs.
        w.data.runs[r.head] = { id: 1001, attempt: 1 };
        w.data.jobs[1001] = [job("compact-mantine"), job("graphty-element")];
        w.data.artifacts[1001] = ["visual-compact-mantine-1", "visual-graphty-element-1"];
        w.data.results["1001/visual-compact-mantine-1"] = {
            items: CM_ITEMS.map((i) =>
                i.file === "button--primary.dark.png" ? { ...i, capture: BUTTON_BASELINE_HASH } : i,
            ),
        };
        w.data.files["1001/visual-compact-mantine-1"] = { "button--primary.dark.png": BUTTON_BASELINE };
        await s.api("GET", "/api/prs");
        const res = await s.api("POST", "/api/decide", {
            id: "123",
            project: "compact-mantine",
            file: "button--primary.dark.png",
            decision: "accept",
            reason: null,
            hash: shown,
            runId: 1000,
            runAttempt: 1,
        });
        expect(res.status).toBe(409);
    });

    it("A stale grid re-creates an accept that was undone in another tab or already committed by Finish (server)", async () => {
        const r = makeRepo();
        const s = await serve(r, world(r));
        await s.api("GET", "/api/prs");
        const opened = { id: "123", project: "compact-mantine", file: "badge--default.light.png", opened: true };
        expect((await s.api("POST", "/api/accept-all", { id: "123", project: "compact-mantine" })).status).toBe(200);
        expect((await s.api("POST", "/api/decide", { ...opened, decision: "accept", reason: null })).status).toBe(200);
        expect(saved(s)["compact-mantine/badge--default.light.png"]).not.toHaveProperty("bulk");
        await decide(s, "compact-mantine", "badge--default.light.png", null);
        expect((await s.api("POST", "/api/decide", { ...opened, decision: "accept", reason: null })).status).toBe(200);
        expect(saved(s)).not.toHaveProperty(["compact-mantine/badge--default.light.png"]);
        const stale = { id: "123", project: "compact-mantine", runId: 999, runAttempt: 1 };
        expect((await s.api("POST", "/api/accept-all", stale)).status).toBe(409);
    });

    it("A kept decision on an item that is no longer decidable (unchanged, unseeded) is invisible, skews the counts, and makes every Finish fail", async () => {
        const r = makeRepo();
        const w = world(r);
        const tmp = join(r.repo, "tmp/visual-review");
        mkdirSync(join(tmp, "state"), { recursive: true });
        const input = CM_ITEMS.find((i) => i.file === "input--default.png");
        writeFileSync(
            join(tmp, "state/123.json"),
            JSON.stringify({
                "compact-mantine/input--default.png": { decision: "accept", reason: null, hash: input.capture },
            }),
        );
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        const cm = (await s.api("GET", "/api/target/123")).body.projects.find((p) => p.project === "compact-mantine");
        expect(cm).toMatchObject({ reviewable: 6, decided: 0, undecided: 6 });
        expect((await decide(s, "compact-mantine", "badge--default.light.png", "accept")).status).toBe(200);
        const j = await finishJob(s);
        expect(j.error).toBeNull();
    });

    it("The state file is rewritten in place, and an unreadable one is silently treated as empty and then overwritten", async () => {
        const r = makeRepo();
        const w = world(r);
        const first = await serve(r, w);
        await first.api("GET", "/api/prs");
        await decide(first, "compact-mantine", "badge--default.light.png", "accept");
        await first.close();
        const file = join(first.tmp, "state/123.json");
        const broken = readFileSync(file).subarray(0, 20);
        writeFileSync(file, broken);
        log = captureLog(vi);
        const second = await serve(r, w);
        await second.api("GET", "/api/prs");
        expect(log.lines.some((l) => l.includes("123.json"))).toBe(true);
        expect((await decide(second, "compact-mantine", "button--primary.dark.png", "accept")).status).toBe(200);
        const dir = join(first.tmp, "state");
        const kept = readdirSync(dir).some((f) => readFileSync(join(dir, f)).equals(broken));
        expect(kept).toBe(true);
    });

    it("A malformed entry in a state file blanks every target with a 500", async () => {
        const r = makeRepo();
        const w = world(r);
        const tmp = join(r.repo, "tmp/visual-review");
        mkdirSync(join(tmp, "state"), { recursive: true });
        writeFileSync(join(tmp, "state/123.json"), JSON.stringify({ "x/y.png": null }));
        log = captureLog(vi);
        const s = await serve(r, w);
        const res = await s.api("GET", "/api/prs");
        expect(res.status).toBe(200);
        expect(log.lines.some((l) => l.includes("123.json"))).toBe(true);
    });

    it("A failed state write still changes the server's memory, so the page, the server and the disk disagree", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        expect((await decide(s, "compact-mantine", "badge--default.light.png", "accept")).status).toBe(200);
        injector({
            rules: [{ on: "fs", match: /^fs\.writeFileSync .*state\/123\.json/, kind: "denied" }],
        }).install();
        expect((await decide(s, "compact-mantine", "badge--default.light.png", null)).status).toBe(500);
        const { body } = await s.api("GET", "/api/pr/123/compact-mantine");
        expect(body.decisions).toHaveProperty("badge--default.light.png");
    });

    it("Two servers on one work directory overwrite each other's decisions and share the accept worktree path", async () => {
        const r = makeRepo();
        const w = world(r);
        const a = await serve(r, w);
        let b;
        try {
            b = await serve(r, w);
        } catch {
            return; // Refusing to start a second server is one of the two fixes.
        }
        await a.api("GET", "/api/prs");
        await b.api("GET", "/api/prs");
        expect((await decide(a, "compact-mantine", "badge--default.light.png", "accept")).status).toBe(200);
        expect((await decide(b, "compact-mantine", "button--primary.dark.png", "accept")).status).toBe(200);
        expect(Object.keys(saved(a)).sort()).toEqual([
            "compact-mantine/badge--default.light.png",
            "compact-mantine/button--primary.dark.png",
        ]);
    });
});

describe("refreshing the targets", () => {
    it("One failed refresh discards targets that had already loaded (all PRs with --master-run, or one PR's target), with misleading 404s afterwards", async () => {
        const r = makeRepo();
        const w = world(r);
        let down = false;
        const gh = async (args, input) => {
            if (down && args[1]?.includes("head_sha=")) {
                throw new Error("HTTP 403: API rate limit exceeded for user ID 1.");
            }
            return w.gh(args, input);
        };
        const s = await serve(r, w, { gh: withRetries(gh, [0, 0, 0]) });
        log = captureLog(vi);
        await s.api("GET", "/api/prs");
        expect((await decide(s, "compact-mantine", "badge--default.light.png", "accept")).status).toBe(200);
        down = true;
        const res = await s.api("GET", "/api/prs");
        const t = res.body.targets.find((x) => x.id === "123");
        expect(t).toMatchObject({ runId: 1000 });
        expect(t.projects.reduce((n, p) => n + p.decided, 0)).toBe(1);
        expect(JSON.stringify(t)).toMatch(/rate limit/);
        expect((await decide(s, "compact-mantine", "button--primary.dark.png", "accept")).status).toBe(200);
    });

    it("One failed refresh discards targets that had already loaded (all PRs with --master-run, or one PR's target), with misleading 404s afterwards (--master-run)", async () => {
        const r = makeRepo();
        const w = world(r);
        w.data.runs[r.master] = { id: 2000, attempt: 1 };
        w.data.jobs[2000] = [job("compact-mantine"), job("graphty-element")];
        w.data.artifacts[2000] = ["visual-compact-mantine-1", "visual-graphty-element-1"];
        let down = false;
        const gh = async (args, input) => {
            if (down && args[1]?.includes("/pulls?state=open")) {
                throw new Error("HTTP 502: Bad Gateway");
            }
            return w.gh(args, input);
        };
        const s = await startApp(r, { gh: withRetries(gh, [0, 0, 0]), masterRun: 2000 });
        servers.push(s);
        log = captureLog(vi);
        await s.api("GET", "/api/prs");
        down = true;
        const res = await s.api("GET", "/api/prs");
        expect(res.body.targets.map((t) => t.id).sort()).toEqual(["123", "master"]);
        expect(JSON.stringify(res.body)).toMatch(/502/);
    });

    it("A CI run still in progress reads 'capture failed', and a new head with no run yet drops the PR from the list", async () => {
        const r = makeRepo();
        const w = world(r);
        w.data.runs[r.head] = { id: 1000, attempt: 1, status: "in_progress", conclusion: null };
        w.data.jobs[1000] = [job("compact-mantine", null), job("graphty-element", null)];
        w.data.artifacts[1000] = [];
        w.data.prs.push({ number: 124, head: OTHER, branch: "other" });
        const s = await serve(r, w);
        const { body } = await s.api("GET", "/api/prs");
        expect(projectOf(body, "123", "compact-mantine").problem).not.toBe("capture failed");
        expect(body.targets.map((t) => t.id)).toContain("124");
    });

    it("The graphty project is matched to the 'visual (graphty-element)' job", async () => {
        const gh = async () =>
            JSON.stringify({
                jobs: [
                    { name: "visual (graphty-element)", conclusion: "failure", html_url: "https://gh/job/ge" },
                    { name: "visual (graphty)", conclusion: "success", html_url: "https://gh/job/g" },
                ],
            });
        const out = await visualJobs(gh, { id: 1 }, 1, ["graphty", "graphty-element"]);
        expect(out.graphty).toEqual({ conclusion: "success", url: "https://gh/job/g" });
    });

    it("Swallowed git fetch failures make the 'merge master first' badge wrong with no log", async () => {
        const r = makeRepo();
        const w = world(r);
        addPr124(w, OTHER, "deleted-branch");
        log = captureLog(vi);
        const s = await serve(r, w);
        const { body } = await s.api("GET", "/api/prs");
        const byId = Object.fromEntries(body.targets.map((t) => [t.id, t]));
        expect(byId["123"].mergeMasterFirst).toBe(false);
        expect(byId["124"].mergeMasterFirst).not.toBe(true);
        expect(log.lines.some((l) => /fetch/.test(l))).toBe(true);
    });

    it("Common gh transfer errors are not treated as transient, and git network steps are never retried", async () => {
        log = captureLog(vi);
        let calls = 0;
        const gh = withRetries(async () => {
            if (++calls === 1) {
                throw new Error("unexpected EOF");
            }
            return "ok";
        }, [0]);
        expect(await gh(["run", "download", "1"])).toBe("ok");
        expect(log.lines.some((l) => l.includes("retrying"))).toBe(true);
    });

    it("An expired artifact hides a capture already on disk and reads as 'capture failed'", async () => {
        const r = makeRepo();
        const w = world(r);
        copyFixture("compact-mantine", join(r.repo, "tmp/visual-review/1000-1/compact-mantine"), {
            commit: r.head,
            headSha: r.head,
        });
        w.data.artifacts[1000] = [{ name: "visual-compact-mantine-1", expired: true }, "visual-graphty-element-1"];
        const s = await serve(r, w);
        const { body } = await s.api("GET", "/api/prs");
        expect(projectOf(body, "123", "compact-mantine").problem).toBeNull();
    });

    it("A damaged cached artifact (bad results.json or a bad PNG) is never re-downloaded and is misreported", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        writeFileSync(join(s.tmp, "1000-1/compact-mantine/results.json"), "{");
        log = captureLog(vi);
        const { body } = await s.api("GET", "/api/prs");
        const downloads = w.data.calls.filter((c) => c.startsWith("run download 1000 -n visual-compact-mantine-1"));
        expect(downloads).toHaveLength(2);
        expect(projectOf(body, "123", "compact-mantine").problem).toBeNull();
        expect(log.lines.some((l) => l.includes("results.json"))).toBe(true);
    });

    it("Interrupted downloads leave .part- directories, and superseded runs are never pruned", async () => {
        const r = makeRepo();
        const w = world(r);
        const tmp = join(r.dir, "downloads");
        const stale = join(tmp, "1000-1/compact-mantine.part-abc");
        mkdirSync(stale, { recursive: true });
        await downloadCaptures(w.gh, { id: 1000 }, ["compact-mantine"], tmp);
        expect(existsSync(stale)).toBe(false);
    });

    it("One slow download holds the whole target list with no progress", async () => {
        const r = makeRepo();
        const w = world(r);
        addPr124(w);
        let release;
        const held = new Promise((resolve) => (release = resolve));
        const gh = async (args, input) => {
            if (args[0] === "run" && args[2] === "1001") {
                await held;
            }
            return w.gh(args, input);
        };
        const s = await startApp(r, { gh });
        servers.push(s);
        try {
            const res = await within(1500, s.api("GET", "/api/prs"));
            expect(res, "GET /api/prs waited for #124's download").not.toBeNull();
            expect(res.body.targets.map((t) => t.id)).toContain("123");
            expect(JSON.stringify(res.body.targets.find((t) => t.id === "124"))).toMatch(/download/i);
        } finally {
            release();
        }
    });

    it("Requests for a vanished target each run a full GitHub refresh and then answer a bare 404", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        w.data.prs = [];
        await s.api("GET", "/api/prs");
        let last;
        for (let i = 0; i < 20; i++) {
            last = await s.api("GET", "/api/img/123/compact-mantine/capture/button--primary.dark.png");
        }
        expect(w.data.calls.filter((c) => c.includes("pulls?state=open")).length).toBeLessThanOrEqual(3);
        expect(last.body.error).not.toMatch(/^no such/);
    });

    it("The review page lists only the projects in the server's local config", async () => {
        const r = makeRepo();
        const w = world(r);
        w.data.artifacts[1000].push("visual-newproj-1");
        const s = await serve(r, w);
        const { body } = await s.api("GET", "/api/prs");
        expect(JSON.stringify(body)).toContain("newproj");
    });
});

describe("stalls", () => {
    // The knob a fix reads for its per-call timeout; rename it here if the fix names it otherwise.
    const TIMEOUT = "VISUAL_REVIEW_TIMEOUT_MS";

    it("A stalled gh or git call hangs every page load, or holds the Finish lock forever, with no log line", async () => {
        process.env[TIMEOUT] = "500";
        try {
            const r = makeRepo();
            const w = world(r);
            log = captureLog(vi);
            injector({
                rules: [{ on: "git", match: /^git fetch -q origin \+refs\/heads\/feature/, kind: "stall" }],
            }).install();
            const s = await serve(r, w);
            const res = await within(3000, s.api("GET", "/api/prs"));
            expect(res, "GET /api/prs never answered").not.toBeNull();
            expect(log.lines.some((l) => l.includes("fetch"))).toBe(true);
        } finally {
            delete process.env[TIMEOUT];
        }
    });

    it("A stalled gh or git call hangs every page load, or holds the Finish lock forever, with no log line (Finish)", async () => {
        process.env[TIMEOUT] = "500";
        try {
            const r = makeRepo();
            const w = world(r);
            const s = await serve(r, w);
            await s.api("GET", "/api/prs");
            await decide(s, "compact-mantine", "badge--default.light.png", "accept");
            injector({ rules: [{ on: "git", match: /^git push /, kind: "stall" }] }).install();
            await s.api("POST", "/api/finish", { id: "123" });
            const j = await within(3000, endedJob(s));
            expect(j, "the Finish never ended").not.toBeNull();
            expect(j.error).toMatch(/push/);
            expect((await decide(s, "compact-mantine", "button--primary.dark.png", "accept")).status).toBe(200);
        } finally {
            delete process.env[TIMEOUT];
        }
    });
});

describe("Finish", () => {
    it("Master seed: the branch is pushed but opening its pull request fails, and every retry is refused with 'already exists on origin'", async () => {
        const r = makeRepo();
        const master = { commit: r.master, headSha: null, pr: null };
        const projects = {
            "compact-mantine": copyFixture("compact-mantine", join(r.dir, "m/compact-mantine"), master),
        };
        let down = true;
        const calls = [];
        const gh = async (args) => {
            calls.push(args.join(" "));
            if (down && args[1] === "repos/{owner}/{repo}/pulls") {
                throw new Error(NET);
            }
            return JSON.stringify({ html_url: "https://gh/pull/9" });
        };
        const run = () =>
            finish({
                repo: r.repo,
                gh,
                target: { pr: null, branch: null },
                projects,
                decisions: [accept("badge--default.light.png")],
                now: NOW,
                config: CONFIG,
            });
        const branch = "visual/seed-2026-09-27";
        const err = await run().catch((e) => e);
        const pushed = git(r.remote, "rev-parse", `refs/heads/${branch}`);
        expect(err.committed).toBe(pushed);
        expect(err.message).toContain(branch);
        down = false;
        calls.length = 0;
        const out = await run();
        expect(calls).toContain("api repos/{owner}/{repo}/pulls --input -");
        expect(out.pullRequest).toBe("https://gh/pull/9");
        expect(git(r.remote, "rev-parse", `refs/heads/${branch}`)).toBe(pushed);
    });

    it("Finish posts 'success, 0 left undecided' and its confirm says nothing while a project failed to load", async () => {
        const r = makeRepo();
        const w = world(r);
        w.data.artifacts[1000] = ["visual-compact-mantine-1"];
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        expect((await s.api("POST", "/api/accept-all", { id: "123", project: "compact-mantine" })).status).toBe(200);
        await decide(s, "compact-mantine", "tooltip--hover.png", "exclude", "races");
        await decide(s, "compact-mantine", "menu--open.png", "exclude", "times out");
        const j = await finishJob(s);
        expect(j.error).toBeNull();
        const status = w.data.posted.find((p) => p.path.includes("/statuses/"));
        expect(status.body.state).toBe("pending");
    });

    it("Finish and other server failures are never written to the server log", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        await decide(s, "compact-mantine", "badge--default.light.png", "accept");
        git(r.repo, "remote", "set-url", "origin", join(r.dir, "gone.git"));
        log = captureLog(vi);
        const j = await finishJob(s);
        expect(j.error).toBeTruthy();
        const first = j.error.split("\n")[0];
        expect(log.lines.some((l) => l.includes("123") && l.includes(first))).toBe(true);
    });

    it("A save failure after a successful push reports the Finish as failed, and can crash the server on an unhandled rejection", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        await decide(s, "compact-mantine", "badge--default.light.png", "accept");
        injector({
            rules: [{ on: "fs", match: /^fs\.writeFileSync .*state\/123\.json/, kind: "denied" }],
        }).install();
        const j = await finishJob(s);
        expect(j.result?.commit).toBe(git(r.remote, "rev-parse", "feature"));
        expect(j.error).toBeNull();
        expect(JSON.stringify(j)).toMatch(/EACCES/);
    });

    it("A removeWorktree failure in finally hides a successful push", async () => {
        const s = finishSetup();
        injector({ rules: [{ on: "git", match: /^git worktree prune/, nth: 2, kind: "partial write" }] }).install();
        const out = await s.run([accept("badge--default.light.png")]).catch((e) => e);
        const tip = git(s.remote, "rev-parse", "feature");
        expect(tip).not.toBe(s.head);
        expect(out).not.toBeInstanceOf(Error);
        expect(out.commit).toBe(tip);
    });

    it("A server killed during `git worktree add` leaves a locked worktree that blocks every later Finish on that target", async () => {
        const s = finishSetup();
        const tree = join(s.repo, CONFIG.workDir, "worktrees", "accept-123");
        git(s.repo, "worktree", "add", "-q", "--detach", tree, s.head);
        git(s.repo, "worktree", "lock", "--reason", "initializing", tree);
        const out = await s.run([accept("badge--default.light.png")]).catch((e) => e);
        expect(out).not.toBeInstanceOf(Error);
        expect(out.commit).toBe(git(s.remote, "rev-parse", "feature"));
    });

    it("A reload during Finish runs a concurrent git fetch into the same remote-tracking refs, which can fail Finish on a ref lock", async () => {
        const r = makeRepo();
        const w = world(r);
        const s = await serve(r, w);
        await s.api("GET", "/api/prs");
        await decide(s, "compact-mantine", "badge--default.light.png", "accept");
        // git takes a lock on each ref it updates; a second fetch of the same ref while the first
        // holds it fails as git does. The page's reload holds its fetch of master open.
        const locked = new Set();
        let reached;
        const atFetch = new Promise((resolve) => (reached = resolve));
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        hooks.exec = async (real, cmd, args, options) => {
            const ref =
                cmd === "git" && args.includes("fetch") && args.find((a) => a.endsWith(":refs/remotes/origin/master"));
            if (!ref) {
                return real(cmd, args, options);
            }
            if (locked.has(ref)) {
                throw new Error(
                    "error: cannot lock ref 'refs/remotes/origin/master': Unable to create '.git/refs/remotes/origin/master.lock': File exists.",
                );
            }
            locked.add(ref);
            try {
                if (!args.includes("-c")) {
                    reached();
                    await gate;
                }
                return await real(cmd, args, options);
            } finally {
                locked.delete(ref);
            }
        };
        const reload = s.api("GET", "/api/prs");
        await atFetch;
        const begun = s.api("POST", "/api/finish", { id: "123" });
        await begun;
        const j = await endedJob(s);
        release();
        await reload;
        expect(j.error).toBeNull();
    });

    it("A restart during Finish loses the job: the page shows the plain target list and the server log says nothing (server)", async () => {
        const r = makeRepo();
        const tmp = join(r.repo, "tmp/visual-review");
        mkdirSync(join(tmp, "state"), { recursive: true });
        const running = { id: 3, target: "123", pr: 123, branch: "feature", running: true, step: "pushing" };
        writeFileSync(join(tmp, "state/finish.json"), JSON.stringify({ ...running, result: null, error: null }));
        log = captureLog(vi);
        const s = await serve(r, world(r));
        const { job: j } = (await s.api("GET", "/api/finish-status")).body;
        expect(j).toMatchObject({ id: 3, running: false, interrupted: true });
        expect(j.error).toMatch(/pushing.*feature/);
        expect(log.lines.some((l) => l.includes("feature"))).toBe(true);
    });

    it("A non-fast-forward push rejection shows git's 'git pull' hint as the instruction", async () => {
        const s = finishSetup();
        injector({
            rules: [{ on: "git", match: /^git push /, before: () => pushCommit(s.remote, "feature", "late.txt") }],
        }).install();
        await expect(s.run([accept("badge--default.light.png")])).rejects.toThrow(/wait for CI/);
    });
});

describe("the session token", () => {
    it("An empty token file disables authentication", async () => {
        const dir = mkdtempSync(join(tmpdir(), "vr-token-"));
        writeFileSync(join(dir, "token"), "\n");
        expect(sessionToken(dir).length).toBeGreaterThan(20);
        const r = makeRepo();
        const s = await serve(r, world(r), { token: "" });
        const bare = await fetch(`${s.origin}/api/prs`);
        expect(bare.status).toBe(401);
    });
});

describe("the gate and the config", () => {
    it("The gate throws a stack trace on an unparseable results.json, hiding every other project's verdict", () => {
        const dir = mkdtempSync(join(tmpdir(), "vr-gate-"));
        mkdirSync(join(dir, "visual-a-1"));
        mkdirSync(join(dir, "visual-b-1"));
        writeFileSync(join(dir, "visual-a-1/results.json"), "{");
        writeFileSync(
            join(dir, "visual-b-1/results.json"),
            readFileSync(join(FIXTURE, "compact-mantine/results.json")),
        );
        const out = newestResults(dir);
        expect(out.a).toMatchObject({ attempt: 1, results: null });
        expect(out.b.results.items.length).toBeGreaterThan(0);
    });

    it("A project id or mode name that results.json rejects fails the capture only after every story has run, and the gate says 're-run'", () => {
        expect(() => normalizeConfig({ projects: { Web: { storybook: "s" } } })).toThrow(/Web/);
        expect(() => storySettings({ chromatic: { modes: { "Dark Mobile": { theme: "dark" } } } }, null)).toThrow(
            /Dark Mobile/,
        );
    });
});
