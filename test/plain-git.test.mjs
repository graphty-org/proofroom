/*
 * The plain git code host (adapters/plain-git.mjs) over a real temporary repository: its branches
 * are the changes, listed in one `git for-each-ref`; it has no CI and posts nothing. Then the server
 * on a plain git repository: a branch captured on this machine is reviewed and finished, and the
 * rejects go to visual-review-rejects/<branch>.md on the branch; a branch only on the remote is
 * captured as another person's code; and `init --code-host plain-git` writes a repository id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { onlyFinishCommits } from "../trusted/lib/accept.mjs";
import { adapterFacts, captureStoreFor, codeHostFor } from "../trusted/lib/adapters/index.mjs";
import { plainGitCodeHost, rejectsFile } from "../trusted/lib/adapters/plain-git.mjs";
import { normalizeConfig } from "../trusted/lib/config.mjs";
import { exec } from "../trusted/lib/github.mjs";
import { init } from "../trusted/lib/init.mjs";
import { captureRepo } from "./capture-repo.mjs";
import { startApp } from "./faults.mjs";
import { git, tempDir, until } from "./helpers.mjs";
import { countingServer } from "./stand-in-storybook.mjs";

const REPO_ID = "1b7e4c2a-9d3f-4e8a-b6c1-2f0a9e8d7c65";
let counter;
const servers = [];

beforeAll(async () => {
    process.env.FC_FONTATIONS = "1";
    vi.stubEnv("GITHUB_ACTIONS", "");
    counter = await countingServer();
});
afterEach(async () => {
    for (const s of servers.splice(0)) {
        await s.close();
    }
    vi.restoreAllMocks();
});
afterAll(() => {
    vi.unstubAllEnvs();
    counter?.close();
});

/**
 * A repository on main with a remote: local branches feat/a and feat/b (feat/b also pushed), and
 * on the remote only, feat/c; skip/me is ignored by the config.
 * @returns {{ repo: string, remote: string, heads: Record<string, string> }} it
 */
function branchesRepo() {
    const remote = tempDir("vr-plain-remote-");
    git(remote, "init", "-q", "--bare", "-b", "main");
    const repo = tempDir("vr-plain-");
    const run = (...args) => git(repo, ...args);
    run("init", "-q", "-b", "main");
    run("config", "user.name", "Ada Owner");
    run("config", "user.email", "ada@example.com");
    run("remote", "add", "origin", remote);
    const commit = (file, subject, name = "Ada Owner") => {
        writeFileSync(join(repo, file), `${subject}\n`);
        run("add", "-A");
        run("-c", `user.name=${name}`, "commit", "-q", "-m", subject, "-m", "The body.");
        return run("rev-parse", "HEAD");
    };
    commit("a.txt", "init");
    run("push", "-q", "origin", "main");
    const heads = {};
    for (const [branch, subject, who] of [
        ["feat/a", "Group padding race", "Ada Owner"],
        ["feat/b", "Legend sizing", "Bo Other"],
        ["feat/c", "Edge label clipping", "Cy Remote"],
        ["skip/me", "Ignored", "Ada Owner"],
    ]) {
        run("checkout", "-q", "-b", branch, "main");
        heads[branch] = commit(`${branch.replace("/", "-")}.txt`, subject, who);
    }
    run("checkout", "-q", "main");
    run("push", "-q", "origin", "feat/b", "feat/c");
    run("branch", "-q", "-D", "feat/c");
    run("fetch", "-q", "origin");
    return { repo, remote, heads };
}

const CONFIG = { defaultBranch: "main", repositoryId: REPO_ID, ignoreBranches: ["skip/"] };

/**
 * A git runner over the repository that counts its calls.
 * @param {string} repo the repository
 * @returns {{ git: (args: string[]) => Promise<string>, calls: string[][] }} it
 */
function counted(repo) {
    const calls = [];
    return { calls, git: (args) => (calls.push(args), exec("git", args, { cwd: repo })) };
}

describe("the plain git code host", () => {
    it("lists every branch but the default and the ignored ones in one git for-each-ref", async () => {
        const { repo, heads } = branchesRepo();
        const c = counted(repo);
        const host = plainGitCodeHost(repo, CONFIG, { git: c.git });
        const changes = await host.listChanges(CONFIG);
        expect(c.calls).toEqual([
            [expect.stringMatching(/^for-each-ref$/), expect.any(String), "refs/heads/", "refs/remotes/"],
        ]);
        expect(changes.map((x) => [x.branch, x.remote])).toEqual([
            ["feat/a", null],
            ["feat/b", null],
            ["feat/c", "origin/feat/c"],
        ]);
        expect(changes[1]).toMatchObject({
            number: null,
            id: "branch:feat/b",
            title: "Legend sizing",
            url: null,
            headSha: heads["feat/b"],
            author: "Bo Other",
            draft: false,
            run: null,
        });
        expect(changes[2]).toMatchObject({ author: "Cy Remote", headSha: heads["feat/c"] });
    });

    it("lists 200 branches in the same one call", async () => {
        const { repo } = branchesRepo();
        const tip = git(repo, "rev-parse", "main");
        const refs = Array.from({ length: 200 }, (_, i) => `create refs/heads/many/${i} ${tip}`).join("\n");
        await exec("git", ["update-ref", "--stdin"], { cwd: repo, input: `${refs}\n` });
        const c = counted(repo);
        const changes = await plainGitCodeHost(repo, CONFIG, { git: c.git }).listChanges(CONFIG);
        expect(changes.filter((x) => x.branch.startsWith("many/"))).toHaveLength(200);
        expect(c.calls).toHaveLength(1);
    });

    it("has the page's words, names the reviewer and the repository, and describes a branch", async () => {
        const { repo } = branchesRepo();
        const host = codeHostFor(
            normalizeConfig({
                codeHost: "plain-git",
                repositoryId: REPO_ID,
                defaultBranch: "main",
                projects: { web: { storybook: "sb" } },
            }),
            { gh: async () => "", repo },
        );
        expect(host.name).toBe("plain-git");
        expect(host.vocabulary).toEqual({
            hostName: "git",
            changeNoun: "branch",
            changeTag: "branch",
            numberPrefix: "",
            ciName: null,
        });
        expect(await host.whoAmI()).toBe("Ada Owner");
        expect(await host.repositoryId()).toBe(REPO_ID);
        expect(await host.describe("feat/a", null)).toMatchObject({
            title: "Group padding race",
            body: "The body.",
            comments: [],
        });
    });

    it("lacks commenting, statuses, issues and opening changes, and has a capture store with no CI", async () => {
        const config = normalizeConfig({
            codeHost: "plain-git",
            repositoryId: REPO_ID,
            projects: { web: { storybook: "sb" } },
        });
        const gh = async () => {
            throw new Error("no gh under plain git");
        };
        const host = codeHostFor(config, { gh, repo: "." });
        const store = captureStoreFor(config, { gh });
        expect(adapterFacts(host, store, config)).toEqual({
            codeHost: {
                name: "plain-git",
                vocabulary: host.vocabulary,
                lacks: ["comment", "setStatus", "fileIssue", "openChange"],
            },
            captureStore: { name: "local-folder", lacks: ["request", "status", "cancel", "expiresAt"] },
            stories: { name: "storybook", lacks: [] },
            renderer: { name: "playwright-chromium", lacks: [] },
        });
        expect(await store.newestRun("0".repeat(40), config)).toBeNull();
        expect(await store.list({})).toEqual([]);
        expect(await store.newestDefault("web", tempDir("vr-none-"), config)).toBeNull();
    });

    it("needs a repositoryId in the config, which change statements name the repository by", () => {
        expect(() => normalizeConfig({ codeHost: "plain-git", projects: { web: { storybook: "sb" } } })).toThrow(
            'codeHost "plain-git" needs a repositoryId',
        );
    });

    it("keeps a capture current after a commit of the rejects file alone only under plain git", async () => {
        const repo = tempDir("vr-plain-rejects-");
        git(repo, "init", "-q", "-b", "main");
        git(repo, "commit", "-q", "--allow-empty", "-m", "init");
        const head = git(repo, "rev-parse", "HEAD");
        mkdirSync(join(repo, "visual-review-rejects"));
        writeFileSync(join(repo, rejectsFile("feat/x")), "rejects\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "rejects");
        const tip = git(repo, "rev-parse", "HEAD");
        const dirs = { baselines: "visual-baselines", approvals: "visual-review-approvals" };
        expect(await onlyFinishCommits(repo, head, tip, { ...dirs, codeHost: "plain-git" })).toBe(true);
        expect(await onlyFinishCommits(repo, head, tip, { ...dirs, codeHost: "github" })).toBe(false);
    });

    it("names a branch's rejects file with every run of other characters one dash", () => {
        expect(rejectsFile("feat/x")).toBe("visual-review-rejects/feat-x.md");
        expect(rejectsFile("fix/3471 group padding!")).toBe("visual-review-rejects/fix-3471-group-padding-.md");
    });
});

describe("init --code-host plain-git", () => {
    it("writes a random repositoryId and the plain git code host, and no workflows", () => {
        const root = tempDir("vr-init-plain-");
        git(root, "init", "-q", "-b", "main");
        const report = init(root, { codeHost: "plain-git" });
        const config = JSON.parse(readFileSync(join(root, "visual-review.config.json"), "utf8"));
        expect(config.codeHost).toBe("plain-git");
        expect(config.repositoryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(existsSync(join(root, ".github"))).toBe(false);
        expect(report.join("\n")).not.toContain(".github/workflows");
        // A second repository gets another id.
        const other = tempDir("vr-init-plain-");
        git(other, "init", "-q", "-b", "main");
        init(other, { codeHost: "plain-git" });
        expect(JSON.parse(readFileSync(join(other, "visual-review.config.json"), "utf8")).repositoryId).not.toBe(
            config.repositoryId,
        );
    });
});

/**
 * The review server on a plain git capture repository: no fakes, the config's own adapters.
 * @param {ReturnType<typeof captureRepo>} r the repository
 * @returns {Promise<any>} startApp's server
 */
async function serve(r) {
    const s = await startApp(r, { config: r.config, previews: join(r.repo, "tmp/visual-review/local") });
    servers.push(s);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await s.api("GET", "/api/prs")).status).toBe(200);
    return s;
}

async function capturedAndListed(s, what) {
    const started = await s.api("POST", "/api/captures", what);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await until(async () => {
        const c = (await s.api("GET", `/api/captures/${started.body.id}`)).body;
        return !["queued", "running"].includes(c.state);
    });
    let t;
    await until(async () => {
        t = (await s.api("GET", "/api/prs?refresh=1")).body.targets?.find((x) => x.id === started.body.target);
        return t?.projects.every((p) => p.problem === null);
    });
    return t;
}

async function finished(s, id) {
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
    return job;
}

const decide = async (s, id, file, decision, reason = null) => {
    const res = await s.api("POST", "/api/decide", { id, project: "demo", file, decision, reason });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
};

describe("the server on a plain git repository", () => {
    it("names the branch's change by its last commit, and says which adapters it uses", async () => {
        const r = captureRepo(counter.url, { codeHost: "plain-git" });
        const s = await serve(r);
        const list = (await s.api("GET", "/api/prs")).body;
        expect(list.adapters.codeHost).toMatchObject({ name: "plain-git", vocabulary: { hostName: "git" } });
        expect(list.adapters.captureStore.name).toBe("local-folder");
        expect((await s.api("GET", "/api/captures")).body.ci).toMatchObject({ available: false, label: "CI" });
        const t = await capturedAndListed(s, { what: { kind: "branch", branch: "feat/x" } });
        expect(t).toMatchObject({ id: "branch-feat%2Fx", localBranch: true, title: "feature", author: "Owner" });
        const about = await s.api("GET", `/api/pr-context/${encodeURIComponent(t.id)}`);
        expect(about.status, JSON.stringify(about.body)).toBe(200);
        expect(about.body.title).toBe("feature");
    });

    it("finishes a captured branch: the accepts and a statement, then the rejects in their file on the branch", async () => {
        const r = captureRepo(counter.url, { codeHost: "plain-git" });
        const s = await serve(r);
        const t = await capturedAndListed(s, { what: { kind: "branch", branch: "feat/x" } });
        await decide(s, t.id, "demo--plain.png", "accept");
        await decide(s, t.id, "demo--small.png", "reject", "Text is clipped");
        const job = await finished(s, t.id);
        expect(job.result).toMatchObject({
            rejects: 1,
            rejectsFile: "visual-review-rejects/feat-x.md",
            pullRequest: null,
            state: null,
            pending: true,
        });
        // Two commits on the captured head: the accept commit, then the rejects file alone.
        expect(git(r.repo, "rev-parse", "feat/x")).toBe(job.result.commit);
        expect(git(r.repo, "rev-parse", "feat/x~2")).toBe(r.head);
        expect(git(r.repo, "diff", "--name-only", "feat/x~1", "feat/x")).toBe("visual-review-rejects/feat-x.md");
        expect(git(r.repo, "log", "-1", "--format=%s", "feat/x")).toBe("test: visual review 1 reject on feat/x");
        const text = git(r.repo, "show", "feat/x:visual-review-rejects/feat-x.md");
        expect(text).toContain("**Visual review: 1 rejected**");
        expect(text).toContain('- `demo/demo--small.png`: "Text is clipped"');
        const files = git(r.repo, "ls-tree", "-r", "--name-only", "feat/x").split("\n");
        expect(files).toContain("visual-baselines/demo/demo--plain.png");
        expect(files.some((f) => f.startsWith("visual-review-approvals/branch-feat-x/"))).toBe(true);
        // The checkout followed, and the branch's capture is still its current one: the Finish's own
        // commits changed only the baselines, the approvals and the rejects file.
        expect(readFileSync(join(r.repo, "visual-review-rejects/feat-x.md"), "utf8")).toBe(`${text}\n`);
        expect(git(r.repo, "status", "--porcelain")).toBe("");
        let after;
        await until(async () => {
            after = (await s.api("GET", "/api/prs?refresh=1")).body.targets?.find((x) => x.id === t.id);
            return after?.unpushed;
        });
        expect(after.unpushed).toBe(true);
    });

    it("writes a Finish of rejects alone to the file too", async () => {
        const r = captureRepo(counter.url, { codeHost: "plain-git" });
        const s = await serve(r);
        const t = await capturedAndListed(s, { what: { kind: "branch", branch: "feat/x" } });
        await decide(s, t.id, "demo--small.png", "reject", "Wrong padding");
        const job = await finished(s, t.id);
        expect(job.result).toMatchObject({ rejects: 1, rejectsFile: "visual-review-rejects/feat-x.md" });
        expect(git(r.repo, "rev-parse", "feat/x~1")).toBe(r.head);
        expect(git(r.repo, "show", "feat/x:visual-review-rejects/feat-x.md")).toContain('"Wrong padding"');
    });

    it("captures a branch only on the remote as another person's code: through captureCommand, once confirmed", async () => {
        const r = captureRepo(counter.url, { codeHost: "plain-git", captureCommand: "exec" });
        onRemote(r);
        const s = await serve(r);
        await until(async () => (await s.api("GET", "/api/captures?sources=1")).body.sources.remote.length > 0);
        const { sources } = (await s.api("GET", "/api/captures?sources=1")).body;
        expect(sources.remote).toEqual([{ name: "origin/feat/y", head: r.head, title: "feature", author: "Owner" }]);
        const what = { kind: "change", branch: "origin/feat/y", head: r.head };
        const asked = await s.api("POST", "/api/captures", { what });
        expect(asked.status).toBe(428);
        expect(asked.body.error).toBe("capturing origin/feat/y here builds and runs its code: confirm it first");
        const t = await capturedAndListed(s, { what, confirmed: true });
        expect(t).toMatchObject({ id: "branch-feat%2Fy", localBranch: true });
        // A local branch now tracks the remote one, so Finish pushes there.
        expect(git(r.repo, "rev-parse", "--abbrev-ref", "feat/y@{upstream}")).toBe("origin/feat/y");
    });

    it("makes no local branch of a remote one for a refused or a look-only capture", async () => {
        const r = captureRepo(counter.url, { codeHost: "plain-git", captureCommand: "exec" });
        onRemote(r);
        const s = await serve(r);
        await until(async () => (await s.api("GET", "/api/captures?sources=1")).body.sources.remote.length > 0);
        const what = { kind: "change", branch: "origin/feat/y", head: r.head };
        const refused = await s.api("POST", "/api/captures", {
            what,
            confirmed: true,
            baselines: { commit: "0".repeat(40) },
        });
        expect(refused.status).toBe(400);
        expect(localBranches(r)).toEqual(["feat/x", "main"]);
        const look = await s.api("POST", "/api/captures", { what, confirmed: true, stories: "demo--" });
        expect(look.status, JSON.stringify(look.body)).toBe(202);
        expect(look.body.target).toBe(`capture-${look.body.id}`);
        let c;
        await until(async () => {
            c = (await s.api("GET", `/api/captures/${look.body.id}`)).body;
            return !["queued", "running"].includes(c.state);
        });
        expect(c.state, c.error).toBe("done");
        expect(localBranches(r)).toEqual(["feat/x", "main"]);
        // Still offered as a branch from the remote.
        const { sources } = (await s.api("GET", "/api/captures?sources=1")).body;
        expect(sources.remote.map((b) => b.name)).toEqual(["origin/feat/y"]);
    });

    it("asks again, and captures through captureCommand, when the local branch made from a remote one is captured", async () => {
        const r = captureRepo(counter.url, { codeHost: "plain-git", captureCommand: "sh wrap.sh" });
        onRemote(r);
        const s = await serve(r);
        await until(async () => (await s.api("GET", "/api/captures?sources=1")).body.sources.remote.length > 0);
        await capturedAndListed(s, {
            what: { kind: "change", branch: "origin/feat/y", head: r.head },
            confirmed: true,
        });
        expect(readFileSync(r.mark, "utf8").trim().split("\n")).toHaveLength(1);
        const what = { kind: "branch", branch: "feat/y" };
        const asked = await s.api("POST", "/api/captures", { what });
        expect(asked.status).toBe(428);
        expect(asked.body.error).toBe("capturing origin/feat/y here builds and runs its code: confirm it first");
        expect(asked.body.change).toEqual({ pr: null, author: "Owner", remote: "origin/feat/y" });
        const t = await capturedAndListed(s, { what, confirmed: true });
        expect(t).toMatchObject({ id: "branch-feat%2Fy", localBranch: true });
        expect(readFileSync(r.mark, "utf8").trim().split("\n")).toHaveLength(2);
    });
});

/**
 * Gives the capture repository a remote holding feat/x's commit as feat/y, a branch with no local
 * branch of its own.
 * @param {ReturnType<typeof captureRepo>} r the repository
 */
function onRemote(r) {
    const remote = tempDir("vr-plain-remote-");
    git(remote, "init", "-q", "--bare", "-b", "main");
    git(r.repo, "remote", "add", "origin", remote);
    git(r.repo, "push", "-q", "origin", "main", "feat/x:feat/y");
    git(r.repo, "fetch", "-q", "origin");
}

const localBranches = (r) => git(r.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n");
