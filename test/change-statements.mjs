/**
 * Shared by the change statement tests: a fixture repository whose base (master) is set up for
 * change statements, and Finish's part of writing one, signed by a software passkey.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { approvalProblems } from "../trusted/gate.mjs";
import { PASSKEYS_FILE } from "../trusted/lib/approval.mjs";
import { contentHash, statementId, statementPath } from "../trusted/lib/change-approval.mjs";
import { CONFIG_FILE } from "../trusted/lib/config.mjs";
import { git, makeRepo } from "./helpers.mjs";
import { approve, makeKey, passkeysJson } from "./passkey-vectors.mjs";

export const KEY = makeKey();
export const BASELINES = "visual-baselines";
export const APPROVALS = "visual-review-approvals";
export const REPO_ID = "0b6f3c1e-5d0a-4c8e-9f57-2b1a7c9d4e10";
/** A baseline master holds, relative to the baselines directory. */
export const CARD = "compact-mantine/card--legacy.png";
export const TOOLTIP = "compact-mantine/tooltip--hover.png";

/**
 * Commits files on the current branch.
 * @param {{ repo: string }} r the repository
 * @param {Record<string, string | Buffer | object | null>} files contents by path (objects as JSON,
 *     null deletes)
 * @param {string} [message] the commit message
 * @returns {string} the new commit
 */
export function commit(r, files, message = "change") {
    for (const [path, data] of Object.entries(files)) {
        if (data === null) {
            git(r.repo, "rm", "-q", path);
            continue;
        }
        mkdirSync(join(r.repo, path, ".."), { recursive: true });
        const text = typeof data === "string" || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`;
        writeFileSync(join(r.repo, path), text);
    }
    git(r.repo, "add", "-A");
    git(r.repo, "commit", "-q", "--allow-empty", "-m", message);
    return git(r.repo, "rev-parse", "HEAD");
}

/**
 * A copy of the fixture repository whose master holds passkeys.json with KEY and a config with
 * these settings, and branch `pr` from it, checked out.
 * @param {{ config?: object, passkeys?: string | null }} [o] config keys to set on master (default:
 *     repositoryId REPO_ID and approvalFormat "change"), and passkeys.json (null: none)
 * @returns {{ repo: string }} the repository
 */
export function changeRepo({
    config = { repositoryId: REPO_ID, approvalFormat: "change" },
    passkeys = passkeysJson(KEY),
} = {}) {
    const r = makeRepo();
    const own = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
    commit(
        r,
        { [CONFIG_FILE]: { ...own, ...config }, ...(passkeys === null ? {} : { [PASSKEYS_FILE]: passkeys }) },
        "base",
    );
    git(r.repo, "checkout", "-q", "-b", "pr");
    return r;
}

/**
 * The hash of a baseline at a commit, as an entry names it; null when the commit has none.
 * @param {{ repo: string }} r the repository
 * @param {string} ref the commit
 * @param {string} path the file, relative to the baselines directory
 * @returns {string | null} its hash
 */
export function hashAt(r, ref, path) {
    try {
        const blob = execFileSync("git", ["cat-file", "blob", `${ref}:${BASELINES}/${path}`], {
            cwd: r.repo,
            stdio: "pipe",
        });
        return contentHash(blob);
    } catch {
        return null;
    }
}

/**
 * The entry Finish writes for a file the change alters: from master's hash to HEAD's.
 * @param {{ repo: string }} r the repository
 * @param {string} path the file, relative to the baselines directory
 * @param {object} [more] other fields, or overrides
 * @returns {object} the entry
 */
export const entry = (r, path, more = {}) => ({
    path,
    from: hashAt(r, "master", path),
    to: hashAt(r, "HEAD", path),
    decision: "accept",
    ...more,
});

/**
 * A change statement with `capturedHead` this branch's head and these entries.
 * @param {{ repo: string }} r the repository
 * @param {object[]} entries the entries
 * @param {object} [more] other fields, or overrides
 * @returns {object} the unsigned statement
 */
export const statementOf = (r, entries, more = {}) => ({
    version: 2,
    type: "change-approval",
    repository: REPO_ID,
    baselines: BASELINES,
    change: "pr:7",
    capturedHead: git(r.repo, "rev-parse", "HEAD"),
    previous: null,
    approvedAt: "2026-10-25T14:02:11Z",
    entries,
    ...more,
});

/**
 * Signs a statement with a key, as the passkey does at Finish.
 * @param {object} statement the statement
 * @param {{ privateKey: object, entry: object } | null} [key] the key; null leaves it unsigned
 * @returns {object} the signed statement
 */
export const sign = (statement, key = KEY) => (key ? { ...statement, approval: approve(statement, key) } : statement);

/**
 * Finish: signs a statement and commits it where its content says it belongs (or at `file`).
 * @param {{ repo: string }} r the repository
 * @param {object} statement the unsigned statement
 * @param {{ key?: object | null, file?: string }} [o] the key, and another place to put it
 * @returns {{ statement: object, id: string, file: string }} what was committed
 */
export function finish(r, statement, { key = KEY, file } = {}) {
    const signed = sign(statement, key);
    const where = file ?? statementPath(APPROVALS, signed);
    commit(r, { [where]: signed }, "finish");
    return { statement: signed, id: statementId(signed), file: where };
}

/**
 * The gate's approval problems for `pr` against `master`.
 * @param {{ repo: string }} r the repository
 * @param {object} [o] approvalProblems' input to override
 * @returns {string[]} the problems
 */
export const check = (r, o = {}) => approvalProblems(checkInput(r, o)).problems;

/**
 * approvalProblems' input for `pr` against `master`, change mode, change pr:7.
 * @param {{ repo: string }} r the repository
 * @param {object} [o] fields to override
 * @returns {any} the input
 */
export const checkInput = (r, o = {}) => ({
    base: "master",
    head: "pr",
    cwd: r.repo,
    baselines: BASELINES,
    approvals: APPROVALS,
    keys: [KEY.entry],
    mode: "change",
    changes: ["pr:7"],
    repository: REPO_ID,
    ...o,
});

export { makeKey, passkeysJson };
