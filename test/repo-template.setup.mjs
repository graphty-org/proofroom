/*
 * Vitest's global setup: builds the repository makeRepo (helpers.mjs) copies, once for the run.
 */

import { rmSync } from "node:fs";

import { isolateGit } from "../../tools/isolated-git-env.mjs";
import { buildRepo } from "./helpers.mjs";

/**
 * Builds the repository and hands it to the test files as `repoTemplate`.
 * @param {import("vitest/node").TestProject} project the test project
 * @returns {() => void} the teardown, which deletes it
 */
export default function setup(project) {
    isolateGit();
    const template = buildRepo();
    project.provide("repoTemplate", template);
    return () => rmSync(template.dir, { recursive: true, force: true });
}
