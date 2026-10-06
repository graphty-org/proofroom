/**
 * Shared by the accept and serve tests: a throwaway repository with a bare remote, and copies of
 * the committed results fixture rewritten to point at that repository's commits.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILE, normalizeConfig } from "../trusted/lib/config.mjs";

export const FIXTURE = fileURLToPath(new URL("fixtures/results/", import.meta.url));
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Inside a git hook (the pre-push gate runs these tests) git exports GIT_DIR and friends, which
// point every git command here, even one run in a temporary directory, at the real repository:
// `git init --bare` there turned the developer's checkout bare. Drop them before any git runs.
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).split("\n")) {
    if (name) delete process.env[name];
}

/** The monorepo's own visual-review.config.json: default branch master, workflow ci.yml. */
const CONFIG_TEXT = readFileSync(join(ROOT, CONFIG_FILE), "utf8");
export const CONFIG = normalizeConfig(JSON.parse(CONFIG_TEXT));

/**
 * The config with only the two projects the fixtures hold, so adding a project to the monorepo's
 * config does not change what the tests expect, while their settings are still the live ones.
 */
export const FIXTURE_CONFIG = {
    ...CONFIG,
    projects: {
        "compact-mantine": CONFIG.projects["compact-mantine"],
        "graphty-element": CONFIG.projects["graphty-element"],
    },
};

/** The line of the monorepo's .gitattributes that stores baseline PNGs in Git LFS. */
export const LFS_ATTRIBUTES = readFileSync(join(ROOT, ".gitattributes"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("visual-baselines/"));

/**
 * Where a bare remote keeps a Git LFS object it received (git-lfs's local file transfer).
 * @param {string} remote the bare repository
 * @param {string} oid the object's SHA-256
 * @returns {string} the path
 */
export const lfsObject = (remote, oid) => join(remote, "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);

/**
 * Keeps the developer's own git configuration (signing, hooks, aliases) out of the tests. Every
 * git process the code under test starts inherits this environment.
 */
export function isolateGit() {
    const home = mkdtempSync(join(tmpdir(), "vr-home-"));
    writeFileSync(join(home, "gitconfig"), "");
    process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
}

/**
 * Runs git and returns its trimmed output.
 * @param {string} cwd the repository
 * @param {...string} args git's arguments
 * @returns {string} stdout
 */
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * Writes a file, creating its directory.
 * @param {string} path the file
 * @param {string | Buffer} data its contents
 */
function put(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
}

/**
 * A repository cloned from a bare remote. master holds the fixture's baselines for the changed,
 * removed and unstable items, as Git LFS pointers the way the monorepo stores them (the same
 * .gitattributes line, `git lfs install --local`, and the bare remote as its LFS store); the
 * branch `feature` adds one commit on top of it.
 * @returns {{ dir: string, repo: string, remote: string, master: string, head: string }} shas of
 *     master and of the feature branch's head
 */
export function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "vr-repo-"));
    const remote = join(dir, "remote.git");
    const repo = join(dir, "repo");
    git(dir, "init", "-q", "--bare", "-b", "master", remote);
    // init and add the remote, not clone: cloning an empty repository prints a warning -q keeps.
    git(dir, "init", "-q", "-b", "master", repo);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "config", "user.name", "Owner");
    git(repo, "config", "user.email", "owner@example.com");
    git(repo, "lfs", "install", "--local");
    put(join(repo, ".gitattributes"), `${LFS_ATTRIBUTES}\n`);
    put(join(repo, "README.md"), "test\n");
    put(join(repo, CONFIG_FILE), CONFIG_TEXT);
    for (const file of ["button--primary.dark.png", "card--legacy.png", "tooltip--hover.png"]) {
        cpSync(join(FIXTURE, "compact-mantine/baselines", file), join(repo, "visual-baselines/compact-mantine", file));
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "master");
    const master = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "feature");
    put(join(repo, "src.txt"), "feature\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "push", "-q", "origin", "feature");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "master");
    return { dir, repo, remote, master, head };
}

/**
 * Adds a commit to a remote branch from a second clone, as another pusher would.
 * @param {string} remote the bare repository
 * @param {string} branch the branch to add to
 * @param {string} path the file to write, relative to the repository
 * @returns {string} the new commit's sha
 */
export function pushCommit(remote, branch, path) {
    const clone = mkdtempSync(join(tmpdir(), "vr-other-"));
    git(clone, "clone", "-q", "-b", branch, remote, ".");
    git(clone, "config", "user.name", "Other");
    git(clone, "config", "user.email", "other@example.com");
    put(join(clone, path), `${Date.now()}\n`);
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "other");
    git(clone, "push", "-q", "origin", branch);
    return git(clone, "rev-parse", "HEAD");
}

/**
 * Copies one project of the fixture and rewrites its results.json.
 * @param {string} project the fixture project
 * @param {string} dest the directory to copy it to
 * @param {object} overrides fields to replace in results.json
 * @returns {{ dir: string, results: object }} the copy and its parsed results
 */
export function copyFixture(project, dest, overrides = {}) {
    cpSync(join(FIXTURE, project), dest, { recursive: true });
    const path = join(dest, "results.json");
    const results = { ...JSON.parse(readFileSync(path, "utf8")), ...overrides };
    writeFileSync(path, JSON.stringify(results));
    return { dir: dest, results };
}

/**
 * A fake gh answering the calls github.mjs makes, from plain data.
 * @param {object} data what gh answers
 * @param {object[]} [data.prs] open pull requests: { number, head, branch }
 * @param {Record<string, object>} [data.runs] CI runs by head sha
 * @param {Record<string, object>} [data.runsById] CI runs by id
 * @param {object[]} [data.masterRuns] master's commits, newest first, each with its CI run (`id`
 *     null for a commit CI never ran on)
 * @param {Record<string, object[]>} [data.jobs] jobs by run id
 * @param {Record<string, string[]>} [data.artifacts] artifact names by run id
 * @param {Record<string, object>} [data.results] results overrides applied to each download, by
 *     artifact name
 * @param {object[]} [data.posted] collects the comments and commit statuses posted, as { path, body }
 * @returns {Function} the gh runner
 */
export function fakeGh({
    prs = [],
    runs = {},
    runsById = {},
    masterRuns = [],
    jobs = {},
    artifacts = {},
    results = {},
    posted = [],
}) {
    const run = (r) => ({
        id: r.id,
        run_attempt: r.attempt ?? 1,
        status: "completed",
        conclusion: "success",
        html_url: `https://gh/runs/${r.id}`,
        head_sha: r.head,
    });
    return async (args, input) => {
        const path = args[0] === "api" ? args[1] : null;
        let m;
        if (path?.startsWith("repos/{owner}/{repo}/pulls?")) {
            return JSON.stringify(
                prs.map((p) => ({
                    number: p.number,
                    title: `PR ${p.number}`,
                    html_url: `https://gh/pull/${p.number}`,
                    head: { sha: p.head, ref: p.branch },
                })),
            );
        }
        if (path?.startsWith("repos/{owner}/{repo}/commits?sha=master")) {
            return JSON.stringify(masterRuns.map((r) => ({ sha: r.head })));
        }
        if ((m = /workflows\/ci\.yml\/runs\?head_sha=(\w+)/.exec(path))) {
            const found = runs[m[1]] ?? masterRuns.find((r) => r.head === m[1] && r.id !== null);
            return JSON.stringify({ workflow_runs: found ? [run(found)] : [] });
        }
        if ((m = /actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(path))) {
            return JSON.stringify({ jobs: jobs[m[1]] ?? [] });
        }
        if ((m = /actions\/runs\/(\d+)\/artifacts/.exec(path))) {
            return JSON.stringify({
                artifacts: (artifacts[m[1]] ?? []).map((name) => ({ name, expired: false, size_in_bytes: 1000000 })),
            });
        }
        if ((m = /actions\/runs\/(\d+)$/.exec(path))) {
            return JSON.stringify(run(runsById[m[1]]));
        }
        if (/issues\/\d+\/comments$/.test(path ?? "") || /\/statuses\/\w+$/.test(path ?? "")) {
            posted.push({ path, body: JSON.parse(args.length > 2 ? (input ?? "{}") : "{}") });
            return "{}";
        }
        if (path === "repos/{owner}/{repo}/pulls") {
            posted.push({ path, body: JSON.parse(input ?? "{}") });
            return JSON.stringify({ html_url: "https://gh/pull/650", number: 650 });
        }
        if (args[0] === "run" && args[1] === "download") {
            const name = args[4];
            const project = /^visual-(.+)-\d+$/.exec(name)[1];
            copyFixture(project, args[6], results[name] ?? {});
            return "";
        }
        throw new Error(`fake gh: unexpected ${args.join(" ")}`);
    };
}

export const job = (project, conclusion = "success") => ({
    name: `visual (${project})`,
    conclusion,
    html_url: `https://gh/job/${project}`,
});

// One pull request (#123, branch feature) with a finished run 1000 of both projects.
export const onePr =
    (extra = {}) =>
    (r) =>
        fakeGh({
            prs: [{ number: 123, head: r.head, branch: "feature" }],
            runs: { [r.head]: { id: 1000, head: r.head, attempt: 1 } },
            jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
            artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
            results: {
                "visual-compact-mantine-1": { commit: r.head, headSha: r.head },
                "visual-graphty-element-1": { commit: r.head, headSha: r.head },
            },
            ...extra,
        });

/**
 * The compact-mantine fixture's items without its failed capture: a pull request the inbox can
 * call ready (one with a failed story never is).
 * @returns {object[]} the items
 */
export const capturedItems = () =>
    JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items.filter(
        (i) => i.status !== "failed",
    );

/**
 * The fixture as pull request #123, with slider--sizes renamed from old-slider--sizes and looking
 * exactly as that old id's baseline: a moved item, whose baseline is its own capture's bytes.
 * @param {object} r the repository
 * @param {object[]} [extra] more items for compact-mantine's results.json
 * @returns {Function} the gh runner
 */
export const withMoved = (r, extra = []) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
    const items = fixture.items.map((i) =>
        i.file === "slider--sizes.png"
            ? {
                  ...i,
                  status: "moved",
                  from: "old-slider--sizes",
                  baseline: i.capture,
                  baselineSize: i.size,
                  changedPixels: 0,
                  bbox: null,
              }
            : i,
    );
    items.push(...extra);
    const at = { commit: r.head, headSha: r.head };
    return onePr({ results: { "visual-compact-mantine-1": { ...at, items }, "visual-graphty-element-1": at } })(r);
};

/**
 * A new tab whose request interception is on for its whole life, so a `page.route` holds the very
 * next request the page sends. Playwright turns Chromium's interception on with a page's first
 * route and off with its last unroute, and the renderer takes that switch asynchronously: a
 * request sent right after `await page.route(...)` can still go out unintercepted (about one in
 * ten on a CPU throttled sixfold, as a slow CI runner is). With this never-matching route held,
 * later routes only change what Playwright matches, which is in force before `page.route` returns.
 * @param {import("playwright").Browser} browser the browser to open it in
 * @param {import("playwright").BrowserContextOptions} options the viewport and the rest, as for newPage
 * @returns {Promise<import("playwright").Page>} the tab
 */
export async function interceptedPage(browser, options) {
    const page = await browser.newPage(options);
    await page.route("**/interception-stays-on", (route) => route.continue());
    return page;
}
