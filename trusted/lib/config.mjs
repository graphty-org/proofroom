/**
 * The consuming repository's settings: `visual-review.config.json` at the root of its git
 * checkout. Everything that differs from one repository to the next (its Storybooks, where the
 * baselines live, its default branch, the workflow that captures, its commit and label
 * conventions) is read from here, so the tool itself assumes none of it. The README's
 * "Configuration" section documents every key. Standard library only: the gate reads it too.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "visual-review.config.json";

const DEFAULTS = {
    defaultBranch: "main",
    workflow: "visual-review.yml",
    baselines: "visual-baselines",
    workDir: ".visual-review",
    commitPrefix: "test",
    issueLabels: ["bug"],
};

// Project ids name artifacts, jobs, directories and regular expressions, so they stay plain.
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A path inside the repository: relative, no "..", no backslashes.
const REPO_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\\]+$/;

/**
 * Checks a parsed config and fills in the defaults.
 * @param {unknown} input the parsed JSON
 * @returns {{ defaultBranch: string, workflow: string, baselines: string, workDir: string,
 *     commitPrefix: string, issueLabels: string[], projects: Record<string, { storybook: string,
 *     build: string | null, workers: number, seedFromDefaultBranch: boolean, waitFor: { selector:
 *     string, method: string, failOnConsole: string | null } | null }> }} the settings
 */
export function normalizeConfig(input) {
    const raw = /** @type {any} */ (input);
    const fail = (msg) => {
        throw new Error(`${CONFIG_FILE}: ${msg}`);
    };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        fail("must be a JSON object");
    }
    /** @type {any} */
    const out = { ...DEFAULTS };
    for (const key of ["defaultBranch", "workflow", "baselines", "workDir", "commitPrefix"]) {
        if (raw[key] !== undefined) {
            if (typeof raw[key] !== "string" || raw[key] === "") {
                fail(`${key} must be a non-empty string`);
            }
            out[key] = raw[key];
        }
    }
    for (const key of ["baselines", "workDir"]) {
        if (!REPO_PATH.test(out[key])) {
            fail(`${key} must be a path inside the repository, relative and without ".."`);
        }
        out[key] = out[key].replace(/\/+$/, "");
    }
    if (raw.issueLabels !== undefined) {
        if (!Array.isArray(raw.issueLabels) || raw.issueLabels.some((l) => typeof l !== "string")) {
            fail("issueLabels must be an array of strings");
        }
        out.issueLabels = raw.issueLabels;
    }
    const projects = raw.projects;
    if (typeof projects !== "object" || projects === null || Object.keys(projects).length === 0) {
        fail('projects must name at least one Storybook, e.g. { "web": { "storybook": "storybook-static" } }');
    }
    out.projects = {};
    for (const [id, p] of Object.entries(projects)) {
        const where = `projects.${id}`;
        if (!PROJECT_ID.test(id)) {
            fail(`${where}: a project id is letters, digits, ".", "_" and "-"`);
        }
        if (typeof p !== "object" || p === null) {
            fail(`${where} must be an object`);
        }
        if (typeof p.storybook !== "string" || !REPO_PATH.test(p.storybook)) {
            fail(`${where}.storybook must be the built Storybook's directory, relative to the repository`);
        }
        if (p.build !== undefined && typeof p.build !== "string") {
            fail(`${where}.build must be a shell command`);
        }
        const workers = p.workers ?? 4;
        if (!Number.isInteger(workers) || workers < 1) {
            fail(`${where}.workers must be a positive integer`);
        }
        if (p.seedFromDefaultBranch !== undefined && typeof p.seedFromDefaultBranch !== "boolean") {
            fail(`${where}.seedFromDefaultBranch must be true or false`);
        }
        let waitFor = null;
        if (p.waitFor !== undefined && p.waitFor !== null) {
            const w = p.waitFor;
            if (typeof w?.selector !== "string" || typeof w?.method !== "string") {
                fail(`${where}.waitFor needs a "selector" and a "method" to call on each matching element`);
            }
            waitFor = { selector: w.selector, method: w.method, failOnConsole: w.failOnConsole ?? null };
        }
        out.projects[id] = {
            storybook: p.storybook.replace(/\/+$/, ""),
            build: p.build ?? null,
            workers,
            seedFromDefaultBranch: p.seedFromDefaultBranch ?? true,
            waitFor,
        };
    }
    return out;
}

/**
 * The root of the git checkout holding a directory.
 * @param {string} [cwd] where to start
 * @returns {string} the repository's top level
 */
export function repoRoot(cwd = process.cwd()) {
    try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    } catch {
        throw new Error(`${cwd} is not inside a git repository: run visual-review in your repository`);
    }
}

/**
 * Reads and checks the config of a checkout.
 * @param {string} root the repository's top level
 * @returns {ReturnType<typeof normalizeConfig>} the settings
 */
export function loadConfig(root) {
    const file = join(root, CONFIG_FILE);
    if (!existsSync(file)) {
        throw new Error(`no ${CONFIG_FILE} in ${root}: run \`visual-review init\` there first`);
    }
    return parse(readFileSync(file, "utf8"));
}

/**
 * Reads the config as it is at a git ref, falling back to the working tree when the ref has none
 * (the pull request that adds visual review). The gate uses this with the base branch tip, so a
 * pull request cannot move the baselines directory out from under the gate.
 * @param {string} ref the ref
 * @param {string} root the repository's top level
 * @returns {ReturnType<typeof normalizeConfig>} the settings
 */
export function loadConfigAt(ref, root) {
    let text;
    try {
        text = execFileSync("git", ["show", `${ref}:${CONFIG_FILE}`], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return loadConfig(root);
    }
    return parse(text);
}

function parse(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
    }
    return normalizeConfig(raw);
}
