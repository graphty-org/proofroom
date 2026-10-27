/*
 * Capture requests to CI: the GitHub Actions store's request, status and cancel over a replay of
 * gh's recorded answers (never the network), how GitHub's runs and jobs map to the states the
 * Captures screen shows, and the server's side: CI is offered only when the store can request a
 * capture and the capturing workflow on the default branch takes requests, a request is always a
 * whole open change at the head the page showed, its state is asked only while it waits or runs
 * and at most once per poll, and Cancel cancels its run.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { githubActionsStore, jobState, runState } from "../trusted/lib/adapters/github-actions.mjs";
import { renderTemplate } from "../trusted/lib/init.mjs";
import { captureRepo } from "./capture-repo.mjs";
import { fakeAdapters } from "./fakes/adapters.mjs";
import { startApp } from "./faults.mjs";
import { git, tempDir, until } from "./helpers.mjs";

const recorded = JSON.parse(
    readFileSync(new URL("fixtures/github/capture-request.json", import.meta.url), "utf8"),
).calls;
const BRANCH = "feat/3486-storybook-9";
const HEAD = "6dfc21d0c4b1e0f8a5c2b0d9e7a4f3c2b1a09876";
const RUN = 18800105;

/**
 * A gh runner answering from the recording: an unrecorded call fails the test; the dispatched
 * request id is put where the recording wrote {request}, as the run GitHub made would carry it.
 * @returns {{ gh: (args: string[], input?: string) => Promise<string>, asked: string[], sent: object[] }}
 *     the runner, every call, and every body sent
 */
function replayGh() {
    const asked = [];
    const sent = [];
    let request = null;
    const gh = async (args, input) => {
        const call = args.join(" ");
        asked.push(call);
        if (!(call in recorded)) {
            throw new Error(`gh replay: nothing recorded for ${call}`);
        }
        if (input) {
            const body = JSON.parse(input);
            sent.push(body);
            request = body.inputs?.request ?? request;
        }
        const answer = recorded[call];
        return typeof answer === "string" ? answer : JSON.stringify(answer).replaceAll("{request}", request);
    };
    return { gh, asked, sent };
}

describe("the GitHub Actions store asks CI for a capture", () => {
    it("dispatches the workflow on the change's branch, with its head, the projects and a fresh request id", async () => {
        const r = replayGh();
        const store = githubActionsStore(r.gh);
        const req = await store.request(
            { branch: BRANCH, head: HEAD },
            { projects: ["graphty-element", "graphty"], stories: [] },
            { workflow: "visual-review.yml" },
        );
        expect(r.asked).toEqual([
            "api -X POST repos/{owner}/{repo}/actions/workflows/visual-review.yml/dispatches --input -",
        ]);
        expect(r.sent).toEqual([
            {
                ref: BRANCH,
                inputs: { ref: HEAD, projects: "graphty-element,graphty", stories: "", request: req.request },
            },
        ]);
        expect(req).toEqual({
            request: expect.stringMatching(/^[0-9a-f-]{36}$/),
            workflow: "visual-review.yml",
            branch: BRANCH,
            run: null,
        });
        // Each request has its own id.
        const again = await store.request({ branch: BRANCH, head: HEAD }, { projects: [], stories: ["button--"] }, req);
        expect(again.request).not.toBe(req.request);
        expect(r.sent[1].inputs).toMatchObject({ projects: "", stories: "button--" });
    });

    it("finds the run by the request id in its name, and says each project's job state", async () => {
        const r = replayGh();
        const store = githubActionsStore(r.gh);
        const req = await store.request(
            { branch: BRANCH, head: HEAD },
            { projects: [], stories: [] },
            { workflow: "visual-review.yml" },
        );
        const st = await store.status(req, ["graphty-element", "graphty", "compact-mantine"]);
        // Of the branch's two dispatched runs, the one named with this request.
        expect(st.run).toEqual({ id: RUN, url: `https://github.com/graphty-org/graphty-monorepo/actions/runs/${RUN}` });
        expect(st.state).toBe("running");
        expect(st.jobs).toEqual([
            // It found differences ("Capture and compare" failed) and uploaded its capture: passed.
            {
                project: "graphty-element",
                state: "passed",
                url: `https://github.com/graphty-org/graphty-monorepo/actions/runs/${RUN}/job/2`,
                startedAt: "2026-10-27T10:01:00Z",
                endedAt: "2026-10-27T10:04:10Z",
            },
            {
                project: "graphty",
                state: "running",
                url: `https://github.com/graphty-org/graphty-monorepo/actions/runs/${RUN}/job/3`,
                startedAt: "2026-10-27T10:01:05Z",
                endedAt: null,
            },
            // Not made yet.
            { project: "compact-mantine", state: "queued", url: null, startedAt: null, endedAt: null },
        ]);
        // Once the run is known it is asked by its id, not searched for again.
        const later = await store.status({ ...req, run: RUN }, ["graphty-element"]);
        expect(later.state).toBe("done");
        expect(r.asked.filter((c) => c.includes("event=workflow_dispatch"))).toHaveLength(1);
    });

    it("cancels the run a request started, and nothing before GitHub has made one", async () => {
        const r = replayGh();
        const store = githubActionsStore(r.gh);
        const req = await store.request(
            { branch: BRANCH, head: HEAD },
            { projects: [], stories: [] },
            { workflow: "visual-review.yml" },
        );
        expect(await store.cancel(req)).toBe(true);
        expect(r.asked.at(-1)).toBe(`api -X POST repos/{owner}/{repo}/actions/runs/${RUN}/cancel`);
        // A request whose run is not among the branch's: nothing to cancel.
        expect(await store.cancel({ ...req, request: "no-such-request" })).toBe(false);
        expect(r.asked.at(-1)).toContain("event=workflow_dispatch");
    });
});

describe("GitHub's states as the Captures screen says them", () => {
    it("maps a capture job", () => {
        expect(jobState(undefined)).toBe("queued");
        for (const status of ["queued", "waiting", "pending", "requested"]) {
            expect(jobState({ status, conclusion: null })).toBe("queued");
        }
        expect(jobState({ status: "in_progress", conclusion: null })).toBe("running");
        expect(jobState({ status: "completed", conclusion: "success" })).toBe("passed");
        expect(jobState({ status: "completed", conclusion: "failure", uploaded: true })).toBe("passed");
        expect(jobState({ status: "completed", conclusion: "failure", uploaded: false })).toBe("failed");
        expect(jobState({ status: "completed", conclusion: "timed_out" })).toBe("failed");
        expect(jobState({ status: "completed", conclusion: "cancelled" })).toBe("cancelled");
        expect(jobState({ status: "completed", conclusion: "skipped" })).toBe("skipped");
    });

    it("maps a requested capture's run", () => {
        expect(runState(null)).toBe("queued");
        expect(runState({ status: "queued", conclusion: null })).toBe("queued");
        expect(runState({ status: "in_progress", conclusion: null })).toBe("running");
        expect(runState({ status: "completed", conclusion: "success" })).toBe("done");
        expect(runState({ status: "completed", conclusion: "cancelled" })).toBe("cancelled");
        expect(runState({ status: "completed", conclusion: "failure" })).toBe("failed");
        expect(runState({ status: "completed", conclusion: "startup_failure" })).toBe("failed");
    });
});

describe("a capture asked of CI from the page", () => {
    const servers = [];
    beforeAll(() => {
        vi.stubEnv("GITHUB_ACTIONS", "");
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        for (const s of servers.splice(0)) {
            await s.close();
        }
    });

    /**
     * A repository with change #7 open on its branch theirs, its capturing workflow on origin's
     * default branch, and a capture store that can ask CI: its status answers whatever `answer`
     * holds, and every call is counted.
     * @param {{ workflow?: string | null, ciEvery?: number }} [o] the workflow file's text (null:
     *     none), and the least time between two asks of one capture's state
     * @returns {Promise<any>} the repository, its server, the store, and #7's head
     */
    async function withCi({
        workflow = renderTemplate("visual-review.yml", { branch: "main", manager: "npm", version: "1.0.0" }),
        ciEvery = 0,
    } = {}) {
        const r = captureRepo("http://127.0.0.1:9");
        git(r.repo, "checkout", "-q", "main");
        if (workflow !== null) {
            mkdirSync(join(r.repo, ".github/workflows"), { recursive: true });
            writeFileSync(join(r.repo, ".github/workflows/visual-review.yml"), workflow);
            git(r.repo, "add", "-A");
            git(r.repo, "commit", "-q", "-m", "workflow");
        }
        git(r.repo, "checkout", "-q", "-b", "theirs");
        writeFileSync(join(r.repo, "theirs.txt"), "y\n");
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "theirs");
        const head = git(r.repo, "rev-parse", "HEAD");
        const remote = join(tempDir("vr-ci-remote-"), "remote.git");
        git(r.repo, "init", "-q", "--bare", "-b", "main", remote);
        git(r.repo, "remote", "add", "origin", remote);
        git(r.repo, "push", "-q", "origin", "main", "theirs");
        const adapters = fakeAdapters({ prs: [{ number: 7, head, branch: "theirs", author: "mallory" }] });
        const store = Object.assign(adapters.captureStore, {
            requests: [],
            asked: 0,
            cancelled: [],
            answer: { state: "queued", run: null, jobs: [] },
            async request(change, what, config) {
                store.requests.push({ change, what, workflow: config.workflow });
                return {
                    request: `req-${store.requests.length}`,
                    workflow: config.workflow,
                    branch: change.branch,
                    run: null,
                };
            },
            async status() {
                store.asked++;
                return store.answer;
            },
            async cancel(req) {
                store.cancelled.push(req.request);
                return true;
            },
        });
        const s = await startApp(r, {
            config: r.config,
            previews: join(r.repo, "tmp/visual-review/local"),
            ciEvery,
            ...adapters,
        });
        servers.push(s);
        vi.spyOn(console, "log").mockImplementation(() => {});
        expect((await s.api("GET", "/api/prs")).status).toBe(200);
        return { r, s, store, head };
    }

    const state = async (s, id) => (await s.api("GET", `/api/captures/${id}`)).body;

    it("is offered once the workflow takes requests; a workflow without the new inputs is unavailable, with the reason", async () => {
        const { s } = await withCi();
        expect((await s.api("GET", "/api/captures")).body.ci).toEqual({
            available: true,
            why: "",
            status: true,
            cancel: true,
            label: "CI (fake)",
        });
        // A workflow written before the dispatch inputs.
        const old = renderTemplate("visual-review.yml", { branch: "main", manager: "npm", version: "0.9.0" }).replace(
            /\n {4}workflow_dispatch:\n[\s\S]*?\n\npermissions:/,
            "\n\npermissions:",
        );
        expect(old).not.toContain("workflow_dispatch");
        const { s: s2, head } = await withCi({ workflow: old });
        const why =
            ".github/workflows/visual-review.yml on main takes no capture requests: update it with proofroom init --force";
        expect((await s2.api("GET", "/api/captures")).body.ci).toMatchObject({ available: false, why });
        const refused = await s2.api("POST", "/api/captures", {
            what: { kind: "change", number: 7, head },
            where: "ci",
        });
        expect(refused).toEqual({ status: 409, body: { error: `CI cannot capture here: ${why}` } });
        // No workflow at all says so.
        const { s: s3 } = await withCi({ workflow: null });
        expect((await s3.api("GET", "/api/captures")).body.ci.why).toBe(
            ".github/workflows/visual-review.yml is not on main",
        );
    });

    it("asks CI for the change at the head the page showed, follows its run, and lists it until it ends", async () => {
        const { s, store, head } = await withCi();
        const started = await s.api("POST", "/api/captures", {
            what: { kind: "change", number: 7, head },
            where: "ci",
        });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        // Its run becomes the change's capture: it is reviewed as #7.
        expect(started.body.target).toBe("7");
        expect(store.requests).toEqual([
            {
                change: { branch: "theirs", head },
                what: { projects: ["demo"], stories: [] },
                workflow: "visual-review.yml",
            },
        ]);
        // Waiting for CI to make the run: queued, nothing run here.
        const queued = await state(s, started.body.id);
        expect(queued).toMatchObject({ where: "ci", state: "queued", done: 0, total: 1, jobs: [], progress: [] });
        expect(queued.what).toMatchObject({ kind: "change", number: 7, label: "#7 PR 7", author: "mallory" });
        expect(queued.log.lines[0]).toBe(`Asked CI for a capture of #7 PR 7 at ${head.slice(0, 10)} (request req-1)`);
        store.answer = {
            state: "running",
            run: { id: 55, url: "https://ci/runs/55" },
            jobs: [{ project: "demo", state: "running", url: "https://ci/jobs/1", startedAt: null, endedAt: null }],
        };
        await until(async () => (await state(s, started.body.id)).state === "running");
        expect(await state(s, started.body.id)).toMatchObject({ runUrl: "https://ci/runs/55", done: 0 });
        store.answer = {
            state: "done",
            run: { id: 55, url: "https://ci/runs/55" },
            jobs: [{ project: "demo", state: "passed", url: "https://ci/jobs/1", startedAt: null, endedAt: null }],
        };
        await until(async () => (await state(s, started.body.id)).state === "done");
        const done = await state(s, started.body.id);
        expect(done).toMatchObject({ done: 1, total: 1, failures: 0, error: null });
        expect(done.log.lines).toContain("CI: done (https://ci/runs/55)");
        // An ended capture is not asked about again.
        const asked = store.asked;
        await s.api("GET", "/api/captures");
        await s.api("GET", "/api/captures");
        expect(store.asked).toBe(asked);
        const list = (await s.api("GET", "/api/captures")).body;
        expect(list.finished.map((c) => c.id)).toEqual([started.body.id]);
    });

    it("asks a waiting capture's state at most once per poll interval, however often the page asks", async () => {
        const { s, store, head } = await withCi({ ciEvery: 3_600_000 });
        const started = await s.api("POST", "/api/captures", {
            what: { kind: "change", number: 7, head },
            where: "ci",
        });
        for (let i = 0; i < 5; i++) {
            await s.api("GET", "/api/captures");
            await s.api("GET", `/api/captures/${started.body.id}`);
            await s.api("GET", "/api/prs?cached=1");
        }
        await until(() => store.asked > 0);
        // Fifteen polls of the page, one ask of CI.
        expect(store.asked).toBe(1);
    });

    it("captures only a whole open change, against its own baselines", async () => {
        const { r, s, head } = await withCi();
        const ask = (body) => s.api("POST", "/api/captures", { where: "ci", ...body });
        const whole =
            "CI captures a whole change against its own baselines, because its run becomes the change's capture: capture some projects or stories, or against other baselines, on this machine";
        const change = { what: { kind: "change", number: 7, head } };
        expect(await ask({ ...change, stories: "demo--" })).toEqual({ status: 400, body: { error: whole } });
        expect(await ask({ ...change, projects: [] })).toEqual({ status: 400, body: { error: whole } });
        expect(await ask({ ...change, baselines: "default" })).toEqual({ status: 400, body: { error: whole } });
        expect((await ask({ what: { kind: "change", number: 7, head: "0".repeat(40) } })).status).toBe(409);
        expect((await ask({ what: { kind: "change", number: 8, head } })).status).toBe(404);
        // A local branch with no open change, and a working tree with uncommitted changes.
        const branch = await ask({ what: { kind: "branch", branch: "feat/x" } });
        expect(branch.status).toBe(409);
        expect(branch.body.error).toMatch(
            /^CI captures the head of an open change: feat\/x at [0-9a-f]{10} is not one/,
        );
        writeFileSync(join(r.repo, "theirs.txt"), "changed\n");
        expect(await ask({ what: { kind: "tree" } })).toEqual({
            status: 409,
            body: {
                error: "uncommitted changes are not on CI: commit and push them, or capture the working tree on this machine",
            },
        });
        git(r.repo, "checkout", "--", "theirs.txt");
        // The clean working tree on the change's branch, at its head, is the change.
        const tree = await ask({ what: { kind: "tree" } });
        expect(tree.status, JSON.stringify(tree.body)).toBe(202);
        expect(tree.body.target).toBe("7");
    });

    it("Cancel cancels its run, and the capture ends cancelled", async () => {
        const { s, store, head } = await withCi();
        const started = await s.api("POST", "/api/captures", {
            what: { kind: "change", number: 7, head },
            where: "ci",
        });
        const cancelled = await s.api("POST", `/api/captures/${started.body.id}/cancel`, {});
        expect(cancelled).toEqual({ status: 200, body: { id: started.body.id, state: "cancelled" } });
        expect(store.cancelled).toEqual(["req-1"]);
        expect(await state(s, started.body.id)).toMatchObject({ state: "cancelled", error: "Cancelled by you" });
        // Cancelled once: a second Cancel asks CI nothing more.
        await s.api("POST", `/api/captures/${started.body.id}/cancel`, {});
        expect(store.cancelled).toEqual(["req-1"]);
    });
});
