#!/usr/bin/env node
/**
 * The pull request gate: fails while a project holds visual changes the owner has not reviewed.
 *
 * It fails closed: nothing merges with an image nobody approved. Every project with baselines on the
 * base branch, and every project in the base branch's config or the pull request's, is gated, seeded
 * or not. Every story needs an approved baseline. A story with none blocks: `new` when the pull
 * request adds or changes it, `unseeded` when it looks as in master's newest capture. Either way
 * the owner accepts it (on the pull request, or by seeding it from the default branch), which
 * creates its first baseline.
 *
 * <dir> holds the downloaded `visual-<project>-<attempt>` artifacts of this CI run, every attempt
 * of it. For each project only the highest attempt counts, so re-running failed jobs (which
 * leaves the visual jobs' old attempt as the newest) can neither hide nor resurrect a capture.
 * Which projects exist and are seeded is read from <ref> (the base branch tip, fetched by the
 * caller), and so is visual-review.config.json (the projects and where the baselines live), so
 * neither deleting a project's baselines nor removing it from the config turns the gate off, and a
 * pull request that moves the baselines directory fails. The pull request's config can only add
 * projects. A gated project with no results.json, or an incomplete one, fails: a capture that
 * crashed has shown the owner nothing. An invalid results.json counts as missing. So does a story
 * compared at a diffThreshold above MAX_THRESHOLD, which would hide real changes.
 *
 * One exception: a project whose artifact holds, instead of results.json, the marker the workflow
 * writes when the pull request cannot affect it (skipped.json, results.mjs) passes without a
 * capture. Which projects a pull request affects is decided by the pull request's own workflow, so
 * the marker counts only where a full capture follows: never in a merge-queue run (every batch
 * captures every project before it merges), never for a project with no baselines on the base
 * branch, and never for a project whose baselines the pull request changes. Anywhere else a marker
 * is a missing capture.
 *
 * It also fails when a baseline file differs from the base without the owner's signed approval
 * (approvalProblems; docs/approval-format.md is the contract). The way to pass is a change
 * statement: a file under `<approvals>/<change>/` (the config's `approvals`, outside the baselines
 * directory) that this change adds, naming this repository, the baselines directory, this change
 * and a commit of this change's own history, whose newest decision for each altered file accepts
 * exactly the base's hash to the head's (change-approval.mjs). In tree mode (the default, or
 * `approvalFormat` "tree") a version 1 tree statement passes too: a
 * file `<approvals>/<tree>.json`, added by this change, whose statement names a commit X that is
 * an ancestor of the head, the tree of the baselines directory at X, and that tree equal to the
 * head's (treeApprovalProblem). One already on the base never counts, so an earlier approved tree
 * cannot come back without a review. Baseline PNGs are Git LFS pointers, which name each image's
 * SHA-256, so a hash covers every pixel. Once visual-review/passkeys.json on the base branch holds
 * a key, a statement must carry a passkey approval by one of the base branch's keys over exactly
 * that statement (approval.mjs). Keys are never read from the pull request, a pull request that
 * would leave no key fails, and a change to passkeys.json itself is merged by an administrator.
 * Settings (`approvals`, `baselines`, `approvalFormat`, `repositoryId`, `selfApproval`) come from
 * the base's config only. With `"selfApproval": "forbid"` no statement may be signed by a key whose
 * identity contributed to the change (contributorsOf, selfApprovalProblems). Statements and the old review records under <baselines>/reviews/ are append-only: a change
 * that modifies or deletes one the base holds fails, and so does one whose later commit deletes or
 * modifies a statement an earlier commit of it added, in any commit or merge (change-approval.mjs withdrawnStatements). A
 * seed statement (`seed-approval`) is checked as a change statement, but its capturedHead must be
 * on the base: its reviewer saw a capture of the default branch. The review records mean nothing else to the
 * gate. Without that approval, committing the captured PNGs straight into the baselines directory would
 * turn the capture check green with no review at all.
 *
 * CI runs this file as the base branch has it, never the pull request's copy, so a pull request
 * cannot loosen the gate that judges it.
 *
 * In a merge-queue run (`--queue-event`) the head is a batch of several pull requests merged onto the
 * base. Baseline changes are compared with the commit the batch sits on (the draft's
 * `checking_base_sha`), not with the base branch, since a batch stacked on another holds that
 * batch's changes; a draft that names no such commit fails. Nothing else changes.
 *
 * Usage: proofroom gate --captures <dir> --base <ref> [--head <ref>] [--change <id> | --pr <number>
 * | --queue-event <file>], or node gate.mjs with the same options; `--pr N` means `--change pr:N`.
 * Standard library only (results.mjs, config.mjs, approval.mjs and change-approval.mjs have no
 * dependencies), so it runs from a checkout of this package without an install.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PASSKEYS_FILE, parsePasskeys, verifyApproval, verifyRecord } from "./lib/approval.mjs";
import {
    changeApprovals,
    changeCommits,
    contentHash,
    gitIn,
    selfApprovalProblems,
    withdrawnStatements,
} from "./lib/change-approval.mjs";
import { CONFIG_FILE, loadConfigAt, repoRoot } from "./lib/config.mjs";
import { isSkipMarker, SKIPPED_FILE, validateResults } from "./lib/results.mjs";

export { contentHash };

const PASSING = new Set(["unchanged", "excluded"]);

/**
 * The loosest diffThreshold the gate trusts, the highest a story here uses. At 1 pixelmatch counts
 * no pixel as changed, so a settings file or a story's parameters could switch comparison off.
 */
export const MAX_THRESHOLD = 0.8;

/**
 * The newest attempt's results.json of every project in a directory of downloaded artifacts, and
 * whether that attempt holds the not-affected marker instead (`skipped: true`, only with no
 * results.json).
 * @param {string} dir the download directory, one subdirectory per artifact
 * @returns {Record<string, { attempt: number, results: object | null, skipped?: true }>} by project
 */
export function newestResults(dir) {
    /** @type {Record<string, { attempt: number, results: object | null, skipped?: true }>} */
    const out = {};
    const names = existsSync(dir) ? readdirSync(dir) : [];
    for (const name of names) {
        const m = /^visual-(.+)-(\d+)$/.exec(name);
        if (!m) {
            continue;
        }
        const [, project, n] = m;
        const attempt = Number(n);
        if (out[project] && out[project].attempt > attempt) {
            continue;
        }
        const file = join(dir, name, "results.json");
        let results = null;
        try {
            results = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            // Missing or not JSON: counted as missing, like any invalid results.json.
        }
        out[project] = { attempt, results };
        if (!existsSync(file) && isSkipMarker(readJson(join(dir, name, SKIPPED_FILE)), project)) {
            out[project].skipped = true;
        }
    }
    return out;
}

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

/**
 * The projects the gate checks: every project with baselines at the base, and every project of the
 * base's config and of the pull request's.
 * @param {{ projects: Record<string, object> }} config the base branch's config
 * @param {Set<string>} seeded the projects with baselines at the base
 * @param {{ projects: Record<string, object> }} [headConfig] the pull request's config
 * @returns {string[]} the gated project ids
 */
export function gatedProjects(config, seeded, headConfig) {
    return [...new Set([...seeded, ...Object.keys(config.projects), ...Object.keys(headConfig?.projects ?? {})])];
}

/**
 * What blocks the pull request.
 * @param {{ config: { defaultBranch: string, baselines: string,
 *     projects: Record<string, { seedFromDefaultBranch: boolean }> },
 *     headConfig: { baselines: string, projects: Record<string, object> } | undefined, seeded: Set<string>,
 *     captures: Record<string, { attempt: number, results: object | null, skipped?: true }>,
 *     queue?: boolean, baselinesChanged?: Set<string>, notAffected?: string[] }} input the base
 *     branch's config, the pull request's config (if any), the projects with baselines on the base
 *     branch, the newest capture of each project, whether this is a merge-queue run, the projects
 *     whose baselines the pull request changes, and a list the projects whose not-affected marker
 *     the gate accepts are added to
 * @returns {string[]} one line per blocked project; empty when the gate passes
 */
export function gateProblems({
    config,
    headConfig,
    seeded,
    captures,
    queue = false,
    baselinesChanged = new Set(),
    notAffected = [],
}) {
    const problems = [];
    if (headConfig && headConfig.baselines !== config.baselines) {
        // Capture reads the pull request's config, so its baselines would be compared, not the base's.
        problems.push(
            `this pull request moves the baselines directory from ${config.baselines} to ${headConfig.baselines}; ` +
                "move it in a pull request of its own that changes nothing else, merged with an administrator's review",
        );
    }
    for (const p of gatedProjects(config, seeded, headConfig)) {
        const r = captures[p]?.results;
        if (!r && captures[p]?.skipped) {
            const refused = skipRefused(p, { config, seeded, queue, baselinesChanged });
            if (refused) {
                problems.push(`${p}: not captured (marked not affected by this pull request), but ${refused}`);
            } else {
                notAffected.push(p);
            }
            continue;
        }
        problems.push(...captureProblems(p, r, config, seeded));
    }
    return problems;
}

/**
 * What blocks one project's capture.
 * @param {string} p the project
 * @param {object | null | undefined} r its newest results.json
 * @param {{ defaultBranch: string, projects: Record<string, { seedFromDefaultBranch: boolean }> }} config the base branch's config
 * @param {Set<string>} seeded the projects with baselines on the base branch
 * @returns {string[]} the gate's lines for it
 */
function captureProblems(p, r, config, seeded) {
    if (!r) {
        return [`${p}: no capture results (the visual job failed or uploaded nothing); re-run it`];
    }
    const invalid = validateResults(r);
    if (invalid.length > 0) {
        return [`${p}: results.json is invalid (${invalid[0]}); re-run the visual job`];
    }
    if (!r.complete) {
        return [`${p}: the capture did not finish (${r.items.length} of ${r.expected} items); re-run it`];
    }
    const problems = [];
    const loose = r.items.filter((i) => i.threshold > MAX_THRESHOLD).length;
    if (loose > 0) {
        problems.push(
            `${p}: ${loose} ${loose === 1 ? "item is" : "items are"} compared at a diffThreshold above ${MAX_THRESHOLD}, ` +
                "which hides real changes; lower it in the story's parameters or its settings file",
        );
    }
    const open = r.items.map((i) => i.status).filter((s) => !PASSING.has(s));
    if (open.length > 0) {
        // No Object.groupBy: the gate runs on the runner's own Node, which may be 20.
        const counts = new Map();
        for (const s of open) {
            counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        const what = [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
        problems.push(`${p}: ${what} ${seeded.has(p) ? NOT_ACCEPTED : notSeeded(config, p)}`);
    }
    return problems;
}

/**
 * Why the not-affected marker does not stand in for a capture of a project; null when it does.
 * @param {string} p the project
 * @param {{ config: { defaultBranch: string }, seeded: Set<string>, queue: boolean,
 *     baselinesChanged: Set<string> }} input as in gateProblems
 * @returns {string | null} the rest of the gate's line
 */
function skipRefused(p, { config, seeded, queue, baselinesChanged }) {
    if (queue) {
        return "a merge-queue run must capture every project; re-run it";
    }
    if (!seeded.has(p)) {
        return `it has no baselines on ${config.defaultBranch} yet, so every pull request captures it`;
    }
    if (baselinesChanged.has(p)) {
        return "this pull request changes its baselines, so it must be captured";
    }
    return null;
}

/**
 * The projects whose baselines differ between two refs: the first directory under the baselines
 * directory of each changed path, review records left out.
 * @param {string} base the base branch tip
 * @param {string} head the pull request's checkout
 * @param {string} [cwd] the repository
 * @param {string} [baselines] the baselines directory
 * @returns {Set<string>} the projects
 */
export function baselinesChangedBetween(base, head, cwd = process.cwd(), baselines = "visual-baselines") {
    const prefix = `${baselines}/`;
    return new Set(
        gitOut(cwd, ["diff", "-z", "--no-renames", "--name-only", base, head, "--", prefix])
            .toString("utf8")
            .split("\0")
            .filter((f) => f.startsWith(prefix))
            .map((f) => f.slice(prefix.length).split("/"))
            .filter((parts) => parts.length > 1 && parts[0] !== "reviews")
            .map((parts) => parts[0]),
    );
}

const NOT_ACCEPTED = "(not accepted; a rejected item needs a code change, not another review)";

/**
 * Why an unseeded project blocks, and how to seed it.
 * @param {{ defaultBranch: string, projects: Record<string, { seedFromDefaultBranch: boolean }> }} config the
 *     base branch's config
 * @param {string} p the project
 * @returns {string} the rest of the gate's line
 */
function notSeeded(config, p) {
    const branch = config.defaultBranch;
    const here = "accept them on this pull request with `proofroom serve`";
    if (config.projects[p]?.seedFromDefaultBranch === false) {
        return `(not accepted; ${p} has no baselines on ${branch} yet, so ${here} to create its first ones)`;
    }
    return (
        `(not accepted; ${p} has no baselines on ${branch} yet. Seed it: capture a known-good commit with ` +
        `\`gh workflow run visual-seed.yml --ref ${branch} -f ref=<sha>\` (or take ${branch}'s newest run), ` +
        `review that run with \`proofroom serve --master-run <run id>\` and merge the seed pull ` +
        `request, then merge ${branch} into this branch; or ${here})`
    );
}

const gitOut = (cwd, args) => execFileSync("git", args, { cwd, maxBuffer: 1 << 28 });

/**
 * Why an earlier review record does not show that the owner approved image `to` for the baseline
 * `path` (one story in one mode of one project), or null when it does. The review server offers an
 * "approved before" accept only from a record that passes this.
 * @param {any} earlier the earlier record, parsed (untrusted)
 * @param {{ path: string, to: string | null }} claim the baseline and the image
 * @param {object[] | null} keys the base branch's keys once approvals are enforced: then the
 *     earlier record must carry a valid passkey approval itself
 * @returns {string | null} why not, or null
 */
export function earlierApprovalProblem(earlier, { path, to }, keys) {
    if (typeof earlier !== "object" || earlier === null || !Array.isArray(earlier.items)) {
        return "the earlier record is not a review record";
    }
    // A direct decision only: an approval never chains through another "approved before".
    const approves = (i) => i?.path === path && i.to === to && i.approvedBefore === undefined;
    if (typeof to !== "string" || !earlier.items.some(approves)) {
        return "the earlier record does not approve this image for this story";
    }
    return keys ? verifyRecord(earlier, keys, { pr: earlier.pr ?? null }) : null;
}

function parseOr(bytes) {
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch {
        return null;
    }
}

/**
 * The projects with at least one baseline PNG at a git ref: the directories under the baselines
 * directory at the base tip. They are gated whatever the config says.
 * @param {string} ref the base branch tip
 * @param {string} [cwd] the repository
 * @param {string} [baselines] the baselines directory
 * @returns {Set<string>} the seeded ones
 */
export function seededAt(ref, cwd = process.cwd(), baselines = "visual-baselines") {
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", `${baselines}/`], {
        cwd,
        encoding: "utf8",
        maxBuffer: 1 << 28,
    }).split("\n");
    const prefix = `${baselines}/`;
    return new Set(
        files
            .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
            .map((f) => f.slice(prefix.length).split("/"))
            .filter((parts) => parts.length > 1)
            .map((parts) => parts[0]),
    );
}

/**
 * A file at a git ref, or null when the ref does not hold it.
 * @param {string} ref the commit
 * @param {string} path the path
 * @param {string} cwd the repository
 * @returns {string | null} its text
 */
function fileAt(ref, path, cwd) {
    const listed = gitOut(cwd, ["ls-tree", "--name-only", ref, "--", path]).toString("utf8").trim();
    return listed === "" ? null : gitOut(cwd, ["show", `${ref}:${path}`]).toString("utf8");
}

/**
 * Whether approvals are enforced, and the keys they must come from: those of passkeys.json on the
 * base branch, never the pull request's. Absent, or with no key, enforcement is off.
 * @param {string} base the base branch tip
 * @param {string} head the pull request's checkout
 * @param {string} [cwd] the repository
 * @returns {{ keys: object[] | null, problems: string[] }} the keys (null when off), and what fails
 *     the gate: an invalid base file, or a pull request that would switch enforcement off
 */
export function approvalKeys(base, head, cwd = process.cwd()) {
    const text = fileAt(base, PASSKEYS_FILE, cwd);
    let keys = [];
    try {
        keys = text === null ? [] : parsePasskeys(text);
    } catch (err) {
        return { keys: null, problems: [`${PASSKEYS_FILE} on the base branch is invalid: ${err.message}`] };
    }
    if (keys.length === 0) {
        return { keys: null, problems: [] };
    }
    const problems = [];
    let left = 0;
    try {
        const own = fileAt(head, PASSKEYS_FILE, cwd);
        left = own === null ? 0 : parsePasskeys(own).length;
    } catch {
        // Invalid: counts as no key.
    }
    if (left === 0) {
        problems.push(
            `this pull request would switch approval enforcement off: its ${PASSKEYS_FILE} is missing, invalid or holds no key`,
        );
    }
    return { keys, problems };
}

const TREE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The git tree of a directory at a commit, or null when the commit has no such directory.
 * @param {string} ref the commit
 * @param {string} dir the directory
 * @param {string} cwd the repository
 * @returns {string | null} the tree hash
 */
export function treeAt(ref, dir, cwd) {
    try {
        return (
            gitOut(cwd, ["rev-parse", "--verify", "--quiet", `${ref}:${dir}`])
                .toString("utf8")
                .trim() || null
        );
    } catch {
        return null;
    }
}

/**
 * Why a signed tree approval does not approve the baselines at `head`, or null when it does.
 * @param {any} statement the parsed approval file (untrusted)
 * @param {{ head: string, tree: string, baselines: string, keys: object[] | null, cwd: string }} at
 *     the head, its baselines tree, the baselines directory, the base branch's keys (null: approvals
 *     are not enforced, so the signature is not checked) and the repository
 * @returns {string | null} why not, or null
 */
export function treeApprovalProblem(statement, { head, tree, baselines, keys, cwd }) {
    if (typeof statement !== "object" || statement === null || statement.version !== 1) {
        return "not a version 1 tree approval";
    }
    const { commit } = statement;
    if (statement.baselines !== baselines || statement.tree !== tree) {
        return `it signs ${statement.baselines}/ at tree ${statement.tree}, not ${baselines}/ at ${tree}`;
    }
    if (typeof commit !== "string" || !TREE.test(commit) || !haveCommit(commit, cwd)) {
        return `its commit ${commit} is not in this repository`;
    }
    try {
        gitOut(cwd, ["merge-base", "--is-ancestor", commit, head]);
    } catch {
        return `its commit ${commit} is not an ancestor of ${head}`;
    }
    if (treeAt(commit, baselines, cwd) !== tree) {
        return `${baselines}/ at its commit ${commit} is not the tree it signs`;
    }
    return keys ? verifyApproval(statement, keys) : null;
}

/**
 * What blocks the baselines at `head`: nothing when the baselines directory's tree is the base's;
 * otherwise the owner's approval of exactly the head's tree must be at the head
 * (`<approvals>/<tree>.json`, treeApprovalProblem). Once approvals are enforced, a change to
 * passkeys.json fails too: an administrator merges it.
 * @param {object} input the work
 * @param {string} input.base the base branch tip, or a merge-queue batch's base
 * @param {string} input.head the commit being merged
 * @param {string} input.cwd the repository
 * @param {string} input.baselines the baselines directory
 * @param {string} input.approvals the approvals directory
 * @param {object[] | null} input.keys the base branch's keys, null while approvals are not enforced
 * @returns {string[]} one line per problem; empty when the baselines are approved
 */
export function treeApprovalProblems({ base, head, cwd, baselines, approvals, keys }) {
    return [
        ...passkeysProblems({ base, head, cwd, keys }),
        ...treeProblems({ base, head, cwd, baselines, approvals, keys }),
    ];
}

/**
 * Once approvals are enforced, a change to passkeys.json fails: an administrator merges it.
 * @param {{ base: string, head: string, cwd: string, keys: object[] | null }} at as in treeApprovalProblems
 * @returns {string[]} the problem, if any
 */
function passkeysProblems({ base, head, cwd, keys }) {
    if (keys && gitOut(cwd, ["diff", "--name-only", base, head, "--", PASSKEYS_FILE]).toString("utf8").trim()) {
        return [
            `${PASSKEYS_FILE}: changed; once a key is registered, adding or replacing one is merged by an administrator (the README, "Replacing the passkey")`,
        ];
    }
    return [];
}

/**
 * The tree statement check: nothing when the baselines tree is the base's; otherwise
 * `<approvals>/<tree>.json`, added by this change (one already on the base would restore an
 * earlier approved tree with no review), must approve exactly the head's tree.
 * @param {{ base: string, head: string, cwd: string, baselines: string, approvals: string,
 *     keys: object[] | null }} at as in treeApprovalProblems
 * @returns {string[]} one line per problem
 */
function treeProblems({ base, head, cwd, baselines, approvals, keys }) {
    const tree = treeAt(head, baselines, cwd);
    if (tree === treeAt(base, baselines, cwd)) {
        return [];
    }
    if (tree === null) {
        return [`${baselines}/ is gone at ${head}, and no approval can sign that`];
    }
    const file = `${approvals}/${tree}.json`;
    const text = fileAt(head, file, cwd);
    const how = "review the changes with `proofroom serve` and Finish, which signs the tree";
    if (text === null) {
        return [`${baselines}/ differs from the base (tree ${tree}), and no ${file} approves it: ${how}`];
    }
    if (fileAt(base, file, cwd) !== null) {
        return [
            `${file}: already on the base, and a tree statement counts only when this change adds it, so an earlier approved tree cannot come back without a review; ${how}`,
        ];
    }
    const why = treeApprovalProblem(parseOr(Buffer.from(text)), { head, tree, baselines, keys, cwd });
    return why ? [`${file}: ${why}; ${how}`] : [];
}

/**
 * Which approvals the gate reads: the base config's `approvalFormat`, else "tree", where tree
 * statements and change statements both count, so the tree statements Finish writes keep passing.
 * @param {{ approvalFormat?: "tree" | "change" }} config the base's config
 * @returns {"tree" | "change"} the mode
 */
export function approvalMode(config) {
    return config.approvalFormat ?? "tree";
}

/**
 * The repository id change statements must name: `github:<GITHUB_REPOSITORY_ID>` on GitHub Actions
 * (an id a rename or a transfer does not change, and no file of the change can set), else the base
 * config's `repositoryId`; null when there is none.
 * @param {{ repositoryId?: string }} config the base's config
 * @param {Record<string, string | undefined>} [env] the environment
 * @returns {string | null} the id
 */
export function repositoryOf(config, env = process.env) {
    if (env.GITHUB_ACTIONS === "true") {
        return env.GITHUB_REPOSITORY_ID ? `github:${env.GITHUB_REPOSITORY_ID}` : null;
    }
    return config.repositoryId ?? null;
}

/**
 * What blocks the baselines at `head`: a change to passkeys.json once a key is registered; a
 * change to a statement or review record the base holds; any added statement that fails its
 * checks; and, when the baselines differ from the base, the lack of an approval of them. In tree
 * mode a tree statement the change adds for exactly the head's tree approves them, and so do
 * change statements covering every altered file; in change mode only change statements do, and a
 * tree statement is refused.
 * @param {object} input the work
 * @param {string} input.base the base branch tip, or a merge-queue batch's base
 * @param {string} input.head the commit being merged
 * @param {string} input.cwd the repository
 * @param {string} input.baselines the baselines directory
 * @param {string} input.approvals the approvals directory
 * @param {object[] | null} input.keys the base branch's keys, null while approvals are not enforced
 * @param {"tree" | "change"} input.mode approvalMode
 * @param {string[]} input.changes the changes gated (`pr:7`)
 * @param {string | null} input.repository repositoryOf
 * @returns {{ problems: string[], notices: string[], statements: object[], byTree: boolean }} one
 *     line per problem (empty when the baselines are approved), what is only reported, the change
 *     statements that count, and whether a tree statement approved what they do not
 */
export function approvalProblems({ base, head, cwd, baselines, approvals, keys, mode, changes, repository }) {
    const git = gitIn(cwd);
    const c = changeApprovals({ base, head, baselines, approvals, keys, repository, changes, git });
    const problems = [
        ...passkeysProblems({ base, head, cwd, keys }),
        ...c.history,
        ...withdrawnStatements(git, { base, head, approvals, keys }),
        ...c.statements,
    ];
    let unapproved = [];
    let byTree = false;
    if (mode === "change") {
        for (const file of c.treeFiles) {
            problems.push(
                `${file}: a version 1 tree statement, refused: this repository's approvals are change statements (approvalFormat "change"); Finish again`,
            );
        }
        unapproved = c.coverage;
    } else if (c.coverage.length > 0) {
        const tree = treeProblems({ base, head, cwd, baselines, approvals, keys });
        // With no change statement of its own, the change was finished the old way: say why its tree fails.
        unapproved = tree.length === 0 ? [] : c.counted === 0 ? tree : c.coverage;
        byTree = tree.length === 0;
    }
    problems.push(...unapproved);
    if (unapproved.length > 0 && unapproved === c.coverage && changes.length === 0) {
        problems.push("the gate was run without --change (or --pr), so no change statement can count");
    }
    return { problems, notices: c.notices, statements: c.own, byTree };
}

/**
 * Who contributed to each change, for the self-approval rule: the opener and each commit's
 * verified signer, author and committer. The tool's own commits and merges that add nothing are
 * left out (change-approval.mjs changeCommits); every other commit must be signed, or the change
 * fails closed. A change with no commit of its own left (a seed: only Finish's commits) has no
 * contributors, its opener included.
 *
 * On GitHub Actions the commits and the opener come from GitHub (the event payload, and the
 * pull request's commits through the API with GITHUB_TOKEN), and a commit's signer is its
 * committer's account when GitHub verifies the signature. Elsewhere they come from git: a
 * commit counts as signed only by an SSH signature from one of the `signingKeys` an identity in
 * passkeys.json names, and that key's owner is its signer.
 * @param {object} at what to read
 * @param {string} at.base what baseline changes are measured from
 * @param {string} at.head the head
 * @param {string} at.cwd the repository
 * @param {string[]} at.changes the changes (`pr:7`)
 * @param {object[]} at.keys the base's keys
 * @param {string} at.baselines the baselines directory
 * @param {string} at.approvals the approvals directory
 * @param {Record<string, string | undefined>} [at.env] the environment
 * @param {(path: string) => Promise<any>} [at.fetchJson] a GET of the repository's GitHub API path
 *     (`pulls/7`), for tests
 * @param {(args: string[], input?: string) => Buffer} [at.git] the git runner (gitIn), for tests
 * @returns {Promise<Map<string, { logins: Set<string>, emails: Set<string>, signers: Set<string>,
 *     problems: string[] }>>} by change
 */
export async function contributorsOf({
    base,
    head,
    cwd,
    changes,
    keys,
    baselines,
    approvals,
    env = process.env,
    fetchJson,
    git = gitIn(cwd),
}) {
    const out = new Map();
    let commits;
    try {
        commits = changeCommits(git, { base, head, baselines, approvals });
    } catch (err) {
        for (const change of changes) {
            out.set(change, {
                logins: new Set(),
                emails: new Set(),
                signers: new Set(),
                problems: [`could not read who contributed to ${change}: ${err.message}`],
            });
        }
        return out;
    }
    const github = env.GITHUB_ACTIONS === "true";
    const signed = github ? null : sshSigners(git, base, head, keys);
    for (const change of changes) {
        const who = { logins: new Set(), emails: new Set(), signers: new Set(), problems: [] };
        out.set(change, who);
        const add = (set, ...values) => values.filter(Boolean).forEach((v) => set.add(String(v).toLowerCase()));
        if (!github) {
            for (const [sha, c] of commits) {
                if (!c.counts) {
                    continue;
                }
                add(who.emails, ...c.emails);
                const key = signed.get(sha);
                if (key) {
                    who.signers.add(key);
                } else {
                    who.problems.push(
                        `commit ${sha.slice(0, 12)} carries no signature by a signing key an identity in ${PASSKEYS_FILE} names`,
                    );
                }
            }
            continue;
        }
        try {
            const pr = await githubPullRequest(change, env, fetchJson ?? githubApi(env));
            // A change none of whose commits counts (only Finish's own commits and merges that add
            // nothing, as a seed's) brings no code, so it has no contributors, its opener included.
            if ([...commits.values()].some((c) => c.counts)) {
                add(who.logins, pr.opener);
            }
            for (const c of pr.commits) {
                const local = commits.get(c.sha);
                if (!local) {
                    who.problems.push(`commit ${String(c.sha).slice(0, 12)} of ${change} is not in this checkout`);
                    continue;
                }
                if (!local.counts) {
                    continue;
                }
                add(who.logins, c.author?.login, c.committer?.login);
                add(who.emails, c.commit?.author?.email, c.commit?.committer?.email);
                const v = c.commit?.verification;
                if (v?.verified !== true) {
                    who.problems.push(
                        `commit ${c.sha.slice(0, 12)} is not signed, or GitHub does not verify its signature (${v?.reason ?? "unsigned"})`,
                    );
                }
            }
            // Every counted commit the gate checks must be one GitHub lists, but for the merge
            // result CI builds (the base, then the pull request's head).
            const listed = new Set(pr.commits.map((c) => c.sha));
            const prHead = pr.commits.at(-1)?.sha;
            for (const [sha, c] of commits) {
                const mergeResult = c.parents.length === 2 && c.parents[1] === prHead && !commits.has(c.parents[0]);
                if (c.counts && !listed.has(sha) && !mergeResult) {
                    who.problems.push(
                        `commit ${sha.slice(0, 12)} is in this checkout but GitHub does not list it in ${change}`,
                    );
                }
            }
        } catch (err) {
            who.problems.push(`could not ask GitHub who contributed to ${change}: ${err.message}`);
        }
    }
    return out;
}

/**
 * The key whose identity's SSH signing key signed each commit of `base..head`, from one `git log`
 * that verifies against those keys only.
 * @param {(args: string[]) => Buffer} git the runner
 * @param {string} base the base
 * @param {string} head the head
 * @param {object[]} keys the base's keys
 * @returns {Map<string, string>} key id by commit, for the commits such a signature verifies
 */
function sshSigners(git, base, head, keys) {
    const byPrint = new Map();
    const lines = [];
    for (const k of keys) {
        for (const line of k.identity?.signingKeys ?? []) {
            const blob = Buffer.from(line.split(" ")[1], "base64");
            byPrint.set(`SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`, k.id);
            lines.push(`proofroom ${line}`);
        }
    }
    const out = new Map();
    if (lines.length === 0) {
        return out;
    }
    const dir = mkdtempSync(join(tmpdir(), "proofroom-signers-"));
    try {
        const file = join(dir, "allowed_signers");
        writeFileSync(file, `${lines.join("\n")}\n`);
        const text = git([
            "-c",
            `gpg.ssh.allowedSignersFile=${file}`,
            "log",
            "--format=%H %G? %GF",
            `${base}..${head}`,
        ]);
        for (const line of text.toString("utf8").split("\n")) {
            const [sha, status, print] = line.split(" ");
            if (status === "G" && byPrint.has(print)) {
                out.set(sha, byPrint.get(print));
            }
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    return out;
}

/**
 * A GET of the repository's GitHub API, with GITHUB_TOKEN.
 * @param {Record<string, string | undefined>} env the environment
 * @returns {(path: string) => Promise<any>} the getter
 */
function githubApi(env) {
    return async (path) => {
        if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
            throw new Error("the gate step needs GITHUB_TOKEN (and GITHUB_REPOSITORY) to read the pull request");
        }
        const url = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/${path}`;
        const res = await fetch(url, {
            headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
        });
        if (!res.ok) {
            throw new Error(`GET ${path} answered ${res.status}`);
        }
        return res.json();
    };
}

// GitHub lists at most this many of a pull request's commits.
const GITHUB_MAX_COMMITS = 250;

/**
 * A pull request's opener and commits on GitHub: the opener from the event payload when it is
 * this pull request's, else from the API.
 * @param {string} change the change (`pr:7`)
 * @param {Record<string, string | undefined>} env the environment
 * @param {(path: string) => Promise<any>} get the API getter
 * @returns {Promise<{ opener: string | null, commits: any[] }>} what GitHub says
 */
async function githubPullRequest(change, env, get) {
    const n = /^pr:(\d+)$/.exec(change)?.[1];
    if (!n) {
        throw new Error(`${change} is not a pull request`);
    }
    let event = null;
    try {
        event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : null;
    } catch {
        // Unreadable: asked from the API instead.
    }
    const opener =
        event?.pull_request?.number === Number(n)
            ? event.pull_request.user?.login
            : (await get(`pulls/${n}`)).user?.login;
    if (!opener) {
        throw new Error(`GitHub names no account that opened #${n}`);
    }
    const commits = [];
    for (let page = 1; ; page++) {
        const list = await get(`pulls/${n}/commits?per_page=100&page=${page}`);
        commits.push(...list);
        if (list.length < 100) {
            break;
        }
    }
    if (commits.length >= GITHUB_MAX_COMMITS) {
        throw new Error(`#${n} has ${GITHUB_MAX_COMMITS} commits or more, and GitHub lists no more than that`);
    }
    return { opener, commits };
}

/**
 * The files a pull request could loosen the gate with: passkeys.json, the tool's config and the
 * workflow that runs the gate, which pins the tool's version. A change to one is a warning, never a
 * failure, so code review looks at it. The tool's own code is not in the repository it checks, so
 * it is not listed.
 * @param {string} base the base branch tip
 * @param {string} head the pull request's checkout
 * @param {string} workflow the workflow file that runs the gate
 * @param {string} [cwd] the repository
 * @returns {string[]} the changed ones
 */
export function trustFilesChanged(base, head, workflow, cwd = process.cwd()) {
    const files = [PASSKEYS_FILE, CONFIG_FILE, `.github/workflows/${workflow}`];
    return gitOut(cwd, ["diff", "--name-only", base, head, "--", ...files])
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
}

/**
 * The pull requests of a Mergify merge-queue batch, from its draft pull request's event: the body
 * ends with a fenced yaml block whose `pull_requests:` list names each one (`- number: 988`).
 * @param {any} event the parsed GITHUB_EVENT_PATH of the queue run
 * @returns {number[]} the batch's pull request numbers; empty when the block is missing
 */
export function queuePullRequests(event) {
    const list = /^pull_requests:\r?\n((?:[ \t-].*(?:\r?\n|$))*)/m.exec(queueYaml(event))?.[1] ?? "";
    return [...list.matchAll(/^[ \t]*- number: *(\d+)[ \t]*\r?$/gm)].map((m) => Number(m[1]));
}

/**
 * The commit a Mergify merge-queue batch sits on, from the same yaml block: `checking_base_sha:`.
 * It is the default branch for the first batch, and the previous batch's draft branch for a batch
 * stacked on it (Mergify checks two batches at once).
 * @param {any} event the parsed GITHUB_EVENT_PATH of the queue run
 * @returns {string | null} the full commit hash; null when it is missing or not a full hash
 */
export function queueBaseSha(event) {
    return /^checking_base_sha: *([0-9a-f]{40})[ \t]*\r?$/m.exec(queueYaml(event))?.[1] ?? null;
}

/**
 * The last fenced yaml block of a queue draft's body, where Mergify writes the batch.
 * @param {any} event the parsed event
 * @returns {string} the block's text; empty when there is none
 */
function queueYaml(event) {
    const body = String(event?.pull_request?.body ?? "");
    return [...body.matchAll(/```yaml\r?\n([\s\S]*?)```/g)].at(-1)?.[1] ?? "";
}

/**
 * Whether the repository holds a commit, fetching it from origin when it does not (a queue base
 * on a mergify/merge-queue/* branch is not in CI's shallow checkout).
 * @param {string} sha the full commit hash
 * @param {string} cwd the repository
 * @returns {boolean} whether the commit is there now
 */
function haveCommit(sha, cwd) {
    const git = (args) => {
        try {
            gitOut(cwd, args);
            return true;
        } catch {
            return false;
        }
    };
    const has = () => git(["cat-file", "-e", `${sha}^{commit}`]);
    return has() || (git(["fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", "origin", sha]) && has());
}

/**
 * Reads a merge-queue draft's event: its batch's pull requests and the commit the batch sits on,
 * printing what the gate reports about them.
 * @param {string} file the event file
 * @returns {string | null} the batch's base commit; null when the gate fails on the event
 */
function queueBaseOf(file) {
    let event = null;
    try {
        event = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        // Unreadable: no pull requests, which fails below.
    }
    const prs = queuePullRequests(event);
    if (prs.length === 0) {
        console.log("::error::merge queue -- the queue's draft pull request names no pull requests of the batch");
        return null;
    }
    console.log(`Merge-queue batch: #${prs.join(", #")}`);
    const base = queueBaseSha(event);
    if (base === null || !haveCommit(base, repoRoot())) {
        console.log(
            `::error::merge queue -- the queue's draft pull request names no checking_base_sha the gate can read (${base ?? "missing"})`,
        );
        return null;
    }
    console.log(`Baseline changes compared with the batch's base ${base}`);
    return base;
}

/**
 * Prints and returns what fails the gate about the owner's approval: the keys (approvalKeys), the
 * approvals directory, and the approval of the head's baselines tree (treeApprovalProblems).
 * @param {object} at what to check
 * @param {string} at.base the base branch tip, where keys and config are read
 * @param {string} at.diffBase what baseline changes are measured from
 * @param {string} at.head the head
 * @param {string} at.root the repository
 * @param {{ baselines: string, approvals: string, approvalFormat?: "tree" | "change", repositoryId?: string, selfApproval?: "allow" | "forbid" }} at.config the base branch's config
 * @param {{ approvals: string, repositoryId?: string }} at.headConfig the head's config
 * @param {string[]} at.changes the changes gated (`pr:7`)
 * @returns {Promise<string[]>} the failing lines
 */
async function approvalLines({ base, diffBase, head, root, config, headConfig, changes }) {
    const { keys, problems } = approvalKeys(base, head, root);
    if (headConfig.approvals !== config.approvals) {
        problems.push(
            `this pull request moves the approvals directory from ${config.approvals} to ${headConfig.approvals}`,
        );
    }
    if ((headConfig.repositoryId ?? null) !== (config.repositoryId ?? null)) {
        problems.push(
            `this pull request changes repositoryId from ${config.repositoryId ?? "none"} to ${headConfig.repositoryId ?? "none"}; a repository's id never changes`,
        );
    }
    const lines = problems.map((line) => `::error::passkey approval -- ${line}`);
    const { baselines, approvals } = config;
    const mode = approvalMode(config);
    const repository = repositoryOf(config);
    const found = approvalProblems({
        base: diffBase,
        head,
        cwd: root,
        baselines,
        approvals,
        keys,
        mode,
        changes,
        repository,
    });
    for (const line of found.notices) {
        console.log(`::notice::${line}`);
    }
    for (const line of found.problems) {
        lines.push(`::error::baselines not approved -- ${line}`);
    }
    if (config.selfApproval === "forbid") {
        for (const line of await selfApprovalLines({ diffBase, head, root, config, changes, keys, found })) {
            lines.push(`::error::self-approval -- ${line}`);
        }
    }
    for (const line of lines) {
        console.log(line);
    }
    return lines;
}

/**
 * What the self-approval rule refuses (selfApprovalProblems), asking who contributed only when a
 * statement counts. A tree statement's signer is never checked, so one that approves the change
 * fails.
 * @param {object} at what to check
 * @param {string} at.diffBase what baseline changes are measured from
 * @param {string} at.head the head
 * @param {string} at.root the repository
 * @param {{ baselines: string, approvals: string }} at.config the base branch's config
 * @param {string[]} at.changes the changes gated
 * @param {object[] | null} at.keys the base branch's keys
 * @param {{ statements: object[], byTree: boolean }} at.found approvalProblems' result
 * @returns {Promise<string[]>} the problems
 */
async function selfApprovalLines({ diffBase, head, root, config, changes, keys, found }) {
    const problems = [];
    if (found.byTree) {
        problems.push(
            'a version 1 tree statement approves these baselines, and its signer cannot be checked against the change\'s contributors; with "selfApproval": "forbid", Finish again with change statements',
        );
    }
    if (found.statements.length === 0) {
        return problems;
    }
    const contributors =
        keys === null
            ? new Map()
            : await contributorsOf({
                  base: diffBase,
                  head,
                  cwd: root,
                  changes,
                  keys,
                  baselines: config.baselines,
                  approvals: config.approvals,
              });
    return [...problems, ...selfApprovalProblems({ statements: found.statements, keys, contributors })];
}

export const GATE_USAGE = `usage: proofroom gate --captures <dir> --base <ref> [--head <ref>] [--change <id> | --pr <number> | --queue-event <file>]

Fails (exit 1) while a change holds visual changes nobody accepted, or baselines nobody approved:
every baseline file that differs from the base needs a change statement of this change accepting
exactly that file, or (in tree mode) the change adds the approval of exactly the head's baselines
tree. Once ${PASSKEYS_FILE} on the base branch holds a key, an approval must carry a passkey
signature by one of its keys. Run it in CI after the capture jobs, on the change's merge commit
(docs/approval-format.md).

  --captures <dir>  the downloaded visual-<project>-<attempt> artifacts of this run
  --base <ref>      the base branch tip (HEAD^1 on a pull request's merge commit)
  --head <ref>      the change's checkout (default HEAD), with its history
  --change <id>     the change being gated, as its statements name it (pr:3486, branch:feat/x)
  --pr <number>     the same as --change pr:<number>
  --queue-event <file>  in a merge-queue run, the event file of the queue's draft pull request
                    (GITHUB_EVENT_PATH): baseline changes are compared with the batch's
                    checking_base_sha instead of --base`;

/**
 * The gate as a command.
 * @param {string[]} args the command line after "gate"
 * @returns {Promise<number>} the exit code
 */
export async function runGate(args) {
    const { values } = parseArgs({
        args,
        options: {
            captures: { type: "string" },
            base: { type: "string" },
            head: { type: "string", default: "HEAD" },
            pr: { type: "string" },
            change: { type: "string" },
            "queue-event": { type: "string" },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log(GATE_USAGE);
        return 0;
    }
    const queueEvent = values["queue-event"];
    const pr = values.pr === undefined ? undefined : Number(values.pr);
    // A batch's changes are those since the commit it sits on, not since the base branch: a batch
    // stacked on another holds that batch's approved changes, which its own run gated. If that batch
    // fails, Mergify rebuilds this one on a new base. The config, the seeded projects and the keys
    // are still read from --base.
    let queueBase = null;
    let changes = pr === undefined ? [values.change].filter(Boolean) : [`pr:${pr}`];
    if (
        !values.captures ||
        !values.base ||
        (pr !== undefined && !(Number.isInteger(pr) && pr > 0)) ||
        [pr, values.change, queueEvent].filter((v) => v !== undefined).length > 1 ||
        (values.change !== undefined && !/^[a-z][a-z0-9-]*:\S+$/.test(values.change))
    ) {
        console.error(GATE_USAGE);
        return 2;
    }
    if (queueEvent !== undefined) {
        queueBase = queueBaseOf(queueEvent);
        if (queueBase === null) {
            return 1;
        }
        changes = queuePullRequests(JSON.parse(readFileSync(queueEvent, "utf8"))).map((n) => `pr:${n}`);
    }
    const root = repoRoot();
    const config = loadConfigAt(values.base, root);
    const seeded = seededAt(values.base, root, config.baselines);
    const headConfig = loadConfigAt(values.head, root);
    const captures = newestResults(values.captures);
    const queue = queueEvent !== undefined;
    const diffBase = queueBase ?? values.base;
    const baselinesChanged = baselinesChangedBetween(diffBase, values.head, root, config.baselines);
    const notAffected = [];
    const problems = gateProblems({ config, headConfig, seeded, captures, queue, baselinesChanged, notAffected });
    for (const p of notAffected) {
        console.log(`::notice::${p} was not captured: this pull request does not affect it`);
    }
    for (const line of problems) {
        console.log(`::error::visual changes not accepted -- ${line}`);
    }
    const unrecorded = await approvalLines({
        base: values.base,
        diffBase,
        head: values.head,
        root,
        config,
        headConfig,
        changes,
    });
    for (const file of trustFilesChanged(diffBase, values.head, config.workflow, root)) {
        console.log(
            `::warning::this pull request changes ${file}, which decides what the visual gate accepts: review that change with care`,
        );
    }
    if (problems.length + unrecorded.length > 0) {
        console.log("Review them with `proofroom serve` (the proofroom README).");
        return 1;
    }
    console.log("No unaccepted visual changes, and the baselines are the base's or approved by the owner.");
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = await runGate(process.argv.slice(2));
}
