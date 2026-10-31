/*
 * The accept commit a Finish prepares is built without a worktree (a temporary index, one
 * hash-object, one update-index, write-tree and commit-tree). These tests build the same commit
 * the way Finish built it before: a worktree of the parent, the same files written into it, then
 * `git add -A` (git-lfs's clean filter making the pointers) and `git commit` with the same message,
 * author and dates. The two commits must be the same object: the same tree (every LFS pointer, the
 * review record, every file), the same parent, the same message and the same metadata.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { prepareApproval } from "../trusted/lib/accept.mjs";
import { isLfsPointer, sha256 } from "../trusted/lib/compare.mjs";
import { CONFIG_FILE } from "../trusted/lib/config.mjs";
import { CONFIG, copyFixture, git, isolateGit, makeRepo, tempDir } from "./helpers.mjs";

beforeAll(isolateGit);

const NOW = new Date("2026-09-27T15:04:05Z");
const accept = (file, project = "compact-mantine", reason = null) => ({ project, file, decision: "accept", reason });
const DECISIONS = [
    accept("button--primary.dark.png", "compact-mantine", "wider"),
    accept("card--legacy.png"),
    accept("badge--default.light.png"),
    { project: "compact-mantine", file: "tooltip--hover.png", decision: "exclude", reason: "hover races" },
    accept("graph--basic.png", "graphty-element"),
];

/**
 * The fixture repository and both fixture projects captured at `at`.
 * @param {object} [r] the repository, makeRepo's by default
 * @param {object} [at] what the captures name (commit, headSha, pr)
 * @returns {object} the repository and its projects
 */
function setup(r = makeRepo(), at = { commit: r.head, headSha: r.head }) {
    const projects = {
        "compact-mantine": copyFixture("compact-mantine", join(r.dir, "art/compact-mantine"), at),
        "graphty-element": copyFixture("graphty-element", join(r.dir, "art/graphty-element"), at),
    };
    return { ...r, projects };
}

/**
 * The accept commit as Finish made it before: the parent checked out in a worktree (pointers left
 * as pointers), each changed file written there (an accepted image as the capture's own bytes, any
 * other file as the commit holds it), then `git add -A` and `git commit` with the commit's message,
 * author, committer and dates.
 * @param {string} repo the repository
 * @param {string} commit the commit built without a worktree
 * @param {Map<string, Buffer>} images the bytes of each accepted image, by path, read from the capture
 * @returns {string} the commit the worktree made
 */
function builtTheOldWay(repo, commit, images) {
    const parent = git(repo, "rev-parse", `${commit}^`);
    const tree = join(tempDir("vr-old-way-"), "tree");
    const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" };
    const run = (cwd, args, input) =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
            cwd,
            env: { ...env, ...input?.env },
            input: input?.stdin,
            encoding: "utf8",
        }).trim();
    run(repo, ["worktree", "add", "-q", "--detach", tree, parent]);
    try {
        const changes = run(repo, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", parent, commit])
            .split("\0")
            .filter(Boolean);
        for (let i = 0; i < changes.length; i += 2) {
            const [status, path] = [changes[i], changes[i + 1]];
            if (status === "D") {
                rmSync(join(tree, path), { force: true });
                continue;
            }
            const blob = execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], { cwd: repo });
            mkdirSync(join(tree, path, ".."), { recursive: true });
            // An image is written as the capture's bytes, never as the new commit's pointer.
            writeFileSync(join(tree, path), isLfsPointer(blob) ? images.get(path) : blob);
        }
        run(tree, ["add", "-A", "--", "."]);
        const [an, ae, ad, cn, ce, cd] = run(repo, [
            "log",
            "-1",
            "--date=raw",
            "--format=%an%n%ae%n%ad%n%cn%n%ce%n%cd",
            commit,
        ]).split("\n");
        const message = execFileSync("git", ["log", "-1", "--format=%B", commit], { cwd: repo, encoding: "utf8" });
        run(tree, ["commit", "-q", "--no-verify", "-F", "-"], {
            stdin: message,
            env: {
                GIT_AUTHOR_NAME: an,
                GIT_AUTHOR_EMAIL: ae,
                GIT_AUTHOR_DATE: ad,
                GIT_COMMITTER_NAME: cn,
                GIT_COMMITTER_EMAIL: ce,
                GIT_COMMITTER_DATE: cd,
            },
        });
        return run(tree, ["rev-parse", "HEAD"]);
    } finally {
        run(repo, ["worktree", "remove", "--force", "--force", tree]);
    }
}

/**
 * The bytes of each accepted image, by the path the commit holds it at.
 * @param {object} s the setup
 * @param {object[]} decisions the decisions
 * @returns {Map<string, Buffer>} them
 */
const imagesOf = (s, decisions) =>
    new Map(
        decisions
            .filter((d) => d.decision === "accept" && existsSync(join(s.projects[d.project].dir, d.file)))
            .map((d) => [
                `${CONFIG.baselines}/${d.project}/${d.file}`,
                readFileSync(join(s.projects[d.project].dir, d.file)),
            ]),
    );

describe("the accept commit, built without a worktree", () => {
    it("is the commit a worktree, git add and git commit make of the same files: a pull request", async () => {
        const s = setup();
        // No worktree is made: where the accept worktree would go is a file, so `git worktree add` fails.
        mkdirSync(join(s.repo, CONFIG.workDir), { recursive: true });
        writeFileSync(join(s.repo, CONFIG.workDir, "worktrees"), "");
        const prepared = await prepareApproval({
            repo: s.repo,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions: DECISIONS,
            now: NOW,
            config: CONFIG,
        });
        const changed = git(s.repo, "diff-tree", "-r", "--name-only", `${prepared.commit}^`, prepared.commit).split(
            "\n",
        );
        // The images, the settings file of the exclusion and the review record.
        expect(changed).toEqual(
            expect.arrayContaining([
                "visual-baselines/compact-mantine/button--primary.dark.png",
                "visual-baselines/compact-mantine/tooltip--hover.json",
                "visual-baselines/graphty-element/graph--basic.png",
                prepared.record,
            ]),
        );
        expect(builtTheOldWay(s.repo, prepared.commit, imagesOf(s, DECISIONS))).toBe(prepared.commit);
        // Each accepted image is in git-lfs's store, as the clean filter would have left it, for the push.
        for (const [path, bytes] of imagesOf(s, DECISIONS)) {
            const blob = execFileSync("git", ["cat-file", "blob", `${prepared.commit}:${path}`], { cwd: s.repo });
            if (blob.length === 0 || !isLfsPointer(blob)) {
                continue;
            }
            const oid = sha256(bytes);
            expect(blob.toString()).toContain(`oid sha256:${oid}`);
            expect(sha256(readFileSync(join(s.repo, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid)))).toBe(
                oid,
            );
        }
    });

    it("is the same commit for a seed whose commit predates the LFS rule, master's .gitattributes carried in", async () => {
        const r = makeRepo();
        git(r.repo, "checkout", "-q", "--detach", r.master);
        writeFileSync(join(r.repo, ".gitattributes"), "");
        // Only the rules change: every baseline stays the pointer it was. (A worktree's `git add`
        // re-hashes a file git cannot tell is unchanged, its mtime the index's second, so where the
        // rules change it decided by timing whether an untouched baseline was converted; the commit
        // built without a worktree changes only the decided files.)
        git(r.repo, "add", "--", ".gitattributes");
        git(r.repo, "commit", "-q", "-m", "before the LFS rule");
        const old = git(r.repo, "rev-parse", "HEAD");
        const s = setup(r, { commit: old, headSha: null, pr: null });
        const decisions = [accept("badge--default.light.png")];
        const prepared = await prepareApproval({
            repo: s.repo,
            target: { pr: null, branch: null },
            projects: { "compact-mantine": s.projects["compact-mantine"] },
            decisions,
            now: NOW,
            config: CONFIG,
        });
        const image = "visual-baselines/compact-mantine/badge--default.light.png";
        expect(isLfsPointer(execFileSync("git", ["show", `${prepared.commit}:${image}`], { cwd: s.repo }))).toBe(true);
        expect(builtTheOldWay(s.repo, prepared.commit, imagesOf(s, decisions))).toBe(prepared.commit);
    });

    it("is the same commit in change mode, which holds only the baselines until the statement is signed", async () => {
        const r = makeRepo();
        const own = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
        const config = { ...own, approvalFormat: "change", repositoryId: "5d2c9a10-7f3e-4b61-a8d4-0c9e1b2f3a47" };
        writeFileSync(join(r.repo, CONFIG_FILE), `${JSON.stringify(config, null, 4)}\n`);
        git(r.repo, "commit", "-q", "-am", "change mode");
        git(r.repo, "push", "-q", "origin", "master");
        git(r.repo, "checkout", "-q", "feature");
        git(r.repo, "merge", "-q", "--no-edit", "master");
        git(r.repo, "push", "-q", "origin", "feature");
        const head = git(r.repo, "rev-parse", "HEAD");
        git(r.repo, "checkout", "-q", "master");
        const s = setup({ ...r, head });
        const prepared = await prepareApproval({
            repo: s.repo,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions: DECISIONS,
            now: NOW,
            config: CONFIG,
        });
        expect(prepared.statement).toBeDefined();
        expect(builtTheOldWay(s.repo, prepared.commit, imagesOf(s, DECISIONS))).toBe(prepared.commit);
    });

    it("signs the commit when the repository signs its commits, as git commit does", async () => {
        const s = setup();
        git(s.repo, "config", "gpg.format", "ssh");
        // A signing program that fails: a commit made without asking it would not fail.
        git(s.repo, "config", "gpg.ssh.program", "false");
        git(s.repo, "config", "user.signingkey", "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderKey");
        git(s.repo, "config", "commit.gpgsign", "true");
        await expect(
            prepareApproval({
                repo: s.repo,
                target: { pr: 123, branch: "feature" },
                projects: s.projects,
                decisions: DECISIONS,
                now: NOW,
                config: CONFIG,
            }),
        ).rejects.toThrow(/failed to write commit object/);
    });
});
