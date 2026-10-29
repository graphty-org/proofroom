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
    approvals: "visual-review-approvals",
    workDir: ".visual-review",
    commitPrefix: "test",
    issueLabels: ["bug"],
    fontconfig: null,
    updateCheck: null,
    candidates: null,
    rolling: null,
    usage: false,
    ignoreBranches: [],
};

// Project ids name artifacts, jobs, directories and regular expressions, so they stay plain; and
// results.json allows only these.
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
// A path inside the repository: relative, no "..", no backslashes.
const REPO_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\\]+$/;

/**
 * Checks a parsed config and fills in the defaults.
 * @param {unknown} input the parsed JSON
 * @returns {{ defaultBranch: string, workflow: string, baselines: string, approvals: string, workDir: string,
 *     commitPrefix: string, issueLabels: string[], fontconfig: string | null, updateCheck: string | null, candidates: string | null, rolling: string | null, usage: boolean, ignoreBranches: string[], projects: Record<string, { storybook: string,
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
    stringSettings(raw, out, fail);
    pathSettings(out, fail);
    apart(out, fail);
    commandSettings(raw, out, fail);
    // Usage events: the review page's timeline, kept only in the work directory (README, "Usage
    // events"). Off unless a repository turns it on.
    out.usage = usageSetting(raw.usage, fail);
    if (raw.issueLabels !== undefined) {
        if (!Array.isArray(raw.issueLabels) || raw.issueLabels.some((l) => typeof l !== "string")) {
            fail("issueLabels must be an array of strings");
        }
        out.issueLabels = raw.issueLabels;
    }
    // Pull requests whose branch starts with one of these are never listed (e.g. a bot's updates
    // that reach the default branch some other way and are reviewed there).
    if (raw.ignoreBranches !== undefined) {
        if (!Array.isArray(raw.ignoreBranches) || raw.ignoreBranches.some((b) => typeof b !== "string" || b === "")) {
            fail("ignoreBranches must be an array of non-empty branch-name prefixes");
        }
        out.ignoreBranches = raw.ignoreBranches;
    }
    out.projects = projectsSetting(raw.projects, fail);
    return out;
}

/**
 * The plain string settings: each, when set, a non-empty string.
 * @param {any} raw the parsed config
 * @param {any} out the settings being filled in
 * @param {(msg: string) => never} fail throws the config error
 */
function stringSettings(raw, out, fail) {
    for (const key of ["defaultBranch", "workflow", "baselines", "approvals", "workDir", "commitPrefix"]) {
        if (raw[key] !== undefined) {
            if (typeof raw[key] !== "string" || raw[key] === "") {
                fail(`${key} must be a non-empty string`);
            }
            out[key] = raw[key];
        }
    }
}

/**
 * The directory settings: each a path inside the repository, without a trailing slash.
 * @param {any} out the settings being filled in
 * @param {(msg: string) => never} fail throws the config error
 */
function pathSettings(out, fail) {
    for (const key of ["baselines", "approvals", "workDir"]) {
        if (!REPO_PATH.test(out[key])) {
            fail(`${key} must be a path inside the repository, relative and without ".."`);
        }
        out[key] = out[key].replace(/\/+$/, "");
    }
}

/**
 * The optional fontconfig file and update check command.
 * @param {any} raw the parsed config
 * @param {any} out the settings being filled in
 * @param {(msg: string) => never} fail throws the config error
 */
function commandSettings(raw, out, fail) {
    // The fontconfig file every capture draws with (FONTCONFIG_FILE), so local and CI captures use
    // the same committed fonts instead of whatever the host has installed. Null: host fonts.
    if (raw.fontconfig !== undefined && raw.fontconfig !== null) {
        if (typeof raw.fontconfig !== "string" || !REPO_PATH.test(raw.fontconfig)) {
            fail('fontconfig must be a fonts.conf inside the repository, relative and without ".."');
        }
        out.fontconfig = raw.fontconfig;
    }
    // The shell command `update` runs in the merged checkout before it pushes, when the merge
    // changed anything outside the baselines. Null: no check.
    if (raw.updateCheck !== undefined && raw.updateCheck !== null) {
        if (typeof raw.updateCheck !== "string" || raw.updateCheck.trim() === "") {
            fail("updateCheck must be a shell command");
        }
        out.updateCheck = raw.updateCheck;
    }
    // The shell command `serve --candidate next` runs in the repository to list the default
    // branch's full runs: JSON on stdout, `[{ commit, runId, waiting, at }]`. Null: none.
    if (raw.candidates !== undefined && raw.candidates !== null) {
        if (typeof raw.candidates !== "string" || raw.candidates.trim() === "") {
            fail("candidates must be a shell command");
        }
        out.candidates = raw.candidates;
    }
    // The shell command `serve --candidate next` also runs to list the default branch's rolling renders,
    // newest render commit first: JSON on stdout, `[{ commit, at, items: [{ project, id, mode, runId, attempt,
    // artifact }], pending: [{ project, id, mode, why }] }]`. Null: no rolling target.
    if (raw.rolling !== undefined && raw.rolling !== null) {
        if (typeof raw.rolling !== "string" || raw.rolling.trim() === "") {
            fail("rolling must be a shell command");
        }
        out.rolling = raw.rolling;
    }
}

/**
 * The `projects` setting: at least one, each checked by projectSetting.
 * @param {any} projects the config's value
 * @param {(msg: string) => never} fail throws the config error
 * @returns {Record<string, any>} the projects by id
 */
function projectsSetting(projects, fail) {
    if (typeof projects !== "object" || projects === null || Object.keys(projects).length === 0) {
        fail('projects must name at least one Storybook, e.g. { "web": { "storybook": "storybook-static" } }');
    }
    const out = {};
    for (const [id, p] of Object.entries(projects)) {
        out[id] = projectSetting(id, p, fail);
    }
    return out;
}

/**
 * One project's settings, with the defaults filled in.
 * @param {string} id the project id
 * @param {any} p the config's value
 * @param {(msg: string) => never} fail throws the config error
 * @returns {{ storybook: string, build: string | null, workers: number, seedFromDefaultBranch: boolean,
 *     waitFor: { selector: string, method: string, failOnConsole: string | null } | null }} the project
 */
function projectSetting(id, p, fail) {
    const where = `projects.${id}`;
    if (!PROJECT_ID.test(id)) {
        fail(`${where}: a project id is lowercase letters, digits and "-"`);
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
    if (p.gate !== undefined) {
        fail(`${where}.gate is not a setting: every project is gated, and every story needs an approved baseline`);
    }
    return {
        storybook: p.storybook.replace(/\/+$/, ""),
        build: p.build ?? null,
        workers,
        seedFromDefaultBranch: p.seedFromDefaultBranch ?? true,
        waitFor: waitForSetting(where, p.waitFor, fail),
    };
}

/**
 * A project's `waitFor` setting, or null when unset.
 * @param {string} where the project's place in the config, for errors
 * @param {any} w the config's value
 * @param {(msg: string) => never} fail throws the config error
 * @returns {{ selector: string, method: string, failOnConsole: string | null } | null} the setting
 */
function waitForSetting(where, w, fail) {
    if (w === undefined || w === null) {
        return null;
    }
    if (typeof w?.selector !== "string" || typeof w?.method !== "string") {
        fail(`${where}.waitFor needs a "selector" and a "method" to call on each matching element`);
    }
    return { selector: w.selector, method: w.method, failOnConsole: w.failOnConsole ?? null };
}

/**
 * Refuses an approvals directory inside the baselines directory, or the other way round: the
 * owner's approvals sign the baselines directory's tree, so adding one must not change it.
 * @param {{ baselines: string, approvals: string }} out the settings
 * @param {(msg: string) => never} fail throws the config error
 */
function apart({ baselines, approvals }, fail) {
    if (`${approvals}/`.startsWith(`${baselines}/`) || `${baselines}/`.startsWith(`${approvals}/`)) {
        fail("approvals must be a directory outside baselines, and baselines outside approvals");
    }
}

/**
 * The `usage` setting: off unless set to true.
 * @param {unknown} value the config's value
 * @param {(msg: string) => never} fail throws the config error
 * @returns {boolean} whether usage events are on
 */
function usageSetting(value, fail) {
    if (value !== undefined && typeof value !== "boolean") {
        fail("usage must be true or false");
    }
    return value === true;
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
