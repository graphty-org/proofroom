/*
 * Vitest's global setup: builds the repositories makeRepo (helpers.mjs) copies, once for the run.
 */

import { rmSync } from "node:fs";

import { isolateGit } from "../../tools/isolated-git-env.mjs";
import { buildConflicted, buildRepo } from "./helpers.mjs";

/**
 * Builds the repositories and hands them to the test files as `repoTemplate`, and as
 * `conflictedRepo` and `conflictedCodeRepo` (buildConflicted, without and with a conflict outside
 * the baselines).
 * @param {import("vitest/node").TestProject} project the test project
 * @returns {() => void} the teardown, which deletes them
 */
export default function setup(project) {
    isolateGit();
    const template = buildRepo();
    const built = {
        repoTemplate: template,
        conflictedRepo: buildConflicted(template),
        conflictedCodeRepo: buildConflicted(template, { code: true }),
    };
    for (const [name, repo] of Object.entries(built)) {
        project.provide(name, repo);
    }
    return () => {
        for (const { dir } of Object.values(built)) {
            rmSync(dir, { recursive: true, force: true });
        }
    };
}
