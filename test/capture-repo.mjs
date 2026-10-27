/*
 * A repository for the tests of captures started from the review page: one project whose built
 * Storybook is the stand-in (stand-in-storybook.mjs), committed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_FILE, normalizeConfig } from "../trusted/lib/config.mjs";
import { git, tempDir } from "./helpers.mjs";
import { storybook } from "./stand-in-storybook.mjs";

/** The stories the stand-in Storybook of a capture repository lists. */
export const STORIES = ["demo--plain", "demo--small", "demo--broken"];
const REPO_ID = "1b7e4c2a-9d3f-4e8a-b6c1-2f0a9e8d7c65";

/**
 * A repository with one project, demo, whose built Storybook (the stand-in) is committed: its
 * default branch main, and the branch feat/x checked out with a commit of its own. Baselines are
 * Git LFS files, and Finish writes change statements.
 * @param {string} sbServer the server the stand-in Storybook's stories ask (stand-in-storybook.mjs
 *     countingServer; one that never answers keeps a story loading)
 * @param {{ captureCommand?: string }} [o] the config's captureCommand
 * @returns {{ repo: string, config: object, main: string, head: string, mark: string }} it, its
 *     config, main's and feat/x's commits, and the file a wrapper script appends to
 */
export function captureRepo(sbServer, { captureCommand } = {}) {
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
