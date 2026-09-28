/*
 * tools/lfs-pre-push.sh, which .husky/pre-push runs first: it must upload a pushed baseline's Git
 * LFS object (git-lfs's own pre-push hook cannot be installed next to husky's), and without
 * git-lfs it must refuse a push holding LFS files and let any other push through.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256 } from "../trusted/lib/compare.mjs";
import { git, isolateGit, LFS_ATTRIBUTES, lfsObject, ROOT } from "./helpers.mjs";

beforeAll(isolateGit);

const HOOK = join(ROOT, "tools/lfs-pre-push.sh");
const PNG = "visual-baselines/demo/story--one.png";

/**
 * A repository with git-lfs set up, the monorepo's LFS attributes and a bare remote, whose only
 * pre-push hook is tools/lfs-pre-push.sh.
 * @returns {{ repo: string, remote: string }} the paths
 */
function setup() {
    const dir = mkdtempSync(join(tmpdir(), "vr-lfs-hook-"));
    const remote = join(dir, "remote.git");
    const repo = join(dir, "repo");
    git(dir, "init", "-q", "--bare", "-b", "master", remote);
    git(dir, "init", "-q", "-b", "master", repo);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "config", "user.name", "Owner");
    git(repo, "config", "user.email", "owner@example.com");
    git(repo, "lfs", "install", "--local");
    // After `git lfs install`, which would otherwise write its own hooks into this directory.
    const hooks = join(dir, "hooks");
    mkdirSync(hooks);
    symlinkSync(HOOK, join(hooks, "pre-push"));
    git(repo, "config", "core.hooksPath", hooks);
    writeFileSync(join(repo, ".gitattributes"), `${LFS_ATTRIBUTES}\n`);
    writeFileSync(join(repo, "README.md"), "test\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "master");
    return { repo, remote };
}

function commit(repo, path, data) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), data);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", path);
}

/**
 * A PATH holding git and the tools the hook uses, but not git-lfs.
 * @returns {string} the directory
 */
function pathWithoutLfs() {
    const bin = mkdtempSync(join(tmpdir(), "vr-bin-"));
    for (const tool of ["git", "cat", "sort", "grep", "sed", "head"]) {
        symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
    }
    return bin;
}

const push = (repo, env = {}) =>
    spawnSync("git", ["push", "origin", "master"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });

describe("lfs-pre-push.sh", () => {
    it("uploads the LFS object of a pushed baseline, which a push without the hook does not", () => {
        const { repo, remote } = setup();
        commit(repo, PNG, "image one");
        expect(push(repo).status).toBe(0);
        expect(existsSync(lfsObject(remote, sha256(Buffer.from("image one"))))).toBe(true);

        commit(repo, "visual-baselines/demo/story--two.png", "image two");
        git(repo, "push", "-q", "--no-verify", "origin", "master");
        expect(existsSync(lfsObject(remote, sha256(Buffer.from("image two"))))).toBe(false);
    });

    it("without git-lfs, refuses a push holding LFS files and says how to install it", () => {
        const { repo, remote } = setup();
        commit(repo, PNG, "image one");
        const out = push(repo, { PATH: pathWithoutLfs() });
        expect(out.status).not.toBe(0);
        expect(out.stderr).toMatch(/git-lfs is not installed, and this push holds Git LFS files/);
        expect(out.stderr).toContain(PNG);
        expect(out.stderr).toMatch(/apt-get install git-lfs/);
        expect(git(remote, "log", "--format=%s", "master")).toBe("init");
    });

    it("without git-lfs, lets a push with no LFS files through", () => {
        const { repo, remote } = setup();
        commit(repo, "src.txt", "code");
        const out = push(repo, { PATH: pathWithoutLfs() });
        expect(out.stderr).toMatch(/holds no Git LFS files, so it goes ahead/);
        expect(out.status).toBe(0);
        expect(git(remote, "log", "-1", "--format=%s", "master")).toBe("src.txt");
    });
});
