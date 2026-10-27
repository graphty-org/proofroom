/**
 * Finish: turns the owner's decisions on one pull request (or on the default branch, for the
 * seed, which the page and this module call "master") into one commit, one push and one comment
 * (on master, one issue).
 *
 * Accepts and exclusions are written as files under the baselines directory (the config's
 * `baselines`) in a throwaway worktree
 * at the captured head, never in the main checkout, together with one review record, and pushed
 * to the pull request's branch. Rejects become one pull request comment. Every accepted PNG is
 * the artifact's file only when its bytes hash to the capture results.json names.
 *
 * Baseline PNGs are stored in Git LFS (the repository's .gitattributes). The commit must hold LFS pointers,
 * never raw PNGs, and the LFS objects must reach GitHub before the commit does; with hooks
 * switched off nothing else uploads them, so this module checks git-lfs is set up, checks every
 * committed PNG is a pointer, and runs `git lfs push` before `git push`.
 *
 * Once a passkey is known, every Finish that commits decisions is signed by the owner with one
 * passkey approval, so its accepts count as "approved before" on later pull requests. The merge
 * itself is approved by a signed statement about the baselines directory's git tree (gate.mjs
 * treeApprovalProblems), which only a Finish with nothing rejected and nothing left undecided
 * signs; the tree holds the review record, so that one signature covers the decisions too
 * (treeSignedRecords). Any other Finish signs its review record instead (version 2, with
 * `approval`, the form gate.mjs earlierApprovalProblem verifies). The tree signed is the tree that
 * lands:
 *
 * 1. the accept commit X: the accepted baselines and the review record, under the baselines
 *    directory (prepareApproval, before the owner is asked; X is not pushed yet);
 * 2. a Finish that signs the tree: the statement, naming X, the tree of the baselines directory at
 *    X and the pull request (treeStatement); the owner's device signs its SHA-256 (WebAuthn). Any
 *    other Finish: the record; the owner's device signs its SHA-256, and X is amended to X' holding
 *    the signed record (signRecord). An accept commit an earlier, unsigned Finish already pushed
 *    gets a commit on top instead, which only signs its record;
 * 3. the approval commit Y on X: only `<approvals>/<tree>.json`, the statement with its signature,
 *    outside the baselines directory, so Y's baselines tree is still the one signed
 *    (pushApproval); then X and Y are pushed together. Without a tree to sign, X' alone is pushed.
 *
 * Without a passkey (none registered) the same statement is committed unsigned. `proposeKey` opens
 * the pull request that registers a passkey.
 *
 * That is tree mode. In change mode (the default branch's config, config.mjs approvalFormatAt;
 * docs/approval-format.md) a Finish writes no review record and no tree statement: the accept
 * commit X holds the baselines and one change statement of this Finish's decisions, which the
 * owner signs once whatever is left undecided (prepareApproval returns it, pushApproval writes it
 * into X once signed, at the place its id gives). A push the branch refused because it moved is
 * made again on the new tip when nothing it writes changed there (pushChange).
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PASSKEYS_FILE, parsePasskeys, verifyApproval } from "./approval.mjs";
import {
    changeFolder,
    contentHash,
    newestDecisions,
    statementId,
    statementPath,
    statementProblem,
} from "./change-approval.mjs";
import { approvalFormatAt, CONFIG_FILE } from "./config.mjs";
import { githubCodeHost } from "./adapters/github.mjs";
import { exec, NETWORK, RETRY_DELAYS, retryOnNetwork, UNSENT } from "./github.mjs";
import { isLfsPointer, sha256 } from "./compare.mjs";

/** The statuses an item can be accepted or rejected in; unstable and failed are only excluded. */
const DECIDABLE = new Set(["changed", "moved", "new", "unseeded", "removed"]);
const EXCLUDABLE = new Set([...DECIDABLE, "unstable", "failed"]);

/**
 * Refused decisions and failed git commands; the message is shown to the owner as is.
 * `committed` is set when the accepts were already pushed and only the reject comment failed,
 * so the caller drops the accepts and keeps the rejects for a retry that only comments. On
 * master, `pullRequestMissing` is set too when opening the seed's pull request failed: the caller
 * keeps the accepts, and the retry opens the pull request for the branch already pushed.
 */
export class AcceptError extends Error {
    committed = null;
    pullRequestMissing = false;
    raced = false;
}

/**
 * Runs git with every hook switched off.
 *
 * A repository's hooks (husky's, say: secretlint, commitlint, Commitizen, a pre-push gate) would
 * run in an accept worktree that has no node_modules for them, and some want a terminal. This
 * commit holds only PNG and JSON files the tool wrote under the baselines directory, and its
 * message is a conventional commit (`commitPrefix` in the config; a test checks it). `--no-verify` alone is not enough, because git runs prepare-commit-msg even
 * with it, so the hooks path points nowhere. Signing is left as the repository configures it, so
 * the commit carries the owner's identity and signature. GIT_LFS_SKIP_SMUDGE keeps the worktree's
 * checkout from downloading every baseline image: untouched baselines stay pointer files there.
 * GIT_TERMINAL_PROMPT=0 makes a credential prompt fail instead of waiting on a terminal.
 * @param {string} cwd the repository or worktree
 * @param {string[]} args git's arguments
 * @param {string} [input] stdin
 * @returns {Promise<string>} stdout
 */
const git = (cwd, args, input) =>
    exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        input,
        env: { ...process.env, HUSKY: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
    });

/**
 * git's options for work that moves LFS pointer files between commits and never reads an image
 * (update from master): no LFS filter, so a pointer stays a pointer, and no checkout, merge, diff
 * or commit starts git-lfs, which starts eight git processes of its own every time.
 */
const NO_LFS = ["process=", "smudge=", "clean=", "required=false"].flatMap((v) => ["-c", `filter.lfs.${v}`]);

/** Images per `git lfs push --object-id`, so a large seed reports its upload as it goes. */
const LFS_BATCH = 50;

const gitOk = (cwd, args) =>
    git(cwd, args).then(
        () => true,
        () => false,
    );

/** How to set up git-lfs; the README of proofroom, "Requirements", has more. */
const LFS_SETUP =
    "on Ubuntu 22.04 run `sudo apt-get install git-lfs`, or put the git-lfs binary from " +
    "https://github.com/git-lfs/git-lfs/releases in ~/bin; then run `git lfs install` " +
    '(the proofroom README, "Requirements")';

/**
 * Why an accept would commit raw PNGs instead of Git LFS pointers, if it would: git-lfs is
 * missing, or its filter is not configured (`git lfs install` never ran).
 * @param {string} repo the repository
 * @returns {Promise<string | null>} the problem and how to fix it, or null when git-lfs is ready
 */
export async function lfsProblem(repo) {
    const env = await exec("git", ["lfs", "env"], { cwd: repo }).catch(() => null);
    if (env === null) {
        return `git-lfs is not installed (git lfs env failed): ${LFS_SETUP}`;
    }
    if (!/^git config filter\.lfs\.clean = "[^"]/m.test(env)) {
        return `git-lfs is installed but its filter is not configured: ${LFS_SETUP}`;
    }
    return null;
}

/**
 * The generated commit message.
 * @param {{ pr: number | null, branch?: string | null, counts: { accept: number, exclude: number, remove: number },
 *     runId: number | null, runAttempt: number | null, record: string, prefix: string,
 *     local?: object[], label?: string, candidate?: string | null }} input what the commit holds, the
 *     conventional-commit type and scope it starts with (`commitPrefix`), the projects captured by a
 *     local preview, what its last line names: the review record ("Record", the default) or a change
 *     statement ("Approval"), and the default branch candidate it accepts
 * @returns {string} a conventional commit message
 */
export function commitMessage({
    pr,
    branch = null,
    counts,
    runId,
    runAttempt,
    record,
    prefix,
    local = [],
    label = "Record",
    candidate = null,
}) {
    const subject =
        branch !== null
            ? `${prefix}: accept visual baselines for branch ${branch}`
            : pr === null
              ? masterSubject(prefix, candidate)
              : `${prefix}: accept visual baselines for #${pr}`;
    const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    return [
        subject,
        "",
        `Accepted in the review page: ${n(counts.accept, "image", "images")}, ` +
            `${n(counts.exclude, "exclusion", "exclusions")}, ${n(counts.remove, "removal", "removals")}.`,
        ...(local.length > 0
            ? [
                  `Captured locally at ${local[0].merge} (${local.map((l) => l.project).join(", ")}).`,
                  "CI checks it; anything CI draws differently comes back to review.",
              ]
            : branch !== null
              ? ["Captured on this machine from the review page."]
              : [`Captured by CI run ${runId}, attempt ${runAttempt}.`]),
        `${label}: ${record}`,
        "",
    ].join("\n");
}

/**
 * The subject of a commit or pull request that accepts on the default branch: a seed, or the
 * approval of a candidate (a default branch run waiting for its screenshots' approval; serve's `candidates`).
 * @param {string} prefix the config's commitPrefix
 * @param {string | null} candidate the candidate's commit, or null for a seed
 * @returns {string} the subject
 */
export const masterSubject = (prefix, candidate) =>
    candidate ? `${prefix}: approve visual baselines at ${candidate.slice(0, 12)}` : `${prefix}: seed visual baselines`;

/**
 * The branch a candidate's accept commit goes to.
 * @param {string} candidate the candidate's commit
 * @returns {string} `visual/approve-<short sha>`
 */
const candidateBranch = (candidate) => `visual/approve-${candidate.slice(0, 12)}`;

/**
 * Refuses an accept commit for a candidate that changes anything outside the baselines and
 * approvals directories: such a pull request is merged on the owner's signature alone. No rename
 * detection, so a file moved into one of them is listed under its old path too.
 * @param {string} tree the accept worktree, its HEAD the commit to push
 * @param {string} candidate the candidate's commit, the accept commit's base
 * @param {{ baselines: string, approvals: string }} config the settings
 */
async function requireAcceptOnly(tree, candidate, { baselines, approvals }) {
    const changed = (await git(tree, ["diff", "--name-only", "--no-renames", candidate, "HEAD"]))
        .split("\n")
        .filter(Boolean);
    const other = changed.filter((f) => !f.startsWith(`${baselines}/`) && !f.startsWith(`${approvals}/`));
    if (other.length > 0) {
        throw new AcceptError(
            `the accept commit would change ${other.join(", ")}, outside ${baselines}/ and ${approvals}/; nothing was pushed`,
        );
    }
}

/**
 * Why a decision cannot be taken on an item, if it cannot.
 * @param {{ status: string, file: string }} item the results.json item
 * @param {string} decision accept, reject or exclude
 * @param {string | null} reason the owner's reason
 * @returns {{ status: number, message: string } | null} an HTTP status and a message, or null
 */
export function decisionProblem(item, decision, reason) {
    if (!["accept", "reject", "exclude"].includes(decision)) {
        return { status: 400, message: `unknown decision "${decision}"` };
    }
    const allowed = decision === "exclude" ? EXCLUDABLE : DECIDABLE;
    if (!allowed.has(item.status)) {
        const only = ["unstable", "failed"].includes(item.status);
        return {
            status: 409,
            message: `${item.file} is ${item.status}: ${only ? "it can only be excluded" : "nothing to decide"}`,
        };
    }
    if (reason === null && decision !== "accept") {
        return { status: 400, message: `${item.file}: a ${decision} needs a reason` };
    }
    return null;
}

/**
 * A reason as stored: trimmed and at most 2,000 characters.
 * @param {unknown} r the reason as sent
 * @returns {string | null} the reason, or null when empty
 */
export const cleanReason = (r) => (typeof r === "string" && r.trim() !== "" ? r.trim().slice(0, 2000) : null);

/**
 * Whether a capture is a local preview of this pull request's merge tree (tools/visual-preview.sh):
 * decidable like a CI capture, and checked by CI's own capture at the gate. An ad hoc local
 * capture (no `local.preview`) and a preview of another pull request are not.
 * @param {object} r the results.json
 * @param {number | null} pr the pull request being finished; null (master) takes none
 * @returns {boolean} whether it is
 */
export const isPreviewOf = (r, pr) => pr !== null && Boolean(r.local?.preview) && r.pr === pr && r.headSha !== null;

/** The hash `local.diff` holds for a checkout with no uncommitted change: of an empty diff. */
const NO_DIFF = sha256(Buffer.alloc(0));

/**
 * Whether a capture is of a local branch's commit, as the review page captures one
 * (captures.mjs): made on this machine, no change named, and no uncommitted change in it.
 * @param {object} r its results.json
 * @param {string | null} branch the local branch being finished, or null
 * @returns {boolean} whether it is
 */
export const isBranchCapture = (r, branch) =>
    branch !== null && r.pr === null && r.runId === null && Boolean(r.local) && !r.local.preview && r.local.diff === NO_DIFF;

/**
 * The projects of the decided captures that came from a local preview, for the record's
 * `subject.local` and the commit message.
 * @param {object[]} decided the checked accepts and rejects
 * @param {number | null} pr the pull request
 * @returns {{ project: string, merge: string, host: string, tool: string }[]} by project
 */
const previewsOf = (decided, pr) =>
    [...new Map(decided.map((d) => [d.project, d.capture.results])).entries()]
        .filter(([, r]) => isPreviewOf(r, pr))
        .map(([project, r]) => ({ project, ...r.local.preview }))
        .sort((a, b) => a.project.localeCompare(b.project));

/**
 * Checks every decision against its results.json and sorts it into accepts and rejects.
 * @param {Record<string, { dir: string, results: object }>} projects the captures, by project
 * @param {{ project: string, file: string, decision: string, reason: string | null }[]} decisions
 *     the owner's decisions
 * @param {number | null} pr the pull request being finished (null for master)
 * @param {string | null} [branch] the local branch being finished (its captures are accepted)
 * @returns {{ accepts: object[], rejects: object[] }} each with its results item attached
 */
function check(projects, decisions, pr, branch = null) {
    const accepts = [];
    const rejects = [];
    for (const d of decisions) {
        const capture = Object.hasOwn(projects, d.project) ? projects[d.project] : undefined;
        const item = capture?.results.items.find((i) => i.file === d.file);
        if (!item) {
            throw new AcceptError(`${d.project}/${d.file} is not in this capture`);
        }
        const preview = isPreviewOf(capture.results, pr) || isBranchCapture(capture.results, branch);
        if (!preview && (capture.results.local !== null || capture.results.runId === null)) {
            throw new AcceptError(
                `${d.project} is a local capture, not acceptable: only CI captures and local previews of this pull request are`,
            );
        }
        const reason = cleanReason(d.reason);
        const problem = decisionProblem(item, d.decision, reason);
        if (problem) {
            throw new AcceptError(`${d.project}/${problem.message}`);
        }
        (d.decision === "reject" ? rejects : accepts).push({ ...d, reason, item, capture });
    }
    return { accepts, rejects };
}

/**
 * Applies the owner's decisions for one target.
 * @param {object} input the work
 * @param {string} input.repo the repository (its `.worktrees/` holds the accept worktree)
 * @param {(args: string[], input?: string) => Promise<string>} [input.gh] the gh runner, wrapped into the GitHub code host when no `codeHost` is given
 * @param {import("./adapters/index.mjs").CodeHost} [input.codeHost] the code host the pull
 *     request, comment, issue and status go to; wins over `gh`
 * @param {{ pr: number | null, branch: string | null, candidate?: string, localBranch?: boolean }} input.target a pull request and its
 *     branch, or `{ pr: null }` for master; on master, `candidate` is the commit of the full run
 *     offered (serve's `candidates`): the accept commit goes on `visual/approve-<short sha>` and
 *     may change only the baselines and approvals directories
 * @param {Record<string, { dir: string, results: object }>} input.projects the downloaded captures
 * @param {{ project: string, file: string, decision: string, reason: string | null }[]} input.decisions
 *     what the owner decided: accept, reject or exclude (checked here)
 * @param {number} [input.undecided] how many reviewable items are left undecided, for the status
 * @param {string[]} [input.unloaded] the projects whose capture did not load, so nobody reviewed them
 * @param {Date} [input.now] the review time
 * @param {(step: string) => void} [input.progress] told each step as it starts, for the page, and
 *     again with "(retrying after a network error, attempt n of N)" when a step's network call failed
 * @param {number[]} [input.retryDelays] milliseconds before each retry of a network call
 * @param {ReturnType<typeof import("./config.mjs").normalizeConfig>} input.config the settings
 * @param {boolean} [input.sign] whether this Finish approves the baselines tree it leaves (nothing
 *     rejected, nothing undecided): with `approval` the statement carries the owner's signature,
 *     without it (no key known) it is committed unsigned
 * @param {{ statement?: object, commit: string, branch: string, record: string,
 *     pendingKeys?: object[], origin: string, resign?: boolean } | null} [input.approval] the accept
 *     commit prepareApproval built and signRecord signed, and its statement with the owner's
 *     `approval` when the Finish signs the tree, the keys registered but not yet on the default
 *     branch, and the page's origin; `resign`: the commit only signs the record of an earlier
 *     Finish, so nothing is posted again
 * @param {string | null} [input.repository] this repository's id (`github:<id>`) for a change
 *     statement; null takes the default branch config's `repositoryId`
 * @returns {Promise<{ commit: string | null, branch: string | null, pullRequest: string | null,
 *     issue: string | null, rejects: number, acceptNotes: number, state: string | null,
 *     status: string | null, statusError: string | null, commentError: string | null, pending?: boolean,
 *     alreadyFinished?: true, resigned?: true, closedPullRequest?: string, closeError?: string }>} what
 *     was pushed and posted (`closedPullRequest`: a rejected candidate's accept pull request, closed;
 *     `alreadyFinished`: an earlier Finish
 *     already pushed these decisions as `commit`, and nothing was pushed or posted now; `resigned`:
 *     `commit` only signs the record of an earlier Finish, and nothing was posted; `issue`: master's rejects; `acceptNotes`: the accept notes published, in the comment or the
 *     seed pull request's description; `state` and `status`: the commit status's state and
 *     description, or `statusError` when posting it failed; `commentError` when a comment holding
 *     only accept notes failed after the accepts were pushed)
 */
export async function finish({
    repo,
    gh,
    codeHost = null,
    target,
    projects,
    decisions,
    undecided = 0,
    unloaded = [],
    now = new Date(),
    progress: tell = () => {},
    retryDelays = RETRY_DELAYS,
    config,
    sign = false,
    approval = null,
    repository = null,
}) {
    const host = codeHost ?? githubCodeHost(gh);
    const { progress, net } = stepRunner(tell, retryDelays);
    progress("checking");
    const { accepts, rejects } = check(projects, decisions, target.pr, localBranchOf(target));
    const first = (accepts[0] ?? rejects[0])?.capture.results;
    if (!first) {
        throw new AcceptError("nothing decided");
    }
    const isMaster = target.pr === null && !target.localBranch;
    if (isMaster && target.candidate && rejects.length > 0 && accepts.length > 0) {
        // A rejected image means the candidate never promotes: an accept pull request would be orphaned.
        throw new AcceptError("a Finish that rejects an image of a candidate posts only its rejects");
    }
    const notes = accepts.filter((a) => a.decision === "accept" && a.reason !== null);
    const decided = { target, first, accepts, rejects, notes, isMaster, progress, net, config };

    const made = await pushDecisions({
        repo,
        target,
        approval,
        accepts,
        rejects,
        first,
        now,
        progress,
        net,
        config,
        sign,
        repository,
    });
    if (made.done) {
        return made.done;
    }
    const pushed = made.pushed ?? { commit: null, branch: target.branch, record: null };
    const pullRequest = made.pushed && isMaster ? await openSeedPullRequest(host, decided, pushed) : null;
    const { commit, branch } = pushed;
    if (target.localBranch) {
        // A local branch has no code host to comment on or set a status for.
        return { ...unposted(pushed), rejects: rejects.length, pending: pushed.pending === true };
    }
    // On a pull request, one comment holds the rejects and the accept notes; on master the accept
    // notes are in the seed pull request's description, and only rejects open the issue.
    const comment = isMaster ? rejects.length > 0 : rejects.length > 0 || notes.length > 0;
    const { issue, commentError } = comment
        ? await postRejects(host, decided, pushed, pullRequest)
        : { issue: null, commentError: null };
    const { state, status, statusError } = await postFinishStatus(host, decided, { commit, undecided, unloaded });
    const notesPosted = (comment && commentError === null) || (isMaster && pullRequest);
    // A rejected image means the candidate never promotes: an accept pull request an earlier Finish
    // of it opened is closed, so its baselines never reach the default branch.
    const closed =
        isMaster && target.candidate && rejects.length > 0 ? await closeCandidatePullRequest(host, target) : {};
    return {
        ...closed,
        commit,
        branch,
        pullRequest,
        issue,
        rejects: rejects.length,
        acceptNotes: notesPosted ? notes.length : 0,
        state,
        status,
        statusError,
        commentError,
    };
}

// Pushes what a Finish decided: the accept commit the owner signed, or the accepts committed here.
// `pushed` is null when there was nothing to push; `done` is the whole Finish result when an
// earlier Finish already posted everything, so nothing is posted again.
async function pushDecisions({
    repo,
    target,
    approval,
    accepts,
    rejects,
    first,
    now,
    progress,
    net,
    config,
    sign,
    repository,
}) {
    if (approval) {
        const pushed = await pushApproval({ repo, target, approval, progress, net, config });
        // Only the earlier Finish's record was signed: its comment and status stand as posted.
        return {
            pushed,
            done: approval.resign ? { ...unposted(pushed), resigned: /** @type {const} */ (true) } : null,
        };
    }
    if (accepts.length === 0) {
        return { pushed: null, done: null };
    }
    const pushed = await commitAccepts({
        repo,
        target,
        accepts,
        rejects,
        first,
        now,
        progress,
        net,
        config,
        statement: sign,
        repository,
    });
    // The earlier Finish posted the comment and the status too: nothing is posted again.
    return {
        pushed,
        done: pushed.alreadyFinished ? { ...unposted(pushed), alreadyFinished: /** @type {const} */ (true) } : null,
    };
}

// A Finish result that posted nothing.
const unposted = ({ commit, branch }) => ({
    commit,
    branch,
    pullRequest: null,
    issue: null,
    rejects: 0,
    acceptNotes: 0,
    state: null,
    status: null,
    statusError: null,
    commentError: null,
});

/**
 * Finish's step reporter and network runner. Each network call is tried again while it fails on
 * the network (a DNS lookup that failed, say), and the page's step says so. A write GitHub may
 * have applied is retried only when the failure means it never reached GitHub (`unsentOnly`). A
 * call exec stopped for running too long is not retried: it already took the whole timeout.
 * @param {(step: string) => void} tell told each step as it starts, and each retry
 * @param {number[]} retryDelays milliseconds before each retry of a network call
 * @returns {{ progress: (step: string) => void, net: (label: string, run: Function, unsentOnly?: boolean) => Promise<any> }}
 *     the step reporter and the network runner
 */
function stepRunner(tell, retryDelays) {
    let current = "starting";
    const progress = (step) => {
        current = step;
        tell(step);
    };
    const net = (label, run, unsentOnly = false) =>
        retryOnNetwork(run, {
            label,
            delays: retryDelays,
            on: unsentOnly ? UNSENT : NETWORK,
            onRetry: (w) => tell(`${current} (retrying after a network error, attempt ${w.attempt} of ${w.of})`),
        });
    return { progress, net };
}

/**
 * Opens the seed's pull request for the branch commitAccepts pushed.
 * @param {import("./adapters/index.mjs").CodeHost} host the code host
 * @param {object} decided what finish checked: first, accepts, rejects, notes, progress, net, config
 * @param {{ commit: string, branch: string }} pushed the pushed commit and branch
 * @returns {Promise<string>} the pull request's URL
 */
async function openSeedPullRequest(host, decided, { commit, branch }) {
    const { first, accepts, rejects, notes, progress, net, config } = decided;
    progress("opening the pull request");
    try {
        return await net(
            "opening the pull request",
            () =>
                host.openChange({
                    title: masterSubject(config.commitPrefix, decided.target.candidate ?? null),
                    head: branch,
                    base: config.defaultBranch,
                    body: seedBody(first, accepts, rejects, notes, config, decided.target.candidate ?? null),
                }),
            true,
        );
    } catch (err) {
        // A candidate's branch is replaced on a later Finish, so its pull request may be open already.
        const open = decided.target.candidate ? await host.openChangeOf(branch).catch(() => null) : null;
        if (open) {
            // Its description is the only place a candidate's accept notes are published, so it is
            // rewritten with this Finish's (every decision of the candidate, notes included).
            const body = seedBody(first, accepts, rejects, notes, config, decided.target.candidate);
            try {
                await net("updating the pull request", () => host.updateChange(open.number, { body }));
            } catch (patchErr) {
                const e = new AcceptError(
                    `${branch} was pushed as ${commit.slice(0, 10)}, but updating the description of ` +
                        `${open.html_url} failed: ${patchErr.message}. Press Finish again to update it.`,
                );
                e.committed = commit;
                throw e;
            }
            return open.html_url;
        }
        const e = new AcceptError(
            `${branch} was pushed as ${commit.slice(0, 10)}, but opening its pull request failed: ` +
                `${err.message}. Press Finish again to open it.`,
        );
        e.committed = commit;
        e.pullRequestMissing = true;
        throw e;
    }
}

/**
 * Closes the open accept pull request of a candidate, if there is one.
 * @param {import("./adapters/index.mjs").CodeHost} host the code host
 * @param {{ candidate?: string }} target the candidate
 * @returns {Promise<{ closedPullRequest?: string, closeError?: string }>} the pull request closed,
 *     or why closing it failed
 */
export async function closeCandidatePullRequest(host, target) {
    const branch = candidateBranch(target.candidate);
    let open = null;
    try {
        open = await host.openChangeOf(branch);
        if (open) {
            await host.closeChange(open.number);
        }
        return open ? { closedPullRequest: open.html_url } : {};
    } catch (err) {
        const what = open?.html_url ?? `the pull request of ${branch}`;
        console.error(`proofroom: could not close ${what}: ${err.message}`);
        return { closeError: `could not close ${what}: ${err.message}` };
    }
}

/**
 * Posts the rejects and the accept notes: one pull request comment, or on master (which has no
 * pull request to comment on) one issue an agent can pick up, since master's rejects are stories
 * that do not look right yet.
 * @param {import("./adapters/index.mjs").CodeHost} host the code host
 * @param {object} decided what finish checked
 * @param {{ commit: string | null, record: string | null }} pushed what commitAccepts pushed
 * @param {string | null} pullRequest the seed's pull request
 * @returns {Promise<{ issue: string | null, commentError: string | null }>} master's issue, and why
 *     a comment holding only accept notes failed after the accepts were pushed
 */
async function postRejects(host, decided, { commit, record }, pullRequest) {
    const { target, first, rejects, notes, isMaster, progress, net, config } = decided;
    try {
        progress(isMaster ? "opening the issue for the rejects" : "posting the comment");
        // A committed record is named, not copied: a large one would pass GitHub's 65,536
        // character limit. A session of rejects alone commits nothing, so its record goes here.
        const body = rejectComment(
            target.pr,
            first,
            rejects,
            isMaster ? [] : notes,
            config.defaultBranch,
            commit === null ? {} : { recordFile: record, commit },
        );
        if (isMaster) {
            const issue = await net(
                "opening the issue",
                () =>
                    host.fileIssue({
                        title: `Visual review: ${rejects.length} ${rejects.length === 1 ? "story" : "stories"} rejected on ${config.defaultBranch}`,
                        body,
                        labels: config.issueLabels,
                    }),
                true,
            );
            return { issue, commentError: null };
        }
        await net("posting the comment", () => host.comment(target.pr, body), true);
        return { issue: null, commentError: null };
    } catch (err) {
        if (commit === null) {
            throw err;
        }
        return { issue: null, commentError: rejectsFailed(err, decided, commit, pullRequest) };
    }
}

/**
 * What a failed reject comment or issue means once the accepts are pushed: with only accept notes
 * the accepts stand and the page says the notes were not posted (returned); with rejects, an
 * AcceptError naming what landed (thrown). The accepts are pushed and cleared, so their notes are
 * never posted again: the message names them. On master they are already in the seed pull
 * request's description.
 * @param {Error} err the failure
 * @param {{ rejects: object[], notes: object[], isMaster: boolean }} decided what finish checked
 * @param {string} commit the pushed commit
 * @param {string | null} pullRequest the seed's pull request
 * @returns {string} the comment error, when there are no rejects
 */
function rejectsFailed(err, { rejects, notes, isMaster }, commit, pullRequest) {
    const unposted = !isMaster && notes.length > 0;
    const lost = unposted ? ` These accept notes were not posted and are not kept: ${noteList(notes)}.` : "";
    if (rejects.length === 0) {
        return `${err.message}.${lost}`;
    }
    const noteCount = notes.length === 1 ? "1 accept note" : `${notes.length} accept notes`;
    const withNotes = unposted ? ` and ${noteCount}` : "";
    const opened = isMaster && pullRequest ? ` and opened ${pullRequest}` : "";
    const e = new AcceptError(
        `the accepts were pushed as ${commit.slice(0, 10)}${opened}, but the ` +
            `${isMaster ? "issue" : "comment"} with the rejects${withNotes} failed: ${err.message}. ` +
            `Press Finish again to post the rejects.${lost}`,
    );
    e.committed = commit;
    throw e;
}

/**
 * Posts one commit status per Finish, on the commit it pushed, or the captured one when it pushed
 * none. A failure here does not undo what was pushed and posted; the page shows it.
 * @param {import("./adapters/index.mjs").CodeHost} host the code host
 * @param {object} decided what finish checked
 * @param {{ commit: string | null, undecided: number, unloaded: string[] }} counts the pushed
 *     commit, and what the Finish leaves
 * @returns {Promise<{ state: string, status: string, statusError: string | null }>} the status
 *     posted, and why posting it failed
 */
async function postFinishStatus(host, decided, { commit, undecided, unloaded }) {
    const { accepts, rejects, isMaster, first, progress, net } = decided;
    const accepted = accepts.filter((a) => a.decision === "accept").length;
    const { state, description: status } = commitStatus({
        accepted,
        rejected: rejects.length,
        excluded: accepts.length - accepted,
        undecided,
        unloaded,
    });
    let statusError = null;
    progress("posting the status");
    try {
        // Posting the same status again replaces it, so every network failure is retried.
        const sha = commit ?? (isMaster ? first.commit : first.headSha);
        await net("posting the status", () => host.setStatus(sha, { state, description: status }));
    } catch (err) {
        statusError = err.message;
    }
    return { state, status, statusError };
}

/**
 * The commit status a Finish sets: failure when anything is rejected, pending while items are
 * left undecided or a project did not load, success otherwise. The review page shows it before
 * Finish runs, so this is the one place the rule lives.
 * @param {{ accepted: number, rejected: number, excluded: number, undecided: number,
 *     unloaded: string[] }} counts what the Finish applies, and what it leaves
 * @returns {{ state: "failure" | "pending" | "success", description: string }} the status
 */
export function commitStatus({ accepted, rejected, excluded, undecided, unloaded }) {
    /** @type {"failure" | "pending" | "success"} */
    let state = "success";
    if (rejected > 0) {
        state = "failure";
    } else if (undecided > 0 || unloaded.length > 0) {
        state = "pending";
    }
    const description =
        `Reviewed: ${accepted} accepted, ${rejected} rejected, ${excluded} excluded, ` +
        `${undecided} left undecided${unloaded.length > 0 ? `, not loaded: ${unloaded.join(", ")}` : ""}`;
    return { state, description };
}

/**
 * Step 1 of a signed Finish: the accept commit X of these decisions, built and committed in a
 * throwaway worktree but not pushed, and its review record (version 2, without its approval yet),
 * which the owner's device signs next. When an earlier Finish already pushed exactly these
 * decisions (unsigned), X is that commit (`pushed`), and the record is its record as version 2.
 * Every check Finish makes runs here, so a refusal comes before the owner is asked.
 * @param {object} input the work
 * @param {string} input.repo the repository, with the captured head fetched
 * @param {{ pr: number | null, branch: string | null, candidate?: string, localBranch?: boolean }} input.target as in finish
 * @param {Record<string, { dir: string, results: object }>} input.projects as in finish
 * @param {object[]} input.decisions as in finish
 * @param {Date} input.now the review time, which becomes the record's `reviewedAt` and the
 *     statement's `approvedAt`
 * @param {ReturnType<typeof import("./config.mjs").normalizeConfig>} input.config the settings
 * @param {number[]} [input.retryDelays] as in finish
 * @param {string | null} [input.repository] as in finish
 * @returns {Promise<{ commit: string, branch: string, record: string | null, recordBody: object | null,
 *     statement?: object, pushed: boolean, accepts: number, excludes: number, rejects: number }>}
 *     the accept commit and branch it goes to, the record's path and the record to sign, whether
 *     the commit is pushed already, and what the Finish holds; in change mode (the default
 *     branch's config, docs/approval-format.md) no record but the change `statement` to sign,
 *     which pushApproval adds to the commit
 */
export async function prepareApproval({
    repo,
    target,
    projects,
    decisions,
    now,
    config,
    retryDelays,
    repository = null,
}) {
    const { accepts, rejects } = check(projects, decisions, target.pr, localBranchOf(target));
    const first = (accepts[0] ?? rejects[0])?.capture.results;
    if (!first || accepts.length === 0) {
        throw new AcceptError("nothing to accept: a Finish signs the baselines only when it accepts something");
    }
    const base = target.pr === null ? first.commit : first.headSha;
    if (!(await gitOk(repo, ["cat-file", "-e", `${base}^{commit}`]))) {
        throw new AcceptError("the captured commit is not fetched here yet: reload the page and press Finish again");
    }
    const { net } = stepRunner(() => {}, retryDelays ?? RETRY_DELAYS);
    const built = await commitAccepts({
        repo,
        target,
        accepts,
        rejects,
        first,
        now,
        progress: () => {},
        net,
        config,
        push: false,
        recordVersion: 2,
        repository,
    });
    if (built.statement !== undefined) {
        if (built.alreadyFinished || built.statement === null) {
            throw new AcceptError(
                "an earlier Finish of this change already holds these decisions: nothing is left to sign",
            );
        }
        return {
            commit: built.commit,
            branch: built.branch,
            record: null,
            recordBody: null,
            statement: built.statement,
            pushed: false,
            accepts: accepts.filter((a) => a.decision === "accept").length,
            excludes: accepts.filter((a) => a.decision !== "accept").length,
            rejects: rejects.length,
        };
    }
    const message = await git(repo, ["log", "-1", "--format=%B", built.commit]);
    const record = built.record ?? /^Record: (.+)$/m.exec(message)?.[1];
    const recordBody = record
        ? await git(repo, ["show", `${built.commit}:${record}`])
              .then(JSON.parse)
              .catch(() => null)
        : null;
    if (!recordBody) {
        throw new AcceptError(`the review record of ${built.commit.slice(0, 10)} cannot be read`);
    }
    if (recordBody.approval !== undefined) {
        throw new AcceptError("an earlier Finish already signed these decisions: nothing is left to sign");
    }
    return {
        commit: built.commit,
        branch: built.branch,
        record,
        recordBody: { ...recordBody, version: 2 },
        pushed: built.alreadyFinished === true || built.record === null,
        accepts: accepts.filter((a) => a.decision === "accept").length,
        excludes: accepts.filter((a) => a.decision !== "accept").length,
        rejects: rejects.length,
    };
}

/**
 * Step 2 of a Finish that signs the tree: what the owner signs. Its canonical JSON's SHA-256
 * (approval.mjs recordHash) is the WebAuthn challenge; the gate checks it (gate.mjs
 * treeApprovalProblem).
 * @param {object} input what to state
 * @param {string} input.repo the repository
 * @param {string} input.commit the commit reviewed: the accept commit X
 * @param {{ baselines: string }} input.config the settings
 * @param {number | null} input.pr the pull request, recorded only; null for a seed
 * @param {Date} input.now when
 * @returns {Promise<{ version: 1, commit: string, tree: string, baselines: string, pr: number | null,
 *     approvedAt: string }>} the statement
 */
export async function treeStatement({ repo, commit, config, pr, now }) {
    const tree = await git(repo, ["rev-parse", `${commit}:${config.baselines}`]);
    return { version: 1, commit, tree, baselines: config.baselines, pr, approvedAt: now.toISOString() };
}

/**
 * Step 2 of a Finish that does not sign the tree: the owner's approval of the review record,
 * written into it. The accept commit is amended
 * while it is not pushed; on a commit an earlier Finish pushed, a commit on top signs its record.
 * The approval is checked first, with the gate's own code.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {{ pr: number | null, branch?: string | null, candidate?: string, localBranch?: boolean }} input.target as in finish
 * @param {{ commit: string, record: string, recordBody: object, pushed: boolean }} input.prepared
 *     as prepareApproval returns
 * @param {object} input.approval the owner's approval of `recordBody`
 * @param {object[]} input.keys the keys it may come from
 * @param {string} input.origin the page's origin
 * @param {ReturnType<typeof import("./config.mjs").normalizeConfig>} input.config the settings
 * @returns {Promise<{ commit: string }>} the commit holding the signed record (not pushed)
 */
export async function signRecord({ repo, target, prepared, approval, keys, origin, config }) {
    const signed = { ...prepared.recordBody, approval };
    const why = verifyApproval(signed, keys, { origin });
    if (why) {
        throw new AcceptError(`the approval does not verify (${why}); nothing was committed`);
    }
    const tree = join(repo, config.workDir, "worktrees", acceptTree(target));
    await removeWorktree(repo, tree);
    await git(repo, ["worktree", "add", "-q", "--detach", tree, prepared.commit]);
    try {
        await put(join(tree, prepared.record), `${JSON.stringify(signed, null, 2)}\n`);
        await git(tree, ["add", "--", prepared.record]);
        if (prepared.pushed) {
            const who = target.pr === null ? "the seed" : `#${target.pr}`;
            const message = `${config.commitPrefix}: sign the review record of ${who}\n\nSigned by the owner's passkey.\nRecord: ${prepared.record}\n`;
            await git(tree, ["commit", "-q", "--no-verify", "-F", "-"], message);
        } else {
            await git(tree, ["commit", "-q", "--no-verify", "--amend", "--no-edit"]);
        }
        return { commit: await git(tree, ["rev-parse", "HEAD"]) };
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    } finally {
        await removeWorktree(repo, tree).catch((err) =>
            console.error(`proofroom: could not remove the accept worktree ${tree}: ${err.message}`),
        );
    }
}

const blobsOf = (listing) =>
    listing
        .split("\n")
        .map((line) => line.split("\t")[0].split(" ")[2])
        .filter(Boolean);

/**
 * The review records the owner signed by signing a baselines tree: the blobs under `reviews/` of
 * every tree that a statement in the approvals directory at `sha` approves with a valid passkey
 * signature. The tree's hash covers each record's bytes, so such a record is as signed as one
 * carrying its own approval. Statements are checked as the gate checks their signature; which
 * commit they name does not matter here, only the tree they sign.
 * @param {string} repo the repository
 * @param {string} sha the commit whose approvals directory is read
 * @param {{ approvals: string, baselines: string }} config the settings
 * @param {object[]} keys the keys a signature must come from
 * @param {Map<string, any>} [cache] what each statement blob says, by blob and keys, kept across
 *     calls
 * @returns {Promise<Set<string>>} the record blobs
 */
export async function treeSignedRecords(repo, sha, config, keys, cache = new Map()) {
    return (await earlierApprovalsAt(repo, sha, config, keys, cache)).treeSigned;
}

/**
 * Every earlier approval at a commit, from one `git ls-tree` of the approvals directory and the
 * review records: the review record files, the record blobs a signed tree statement covers
 * (treeSignedRecords), and every change statement (change-approval.mjs), each blob read once.
 * A change statement is verified when it sits where its content says it belongs, names this
 * repository, is about these baselines and carries a valid signature from one of `keys`; an
 * unverified one is listed too, so a history can show it as unverified, and never counts as an
 * approval.
 * @param {string} repo the repository
 * @param {string} sha the commit
 * @param {{ approvals: string, baselines: string }} config the settings
 * @param {object[] | null} keys the default branch's keys; null when it has none, so nothing
 *     verifies
 * @param {Map<string, any>} [cache] what each statement blob says, by blob, keys and placement,
 *     kept across calls
 * @param {string | null} [repository] this repository's id as the gate names it (gate.mjs
 *     repositoryOf); null when it is not known, so no change statement verifies
 * @returns {Promise<{ records: { path: string, blob: string }[], treeSigned: Set<string>,
 *     statements: { path: string, blob: string, statement: object, verified: boolean }[] }>} them
 */
export async function earlierApprovalsAt(repo, sha, config, keys, cache = new Map(), repository = null) {
    const approvals = `${config.approvals}/`;
    const reviews = `${config.baselines}/reviews/`;
    const listing = await git(repo, ["ls-tree", "-r", sha, "--", approvals, reviews]).catch(() => "");
    const out = { records: [], treeSigned: new Set(), statements: [] };
    const ids = (keys ?? []).map((k) => k.id).join(",");
    for (const line of listing.split("\n")) {
        const [meta, path] = line.split("\t");
        const blob = meta.split(" ")[2];
        const inReviews = path?.startsWith(reviews);
        const rest = path?.slice((inReviews ? reviews : approvals).length) ?? "";
        if (!path?.endsWith(".json") || (inReviews && rest.includes("/"))) {
            continue;
        }
        if (inReviews) {
            out.records.push({ path, blob });
            continue;
        }
        const nested = rest.includes("/");
        const key = `${blob} ${ids} ${nested}`;
        if (!cache.has(key)) {
            cache.set(key, await readApproval(repo, blob, config, keys, nested));
        }
        const read = cache.get(key);
        if (read.statement) {
            const placed = statementPath(config.approvals, read.statement) === path;
            const ours = repository !== null && read.statement.repository === repository;
            out.statements.push({ path, blob, statement: read.statement, verified: read.signed && placed && ours });
        }
        read.records?.forEach((b) => out.treeSigned.add(b));
    }
    return out;
}

/**
 * What one blob of the approvals directory says: a change statement (in a folder) and whether its
 * signature holds, or the record blobs a signed tree statement (at the top) covers.
 * @param {string} repo the repository
 * @param {string} blob the blob
 * @param {{ baselines: string }} config the settings
 * @param {object[] | null} keys the keys a signature must come from
 * @param {boolean} nested whether it sits in a folder, where change statements live
 * @returns {Promise<{ statement?: object, signed?: boolean, records?: string[] }>} it
 */
async function readApproval(repo, blob, config, keys, nested) {
    const doc = await git(repo, ["cat-file", "blob", blob]).then(JSON.parse, () => null);
    if (nested) {
        if (statementProblem(doc) !== null) {
            return {};
        }
        const signed = keys !== null && doc.baselines === config.baselines && verifyApproval(doc, keys) === null;
        return { statement: doc, signed };
    }
    const holds =
        keys !== null &&
        doc?.version === 1 &&
        doc.baselines === config.baselines &&
        /^[0-9a-f]{40,64}$/.test(String(doc.tree)) &&
        verifyApproval(doc, keys) === null;
    const records = holds ? await git(repo, ["ls-tree", doc.tree, "--", "reviews/"]).catch(() => "") : "";
    return { records: blobsOf(records) };
}

/**
 * The review record of a pull request's branch tip that an earlier Finish pushed unsigned: the tip
 * is that Finish's accept commit, and its record carries no approval. A Finish with nothing new to
 * decide signs it (prepareApproval finds it again and checks it holds exactly the saved decisions).
 * @param {string} repo the repository
 * @param {string | null | undefined} tip the branch tip
 * @param {number | null} pr the pull request
 * @param {{ commitPrefix: string }} config the settings
 * @returns {Promise<string | null>} the record's path, or null
 */
export async function unsignedRecordAt(repo, tip, pr, config) {
    if (pr === null || !tip) {
        return null;
    }
    const log = await git(repo, ["log", "-1", "--format=%P%n%B", tip]).catch(() => "");
    const [parents, subject] = log.split("\n");
    const path = /^Record: (.+)$/m.exec(log)?.[1];
    if (!path || parents.includes(" ") || subject !== `${config.commitPrefix}: accept visual baselines for #${pr}`) {
        return null;
    }
    const record = await git(repo, ["show", `${tip}:${path}`])
        .then(JSON.parse)
        .catch(() => null);
    return record?.pr === pr && Array.isArray(record.items) && record.approval === undefined ? path : null;
}

/**
 * Step 4: commits the signed statement on the accept commit, outside the baselines directory, and
 * pushes both; without a statement (the tree is not signed), pushes the accept commit alone. The
 * push is the staleness check: a branch that moved since step 1 refuses it.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {{ pr: number | null, branch?: string | null, candidate?: string, localBranch?: boolean }} input.target as in finish
 * @param {{ statement?: object, commit: string, branch: string, record: string, pendingKeys?: object[],
 *     origin: string }} input.approval as in finish, the statement with its `approval`
 * @param {(step: string) => void} input.progress as in finish
 * @param {Function} input.net as in finish
 * @param {ReturnType<typeof import("./config.mjs").normalizeConfig>} input.config the settings
 * @returns {Promise<{ commit: string, branch: string, record: string, pending?: boolean }>} what was pushed
 */
async function pushApproval({ repo, target, approval, progress, net, config }) {
    const { statement, commit, branch } = approval;
    if (statement?.version === 2) {
        return pushSignedChange({ repo, target, approval, progress, net, config });
    }
    if (statement) {
        progress("checking the approval");
        const tracking = ownRef(config.defaultBranch);
        const from = await remoteOf(repo, target, config.defaultBranch);
        await net(`git fetch ${config.defaultBranch}`, () =>
            git(repo, ["fetch", "-q", "--no-write-fetch-head", from, `+refs/heads/${config.defaultBranch}:${tracking}`]),
        );
        await requireApproval(repo, tracking, statement, approval);
        if ((await git(repo, ["rev-parse", `${commit}:${config.baselines}`])) !== statement.tree) {
            throw new AcceptError("the accept commit is not the one approved; press Finish again");
        }
    }
    const tree = join(repo, config.workDir, "worktrees", acceptTree(target));
    await removeWorktree(repo, tree);
    await git(repo, ["worktree", "add", "-q", "--detach", tree, commit]);
    try {
        if (statement) {
            await writeStatement(tree, statement, config);
        }
        const only = target.candidate ? { candidate: target.candidate, config } : null;
        const pushed = await pushAccepts({ repo, target, progress, net }, { tree, writes: [], branch, only });
        return { commit: pushed, branch, record: approval.record, pending: await pendingPush(repo, target) };
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    } finally {
        await removeWorktree(repo, tree).catch((err) =>
            console.error(`proofroom: could not remove the accept worktree ${tree}: ${err.message}`),
        );
    }
}

/**
 * pushApproval in change mode: the signed statement, checked with the gate's own code, goes into
 * the accept commit at the place its content gives, and the commit is pushed (pushChange).
 * @param {object} input as pushApproval's
 * @returns {Promise<{ commit: string, branch: string, record: null, pending?: boolean }>} what was pushed
 */
async function pushSignedChange(input) {
    const { repo, target, approval, progress, net, config } = input;
    const { statement, commit, branch } = approval;
    progress("checking the approval");
    const fetch = fetcher(repo, target, net);
    await fetch(config.defaultBranch);
    await requireApproval(repo, ownRef(config.defaultBranch), statement, approval);
    const tree = join(repo, config.workDir, "worktrees", acceptTree(target));
    await removeWorktree(repo, tree);
    await git(repo, ["worktree", "add", "-q", "--detach", tree, commit]);
    try {
        const path = statementPath(config.approvals, statement);
        await put(join(tree, path), `${JSON.stringify(statement, null, 2)}\n`);
        await git(tree, ["add", "--", path]);
        const message = (await git(repo, ["log", "-1", "--format=%B", commit])).replace(
            /^Approval: pending$/m,
            `Approval: ${path}`,
        );
        await git(tree, ["commit", "-q", "--no-verify", "--amend", "-F", "-"], `${message}\n`);
        const pushed = await pushChange(
            { repo, target, progress, net, config },
            { tree, writes: [], branch, statement, fetch },
        );
        return { commit: pushed, branch, record: null, pending: await pendingPush(repo, target) };
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    } finally {
        await removeWorktree(repo, tree).catch((err) =>
            console.error(`proofroom: could not remove the accept worktree ${tree}: ${err.message}`),
        );
    }
}

/**
 * Commits a statement (signed or not) as `<approvals>/<tree>.json` in the accept worktree, on its
 * accept commit; nothing under the baselines directory changes.
 * @param {string} tree the accept worktree
 * @param {object} statement the statement, with its `approval` when signed
 * @param {{ approvals: string, baselines: string, commitPrefix: string }} config the settings
 */
async function writeStatement(tree, statement, config) {
    const path = `${config.approvals}/${statement.tree}.json`;
    await put(join(tree, path), `${JSON.stringify(statement, null, 2)}\n`);
    await git(tree, ["add", "--", path]);
    const who = statement.pr === null ? "the seed" : `#${statement.pr}`;
    const message = [
        `${config.commitPrefix}: approve the visual baselines of ${who}`,
        "",
        `${statement.approval ? "Signed by the owner's passkey" : "Unsigned (no passkey is registered)"}: ` +
            `${config.baselines}/ at ${statement.commit} is tree ${statement.tree}.`,
        `Approval: ${path}`,
        "",
    ].join("\n");
    await git(tree, ["commit", "-q", "--no-verify", "-F", "-"], message);
}

/**
 * A review record: the owner's decisions, kept in the tree the owner signs. Version 3 carries no
 * signature (no passkey known); version 2 is the one the owner signs (signRecord adds `approval`).
 * @param {object} input what it records
 * @param {{ pr: number | null }} input.target the pull request, or null for master
 * @param {object} input.first the results.json of the first decided project
 * @param {object[]} [input.local] the decided projects a local preview captured: then the record
 *     names no CI run, and `subject.local` lists them
 * @param {object[]} input.items the record items planWrites made
 * @param {object[]} input.rejects the checked rejects
 * @param {Date} input.now the review time
 * @param {string} input.baselines the baselines directory
 * @param {2 | 3} [input.version] 2 for a record the owner signs
 * @returns {object} the record
 */
function buildRecord({ target, first, local = [], items, rejects, now, baselines, version = 3 }) {
    const byPath = (a, b) => a.path.localeCompare(b.path);
    return {
        version,
        pr: target.pr,
        subject: {
            builtMerge: first.commit,
            head: first.headSha,
            runId: local.length > 0 ? null : first.runId,
            runAttempt: local.length > 0 ? null : first.runAttempt,
            environment: first.environment,
            scale: first.scale ?? 1,
            ...(local.length > 0 && { local }),
        },
        items: dedupe(items).sort(byPath),
        rejects: rejects
            .map((r) => ({
                path: `${baselines}/${r.project}/${r.item.file}`,
                capture: r.item.capture ?? r.item.baseline ?? null,
                reason: r.reason,
            }))
            .sort(byPath),
        reviewedAt: now.toISOString(),
    };
}

/**
 * The keys passkeys.json holds at a ref; none when the file is absent there.
 * @param {string} repo the repository
 * @param {string} ref the ref
 * @returns {Promise<object[]>} the keys
 */
async function keysAt(repo, ref) {
    const text = await git(repo, ["show", `${ref}:${PASSKEYS_FILE}`]).catch(() => null);
    try {
        return text === null ? [] : parsePasskeys(text);
    } catch (err) {
        throw new AcceptError(`${PASSKEYS_FILE} on ${ref} is invalid: ${err.message}`);
    }
}

/**
 * Writes, commits and pushes the accepts. Every check runs before the worktree is created.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {{ pr: number | null, branch: string | null, candidate?: string, localBranch?: boolean }} input.target as in finish
 * @param {object[]} input.accepts the checked accepts and exclusions
 * @param {object[]} input.rejects the checked rejects, for a version 2 record
 * @param {object} input.first the results.json of the first decided project
 * @param {Date} input.now the review time
 * @param {(step: string) => void} input.progress as in finish
 * @param {(label: string, run: (attempt: number) => Promise<any>) => Promise<any>} input.net runs
 *     a network call, again while it fails on the network
 * @param {object} input.config as in finish
 * @param {boolean} [input.push] false: commit only, for prepareApproval (the worktree is removed,
 *     the commit stays in the repository)
 * @param {boolean} [input.statement] also commit the unsigned tree statement (no key known)
 * @param {2 | 3} [input.recordVersion] 2 for a record the owner signs next: then an accept commit
 *     an earlier Finish pushed is reused only when its record holds exactly these decisions
 * @param {string | null} [input.repository] this repository's id for a change statement
 *     (`github:<id>`); null takes the default branch's `repositoryId`
 * @returns {Promise<{ commit: string, branch: string, record: string | null, alreadyFinished?: true, pending?: boolean,
 *     statement?: object }>} the commit (pushed unless `push` is false) and branch, and the record's
 *     path (null for a seed pushed earlier and reused, and in change mode, whose commit holds its
 *     `statement` instead: unsigned, and not yet in the commit when it is not pushed)
 */
async function commitAccepts({
    repo,
    target,
    accepts,
    rejects,
    first,
    now,
    progress,
    net,
    config,
    push = true,
    statement = false,
    recordVersion = 3,
    repository = null,
}) {
    const { baselines, defaultBranch } = config;
    const isMaster = target.pr === null && !target.localBranch;
    const lfs = await lfsProblem(repo);
    if (lfs) {
        throw new AcceptError(lfs);
    }
    const base = target.pr === null ? first.commit : first.headSha;
    requireOneHead(accepts, first, target.pr, base);
    const candidate = isMaster ? (target.candidate ?? null) : null;
    const branch = acceptBranch(target, base, now);
    if (!branch || !(await gitOk(repo, ["check-ref-format", `refs/heads/${branch}`]))) {
        throw new AcceptError(`no usable branch for this target: ${branch}`);
    }

    const writes = await verifiedWrites(accepts);
    // The items come from the captured commit, as prepareRecord's did: the record built here must
    // hash to exactly what the owner approved.
    const plan = await planWrites(repo, base, writes, baselines);
    // Finish fetches into refs of its own, never the remote-tracking refs a page reload fetches
    // into at the same time (two fetches of one ref fail on its lock).
    const fetch = fetcher(repo, target, net);
    await fetch(defaultBranch);
    // The format the default branch's config chooses, never this checkout's (config.mjs).
    const settings = approvalFormatAt(ownRef(defaultBranch), repo);
    if (target.localBranch && settings.format !== "change") {
        throw new AcceptError(
            `a local branch is finished with change statements, and ${defaultBranch} uses tree statements: open a pull request for ${target.branch} and finish it there`,
        );
    }
    if (settings.format === "change") {
        const input = { repo, target, rejects, first, now, progress, net, config, push };
        const id = repository ?? settings.repositoryId;
        return commitChange(input, { base, branch, plan, writes, fetch, repository: id });
    }
    const exact = recordVersion === 2;
    const { parent, seed } = await acceptParent(
        { repo, target, net, config, rejects },
        { base, branch, plan, fetch, exact },
    );
    if (seed) {
        // Already pushed: a signed Finish signs that commit's record (signRecord, a commit on top)
        // and, when it signs the tree, its baselines; an unsigned one has nothing to add.
        return seed;
    }
    // No refusal when the default branch has newer baselines than the capture: each record item
    // names the bytes the owner saw (`from`) and approved (`to`), so a file the default branch
    // changed afterwards no longer starts from its contents there, the gate finds that item moves
    // nothing, and the merge queue's capture of the merged tree brings the image back for review.

    const local = previewsOf([...accepts, ...rejects], target.pr);
    const body = buildRecord({
        target,
        first,
        local,
        items: plan.items,
        rejects,
        now,
        baselines,
        version: recordVersion,
    });

    const tree = join(repo, config.workDir, "worktrees", acceptTree(target));
    await removeWorktree(repo, tree);
    await git(repo, ["worktree", "add", "-q", "--detach", tree, parent]);
    try {
        const input = { repo, target, first, now, progress, net, config };
        const record = await writeAcceptCommit(input, { tree, plan, writes, body, local });
        if (!push) {
            return { commit: await git(tree, ["rev-parse", "HEAD"]), branch, record };
        }
        if (statement) {
            const commit = await git(tree, ["rev-parse", "HEAD"]);
            await writeStatement(tree, await treeStatement({ repo, commit, config, pr: target.pr, now }), config);
        }
        const commit = await pushAccepts(input, {
            tree,
            writes,
            branch,
            only: candidate ? { candidate, config } : null,
        });
        return { commit, branch, record, pending: await pendingPush(repo, target) };
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    } finally {
        // A cleanup failure must not hide what was pushed; the next Finish removes the tree.
        await removeWorktree(repo, tree).catch((err) =>
            console.error(`proofroom: could not remove the accept worktree ${tree}: ${err.message}`),
        );
    }
}

/**
 * commitAccepts in change mode (docs/approval-format.md): the accepted baselines and one change
 * statement, no review record and no tree statement. The statement's `previous` names the newest
 * statement of this change on the branch (both ends of a fork), and `capturedHead` the change's own
 * head. When the commit is not pushed (prepareApproval) it holds only the baselines: the statement's
 * file name comes from its id, which covers the signature, so pushApproval adds it once signed.
 * Without a key the unsigned statement is committed and pushed at once.
 * @param {object} input commitAccepts' repo, target, rejects, first, now, progress, net, config and push
 * @param {{ base: string, branch: string, plan: object, writes: object[],
 *     fetch: (b: string) => Promise<any>, repository: string | null }} work the captured commit,
 *     the branch, the planned writes, the verified writes, the fetcher and the repository's id
 * @returns {Promise<{ commit: string, branch: string, record: null, statement: object, pending?: boolean,
 *     alreadyFinished?: true }>} what was committed (and pushed, unless `push` is false)
 */
async function commitChange(input, { base, branch, plan, writes, fetch, repository }) {
    const { repo, target, rejects, now, config, push } = input;
    if (repository === null) {
        throw new AcceptError(
            `this repository has no id for its change statements: set "repositoryId" in the default branch's ${CONFIG_FILE} (docs/approval-format.md, "Repository")`,
        );
    }
    // A seed's capture is of a default branch commit, which is on its pull request's base, and the
    // pull request's id is not known before Finish opens it: no statement of it could ever count.
    if (target.pr === null && !target.localBranch) {
        throw new AcceptError(
            "a capture of the default branch cannot be approved with change statements: accept these snapshots on a pull request's capture instead (docs/approval-format.md)",
        );
    }
    const change = target.localBranch ? `branch:${target.branch}` : `pr:${target.pr}`;
    const entries = [...plan.entries, ...rejectEntries(rejects)].sort((a, b) => a.path.localeCompare(b.path));
    const found = await changeParent(repo, config, { base, branch, plan, fetch, entries, change });
    if (found.seed) {
        return { ...found.seed, statement: null };
    }
    /** @type {any} */
    const statement = {
        version: 2,
        type: "change-approval",
        repository,
        baselines: config.baselines,
        change,
        capturedHead: base,
        previous: chainEnds(found.chain),
        approvedAt: now.toISOString().replace(/\.\d+Z$/, "Z"),
        entries,
    };
    const why = statementProblem(statement);
    if (why) {
        throw new AcceptError(`this Finish's change statement is not valid (${why})`);
    }
    const tree = join(repo, config.workDir, "worktrees", acceptTree(target));
    await removeWorktree(repo, tree);
    await git(repo, ["worktree", "add", "-q", "--detach", tree, found.parent]);
    try {
        if (found.dead.length > 0) {
            await git(tree, ["rm", "-q", "--", ...found.dead]);
        }
        const local = previewsOf([...input.rejects, ...writes], target.pr);
        await writeAcceptCommit(input, { tree, plan, writes, body: null, local, statement: push ? statement : null });
        if (!push) {
            return { commit: await git(tree, ["rev-parse", "HEAD"]), branch, record: null, statement };
        }
        const commit = await pushChange(input, { tree, writes, branch, statement, fetch });
        return { commit, branch, record: null, statement, pending: await pendingPush(repo, target) };
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    } finally {
        await removeWorktree(repo, tree).catch((err) =>
            console.error(`proofroom: could not remove the accept worktree ${tree}: ${err.message}`),
        );
    }
}

/**
 * The change statement entries of the checked rejects, with their reasons.
 * @param {object[]} rejects the checked rejects
 * @returns {object[]} the entries
 */
const rejectEntries = (rejects) =>
    rejects.map((r) => ({
        path: `${r.project}/${r.item.file}`,
        from: r.item.baseline ?? null,
        to: r.item.capture ?? null,
        decision: "reject",
        ...(r.reason !== null && { reason: r.reason }),
    }));

/**
 * What `previous` names: null with no statement before, else the id of the chain's newest
 * statement, or every newest one when two Finishes forked it (the array closes the fork).
 * @param {{ id: string, previous: string | string[] | null }[]} chain the change's statements
 * @returns {string | string[] | null} it
 */
function chainEnds(chain) {
    const named = new Set(chain.flatMap((st) => (st.previous === null ? [] : [st.previous].flat())));
    const ends = chain
        .map((st) => st.id)
        .filter((id) => !named.has(id))
        .sort();
    return ends.length === 0 ? null : ends.length === 1 ? ends[0] : ends;
}

/**
 * The well-formed statements of one change at a commit, in its folder of the approvals directory.
 * @param {string} repo the repository
 * @param {string} ref the commit
 * @param {{ approvals: string }} config the settings
 * @param {string} change the change id
 * @returns {Promise<{ file: string, id: string, previous: any, entries: object[] }[]>} them
 */
async function statementsAt(repo, ref, config, change) {
    const dir = `${config.approvals}/${changeFolder(change)}/`;
    const names = await git(repo, ["ls-tree", "-r", "--name-only", ref, "--", dir]).catch(() => "");
    const out = [];
    for (const file of names.split("\n").filter((n) => n.endsWith(".json"))) {
        const st = await git(repo, ["show", `${ref}:${file}`]).then(JSON.parse, () => null);
        if (statementProblem(st) === null && st.change === change) {
            out.push({ ...st, file, id: statementId(st) });
        }
    }
    return out;
}

const sameDecision = (a, b) =>
    a.decision === b.decision && a.from === b.from && a.to === b.to && (a.reason ?? null) === (b.reason ?? null);

/**
 * The files of a plan the commit at `ref` does not already hold as the plan writes them. Only the
 * files `ref` changed since the captured commit are read, one git call each: the others are as
 * the capture showed them, which a decision changes.
 * @param {string} repo the repository
 * @param {string} ref the commit
 * @param {{ files: { path: string, bytes: Buffer | string | null }[] }} plan the planned writes
 * @param {Set<string>} since the files `ref` changed since the captured commit
 * @returns {Promise<string[]>} their paths
 */
async function differingFiles(repo, ref, plan, since) {
    const out = [];
    for (const f of plan.files) {
        if (!since.has(f.path)) {
            out.push(f.path);
            continue;
        }
        const held = await blobAt(repo, ref, f.path);
        if ((held === null ? null : contentHash(held)) !== (f.bytes === null ? null : sha256(f.bytes))) {
            out.push(f.path);
        }
    }
    return out;
}

/**
 * The commit a change mode Finish of a pull request goes on: the branch's tip, when it is the
 * captured head plus Finish commits (or a merge of the default branch, masterMergeProblem) that
 * changed no file this Finish writes into something else; and the change's statements there.
 * A tip whose chain already holds every one of these decisions, with nothing left to write, is
 * an earlier Finish of the same decisions (sent again): nothing is left to do.
 * @param {string} repo the repository
 * @param {object} config the settings
 * @param {object} at the captured commit, the branch, the plan, the fetcher, the entries and the change
 * @returns {Promise<{ parent?: string, chain: object[], dead: string[], seed?: object }>} it, and
 *     the files of the change's statements the default branch's keys do not verify
 */
async function changeParent(repo, config, at) {
    const { base, branch, plan, fetch, entries, change } = at;
    await fetch(branch);
    const tip = await git(repo, ["rev-parse", ownRef(branch)]);
    const since = tip === base ? [] : await changedSince(repo, base, tip);
    const differ = await differingFiles(repo, tip, plan, new Set(since));
    if (tip !== base) {
        const finishOnly = (await onlyFinishCommits(repo, base, tip, config)) && !since.some((f) => differ.includes(f));
        const why = finishOnly ? null : await masterMergeProblem(repo, base, tip, ownRef(config.defaultBranch), differ);
        if (why) {
            throw new AcceptError(
                `capture is stale, wait for CI: the branch has moved past the captured head (${why})`,
            );
        }
    }
    // Once the default branch holds a key, a statement it does not verify (one committed unsigned
    // before the key landed) would fail the gate: this Finish removes it and decides afresh.
    const keys = await keysAt(repo, ownRef(config.defaultBranch));
    const all = await statementsAt(repo, tip, config, change);
    const docOf = (st) => Object.fromEntries(Object.entries(st).filter(([k]) => k !== "file" && k !== "id"));
    const verified = (st) => keys.length === 0 || verifyApproval(docOf(st), keys) === null;
    const chain = all.filter(verified);
    const dead = all.filter((st) => !verified(st)).map((st) => st.file);
    const newest = chain.length > 0 ? newestDecisions(chain) : null;
    const held =
        newest !== null &&
        "decisions" in newest &&
        differ.length === 0 &&
        entries.every((e) => {
            const d = newest.decisions.get(e.path);
            return d !== undefined && !("conflict" in d) && sameDecision(d, e);
        });
    if (held && dead.length === 0) {
        return { chain, dead, seed: { commit: tip, branch, record: null, alreadyFinished: true } };
    }
    return { parent: tip, chain, dead };
}

/**
 * Pushes a change mode accept commit (the worktree's HEAD, its statement in it). When the branch
 * moved meanwhile and the push is refused, the branch is fetched again:
 * - it holds another statement of this change: nothing is pushed, and the error names the
 *   snapshots that statement decided differently, or asks for a Finish after it (one passkey
 *   touch, `previous` naming it);
 * - its new commits hold the captured head and change no file this commit writes: the same
 *   commit, signed statement and all, is made again on the new tip and pushed, with no new touch;
 * - otherwise the capture is stale.
 * @param {object} input finish's repo, progress, net and config
 * @param {{ tree: string, writes: object[], branch: string, statement: object,
 *     fetch: (b: string) => Promise<any> }} work the worktree, the writes, the branch, the
 *     statement and the fetcher
 * @returns {Promise<string>} the pushed commit
 */
async function pushChange(input, { tree, writes, branch, statement, fetch }) {
    const { repo, config } = input;
    for (let rebuilt = 0; ; rebuilt++) {
        try {
            return await pushAccepts(input, { tree, writes, branch });
        } catch (err) {
            if (!(err instanceof AcceptError && err.raced) || rebuilt >= 2) {
                throw err;
            }
        }
        await fetch(branch);
        const tip = await git(repo, ["rev-parse", ownRef(branch)]);
        const own = await git(tree, ["rev-parse", "HEAD"]);
        const parent = await git(tree, ["rev-parse", "HEAD^"]);
        const before = new Set((await statementsAt(repo, parent, config, statement.change)).map((st) => st.file));
        const others = (await statementsAt(repo, tip, config, statement.change)).filter((st) => !before.has(st.file));
        if (others.length > 0) {
            throw new AcceptError(otherFinishMessage(statement, others));
        }
        const mine = (await git(tree, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", parent, own]))
            .split("\0")
            .filter(Boolean);
        const theirs = new Set(await changedSince(repo, parent, tip));
        const clash = mine.find((f) => theirs.has(f));
        if (clash !== undefined || !(await gitOk(repo, ["merge-base", "--is-ancestor", statement.capturedHead, tip]))) {
            const why = clash === undefined ? "the branch no longer holds the captured head" : `it changed ${clash}`;
            throw new AcceptError(
                `capture is stale, wait for CI: the branch moved while Finish ran (${why}); nothing was pushed`,
            );
        }
        // The same files on the new tip: it copies nobody's commit, so nothing is rebased.
        await git(tree, ["checkout", "-q", "--detach", tip]);
        await git(tree, ["restore", `--source=${own}`, "--staged", "--worktree", "--", ...mine]);
        await git(tree, ["commit", "-q", "--no-verify", "-C", own]);
    }
}

/**
 * Why a push lost to another Finish of the same change.
 * @param {{ entries: object[] }} statement this Finish's statement
 * @param {{ entries: object[] }[]} others the other statements the branch gained
 * @returns {string} the message
 */
function otherFinishMessage(statement, others) {
    const theirs = new Map(others.flatMap((st) => st.entries.map((e) => [e.path, e])));
    const differ = statement.entries.filter((e) => theirs.has(e.path) && !sameDecision(theirs.get(e.path), e));
    if (differ.length > 0) {
        const names = differ.map((e) => e.path).join(", ");
        return `another Finish of this change was pushed while yours ran and decided ${names} differently; nothing was pushed: look at ${differ.length === 1 ? "it" : "them"} again and Finish`;
    }
    return "another Finish of this change was pushed while yours ran and decided no snapshot differently; nothing was pushed: press Finish again to sign yours after it (one passkey touch)";
}

/**
 * The branch an accept commit goes to: the pull request's, a candidate's `visual/approve-<sha>`, or a
 * dated seed branch. Refuses a candidate whose capture is of another commit.
 * @param {{ pr: number | null, branch: string | null, candidate?: string, localBranch?: boolean }} target as in finish
 * @param {string} base the captured commit
 * @param {Date} now the review time
 * @returns {string | null} the branch
 */
function acceptBranch(target, base, now) {
    if (target.pr !== null || target.localBranch) {
        return target.branch;
    }
    if (!target.candidate) {
        return `visual/seed-${now.toISOString().slice(0, 10)}`;
    }
    if (target.candidate !== base) {
        throw new AcceptError(
            `the capture is of ${base.slice(0, 10)}, not of the candidate ${target.candidate.slice(0, 10)}`,
        );
    }
    return candidateBranch(target.candidate);
}

/**
 * The ref Finish fetches a branch into: its own, never a remote-tracking ref.
 * @param {string} b the branch
 * @returns {string} the ref
 */
const ownRef = (b) => `refs/visual-review/origin/${b}`;

/**
 * Refuses accepts that do not all come from one head: CI's projects of one run, or (on a pull
 * request) local previews of the same head.
 * @param {object[]} accepts the checked accepts and exclusions
 * @param {object} first the results.json of the first decided project
 * @param {number | null} pr the pull request; null for master
 * @param {string} base the captured commit
 */
function requireOneHead(accepts, first, pr, base) {
    const sameRun = (r) => r.runId === first.runId || isPreviewOf(r, pr) || isPreviewOf(first, pr);
    const headOf = (r) => (pr === null ? r.commit : r.headSha);
    if (accepts.some(({ capture }) => headOf(capture.results) !== base || !sameRun(capture.results))) {
        throw new AcceptError("the projects of one Finish must come from one CI run, or one head of the pull request");
    }
}

/**
 * Reads and verifies every new file before git is touched.
 * @param {object[]} accepts the checked accepts and exclusions
 * @returns {Promise<object[]>} the accepts, each accepted image with its `bytes`
 */
async function verifiedWrites(accepts) {
    const writes = [];
    for (const a of accepts) {
        if (a.decision !== "accept" || a.item.status === "removed") {
            writes.push(a);
            continue;
        }
        const bytes = await readFile(join(a.capture.dir, a.item.file));
        if (sha256(bytes) !== a.item.capture) {
            throw new AcceptError(`${a.project}/${a.item.file} does not match the capture results.json names`);
        }
        writes.push({ ...a, bytes });
    }
    return writes;
}

/**
 * The commit the accepts go on: the captured head, or the branch's newer tip when it only merged
 * the default branch since (masterMergeProblem). On master, a seed this tool pushed whose pull
 * request failed to open is used as it is; on a pull request, an accept commit an earlier Finish
 * pushed for these same decisions is reported as already finished (finishedBefore).
 * @param {object} input finish's repo, target, net, config and rejects
 * @param {{ base: string, branch: string, plan: object, fetch: (b: string) => Promise<any>,
 *     exact?: boolean }} at the captured commit, the branch, the planned writes and the fetcher, and
 *     whether an earlier Finish's record must hold exactly these decisions (finishedBefore)
 * @returns {Promise<{ parent?: string, seed?: { commit: string, branch: string, record: string | null,
 *     alreadyFinished?: true } }>} the parent, or the commit already pushed
 */
async function acceptParent(input, { base, branch, plan, fetch, exact = false }) {
    const { repo, target, net, config, rejects } = input;
    if (target.pr !== null || target.localBranch) {
        await fetch(branch);
        const parent = await git(repo, ["rev-parse", ownRef(branch)]);
        const paths = plan.files.map((f) => f.path);
        // A tip that is the captured head plus earlier Finishes' own commits is current for this capture,
        // unless one of them wrote a file this Finish writes (its `from` would no longer be the tip's).
        const moved = async (tip) =>
            tip === base ||
            ((await onlyFinishCommits(repo, base, tip, config)) &&
                !(await changedSince(repo, base, tip)).some((f) => paths.includes(f)))
                ? null
                : masterMergeProblem(repo, base, tip, ownRef(config.defaultBranch), paths);
        const why = await moved(parent);
        const { items } = plan;
        const record =
            why && (await finishedBefore(repo, { tip: parent, base, target, config, items, rejects, moved, exact }));
        if (record) {
            return { seed: { commit: parent, branch, record, alreadyFinished: true } };
        }
        if (why) {
            throw new AcceptError(
                `capture is stale, wait for CI: the branch has moved past the captured head (${why})`,
            );
        }
        return { parent };
    }
    if ((await net("git ls-remote", () => git(repo, ["ls-remote", "--heads", "origin", branch]))) === "") {
        // Gone from origin: forget the copy fetched earlier, so pushAccepts leases nothing stale.
        await git(repo, ["update-ref", "-d", ownRef(branch)]).catch(() => {});
        return { parent: base };
    }
    // ponytail: assumes the decisions did not change since that push; compare the trees if
    // they can.
    await fetch(branch);
    const [subject, parent] = (await git(repo, ["log", "-1", "--format=%s%n%P", ownRef(branch)])).split("\n");
    if (target.candidate && (await candidateBranchOwned(repo, base, ownRef(branch), config))) {
        // An earlier Finish of this candidate: its Finish sends every decision on it, so the accept
        // commit is built again on the candidate and pushAccepts replaces the branch (its pull request,
        // open or not, then holds this Finish's commit).
        return { parent: base };
    }
    if (subject === masterSubject(config.commitPrefix, null) && parent === base) {
        return { seed: { commit: await git(repo, ["rev-parse", ownRef(branch)]), branch, record: null } };
    }
    throw new AcceptError(`${branch} already exists on origin: merge or delete it first`);
}

/**
 * The record of the accept commit an earlier Finish pushed, when that commit is all the branch
 * gained since the captured head (or since a merge of the default branch it allows) and it already
 * records every one of these decisions: a Finish sent again (a second press, or a page that had
 * not seen the first end) then has nothing left to do. Anything else on the branch returns null,
 * and the caller refuses the capture as stale.
 * @param {string} repo the repository
 * @param {object} at what to compare
 * @param {string} at.tip the branch tip as fetched
 * @param {string} at.base the captured head
 * @param {{ pr: number }} at.target the pull request
 * @param {{ commitPrefix: string, baselines: string }} at.config the settings
 * @param {object[]} at.items the record items this Finish would write
 * @param {object[]} at.rejects the checked rejects
 * @param {(tip: string) => Promise<string | null>} at.moved why a tip is stale for this capture
 * @param {boolean} [at.exact] the record must hold nothing else either: it is about to be signed,
 *     and the owner signs only what they decided
 * @returns {Promise<string | null>} the record's path, or null
 */
async function finishedBefore(repo, { tip, base, target, config, items, rejects, moved, exact = false }) {
    const [subject, parents] = (await git(repo, ["log", "-1", "--format=%s%n%P", tip])).split("\n");
    if (subject !== `${config.commitPrefix}: accept visual baselines for #${target.pr}` || parents.includes(" ")) {
        return null;
    }
    if (await moved(parents)) {
        return null;
    }
    const path = /^Record: (.+)$/m.exec(await git(repo, ["log", "-1", "--format=%B", tip]))?.[1];
    const record = path
        ? await git(repo, ["show", `${tip}:${path}`])
              .then(JSON.parse)
              .catch(() => null)
        : null;
    if (record?.pr !== target.pr || record.subject?.head !== base || !Array.isArray(record.items)) {
        return null;
    }
    // A note or a reject's reason differs too: the earlier Finish posted its own.
    const key = (i, kind = "item") => JSON.stringify([kind, i.path, i.to, i.reason ?? null]);
    const recorded = new Set([
        ...record.items.map((i) => key(i)),
        ...(record.rejects ?? []).map((r) => key({ ...r, to: r.capture }, "reject")),
    ]);
    const wanted = new Set([
        ...items.map((i) => key(i)),
        ...rejects.map((r) =>
            key(
                {
                    path: `${config.baselines}/${r.project}/${r.item.file}`,
                    to: r.item.capture ?? r.item.baseline ?? null,
                    reason: r.reason,
                },
                "reject",
            ),
        ),
    ]);
    const same = [...wanted].every((k) => recorded.has(k)) && (!exact || recorded.size === wanted.size);
    return same ? path : null;
}

/**
 * Writes the accepts and the record in the accept worktree and commits them. In change mode
 * (`body` null) no record is written: the commit holds `statement` instead, or, with none yet
 * (it is signed next, pushApproval), only the baselines.
 * @param {object} input finish's repo, target, first, now, progress and config
 * @param {{ tree: string, plan: object, writes: object[], body: object | null, local: object[],
 *     statement?: object | null }} work the worktree, the planned writes, the record, the local
 *     previews and, in change mode, the statement to commit
 * @returns {Promise<string>} the path of the record (or of the statement; "pending" before it is signed)
 */
async function writeAcceptCommit(input, { tree, plan, writes, body, local, statement = null }) {
    const { repo, target, first, now, progress, config } = input;
    const { baselines } = config;
    const isMaster = target.pr === null && !target.localBranch;
    const tracking = ownRef(config.defaultBranch);
    // A seed may be built on a commit older than the rule that stores baselines in Git LFS.
    // Carry the default branch's .gitattributes into it, so the PNGs become pointers and the
    // seed merges back with the same rule.
    // A candidate is a recent commit of the default branch, and its accept commit holds only the
    // baselines and approvals directories.
    const rules =
        isMaster && !target.candidate ? await git(repo, ["show", `${tracking}:.gitattributes`]).catch(() => "") : "";
    if (rules !== "") {
        await put(join(tree, ".gitattributes"), `${rules}\n`);
        await git(tree, ["add", "--", ".gitattributes"]);
    }
    progress(`writing ${writes.length} ${writes.length === 1 ? "file" : "files"}`);
    for (const f of plan.files) {
        await (f.bytes === null ? rm(join(tree, f.path), { force: true }) : put(join(tree, f.path), f.bytes));
    }
    const stamp = now.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+/, "");
    let record = `${baselines}/reviews/${stamp}-${isMaster ? "master" : `pr${target.pr}`}.json`;
    if (body === null) {
        record = statement ? statementPath(config.approvals, statement) : "pending";
        if (statement) {
            await put(join(tree, record), `${JSON.stringify(statement, null, 2)}\n`);
            await git(tree, ["add", "--", record]);
        }
    } else {
        await put(join(tree, record), `${JSON.stringify(body, null, 2)}\n`);
    }
    progress("committing");
    await git(tree, ["add", "-A", "--", baselines]);
    const message = commitMessage({
        pr: target.pr,
        branch: target.localBranch ? target.branch : null,
        counts: plan.counts,
        runId: first.runId,
        runAttempt: first.runAttempt,
        record,
        prefix: config.commitPrefix,
        local,
        label: body === null ? "Approval" : "Record",
        candidate: target.candidate ?? null,
    });
    // Before a statement is signed, the commit may hold nothing: every file already as decided.
    await git(tree, ["commit", "-q", "--no-verify", ...(body === null ? ["--allow-empty"] : []), "-F", "-"], message);
    await requireLfsPointers(tree, plan.items);
    return record;
}

/**
 * The gate's own check, on the statement about to be committed, with the default branch's keys as
 * just fetched and the keys this server registered.
 * @param {string} repo the repository
 * @param {string} tracking the default branch as fetched
 * @param {object} statement the statement, with its `approval`
 * @param {{ pendingKeys?: object[], origin: string }} approval as in finish
 */
async function requireApproval(repo, tracking, statement, approval) {
    const keys = [...(await keysAt(repo, tracking)), ...(approval.pendingKeys ?? [])];
    const why = verifyApproval(statement, keys, { origin: approval.origin });
    if (why) {
        throw new AcceptError(`the approval does not verify (${why}); nothing was committed`);
    }
}

/**
 * Refuses a commit that holds a raw PNG where a Git LFS pointer belongs.
 * @param {string} tree the accept worktree, its HEAD the new commit
 * @param {{ path: string, to: string | null }[]} items the record items
 */
async function requireLfsPointers(tree, items) {
    for (const { path, to } of items) {
        if (!path.endsWith(".png") || to === null) {
            continue;
        }
        if (!isLfsPointer(Buffer.from(await git(tree, ["cat-file", "blob", `HEAD:${path}`])))) {
            throw new AcceptError(`${path} was committed as a raw PNG, not a Git LFS pointer: check .gitattributes`);
        }
    }
}

/**
 * Uploads the new images to Git LFS and pushes the accept commit.
 *
 * git lfs push reports progress only to a terminal, so the new images of a large Finish go up in
 * batches the page can count; the push of HEAD after them uploads whatever else the commit needs.
 * Images that fit one batch go up with that push alone: a batch of its own would only start
 * git-lfs, and its round trip to the LFS server, twice.
 * A local branch's accept commit is not pushed: the branch is moved to it (moveLocalBranch).
 * @param {{ repo?: string, target?: object, progress: (step: string) => void, net: Function }} input
 *     finish's repository, target, step reporter and network runner
 * @param {{ tree: string, writes: object[], branch: string, only?: { candidate: string, config: object } | null }} work
 *     the worktree, the writes, the branch to push to, and for a candidate its commit (requireAcceptOnly)
 * @returns {Promise<string>} the pushed commit
 */
async function pushAccepts({ repo, target, progress, net }, { tree, writes, branch, only = null }) {
    if (target?.localBranch) {
        return moveLocalBranch({ repo, progress, net }, { tree, branch });
    }
    if (only) {
        await requireAcceptOnly(tree, only.candidate, only.config);
    }
    const oids = [...new Set(writes.filter((w) => w.bytes).map((w) => w.item.capture))];
    for (let i = 0; oids.length > LFS_BATCH && i < oids.length; i += LFS_BATCH) {
        progress(`uploading images to LFS (${i} of ${oids.length} done)`);
        const batch = oids.slice(i, i + LFS_BATCH);
        await net("git lfs push", () => git(tree, ["lfs", "push", "--object-id", "origin", ...batch]));
    }
    progress("uploading images to LFS (checking the commit has them all)");
    await net("git lfs push", () => git(tree, ["lfs", "push", "origin", "HEAD"]));
    progress("pushing");
    const head = await git(tree, ["rev-parse", "HEAD"]);
    const lease = only ? await replaceable(tree, branch, head, only) : null;
    await net("git push", async (attempt) => {
        // A push whose connection dropped may have landed: a later attempt checks before pushing.
        const tip = attempt > 1 ? await git(tree, ["ls-remote", "origin", `refs/heads/${branch}`]) : "";
        if (tip.split("\t")[0] !== head) {
            const force = lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : [];
            await git(tree, ["push", "-q", "--no-verify", ...force, "origin", `HEAD:refs/heads/${branch}`]);
        }
    }).catch((err) => {
        // git's own advice ("git pull") is wrong here: the capture no longer matches the branch.
        if (!/\[rejected\].*\((fetch first|non-fast-forward)\)/.test(err.message)) {
            throw err;
        }
        const stale = new AcceptError(
            "capture is stale, wait for CI: the branch moved past the captured head while Finish ran; nothing was pushed",
        );
        // The branch moved: a change mode Finish may make its commit again on the new tip (pushChange).
        stale.raced = true;
        throw stale;
    });
    return head;
}

/**
 * Moves a local branch to the accept commit: where the branch is checked out, by a fast-forward
 * merge in that worktree (its files follow, and changes of its own that the merge does not touch
 * stay); elsewhere by updating the ref only if it is still the tip Finish read. A branch that
 * moved meanwhile is refused as stale, nothing changed. A branch with an upstream is then pushed
 * there; one without stays on this machine.
 * @param {{ repo: string, progress: (step: string) => void, net: Function }} input finish's
 *     repository, step reporter and network runner
 * @param {{ tree: string, branch: string }} work the accept worktree and the branch
 * @returns {Promise<string>} the commit the branch is at now
 */
async function moveLocalBranch({ repo, progress, net }, { tree, branch }) {
    progress(`moving ${branch}`);
    const head = await git(tree, ["rev-parse", "HEAD"]);
    const read = await git(repo, ["rev-parse", ownRef(branch)]);
    const tip = await git(repo, ["rev-parse", `refs/heads/${branch}`]);
    const stale = () => {
        const err = new AcceptError(
            `capture is stale: ${branch} moved past the captured commit while Finish ran; nothing was changed`,
        );
        err.raced = true;
        return err;
    };
    if (tip !== read) {
        throw stale();
    }
    const listed = await git(repo, ["worktree", "list", "--porcelain"]);
    const checkedOut = listed
        .split("\n\n")
        .map((block) => block.split("\n"))
        .find((lines) => lines.includes(`branch refs/heads/${branch}`));
    if (checkedOut) {
        // Its files are the reader's: written with the LFS filter, so images, not pointers.
        const where = checkedOut[0].slice("worktree ".length);
        await exec("git", ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "-q", head], { cwd: where }).catch(
            (err) => {
                throw new AcceptError(`${branch} could not take the accept commit in ${where}: ${err.message}`);
            },
        );
    } else {
        await git(repo, ["update-ref", `refs/heads/${branch}`, head, read]).catch(() => {
            throw stale();
        });
    }
    const remote = await git(repo, ["config", `branch.${branch}.remote`]).catch(() => "");
    const merge = await git(repo, ["config", `branch.${branch}.merge`]).catch(() => "");
    if (remote && merge) {
        progress(`pushing ${branch}`);
        await net("git lfs push", () => git(tree, ["lfs", "push", remote, "HEAD"]));
        await net("git push", () => git(tree, ["push", "-q", "--no-verify", remote, `HEAD:${merge}`])).catch((err) => {
            throw new AcceptError(`the accept commit is on ${branch}, but pushing it to ${remote} failed: ${err.message}`);
        });
    }
    return head;
}

/**
 * Whether a Finish's commit stays on this machine: a local branch with no upstream to push to.
 * @param {string} repo the repository
 * @param {{ localBranch?: boolean, branch?: string | null }} target as in finish
 * @returns {Promise<boolean>} whether it does
 */
async function pendingPush(repo, target) {
    if (!target.localBranch) {
        return false;
    }
    return (await git(repo, ["config", `branch.${target.branch}.merge`]).catch(() => "")) === "";
}

/**
 * The local branch a target finishes onto, or null.
 * @param {{ localBranch?: boolean, branch?: string | null }} target as in finish
 * @returns {string | null} it
 */
const localBranchOf = (target) => (target.localBranch ? target.branch : null);

/**
 * The accept worktree's name for a target.
 * @param {{ pr: number | null, localBranch?: boolean, branch?: string | null }} target as in finish
 * @returns {string} it
 */
const acceptTree = (target) =>
    `accept-${target.localBranch ? `branch-${target.branch.replace(/[^A-Za-z0-9._-]/g, "-")}` : (target.pr ?? "master")}`;

/**
 * Where Finish fetches a branch from: the repository itself for the local branch being finished,
 * origin for anything else (or the repository itself when it has no origin).
 * @param {string} repo the repository
 * @param {{ localBranch?: boolean, branch?: string | null } | undefined} target as in finish
 * @param {string} b the branch
 * @returns {Promise<string>} the remote
 */
async function remoteOf(repo, target, b) {
    if (target?.localBranch && b === target.branch) {
        return ".";
    }
    const remotes = await git(repo, ["remote"]).catch(() => "");
    return remotes.split("\n").includes("origin") ? "origin" : ".";
}

/**
 * Finish's fetcher: a branch into its own ref (ownRef), from where remoteOf says.
 * @param {string} repo the repository
 * @param {object} target as in finish
 * @param {Function} net the network runner
 * @returns {(b: string) => Promise<any>} it
 */
const fetcher = (repo, target, net) => async (b) => {
    const from = await remoteOf(repo, target, b);
    return net(`git fetch ${b}`, () =>
        git(repo, ["fetch", "-q", "--no-write-fetch-head", from, `+refs/heads/${b}:${ownRef(b)}`]),
    );
};

/**
 * The tip a candidate's push may replace: its branch as last fetched, when that holds nothing but
 * an earlier Finish's commits on the candidate. Null when there is none to replace.
 * @param {string} tree the accept worktree
 * @param {string} branch the candidate's branch
 * @param {string} head the commit about to be pushed
 * @param {{ candidate: string, config: object }} only the candidate and the settings
 * @returns {Promise<string | null>} the tip to lease
 */
async function replaceable(tree, branch, head, { candidate, config }) {
    const tip = await git(tree, ["rev-parse", "--verify", "-q", ownRef(branch)]).catch(() => "");
    if (tip === "" || tip === head || (await gitOk(tree, ["merge-base", "--is-ancestor", tip, head]))) {
        return null;
    }
    return (await candidateBranchOwned(tree, candidate, tip, config)) ? tip : null;
}

/**
 * Whether a candidate's branch holds nothing but Finish commits on the candidate and merges of the
 * default branch (an "Update branch" on its pull request): then a Finish may rebuild and replace it.
 * @param {string} repo the repository
 * @param {string} candidate the candidate
 * @param {string} tip the branch as fetched
 * @param {{ baselines: string, approvals: string, defaultBranch: string }} config the settings
 * @returns {Promise<boolean>} whether it does
 */
async function candidateBranchOwned(repo, candidate, tip, config) {
    if (!(await gitOk(repo, ["merge-base", "--is-ancestor", candidate, tip]))) {
        return false;
    }
    const range = [`${candidate}..${tip}`, `^${ownRef(config.defaultBranch)}`];
    const files = await git(repo, ["log", "--no-merges", "--no-renames", "--format=", "--name-only", ...range]).catch(
        () => null,
    );
    const inside = (f) => [config.baselines, config.approvals].some((d) => f.startsWith(`${d}/`));
    return files !== null && files.split("\n").filter(Boolean).every(inside);
}

/**
 * Opens the pull request that registers a passkey: the default branch's passkeys.json (created
 * when absent) with the entry appended, on a new branch. Merging it is the owner's trust step;
 * from then on the gate requires approvals.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {(args: string[], input?: string) => Promise<string>} [input.gh] the gh runner, wrapped into the GitHub code host when no `codeHost` is given
 * @param {import("./adapters/index.mjs").CodeHost} [input.codeHost] the code host the pull request
 *     is opened on; wins over `gh`
 * @param {{ id: string, publicKey: string, rpId: string, label: string, registeredAt: string }} input.entry
 *     the key, as verifyRegistration accepted it
 * @param {Date} [input.now] when
 * @param {{ defaultBranch: string, workDir: string, commitPrefix: string }} input.config the settings
 * @returns {Promise<{ branch: string, pullRequest: string, gated: boolean }>} the pushed branch, its
 *     pull request, and whether the visual gate fails it (the default branch already holds a key)
 */
export async function proposeKey({ repo, gh, codeHost = null, entry, now = new Date(), config }) {
    const { defaultBranch } = config;
    const tracking = `refs/visual-review/origin/${defaultBranch}`;
    const branch = `visual/passkey-${now.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+/, "")}`;
    const tree = join(repo, config.workDir, "worktrees", "passkey");
    let keys;
    try {
        await git(repo, ["fetch", "-q", "--no-write-fetch-head", "origin", `+refs/heads/${defaultBranch}:${tracking}`]);
        keys = await keysAt(repo, tracking);
        if (keys.some((k) => k.id === entry.id)) {
            throw new AcceptError("this passkey is already registered");
        }
        await removeWorktree(repo, tree);
        await git(repo, ["worktree", "add", "-q", "--detach", tree, tracking]);
        try {
            await put(
                join(tree, PASSKEYS_FILE),
                `${JSON.stringify({ version: 1, keys: [...keys, entry] }, null, 4)}\n`,
            );
            await git(tree, ["add", "--", PASSKEYS_FILE]);
            const message =
                `${config.commitPrefix}: register a visual review passkey\n\n` +
                `Adds the passkey "${entry.label}" for ${entry.rpId} (credential ${entry.id}).\n`;
            await git(tree, ["commit", "-q", "--no-verify", "-F", "-"], message);
            await git(tree, ["push", "-q", "--no-verify", "origin", `HEAD:refs/heads/${branch}`]);
        } finally {
            await removeWorktree(repo, tree).catch((err) =>
                console.error(`proofroom: could not remove the passkey worktree ${tree}: ${err.message}`),
            );
        }
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    }
    const gated = keys.length > 0;
    const pullRequest = await (codeHost ?? githubCodeHost(gh)).openChange({
        title: `${config.commitPrefix}: register a visual review passkey`,
        head: branch,
        base: defaultBranch,
        body: [
            `Registers the passkey "${entry.label}" for the review page on \`${entry.rpId}\`, credential id \`${entry.id}\`.`,
            "",
            gated
                ? `${PASSKEYS_FILE} on ${defaultBranch} already holds a key, so the visual gate fails this pull request: a new key is trusted only when an administrator merges it past the gate.`
                : `Merging this turns approval enforcement on: from then on the visual gate accepts changed baselines only when this passkey (or another key in \`${PASSKEYS_FILE}\` on ${defaultBranch}) signed their approval with Face ID or Touch ID.`,
            "Merge it only if you pressed Register passkey yourself just now and the review page showed this credential id.",
        ].join("\n"),
    });
    return { branch, pullRequest, gated };
}

/**
 * Whether the default branch holds a commit touching the project's baselines that `head` lacks.
 * @param {string} repo the repository, with the default branch fetched
 * @param {string} head the captured head
 * @param {string} project the project id
 * @param {{ defaultBranch: string, baselines: string }} config the settings
 * @param {string} [tracking] the fetched default branch
 * @returns {Promise<boolean>} true when a capture of `head` was not compared with the default
 *     branch's newest baselines for the project
 */
export async function behindMaster(
    repo,
    head,
    project,
    { defaultBranch, baselines },
    tracking = `refs/remotes/origin/${defaultBranch}`,
) {
    const newest = await git(repo, ["log", "-1", "--format=%H", tracking, "--", `${baselines}/${project}/`]);
    return newest !== "" && !(await gitOk(repo, ["merge-base", "--is-ancestor", newest, head]));
}

/**
 * The files under a project's baselines that the default branch changed since `head` forked from
 * it: what a capture of `head` was not compared with.
 * @param {string} repo the repository, with the default branch fetched
 * @param {string} head the captured head
 * @param {string} project the project id
 * @param {{ defaultBranch: string, baselines: string }} config the settings
 * @param {string} [tracking] the fetched default branch
 * @returns {Promise<string[]>} the files, relative to the project's baselines directory
 */
export async function newerOnMaster(
    repo,
    head,
    project,
    { defaultBranch, baselines },
    tracking = `refs/remotes/origin/${defaultBranch}`,
) {
    const dir = `${baselines}/${project}/`;
    const out = await git(repo, ["diff", "--name-only", "--no-renames", `${head}...${tracking}`, "--", dir]);
    return out
        .split("\n")
        .filter(Boolean)
        .map((p) => p.slice(dir.length));
}

/**
 * Update from the default branch: merges it into a pull request's branch (a merge commit, never a
 * rebase, so an accept commit stays as it was made) and pushes, so CI captures again against the
 * default branch's baselines. A conflicting file under the baselines directory takes the default
 * branch's side: its contents there are already approved, and whatever the pull request's capture
 * still shows differently comes back to the review as changed. Any other conflict refuses, naming
 * the files, and nothing is committed or pushed.
 *
 * When the merge changed a file outside the baselines directory and the config sets `updateCheck`,
 * that command runs in the merged worktree before the push; when it fails, nothing is pushed and
 * the branch stays where it was (the merge commit only ever existed in the throwaway worktree).
 *
 * The rule for a conflicting path under the baselines directory: a pointer both sides changed, a
 * pointer one side deleted and a settings file take the default branch's side (kept or deleted);
 * a project's `renames.json` is merged as a list of pairs against the version both started from,
 * the default branch's pair winning when both name the same old id, a pair it removed staying
 * removed, and its deletion of the file winning.
 *
 * It accepts nothing and writes no review record: a baseline that ends up as on the default
 * branch is no change for the gate, which diffs the pull request against its base.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {number} input.pr the pull request
 * @param {string} input.branch its branch
 * @param {{ defaultBranch: string, baselines: string, workDir: string, commitPrefix: string,
 *     updateCheck?: string | null }} input.config the settings
 * @param {(step: string) => void} [input.progress] told each step as it starts
 * @param {(projects: string[]) => Promise<Record<string, { items: { file: string,
 *     capture: string | null }[] } | null>>} [input.captures] the change's last capture
 *     (results.json) of each project named, null for a project with none; asked only for the
 *     projects with a conflicting snapshot, before anything is pushed
 * @returns {Promise<{ commit: string, branch: string, taken: string[], merged: string[],
 *     recapture: string[], report: { match: string[], decide: string[], unknown: string[] } }>}
 *     the pushed merge commit, the conflicting baseline files resolved (taking the default
 *     branch's side, or for the renames files in `merged` both sides' pairs), the baseline files the branch now has different from before (paths under the
 *     baselines directory), whose stories CI compares again, and the conflicting snapshots split
 *     by the change's last capture: equal to the default branch's image (nothing to decide),
 *     different (decide again), or not in any capture known
 */
export async function updateFromMaster({ repo, pr, branch, config, progress = () => {}, captures = async () => ({}) }) {
    const { baselines, defaultBranch } = config;
    const own = (b) => `refs/visual-review/origin/${b}`;
    const master = own(defaultBranch);
    try {
        if (!branch || !(await gitOk(repo, ["check-ref-format", `refs/heads/${branch}`]))) {
            throw new AcceptError(`no usable branch for #${pr}: ${branch}`);
        }
        progress("fetching");
        for (const b of [defaultBranch, branch]) {
            await git(repo, ["fetch", "-q", "--no-write-fetch-head", "origin", `+refs/heads/${b}:${own(b)}`]);
        }
        const head = await git(repo, ["rev-parse", own(branch)]);
        if (await gitOk(repo, ["merge-base", "--is-ancestor", master, head])) {
            throw new AcceptError(`${branch} already has everything on ${defaultBranch}: nothing to update`);
        }
        const tree = join(repo, config.workDir, "worktrees", `update-${pr}`);
        await removeWorktree(repo, tree);
        await git(repo, [...NO_LFS, "worktree", "add", "-q", "--detach", tree, head]);
        const work = (args, input) => git(tree, [...NO_LFS, ...args], input);
        const workOk = (args) => gitOk(tree, [...NO_LFS, ...args]);
        try {
            progress("merging");
            let conflicts = [];
            await work(["merge", "-q", "--no-ff", "--no-commit", master]).catch(async (err) => {
                conflicts = (await work(["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
                if (conflicts.length === 0) {
                    throw err;
                }
            });
            const outside = conflicts.filter((p) => !p.startsWith(`${baselines}/`));
            if (outside.length > 0) {
                throw new AcceptError(
                    `${branch} conflicts with ${defaultBranch} outside ${baselines}/, so nothing was changed; ` +
                        `merge ${defaultBranch} into it by hand: ${outside.join(", ")}`,
                );
            }
            const show = (rev, path) => work(["show", `${rev}:${path}`]).catch(() => null);
            const merged = [];
            const base = await git(repo, ["merge-base", head, master]);
            for (const path of conflicts) {
                const both =
                    isRenamesFile(path, baselines) &&
                    mergeRenames(await show(base, path), await show(head, path), await show(master, path));
                if (both) {
                    await writeFile(join(tree, path), both);
                    await work(["add", "--", path]);
                    merged.push(path);
                } else {
                    await ((await workOk(["cat-file", "-e", `${master}:${path}`]))
                        ? work(["checkout", master, "--", path])
                        : work(["rm", "-q", "--", path]));
                }
            }
            const report = await conflictReport(conflicts, { baselines, show: (p) => show(master, p), captures });
            const recapture = (await work(["diff", "--cached", "--name-only", "-z", head, "--", `${baselines}/`]))
                .split("\0")
                .filter((p) => p && !p.startsWith(`${baselines}/reviews/`));
            progress("committing");
            const taken =
                conflicts.length === 0
                    ? ["No conflicts."]
                    : [
                          `Takes ${defaultBranch}'s side for ${conflicts.length} conflicting baseline ${conflicts.length === 1 ? "file" : "files"}, ` +
                              "already approved there; CI captures them again and the review shows what still differs:",
                          "",
                          ...conflicts.map((p) => `- ${p}${merged.includes(p) ? " (both sides' renames merged)" : ""}`),
                      ];
            const message = [
                `${config.commitPrefix}: merge ${defaultBranch} into ${branch} for visual review`,
                "",
                `Updates #${pr} from ${defaultBranch} (proofroom update). It accepts nothing.`,
                ...taken,
                "",
            ].join("\n");
            await work(["commit", "-q", "--no-verify", "-F", "-"], message);
            if (
                config.updateCheck &&
                (await work(["diff", "--name-only", head, "HEAD", "--", ".", `:(exclude)${baselines}/`]))
            ) {
                progress("checking");
                await runUpdateCheck(config.updateCheck, tree, head).catch((err) => {
                    throw new AcceptError(
                        `the merge of ${defaultBranch} into ${branch} fails the update check: ${err.message}, ` +
                            `so nothing was pushed and ${branch} is as it was; merge ${defaultBranch} into it by hand and fix it` +
                            (err.tail ? `. The check's output ended:\n${err.tail}` : ""),
                    );
                });
            }
            progress("pushing");
            await work(["push", "-q", "--no-verify", "origin", `HEAD:refs/heads/${branch}`]).catch((err) => {
                throw /\[rejected\].*\((fetch first|non-fast-forward)\)/.test(err.message)
                    ? new AcceptError(`${branch} moved while it was being updated; nothing was pushed: update again`)
                    : err;
            });
            return { commit: await work(["rev-parse", "HEAD"]), branch, taken: conflicts, merged, recapture, report };
        } finally {
            await removeWorktree(repo, tree).catch((err) =>
                console.error(`proofroom: could not remove the update worktree ${tree}: ${err.message}`),
            );
        }
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    }
}

/**
 * Whether a path is a project's renames file, `<baselines>/<project>/renames.json`.
 * @param {string} path the path
 * @param {string} baselines the baselines directory
 * @returns {boolean} whether it is
 */
const isRenamesFile = (path, baselines) => /^[^/]+\/renames\.json$/.test(path.slice(baselines.length + 1));

/**
 * Two sides' renames files merged against the version both started from, as lists of
 * `{ from, to }` pairs: every pair of the default branch's, then the pairs the change added or
 * changed whose old id the default branch does not rename. A pair the default branch removed stays
 * removed. A side without the file counts as an empty list, except the default branch's: when it
 * deleted the file, its side (the deletion) is taken.
 * @param {string | null} common the file both sides started from
 * @param {string | null} mine the change's file
 * @param {string | null} theirs the default branch's file
 * @returns {string | null} the merged file, or null when the default branch has no file or a side
 *     is not a list (the default branch's side is then taken whole)
 */
function mergeRenames(common, mine, theirs) {
    if (theirs === null) {
        return null;
    }
    const list = (text) => {
        try {
            const v = text === null ? [] : JSON.parse(text);
            return Array.isArray(v) ? v : null;
        } catch {
            return null;
        }
    };
    const [o, a, b] = [list(common), list(mine), list(theirs)];
    if (o === null || a === null || b === null) {
        return null;
    }
    const before = new Set(o.map((r) => JSON.stringify(r)));
    const taken = new Set(b.map((r) => r?.from));
    const added = a.filter((r) => !before.has(JSON.stringify(r)) && !taken.has(r?.from));
    return `${JSON.stringify([...b, ...added], null, 4)}\n`;
}

/**
 * The conflicting snapshots of an update, split by whether the change's last capture already
 * equals the image the default branch now has: those need nothing once CI captures again, the
 * others a decision again. A snapshot absent on the default branch matches a capture without it.
 * @param {string[]} conflicts the conflicting paths
 * @param {object} input how to read them
 * @param {string} input.baselines the baselines directory
 * @param {(path: string) => Promise<string | null>} input.show the default branch's file, or null
 * @param {(projects: string[]) => Promise<Record<string, { items: { file: string,
 *     capture: string | null }[] } | null>>} input.captures the change's last captures
 * @returns {Promise<{ match: string[], decide: string[], unknown: string[] }>} the paths
 */
async function conflictReport(conflicts, { baselines, show, captures }) {
    const report = { match: [], decide: [], unknown: [] };
    const snapshots = conflicts
        .filter((p) => p.endsWith(".png") && !p.startsWith(`${baselines}/reviews/`))
        .map((path) => {
            const [project, ...rest] = path.slice(baselines.length + 1).split("/");
            return { path, project, file: rest.join("/") };
        });
    if (snapshots.length === 0) {
        return report;
    }
    const sets = await captures([...new Set(snapshots.map((s) => s.project))]);
    for (const { path, project, file } of snapshots) {
        const results = sets[project];
        if (!results) {
            report.unknown.push(path);
            continue;
        }
        const text = await show(path);
        // ponytail: reads the hash from an LFS pointer only; a baseline stored as a plain PNG never
        // matches, so it is listed as needing a decision, never as needing nothing.
        const theirs = text === null ? null : (/^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1] ?? "");
        const captured = results.items.find((i) => i.file === file)?.capture ?? null;
        report[captured === theirs ? "match" : "decide"].push(path);
    }
    return report;
}

/**
 * What an update says about its conflicting snapshots, as lines for a terminal or a log.
 * @param {{ match: string[], decide: string[], unknown: string[] }} report updateFromMaster's report
 * @param {string} defaultBranch the default branch
 * @returns {string[]} the lines; none when no snapshot conflicted
 */
export function updateReportLines({ match, decide, unknown }, defaultBranch) {
    const n = (k) => `${k} ${k === 1 ? "snapshot" : "snapshots"}`;
    const known = match.length + decide.length;
    return [
        ...(known === 0
            ? []
            : [
                  `${n(match.length)} ${match.length === 1 ? "matches" : "match"} ${defaultBranch} now and ` +
                      `${match.length === 1 ? "needs" : "need"} nothing; ` +
                      `${decide.length} ${decide.length === 1 ? "needs" : "need"} a decision again${decide.length > 0 ? ":" : "."}`,
                  ...decide.map((p) => `  ${p}`),
              ]),
        ...(unknown.length === 0
            ? []
            : [
                  `${n(unknown.length)} with no capture to compare with; CI's new capture shows whether they need a decision:`,
                  ...unknown.map((p) => `  ${p}`),
              ]),
    ];
}

/**
 * The files changed between two commits.
 * @param {string} repo the repository
 * @param {string} a the older commit
 * @param {string} b the newer one
 * @returns {Promise<string[]>} their paths
 */
const changedSince = async (repo, a, b) =>
    (await git(repo, ["diff", "-z", "--name-only", "--no-renames", a, b])).split("\0").filter(Boolean);

/**
 * Whether `tip` is `head` plus nothing but commits a Finish makes (its accept, approval and signing
 * commits): `head` is an ancestor, and every commit after it has one parent and changes nothing
 * outside the baselines and approvals directories. Such commits change no capture, so a capture
 * of `head` is still current for `tip`. Unknown commits (not fetched yet) count as no.
 * @param {string} repo the repository
 * @param {string} head the captured head
 * @param {string} tip the branch's tip
 * @param {{ baselines: string, approvals: string }} config the settings
 * @returns {Promise<boolean>} whether it is
 */
export async function onlyFinishCommits(repo, head, tip, config) {
    if (head === tip) {
        return true;
    }
    if (!(await gitOk(repo, ["merge-base", "--is-ancestor", head, tip]))) {
        return false;
    }
    const log = await git(repo, ["log", "-z", "--format=%x01%P", "--name-only", `${head}..${tip}`]).catch(() => null);
    if (log === null) {
        return false;
    }
    const inside = (f) => [config.baselines, config.approvals].some((d) => f.startsWith(`${d}/`));
    return log
        .split("\x01")
        .filter(Boolean)
        .every((record) => {
            const [parents, ...files] = record.split(/[\n\0]/).filter(Boolean);
            return !parents.includes(" ") && files.every(inside);
        });
}

/**
 * Why a Finish of a capture of `head` cannot be committed on the pull request's newer `tip`, or
 * null when it can: the tip holds the captured head, every file it changed since takes the default
 * branch's contents (a merge of the default branch, and nothing of the pull request's own), and
 * none of those files is one this Finish writes. The record still names what the owner saw at the
 * captured head; the gate replays its items from the base branch's contents and CI captures the new
 * commit, so an image the merge changed comes back for review.
 * @param {string} repo the repository, with the tip and the default branch fetched
 * @param {string} head the captured head
 * @param {string} tip the branch's tip
 * @param {string} tracking the fetched default branch
 * @param {string[]} paths the files this Finish writes or removes
 * @returns {Promise<string | null>} why not, or null
 */
async function masterMergeProblem(repo, head, tip, tracking, paths) {
    if (!(await gitOk(repo, ["merge-base", "--is-ancestor", head, tip]))) {
        return "the branch no longer holds the captured head";
    }
    const master = await git(repo, ["merge-base", tip, tracking]).catch(() => "");
    const diff = async (a, b) =>
        new Set((await git(repo, ["diff", "-z", "--name-only", "--no-renames", a, b])).split("\0").filter(Boolean));
    const since = await diff(head, tip);
    // A file the tip changed since the captured head that is not as the default branch has it.
    const own = master === "" ? [...since] : [...(await diff(master, tip))].filter((f) => since.has(f));
    if (own.length > 0) {
        return `it changed ${own[0]}${own.length > 1 ? ` and ${own.length - 1} more` : ""} since`;
    }
    const touched = paths.filter((p) => since.has(p));
    if (touched.length > 0) {
        return `the default branch changed ${touched[0]}, which this review decides, so review its new capture`;
    }
    return null;
}

/**
 * What the decisions write, computed from the captured commit, never from a worktree: prepareRecord
 * and the commit both use it, so the record approved and the record committed cannot drift.
 * @param {string} repo the repository
 * @param {string} base the captured commit
 * @param {object[]} writes the accepts and exclusions, with their results items (and, for the
 *     commit, an accept's verified bytes)
 * @param {string} baselines the baselines directory
 * @returns {Promise<{ items: { path: string, from: string | null, to: string | null,
 *     reason: string | null, movedFrom?: string, movedTo?: string }[], entries: object[],
 *     files: { path: string, bytes: Buffer | string | null }[],
 *     counts: { accept: number, exclude: number, remove: number } }>} the record items (two for a
 *     renamed story, whose baseline moves to its new name), the same decisions as change statement
 *     entries (rejects not among them), the files to write in order (null bytes delete), and the
 *     tallies for the commit message
 */
async function planWrites(repo, base, writes, baselines) {
    const items = [];
    const entries = [];
    const files = [];
    // A change statement's entry for the same decision: its path inside the baselines directory.
    const entry = (path, from, to, decision, reason, more = {}) =>
        entries.push({
            path: path.slice(baselines.length + 1),
            from,
            to,
            decision,
            ...(reason !== null && { reason }),
            ...more,
        });
    const counts = { accept: 0, exclude: 0, remove: 0 };
    // A settings file written earlier in this Finish (two modes of one story) is read as written.
    const written = new Map();
    const old = async (path) => (written.has(path) ? written.get(path) : await blobAt(repo, base, path));
    for (const w of writes) {
        const dir = `${baselines}/${w.project}`;
        if (w.decision === "exclude") {
            const path = `${dir}/${w.item.id}.json`;
            const before = await old(path);
            const settings = { ...(before ? JSON.parse(before) : {}), disableSnapshot: true, reason: w.reason };
            const bytes = `${JSON.stringify(settings, null, 2)}\n`;
            written.set(path, bytes);
            files.push({ path, bytes });
            counts.exclude++;
            items.push({ path, from: before && sha256(before), to: sha256(bytes), reason: `exclude: ${w.reason}` });
            entry(path, before && sha256(before), sha256(bytes), "exclude", w.reason);
            continue;
        }
        const path = `${dir}/${w.item.file}`;
        if (w.item.status === "removed") {
            files.push({ path, bytes: null });
            counts.remove++;
            items.push({ path, from: w.item.baseline, to: null, reason: w.reason });
            entry(path, w.item.baseline, null, "accept", w.reason);
            continue;
        }
        files.push({ path, bytes: w.bytes ?? null });
        counts.accept++;
        if (!w.item.from) {
            items.push({ path, from: w.item.baseline, to: w.item.capture, reason: w.reason, ...provenance(w) });
            entry(path, w.item.baseline, w.item.capture, "accept", w.reason);
            continue;
        }
        // A rename: the old id's baseline (of this mode) goes, the new one takes its place. For a
        // moved item the bytes are the same, so git sees a rename and the LFS pointer is unchanged.
        const oldPath = `${dir}/${w.item.mode === null ? w.item.from : `${w.item.from}.${w.item.mode}`}.png`;
        files.push({ path: oldPath, bytes: null });
        items.push(
            { path: oldPath, from: w.item.baseline, to: null, reason: w.reason, movedTo: path },
            { path, from: null, to: w.item.capture, reason: w.reason, movedFrom: oldPath },
        );
        const rel = (p) => p.slice(baselines.length + 1);
        entry(oldPath, w.item.baseline, null, "accept", w.reason, { movedTo: rel(path) });
        entry(path, null, w.item.capture, "accept", w.reason, { movedFrom: rel(oldPath) });
    }
    return { items, entries: mergeEntries(entries), files, counts };
}

/**
 * A file's exact bytes at a commit (git's output, untrimmed), or null when it has none.
 * @param {string} repo the repository
 * @param {string} ref the commit
 * @param {string} path the path
 * @returns {Promise<Buffer | null>} the bytes
 */
const blobAt = (repo, ref, path) =>
    new Promise((resolve) =>
        execFile("git", ["show", `${ref}:${path}`], { cwd: repo, encoding: "buffer", maxBuffer: 1 << 26 }, (err, out) =>
            resolve(err ? null : out),
        ),
    );

// An image the owner approved before for this story: the record item names where, and the gate
// checks that earlier approval before the item counts.
const provenance = (w) => (w.approvedBefore ? { approvedBefore: w.approvedBefore } : {});

// Two modes of one story excluded together write one settings file: keep one record item.
const dedupe = (items) => [...new Map(items.map((i) => [i.path, i])).values()];

// The same for a change statement, whose entry starts from the file the default branch side holds
// (the first write's `from`) and ends at the last write's `to`.
const mergeEntries = (entries) => {
    const byPath = new Map();
    for (const e of entries) {
        byPath.set(e.path, byPath.has(e.path) ? { ...e, from: byPath.get(e.path).from } : e);
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
};

async function put(path, data) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
}

/**
 * Runs the config's `updateCheck` shell command in the merged worktree, with the branch's head
 * before the merge in VISUAL_REVIEW_UPDATE_BASE. No time limit: a build takes as long as it takes.
 * @param {string} command the shell command
 * @param {string} cwd the worktree, at the merge commit
 * @param {string} base the branch's head before the merge
 * @returns {Promise<void>} resolves when it exits 0; rejects with its exit status, and the end of its
 *     output in the error's `tail`
 */
function runUpdateCheck(command, cwd, base) {
    return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], {
            cwd,
            env: { ...process.env, HUSKY: "0", VISUAL_REVIEW_UPDATE_BASE: base },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        const keep = (chunk) => {
            out = (out + chunk).slice(-8000);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                Object.assign(new Error(`\`${command}\` exited with ${signal ?? code}`), {
                    tail: out.trim().split("\n").slice(-20).join("\n"),
                }),
            );
        });
    });
}

async function removeWorktree(repo, tree) {
    if (existsSync(tree)) {
        // Twice: a server killed during `worktree add` leaves the tree locked ("initializing").
        await git(repo, ["worktree", "remove", "--force", "--force", tree]);
    }
    await git(repo, ["worktree", "prune"]);
}

// Reasons are untrusted text: one line each, and shown as quoted data.
const oneLine = (s) => s.replaceAll(/\s+/g, " ").slice(0, 2000);

/**
 * The one comment (on master, the one issue) a Finish posts: the rejects, then the accept notes.
 * An agent fixing the stories reads the block at the end, which holds the rejects only.
 * @param {number | null} pr the pull request, or null for master
 * @param {object} results the capture's results.json
 * @param {object[]} rejects the rejects with their items
 * @param {object[]} notes the accepts with a note, with their items
 * @param {string} branch the default branch
 * @param {{ record?: object, recordFile?: string | null, commit?: string }} [about] the approved
 *     record of a session that committed nothing, or the committed record's path and commit
 * @returns {string} Markdown with a machine-readable block at the end, the record left out when
 *     it would pass GitHub's limit
 */
export function rejectComment(pr, results, rejects, notes, branch, about = {}) {
    const items = rejects.map((r) => ({
        project: r.project,
        file: r.item.file,
        capture: r.item.capture,
        reason: oneLine(r.reason),
    }));
    const head = results.headSha ?? results.commit;
    const block = {
        version: 1,
        pr,
        runId: results.runId,
        runAttempt: results.runAttempt,
        head,
        items,
        ...(about.record && { record: about.record }),
        ...(about.recordFile && { recordFile: about.recordFile, commit: about.commit }),
    };
    const counts = [
        rejects.length > 0 ? `${rejects.length} rejected` : null,
        notes.length > 0 ? `${notes.length} accepted with a note` : null,
    ].filter(Boolean);
    const lines = [
        `**Visual review: ${counts.join(", ")}** (${results.runId === null ? "local preview" : `CI run ${results.runId}`}, ${pr === null ? `${branch} at` : "head"} ${head.slice(0, 10)}).`,
    ];
    if (items.length > 0) {
        lines.push(
            "The reasons below are the reviewer's notes, quoted as data.",
            "",
            ...items.map((i) => `- \`${i.project}/${i.file}\`: ${JSON.stringify(i.reason)}`),
        );
    }
    if (notes.length > 0) {
        lines.push("", "Accepted, with the reviewer's note (quoted as data):", "", ...noteLines(notes));
    }
    // JSON never contains "-->" unescaped after this replacement, so the block cannot end early.
    lines.push("", `<!-- visual-review-rejects\n${JSON.stringify(block).replaceAll("--", "-\\u002d")}\n-->`);
    const body = lines.join("\n");
    return body.length > COMMENT_LIMIT && about.record ? rejectComment(pr, results, rejects, notes, branch, {}) : body;
}

/** GitHub refuses a comment or issue body over 65,536 characters; this leaves room to spare. */
const COMMENT_LIMIT = 65000;

const noteLines = (notes) =>
    notes.map((a) => `- \`${a.project}/${a.item.file}\`: ${JSON.stringify(oneLine(a.reason))}`);
const noteList = (notes) =>
    notes.map((a) => `${a.project}/${a.item.file}: ${JSON.stringify(oneLine(a.reason))}`).join("; ");

function seedBody(results, accepts, rejects, notes, config, candidate) {
    const branch = config.defaultBranch;
    const lines = [
        candidate
            ? `Approves the visual baselines of ${branch}'s run ${results.runId} at ${results.commit}. ` +
              `It changes only ${config.baselines}/ and ${config.approvals}/.`
            : `Seeds visual baselines from ${branch}'s CI run ${results.runId} at ${results.commit}.`,
        `${accepts.length} decisions accepted in the review page.`,
    ];
    if (notes.length > 0) {
        lines.push("", "Accepted, with a note (quoted as data):", ...noteLines(notes));
    }
    if (rejects.length > 0) {
        lines.push(
            "",
            "Rejected, left without a baseline (reasons quoted as data):",
            ...rejects.map((r) => `- \`${r.project}/${r.item.file}\`: ${JSON.stringify(oneLine(r.reason))}`),
        );
    }
    // No candidate or seed has an issue of its own; a repository's pull request checks want a line saying so.
    lines.push("", "No issue");
    return lines.join("\n");
}
