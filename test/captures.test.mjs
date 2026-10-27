/*
 * Captures started from the review page (captures.mjs, POST /api/captures): a stand-in Storybook
 * captured through the route, one capture at a time, its progress, Cancel stopping every process it
 * started, what can be decided (a local branch, a change's preview) and what is look only (a dirty
 * working tree, a story prefix), the security rules, a commit that moved, and a local branch's
 * capture reviewed and finished onto the branch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { validateResults as oldValidate } from "./fixtures/old-gate/trusted/lib/results.mjs";
import { run as runCapture } from "../capture/capture.mjs";
import { captureProcesses } from "../trusted/lib/captures.mjs";
import { CONFIG_FILE, normalizeConfig } from "../trusted/lib/config.mjs";
import { fakeAdapters } from "./fakes/adapters.mjs";
import { startApp } from "./faults.mjs";
import { git, tempDir, until } from "./helpers.mjs";
import { countingServer, storybook } from "./stand-in-storybook.mjs";

const STORIES = ["demo--plain", "demo--small", "demo--broken"];
const REPO_ID = "1b7e4c2a-9d3f-4e8a-b6c1-2f0a9e8d7c65";

let counter;
const servers = [];
beforeAll(async () => {
    process.env.FC_FONTATIONS = "1";
    vi.stubEnv("GITHUB_ACTIONS", "");
    counter = await countingServer();
});
afterAll(() => {
    vi.unstubAllEnvs();
    counter.close();
});
afterEach(async () => {
    for (const s of servers.splice(0)) {
        await s.close();
    }
});

/**
 * A repository with one project, demo, whose built Storybook (the stand-in) is committed: its
 * default branch main, and the branch feat/x checked out with a commit of its own. Baselines are
 * Git LFS files, and Finish writes change statements.
 * @param {{ captureCommand?: string, sbServer?: string }} [o] the config's captureCommand, and the
 *     server the stand-in Storybook's stories ask (a hanging one keeps a story loading)
 * @returns {{ repo: string, config: object, main: string, head: string, mark: string }} it, its
 *     config, main's and feat/x's commits, and the file a wrapper script appends to
 */
function captureRepo({ captureCommand, sbServer = counter.url } = {}) {
    const repo = tempDir("vr-capture-repo-");
    const mark = join(tempDir("vr-capture-mark-"), "wrapped.txt");
    const run = (...args) => git(repo, ...args);
    run("init", "-q", "-b", "main");
    run("config", "user.name", "Owner");
    run("config", "user.email", "owner@example.com");
    run("config", "core.hooksPath", "/dev/null");
    run("lfs", "install", "--local", "--skip-repo");
    const raw = {
        defaultBranch: "main",
        workDir: "tmp/visual-review",
        approvalFormat: "change",
        repositoryId: REPO_ID,
        ...(captureCommand && { captureCommand }),
        projects: { demo: { storybook: "storybook-static", workers: 2 } },
    };
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify(raw, null, 4));
    writeFileSync(join(repo, ".gitignore"), "tmp/\n");
    writeFileSync(join(repo, ".gitattributes"), "visual-baselines/**/*.png filter=lfs diff=lfs merge=lfs -text\n");
    writeFileSync(join(repo, "wrap.sh"), `echo "$*" >> ${JSON.stringify(mark)}\nexec "$@"\n`);
    storybook(sbServer, join(repo, "storybook-static"), STORIES);
    mkdirSync(join(repo, "visual-baselines/demo"), { recursive: true });
    writeFileSync(join(repo, "visual-baselines/demo/.keep"), "");
    run("add", "-A");
    run("commit", "-q", "-m", "init");
    const main = run("rev-parse", "HEAD");
    run("checkout", "-q", "-b", "feat/x");
    writeFileSync(join(repo, "feature.txt"), "x\n");
    run("add", "-A");
    run("commit", "-q", "-m", "feature");
    return { repo, config: normalizeConfig(raw), main, head: run("rev-parse", "HEAD"), mark };
}

/**
 * A review server on a capture repository.
 * @param {ReturnType<typeof captureRepo>} r the repository
 * @param {object} [data] the code host's data (fakeAdapters)
 * @returns {Promise<any>} startApp's server
 */
async function serve(r, data = {}) {
    const tmp = join(r.repo, "tmp/visual-review");
    const s = await startApp(r, { config: r.config, previews: join(tmp, "local"), ...fakeAdapters(data) });
    servers.push(s);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await s.api("GET", "/api/prs")).status).toBe(200);
    return s;
}

/**
 * Waits for a capture to end, as the page does: by asking for it.
 * @param {any} s the server
 * @param {number} id the capture
 * @returns {Promise<any>} the capture
 */
async function ended(s, id) {
    let c;
    await until(async () => {
        c = (await s.api("GET", `/api/captures/${id}`)).body;
        return !["queued", "running"].includes(c.state);
    });
    return c;
}

/**
 * The listed target once the list shows it with its captures loaded.
 * @param {any} s the server
 * @param {string} id the target
 * @returns {Promise<any>} its summary
 */
async function listed(s, id) {
    let t;
    await until(async () => {
        const list = (await s.api("GET", "/api/prs?cached=1")).body;
        t = list.targets?.find((x) => x.id === id);
        return t?.projects.every((p) => p.problem === null);
    });
    return t;
}

describe("run's progress file", () => {
    it("is rewritten after every result line, counted from those lines, and ends complete", async () => {
        const out = tempDir("vr-progress-");
        const seen = [];
        await runCapture({
            project: "demo",
            storybook: storybook(counter.url, tempDir("vr-sb-"), STORIES),
            baselines: tempDir("vr-bl-"),
            out,
            workers: 1,
            waitFor: null,
            log: () => {},
            print: () => seen.push(JSON.parse(readFileSync(join(out, "progress.json"), "utf8"))),
        });
        // One line per snapshot, each written before the line was printed.
        expect(seen.map((p) => p.done)).toEqual([1, 2, 3]);
        expect(seen.every((p) => p.total === 3 && p.project === "demo" && !p.ended)).toBe(true);
        expect(STORIES.map((id) => `${id}.png`)).toContain(seen.at(-1).current);
        const last = JSON.parse(readFileSync(join(out, "progress.json"), "utf8"));
        expect(last).toMatchObject({ done: 3, total: 3, failures: 1, ended: true });
        expect(last.failed).toEqual([{ file: "demo--broken.png", reason: "story render errored" }]);
        expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThan(1024);
        // results.json stays what an older gate reads: the planned count is the capture line's only.
        const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
        expect(results.planned).toBeUndefined();
        expect(oldValidate(results)).toEqual([]);
    });
});

describe("a capture from the page", () => {
    it("captures the clean working tree as its branch through the wrapper, queues a second, and lists both", async () => {
        const r = captureRepo({ captureCommand: "sh wrap.sh" });
        const s = await serve(r);
        const first = await s.api("POST", "/api/captures", { what: { kind: "tree" } });
        expect(first.status, JSON.stringify(first.body)).toBe(202);
        expect(first.body.target).toBe("branch-feat%2Fx");
        const second = await s.api("POST", "/api/captures", { what: { kind: "branch", branch: "main" } });
        expect(second.status).toBe(202);
        // One at a time: the second waits for the first.
        const list = (await s.api("GET", "/api/captures")).body;
        expect(list.running.map((c) => c.id)).toEqual([first.body.id]);
        expect(list.queued.map((c) => c.id)).toEqual([second.body.id]);
        expect(list.queued[0].what.label).toBe("branch main");
        const one = await ended(s, first.body.id);
        expect(one.state, one.error).toBe("done");
        expect(one.progress).toEqual([
            expect.objectContaining({ project: "demo", done: 3, total: 3, failures: 1 }),
        ]);
        expect(one.done).toBe(3);
        expect(one.log.lines).toContain("[demo] failed demo--broken.png: story render errored");
        // Each request answers the log since a line: the next poll gets only what came after.
        expect((await s.api("GET", `/api/captures/${first.body.id}?since=${one.log.from + one.log.lines.length}`)).body.log.lines).toEqual([]);
        expect((await ended(s, second.body.id)).state).toBe("done");
        // Both ran through the config's captureCommand, one project each.
        expect(readFileSync(r.mark, "utf8").trim().split("\n")).toHaveLength(2);
        const t = await listed(s, "branch-feat%2Fx");
        expect(t).toMatchObject({ localBranch: true, lookOnly: false, branch: "feat/x", title: "Capture of working tree" });
        expect(t.projects[0].counts).toMatchObject({ new: 2, failed: 1 });
        expect((await listed(s, "branch-main")).title).toBe("Capture of branch main");
        // Its capture is of the branch's head, with nothing uncommitted.
        const results = JSON.parse(readFileSync(join(r.repo, "tmp/visual-review/local/branch/feat%2Fx/demo/results.json"), "utf8"));
        expect(results.commit).toBe(r.head);
    });

    it("is reviewed and finished onto its local branch, which then holds the accepted baselines", async () => {
        const r = captureRepo();
        const s = await serve(r);
        const started = await s.api("POST", "/api/captures", { what: { kind: "branch", branch: "feat/x" } });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        expect((await ended(s, started.body.id)).state).toBe("done");
        const id = "branch-feat%2Fx";
        await listed(s, id);
        for (const file of ["demo--plain.png", "demo--small.png"]) {
            const res = await s.api("POST", "/api/decide", { id, project: "demo", file, decision: "accept", reason: null });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
        }
        const prepared = await s.api("POST", "/api/finish-prepare", { id });
        expect(prepared.body, JSON.stringify(prepared.body)).toMatchObject({ required: false });
        const begun = await s.api("POST", "/api/finish", { id });
        expect(begun.status, JSON.stringify(begun.body)).toBe(202);
        let job;
        await until(async () => {
            ({ job } = (await s.api("GET", "/api/finish-status")).body);
            return !job?.running;
        });
        expect(job.error).toBeNull();
        // The commit is on feat/x, on top of the captured head, and the checkout followed it.
        expect(git(r.repo, "rev-parse", "feat/x")).toBe(job.result.commit);
        expect(git(r.repo, "rev-parse", `${job.result.commit}^`)).toBe(r.head);
        expect(job.result.pending).toBe(true);
        const files = git(r.repo, "ls-tree", "-r", "--name-only", "feat/x").split("\n");
        expect(files).toEqual(expect.arrayContaining(["visual-baselines/demo/demo--plain.png", "visual-baselines/demo/demo--small.png"]));
        expect(files.some((f) => f.startsWith("visual-review-approvals/branch-feat-x/"))).toBe(true);
        expect(git(r.repo, "status", "--porcelain")).toBe("");
        // An image in the checkout, a Git LFS pointer in the commit.
        expect(readFileSync(join(r.repo, "visual-baselines/demo/demo--plain.png")).subarray(1, 4).toString()).toBe("PNG");
        expect(git(r.repo, "show", "feat/x:visual-baselines/demo/demo--plain.png")).toContain("git-lfs");
        expect(git(r.repo, "log", "-1", "--format=%s", "feat/x")).toBe("test: accept visual baselines for branch feat/x");
    });

    it("captures a dirty working tree to look at only", async () => {
        const r = captureRepo();
        writeFileSync(join(r.repo, "feature.txt"), "changed, not committed\n");
        const s = await serve(r);
        const started = await s.api("POST", "/api/captures", { what: { kind: "tree" } });
        expect(started.body.target).toBe(`capture-${started.body.id}`);
        const c = await ended(s, started.body.id);
        expect(c).toMatchObject({ state: "done", look: "uncommitted changes" });
        const t = await listed(s, started.body.target);
        expect(t).toMatchObject({ local: true, lookOnly: true, title: "Capture of working tree" });
        const res = await s.api("POST", "/api/decide", {
            id: t.id,
            project: "demo",
            file: "demo--plain.png",
            decision: "accept",
            reason: null,
        });
        expect(res.status).toBe(403);
    });

    it("captures a story prefix to look at only", async () => {
        const r = captureRepo();
        const s = await serve(r);
        const started = await s.api("POST", "/api/captures", {
            what: { kind: "branch", branch: "main" },
            stories: "demo--plain",
        });
        const c = await ended(s, started.body.id);
        expect(c).toMatchObject({ state: "done", look: "a partial capture", total: 1 });
        expect((await listed(s, started.body.target)).lookOnly).toBe(true);
    });

    it("refuses a capture whose branch moved while it ran", async () => {
        // The wrapper moves main to feat/x's head as the capture of main starts.
        const r = captureRepo({ captureCommand: "git update-ref refs/heads/main refs/heads/feat/x && exec" });
        const s = await serve(r);
        const started = await s.api("POST", "/api/captures", { what: { kind: "branch", branch: "main" } });
        const c = await ended(s, started.body.id);
        expect(c.state).toBe("failed");
        expect(c.error).toMatch(/^the commit moved while it was captured \(main is at [0-9a-f]{10} now\): capture it again$/);
        expect(existsSync(join(r.repo, "tmp/visual-review/local/branch/main/demo/results.json"))).toBe(false);
    });

    it("Cancel stops the capture and every browser it started", async () => {
        // Stories that never finish loading: the stand-in's request to this server is never answered.
        const hang = createServer(() => {});
        await new Promise((resolve) => hang.listen(0, "127.0.0.1", resolve));
        try {
            const r = captureRepo({ sbServer: `http://127.0.0.1:${hang.address().port}/` });
            const s = await serve(r);
            const started = await s.api("POST", "/api/captures", { what: { kind: "branch", branch: "main" } });
            const id = started.body.id;
            const commandOf = (pid) => {
                try {
                    return readFileSync(`/proc/${pid}/cmdline`, "latin1");
                } catch {
                    return "";
                }
            };
            await until(() => captureProcesses(id).some((pid) => /chrom/i.test(commandOf(pid))));
            const res = await s.api("POST", `/api/captures/${id}/cancel`);
            expect(res.body).toEqual({ id, state: "running" });
            expect((await ended(s, id)).state).toBe("cancelled");
            expect(captureProcesses(id)).toEqual([]);
            expect((await s.api("GET", "/api/captures")).body.finished[0]).toMatchObject({ id, state: "cancelled" });
        } finally {
            hang.closeAllConnections();
            hang.close();
        }
    });
});

describe("a change from the code host", () => {
    /**
     * The repository with change #7 open on another branch.
     * @param {object} [o] captureRepo's options
     * @returns {Promise<{ r: any, s: any, head: string }>} it, its server, and #7's head
     */
    async function withChange(o) {
        const r = captureRepo(o);
        git(r.repo, "checkout", "-q", "-b", "theirs", r.main);
        writeFileSync(join(r.repo, "theirs.txt"), "y\n");
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "theirs");
        const head = git(r.repo, "rev-parse", "HEAD");
        git(r.repo, "checkout", "-q", "feat/x");
        // A change's capture is compared with origin's default branch too, as CI's is.
        const remote = join(tempDir("vr-capture-remote-"), "remote.git");
        git(r.repo, "init", "-q", "--bare", "-b", "main", remote);
        git(r.repo, "remote", "add", "origin", remote);
        git(r.repo, "push", "-q", "origin", "main", "theirs");
        const s = await serve(r, { prs: [{ number: 7, head, branch: "theirs", author: "mallory" }] });
        return { r, s, head };
    }

    it("is refused without the config's captureCommand, without confirmation, or at another head", async () => {
        const { s, head } = await withChange();
        const ask = (body) => s.api("POST", "/api/captures", { what: { kind: "change", number: 7, head }, ...body });
        expect((await ask({ confirmed: true })).status).toBe(403);
        const { s: s2, head: h2 } = await withChange({ captureCommand: "exec" });
        const ask2 = (what, body) => s2.api("POST", "/api/captures", { what: { kind: "change", number: 7, ...what }, ...body });
        const unconfirmed = await ask2({ head: h2 });
        expect(unconfirmed.status).toBe(428);
        expect(unconfirmed.body.error).toBe("capturing #7 here builds and runs its code: confirm it first");
        expect((await ask2({ head: "0".repeat(40) }, { confirmed: true })).status).toBe(409);
        // Writes keep the origin check.
        const foreign = await s2.api("POST", "/api/captures", { what: { kind: "tree" } }, { origin: "https://evil.example" });
        expect(foreign.status).toBe(403);
        // CI is not offered by this capture store.
        expect((await ask2({ head: h2 }, { confirmed: true, where: "ci" })).status).toBe(409);
        expect((await s2.api("GET", "/api/captures")).body.ci).toMatchObject({
            available: false,
            why: "your capture store cannot start CI jobs",
        });
    });

    it("confirmed, is captured as the change's preview, which the change then shows", async () => {
        const { r, s, head } = await withChange({ captureCommand: "exec" });
        const started = await s.api("POST", "/api/captures", {
            what: { kind: "change", number: 7, head },
            confirmed: true,
        });
        expect(started.body.target).toBe("7");
        expect((await ended(s, started.body.id)).state).toBe("done");
        const results = JSON.parse(readFileSync(join(r.repo, "tmp/visual-review/local/7/demo/results.json"), "utf8"));
        expect(results).toMatchObject({ pr: 7, headSha: head, commit: head });
        const t = await listed(s, "7");
        expect(t.projects[0]).toMatchObject({ preview: true });
        expect(t.lookOnly).toBe(false);
    });
});
