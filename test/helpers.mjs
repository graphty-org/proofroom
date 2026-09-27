/**
 * Shared by the accept and serve tests: a throwaway repository with a bare remote, and copies of
 * the committed results fixture rewritten to point at that repository's commits.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE = fileURLToPath(new URL("fixtures/results/", import.meta.url));
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Inside a git hook (the pre-push gate runs these tests) git exports GIT_DIR and friends, which
// point every git command here, even one run in a temporary directory, at the real repository:
// `git init --bare` there turned the developer's checkout bare. Drop them before any git runs.
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).split("\n")) {
    if (name) delete process.env[name];
}

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
 * removed and unstable items; the branch `feature` adds one commit on top of it.
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
    put(join(repo, "README.md"), "test\n");
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
