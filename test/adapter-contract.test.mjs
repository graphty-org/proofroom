/*
 * The adapters' contract: what the server, Finish and capture rely on from a code host, a capture
 * store, a story source and a renderer, run against every implementation -- GitHub and GitHub
 * Actions over a replay of gh's recorded answers (never the network), plain git over a temporary
 * repository, the local folder, Storybook and Playwright Chromium over the stand-in Storybook, and
 * the fakes the other tests use. A code host may lack an optional function; it then says so.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as chromium from "../capture/chromium.mjs";
import * as storybookSource from "../capture/storybook.mjs";
import { adapterFacts, captureStoreFor, codeHostFor, localFolderStore } from "../trusted/lib/adapters/index.mjs";
import { plainGitCodeHost } from "../trusted/lib/adapters/plain-git.mjs";
import { normalizeConfig } from "../trusted/lib/config.mjs";
import { fakeCaptureStore } from "./fakes/capture-store.mjs";
import { fakeCodeHost } from "./fakes/code-host.mjs";
import { fakeRenderer } from "./fakes/renderer.mjs";
import { fakeStorySource } from "./fakes/story-source.mjs";
import { exec } from "../trusted/lib/github.mjs";
import { CONFIG, copyFixture, FIXTURE, git, tempDir } from "./helpers.mjs";
import { countingServer, storybook as standIn } from "./stand-in-storybook.mjs";

const HEAD = "6dfc21d0c4b1e0f8a5c2b0d9e7a4f3c2b1a09876";
const RUN = 18800002;
const PROJECT = "compact-mantine";
const replay = JSON.parse(readFileSync(new URL("fixtures/github/replay.json", import.meta.url), "utf8")).calls;
const poll = readFileSync(new URL("fixtures/github/pulls-poll.json", import.meta.url), "utf8");

/**
 * A gh runner answering from the recording: an unrecorded call fails the test, a write is kept
 * with what it sent, and `run download` writes the fixture's capture.
 * @returns {{ gh: (args: string[], input?: string) => Promise<string>, asked: string[], sent: { call: string, input: object }[] }}
 *     the runner, every call it was asked, and every write's body
 */
function replayGh() {
    const asked = [];
    const sent = [];
    const gh = async (args, input) => {
        const call = args.join(" ");
        asked.push(call);
        if (args[0] === "api" && args[1] === "graphql") {
            return poll;
        }
        if (args[0] === "run" && args[1] === "download") {
            copyFixture(/^visual-(.+)-\d+$/.exec(args[4])[1], args[6], { headSha: HEAD, runId: RUN });
            return "";
        }
        if (!(call in replay)) {
            throw new Error(`gh replay: nothing recorded for ${call}`);
        }
        if (args.includes("--input") || args.includes("PATCH")) {
            sent.push({ call, input: input ? JSON.parse(input) : {} });
        }
        return JSON.stringify(replay[call]);
    };
    return { gh, asked, sent };
}

// The gh calls github.mjs makes for the code host and the capture store.
const GH_CALLS = [
    "commentOnPullRequest",
    "createIssue",
    "createPullRequest",
    "downloadCaptures",
    "getRun",
    "hurry",
    "newestCiRun",
    "newestMasterCapture",
    "openPullRequests",
    "postStatus",
    "pullRequestContext",
    "repositoryNumber",
    "reviewerLogin",
    "visualJobs",
];

/**
 * Every module of the tool, by its path from the package root, with its text.
 * @returns {[string, string][]} the modules
 */
function modules() {
    const root = new URL("..", import.meta.url);
    return ["trusted", "capture"].flatMap((dir) =>
        readdirSync(new URL(dir, root), { recursive: true, encoding: "utf8" })
            .filter((f) => f.endsWith(".mjs") && !f.startsWith("vendor"))
            .map((f) => [`${dir}/${f}`, readFileSync(new URL(`${dir}/${f}`, root), "utf8")]),
    );
}

describe("the adapters are the only way out", () => {
    it("no module but an adapter makes a gh call, and none but the renderer loads Playwright", () => {
        const ghUsers = modules()
            .filter(([, text]) => GH_CALLS.some((name) => new RegExp(String.raw`(?<![.\w])${name}\(`).test(text)))
            .map(([path]) => path);
        expect(ghUsers.sort()).toEqual([
            "trusted/lib/adapters/github-actions.mjs",
            "trusted/lib/adapters/github.mjs",
            "trusted/lib/github.mjs",
        ]);
        // Nor calls a gh runner itself, or starts gh by name (exec("gh", ...), spawn("gh", ...)).
        const raw = modules()
            .filter(([path]) => path !== "trusted/lib/github.mjs" && !path.startsWith("trusted/lib/adapters/"))
            .filter(([, text]) => /\bgh\(|\(\s*["'`]gh["'`]/.test(text))
            .map(([path]) => path);
        expect(raw).toEqual([]);
        const playwright = modules()
            .filter(([, text]) => /^import [^;]*from "playwright"|await import\("playwright"\)/m.test(text))
            .map(([path]) => path);
        expect(playwright).toEqual(["capture/chromium.mjs"]);
    });
});

describe("the config picks the adapters by name", () => {
    it("defaults to today's and refuses a name it has no adapter for", () => {
        const config = normalizeConfig({ projects: { web: { storybook: "sb" } } });
        expect(codeHostFor(config, { gh: async () => "" }).name).toBe("github");
        expect(captureStoreFor(config, { gh: async () => "" }).name).toBe("github-actions");
        const named = normalizeConfig({
            codeHost: "github",
            captureStore: "github-actions",
            stories: "storybook",
            renderer: "playwright-chromium",
            projects: { web: { storybook: "sb" } },
        });
        expect(named).toMatchObject({ codeHost: "github", stories: "storybook" });
        expect(() => normalizeConfig({ codeHost: "gitlab", projects: { web: { storybook: "sb" } } })).toThrow(
            'visual-review.config.json: codeHost must be "github"',
        );
        expect(() => normalizeConfig({ renderer: "firefox", projects: { web: { storybook: "sb" } } })).toThrow(
            'renderer must be "playwright-chromium"',
        );
    });
});

const BRANCH = "feat/3486-storybook-9";

/**
 * Plain git over a temporary repository on main with the branch BRANCH, committed by apowers.
 * @returns {{ host: object, written: () => number, asked: () => string[], ref: string, head: string, id: RegExp }}
 *     the host, its writes (none: it has nothing to post to), every git call, and the branch's head
 */
function plainGit() {
    const repo = tempDir("vr-contract-git-");
    const run = (...args) => git(repo, ...args);
    run("init", "-q", "-b", "main");
    run("config", "user.name", "apowers");
    run("config", "user.email", "apowers@example.com");
    run("commit", "-q", "--allow-empty", "-m", "init");
    run("checkout", "-q", "-b", BRANCH);
    run("commit", "-q", "--allow-empty", "-m", "Storybook 9 upgrade for every package and its stories");
    const head = run("rev-parse", "HEAD");
    run("checkout", "-q", "main");
    const asked = [];
    const host = plainGitCodeHost(
        repo,
        { defaultBranch: "main", repositoryId: "1b7e4c2a-9d3f-4e8a-b6c1-2f0a9e8d7c65" },
        {
            git: (args) => {
                asked.push(args.join(" "));
                return exec("git", args, { cwd: repo });
            },
        },
    );
    return { host, written: () => 0, asked: () => asked, ref: BRANCH, head, id: /^[0-9a-f-]{36}$/ };
}

// Each code host, and the change it holds: its number (its branch on a host without numbers), its
// head, and the form of the repository's id.
const codeHosts = [
    [
        "GitHub, over gh's recorded answers",
        () => {
            const r = replayGh();
            return {
                host: codeHostFor(CONFIG, { gh: r.gh }),
                written: () => r.sent.length,
                asked: () => r.asked,
                ref: 3486,
                head: HEAD,
                id: /^\S+:\S+$/,
            };
        },
    ],
    [
        "the fake",
        () => {
            const host = fakeCodeHost({
                changes: [
                    {
                        number: 3486,
                        title: "Storybook 9 upgrade for every package and its stories",
                        url: "https://fake/changes/3486",
                        headSha: HEAD,
                        branch: "feat/3486-storybook-9",
                        draft: false,
                        author: "apowers",
                        run: { id: RUN, status: "completed", conclusion: "success", updatedAt: "2026-10-25T10:30:00Z" },
                        visual: null,
                    },
                ],
                login: "apowers",
            });
            return {
                host,
                written: () => host.posted.length,
                asked: () => host.calls,
                ref: 3486,
                head: HEAD,
                id: /^\S+:\S+$/,
            };
        },
    ],
    ["plain git, over a temporary repository", plainGit],
];

const lacks = (host) => adapterFacts(host, { name: "none" }, {}).codeHost.lacks;
const has = (host, fn) => typeof host[fn] === "function";

describe.each(codeHosts)("the code host: %s", (_, make) => {
    it("has the page's words for its changes", () => {
        const { host } = make();
        expect(Object.keys(host.vocabulary).sort()).toEqual([
            "changeNoun",
            "changeTag",
            "ciName",
            "hostName",
            "numberPrefix",
        ]);
        // Every word is a string, but a host with no CI has no name for it.
        expect(
            Object.entries(host.vocabulary).every(([k, w]) => typeof w === "string" || (k === "ciName" && w === null)),
        ).toBe(true);
    });

    it("lists every open change in one call, each with its head, branch and newest capture run", async () => {
        const { host, asked, ref, head } = make();
        const changes = await host.listChanges({ workflow: "ci.yml" });
        expect(asked()).toHaveLength(1);
        const c = changes.find((x) => x.branch === BRANCH);
        expect(c).toMatchObject({ headSha: head, draft: false, author: "apowers" });
        // A change without a number is named by its branch, and has no page of its own.
        expect(c.number).toBe(typeof ref === "number" ? ref : null);
        expect(typeof c.title).toBe("string");
        if (c.number === null) {
            expect(c.url).toBeNull();
        } else {
            expect(typeof c.url).toBe("string");
        }
        if (host.vocabulary.ciName === null) {
            expect(c.run).toBeNull();
        } else {
            expect(c.run).toMatchObject({ id: expect.any(Number), status: expect.any(String) });
        }
    });

    it("describes a change, names the reviewer and the repository, and reads one change", async () => {
        const { host, ref, head, id } = make();
        const about = await host.describe(ref, "apowers");
        expect(about).toMatchObject({
            title: expect.any(String),
            body: expect.any(String),
            comments: expect.any(Array),
        });
        expect(await host.whoAmI()).toBe("apowers");
        expect(await host.repositoryId()).toMatch(id);
        // One change is read back only after Finish opened one: a host that opens none has neither.
        if (has(host, "openChange")) {
            expect(await host.change(ref)).toMatchObject({ state: "open", head: { ref: BRANCH, sha: head } });
        } else {
            expect(has(host, "change")).toBe(false);
        }
    });

    it("posts a comment, a status and an issue, and opens, finds, updates and closes a change", async () => {
        const { host, written, ref, head } = make();
        let writes = 0;
        // Each write a host can make, made; each it cannot, named among the functions it lacks.
        const each = async (fn, write) => {
            if (has(host, fn)) {
                await write();
                writes += 1;
            } else {
                expect(lacks(host)).toContain(fn);
            }
        };
        await each("comment", () => host.comment(ref, "rejected: slider--sizes.png"));
        await each("setStatus", () => host.setStatus(head, { state: "success", description: "Reviewed: 1 accepted" }));
        await each("fileIssue", async () =>
            expect(await host.fileIssue({ title: "Visual review", body: "rejects", labels: ["bug"] })).toMatch(
                /^https:/,
            ),
        );
        await each("openChange", async () => {
            const url = await host.openChange({
                title: "test: approve",
                head: "visual/approve-6dfc21d0c4",
                base: "master",
                body: "accepts",
            });
            expect(url).toMatch(/^https:/);
            const open = await host.openChangeOf("visual/approve-6dfc21d0c4");
            expect(open).toEqual({ number: expect.any(Number), html_url: url });
            await host.updateChange(open.number, { body: "accepts, again" });
            await host.closeChange(open.number);
            writes += 2;
        });
        if (!has(host, "openChange")) {
            expect(["openChangeOf", "updateChange", "closeChange"].filter((fn) => has(host, fn))).toEqual([]);
        }
        expect(written()).toBe(writes);
    });

    it("finds no open change for a branch that has none", async () => {
        const { host } = make();
        if (has(host, "openChange")) {
            expect(await host.openChangeOf("no-such-branch")).toBeNull();
        } else {
            expect(lacks(host)).toContain("openChange");
        }
    });
});

describe("the GitHub code host", () => {
    it("sends GitHub what today's gh calls sent", async () => {
        const r = replayGh();
        const host = codeHostFor(CONFIG, { gh: r.gh });
        await host.setStatus(HEAD, { state: "pending", description: "x".repeat(200) });
        await host.comment(3486, "hello");
        expect(r.sent).toEqual([
            {
                call: `api repos/{owner}/{repo}/statuses/${HEAD} --input -`,
                input: { state: "pending", context: "Visual review", description: "x".repeat(140) },
            },
            { call: "api repos/{owner}/{repo}/issues/3486/comments --input -", input: { body: "hello" } },
        ]);
        expect(await host.repositoryId()).toBe("github:871234567");
    });
});

/**
 * The fake capture store holding run 18800002 of HEAD, which captured compact-mantine.
 * @returns {ReturnType<typeof fakeCaptureStore>} the store
 */
function fakeStore() {
    const set = tempDir("vr-fake-set-");
    copyFixture(PROJECT, set, { headSha: HEAD, runId: RUN });
    return fakeCaptureStore({
        runs: [
            {
                id: RUN,
                attempt: 1,
                status: "completed",
                conclusion: "success",
                url: "https://fake/runs/18800002",
                headSha: HEAD,
                updatedAt: "2026-10-25T10:30:00Z",
            },
        ],
        jobs: { [RUN]: { [PROJECT]: { status: "completed", conclusion: "success", url: "https://fake/job/1" } } },
        sets: { [RUN]: { [PROJECT]: set } },
    });
}

const stores = [
    ["GitHub Actions, over gh's recorded answers", () => captureStoreFor(CONFIG, { gh: replayGh().gh })],
    ["the fake", fakeStore],
];

describe.each(stores)("the capture store: %s", (_, make) => {
    it("finds a commit's newest run, and none for a commit CI never ran on", async () => {
        const store = make();
        const run = await store.newestRun(HEAD, { workflow: "ci.yml" });
        expect(run).toMatchObject({ id: RUN, attempt: 1, status: "completed", conclusion: "success", headSha: HEAD });
        expect(await store.run(RUN)).toEqual(run);
        expect(await store.newestRun("0".repeat(40), { workflow: "ci.yml" })).toBeNull();
    });

    it("gives each project's capture job, and none for a project it did not run", async () => {
        const store = make();
        const jobs = await store.jobs(await store.run(RUN), [PROJECT, "graphty-element"]);
        expect(jobs[PROJECT]).toMatchObject({ conclusion: "success", url: expect.any(String) });
        expect(jobs["graphty-element"]).toBeUndefined();
    });

    it("lists the run's capture sets and fetches each into its own directory", async () => {
        const store = make();
        const run = await store.run(RUN);
        const sets = await store.list(run);
        expect(sets).toEqual([expect.objectContaining({ project: PROJECT, attempt: 1, expired: false })]);
        const dir = tempDir("vr-fetch-");
        const landed = [];
        const got = await store.fetch(run, [PROJECT, "graphty-element"], dir, [], (p) => landed.push(p));
        expect(got[PROJECT]).toMatchObject({ dir: join(dir, `${RUN}-1`, PROJECT), attempt: 1 });
        expect(got["graphty-element"]).toBeNull();
        expect(landed.sort()).toEqual(["compact-mantine", "graphty-element"]);
        const results = JSON.parse(readFileSync(join(got[PROJECT].dir, "results.json"), "utf8"));
        expect(results).toMatchObject({ project: PROJECT, headSha: HEAD });
    });
});

describe("the GitHub Actions capture store", () => {
    it("asks GitHub once for what a finished run says, keeping the answers beside its downloads", async () => {
        const r = replayGh();
        const keep = tempDir("vr-keep-");
        const store = captureStoreFor(CONFIG, { gh: r.gh, keep });
        const run = await store.run(RUN);
        await store.jobs(run, [PROJECT]);
        await store.jobs(run, [PROJECT]);
        expect(await store.expiresAt(run, PROJECT)).toBe("2027-01-23T10:30:00Z");
        expect(await store.expiresAt(run, PROJECT)).toBe("2027-01-23T10:30:00Z");
        expect(r.asked.filter((c) => c.includes("/jobs?"))).toHaveLength(1);
        expect(r.asked.filter((c) => c.includes("/artifacts?"))).toHaveLength(1);
        expect(existsSync(join(keep, `${RUN}-1`, "gh"))).toBe(true);
    });

    it("finds the default branch's newest complete capture of a project", async () => {
        const store = captureStoreFor(CONFIG, { gh: replayGh().gh });
        const dir = tempDir("vr-default-");
        expect(await store.newestDefault(PROJECT, dir, CONFIG)).toBe(join(dir, `${RUN}-1`, PROJECT));
    });
});

describe("the local folder capture store", () => {
    let root;
    beforeAll(() => {
        root = tempDir("vr-local-");
        copyFixture(PROJECT, join(root, PROJECT));
        copyFixture(PROJECT, join(root, "123", PROJECT), { pr: 123 });
        writeFileSync(join(root, "123", "status.json"), JSON.stringify({ state: "done", head: HEAD }));
        mkdirSync(join(root, `.pending-${HEAD}`));
        writeFileSync(join(root, `.pending-${HEAD}`, "status.json"), JSON.stringify({ pr: 123, head: HEAD }));
    });

    it("lists the capture sets in the folder, or of one change, and fetching one names where it is", async () => {
        const store = localFolderStore(root);
        expect(await store.list(null)).toEqual([
            { project: PROJECT, dir: join(root, PROJECT), ref: join(root, PROJECT) },
        ]);
        const [set] = await store.list(123);
        expect(set.project).toBe(PROJECT);
        expect(await store.fetch(set.ref)).toBe(join(root, "123", PROJECT));
        expect(store.has(123, PROJECT)).toBe(true);
        expect(store.has(123, "graphty-element")).toBe(false);
        expect(await store.list(999)).toEqual([]);
    });

    it("reads a change's status, the captures staged for unpushed commits, and when they changed", () => {
        const store = localFolderStore(root);
        expect(store.status(123)).toEqual({ state: "done", head: HEAD });
        expect(store.status(999)).toBeNull();
        expect(store.pending()).toEqual([{ dir: join(root, `.pending-${HEAD}`), status: { pr: 123, head: HEAD } }]);
        const before = store.stamp(123);
        utimesSync(join(root, "123", "status.json"), new Date(2020, 1, 1), new Date(2020, 1, 1));
        expect(store.stamp(123)).not.toBe(before);
    });

    it("is empty for a folder that does not exist", async () => {
        const store = localFolderStore(join(FIXTURE, "no-such-folder"));
        expect(await store.list(null)).toEqual([]);
        expect(store.pending()).toEqual([]);
    });
});

const IDS = ["demo--plain", "demo--small", "demo--broken"];
let counter;
beforeAll(async () => {
    counter = await countingServer();
});
afterAll(() => counter?.close());

describe.each([
    ["Storybook", () => ({ source: storybookSource, dir: standIn(counter.url, undefined, IDS) })],
    ["the fake", () => ({ source: fakeStorySource(IDS), dir: "unused" })],
])("the story source: %s", (_, make) => {
    it("lists the stories sorted, and gives each story and mode its own URL", async () => {
        const { source, dir } = make();
        expect(await source.stories(dir)).toEqual([...IDS].sort());
        const plain = source.url("http://127.0.0.1:1/", "demo--plain", null);
        const dark = source.url("http://127.0.0.1:1/", "demo--plain", { theme: "dark" });
        expect(plain).toContain("demo--plain");
        expect(plain.startsWith("http://127.0.0.1:1/")).toBe(true);
        expect(dark).not.toBe(plain);
    });

    it("builds nothing when the project has no build command", async () => {
        const { source } = make();
        await expect(source.build(null, tempDir("vr-build-"))).resolves.toBeUndefined();
    });
});

describe("the Storybook story source", () => {
    it("runs the project's build command in the repository", async () => {
        const cwd = tempDir("vr-build-");
        await storybookSource.build("echo built > out.txt", cwd);
        expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("built\n");
        await expect(storybookSource.build("echo nope >&2; exit 3", cwd)).rejects.toThrow("nope");
    });
});

describe.each([
    [
        "Playwright Chromium",
        async () => {
            const [server, base] = await storybookSource.serve(standIn(counter.url, undefined, IDS));
            return {
                renderer: chromium,
                good: storybookSource.url(base, "demo--small", null),
                bad: storybookSource.url(base, "demo--broken", null),
                done: () => server.close(),
            };
        },
    ],
    [
        "the fake",
        async () => ({
            renderer: fakeRenderer({ failing: ["http://x/bad"] }),
            good: "http://x/good",
            bad: "http://x/bad",
            done: () => {},
        }),
    ],
])("the renderer: %s", (_, make) => {
    it("shoots a story as a PNG, says why one could not be shot, and closes", async () => {
        const { renderer, good, bad, done } = await make();
        const browser = await renderer.open();
        try {
            const shot = await renderer.shoot(browser, good, {
                delay: 0,
                waitFor: null,
                rendered: storybookSource.rendered,
            });
            expect(shot.reason).toBeNull();
            expect(PNG.sync.read(shot.png).width).toBeGreaterThan(0);
            const failed = await renderer.shoot(browser, bad, {
                delay: 0,
                waitFor: null,
                rendered: storybookSource.rendered,
            });
            expect(failed.png).toBeNull();
            expect(failed.reason).toMatch(/errored/);
        } finally {
            await renderer.close(browser);
            done();
        }
    });
});
