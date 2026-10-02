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
 * Once a passkey is known, the record is version 2 and approved: `prepareRecord` builds it before
 * any worktree exists, the owner's device signs its hash, and Finish commits only a record that
 * hashes to exactly what was signed, after checking the approval once more with the gate's own
 * code (approval.mjs). `proposeKey` opens the pull request that registers a passkey.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PASSKEYS_FILE, parsePasskeys, recordHash, verifyApproval } from "./approval.mjs";
import { commentOnPullRequest, createIssue, createPullRequest, exec, postStatus } from "./github.mjs";
import { isLfsPointer } from "./compare.mjs";
import { reviewGaps } from "../gate.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

/** Images per `git lfs push --object-id`, so a large seed reports its upload as it goes. */
const LFS_BATCH = 50;

const gitOk = (cwd, args) =>
    git(cwd, args).then(
        () => true,
        () => false,
    );

/** How to set up git-lfs; the README of @graphty/visual-review, "Requirements", has more. */
const LFS_SETUP =
    "on Ubuntu 22.04 run `sudo apt-get install git-lfs`, or put the git-lfs binary from " +
    "https://github.com/git-lfs/git-lfs/releases in ~/bin; then run `git lfs install` " +
    '(the @graphty/visual-review README, "Requirements")';

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
 * @param {{ pr: number | null, counts: { accept: number, exclude: number, remove: number },
 *     runId: number, runAttempt: number, record: string, prefix: string,
 *     legacy?: { items: object[], drop: string[] } | null }} input what the commit holds, the
 *     conventional-commit type and scope it starts with (`commitPrefix`), and the approvals from
 *     before passkeys it signs again
 * @returns {string} a conventional commit message
 */
export function commitMessage({ pr, counts, runId, runAttempt, record, prefix, legacy = null }) {
    const subject = pr === null ? `${prefix}: seed visual baselines` : `${prefix}: accept visual baselines for #${pr}`;
    const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    return [
        subject,
        "",
        `Accepted in the review page: ${n(counts.accept, "image", "images")}, ` +
            `${n(counts.exclude, "exclusion", "exclusions")}, ${n(counts.remove, "removal", "removals")}.`,
        `Captured by CI run ${runId}, attempt ${runAttempt}.`,
        ...(legacy
            ? [
                  `Signed again: ${n(legacy.items.length, "file", "files")} approved before passkeys.`,
                  ...legacy.drop.map((d) => `Removed the unsigned record ${d}, which the gate refuses.`),
              ]
            : []),
        `Record: ${record}`,
        "",
    ].join("\n");
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
 * Checks every decision against its results.json and sorts it into accepts and rejects.
 * @param {Record<string, { dir: string, results: object }>} projects the captures, by project
 * @param {{ project: string, file: string, decision: string, reason: string | null }[]} decisions
 *     the owner's decisions
 * @returns {{ accepts: object[], rejects: object[] }} each with its results item attached
 */
function check(projects, decisions) {
    const accepts = [];
    const rejects = [];
    for (const d of decisions) {
        const capture = Object.hasOwn(projects, d.project) ? projects[d.project] : undefined;
        const item = capture?.results.items.find((i) => i.file === d.file);
        if (!item) {
            throw new AcceptError(`${d.project}/${d.file} is not in this capture`);
        }
        if (capture.results.local !== null || capture.results.runId === null) {
            throw new AcceptError(`${d.project} is a local preview, not acceptable: only CI captures are`);
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
 * @param {Function} input.gh the gh runner
 * @param {{ pr: number | null, branch: string | null }} input.target a pull request and its
 *     branch, or `{ pr: null }` for master
 * @param {Record<string, { dir: string, results: object }>} input.projects the downloaded captures
 * @param {{ project: string, file: string, decision: string, reason: string | null }[]} input.decisions
 *     what the owner decided: accept, reject or exclude (checked here)
 * @param {number} [input.undecided] how many reviewable items are left undecided, for the status
 * @param {string[]} [input.unloaded] the projects whose capture did not load, so nobody reviewed them
 * @param {Date} [input.now] the review time
 * @param {(step: string) => void} [input.progress] told each step as it starts, for the page
 * @param {ReturnType<typeof import("./config.mjs").normalizeConfig>} input.config the settings
 * @param {{ record: object, pendingKeys?: object[], origin: string } | null} [input.approval] the
 *     record prepareRecord built, with the owner's `approval`, the keys registered but not yet on
 *     the default branch, and the page's origin; without it the record is version 1 (no key known)
 * @param {{ items: object[], drop: string[] } | null} [input.legacy] approvals from before
 *     passkeys to sign again (only with an approval), as legacyApprovals returns
 * @returns {Promise<{ commit: string | null, branch: string | null, pullRequest: string | null,
 *     issue: string | null, rejects: number, acceptNotes: number, state: string, status: string | null,
 *     statusError: string | null, commentError: string | null }>} what was pushed and posted
 *     (`issue`: master's rejects; `acceptNotes`: the accept notes published, in the comment or the
 *     seed pull request's description; `state` and `status`: the commit status's state and
 *     description, or `statusError` when posting it failed; `commentError` when a comment holding
 *     only accept notes failed after the accepts were pushed)
 */
export async function finish({
    repo,
    gh,
    target,
    projects,
    decisions,
    undecided = 0,
    unloaded = [],
    now = new Date(),
    progress = () => {},
    config,
    approval = null,
    legacy = null,
}) {
    progress("checking");
    const { accepts, rejects } = check(projects, decisions);
    // Approvals from before passkeys are signed again only with a passkey.
    legacy = approval ? legacy : null;
    const first = (accepts[0] ?? rejects[0])?.capture.results ?? (legacy && firstCapture(projects));
    if (!first) {
        throw new AcceptError("nothing decided");
    }
    const isMaster = target.pr === null;
    const notes = accepts.filter((a) => a.decision === "accept" && a.reason !== null);

    let commit = null;
    let commentError = null;
    let record = null;
    let branch = target.branch;
    let pullRequest = null;
    let issue = null;
    if (accepts.length > 0 || legacy) {
        ({ commit, branch, record } = await commitAccepts({
            repo,
            target,
            accepts,
            rejects,
            first,
            now,
            progress,
            config,
            approval,
            legacy,
        }));
        if (isMaster) {
            progress("opening the pull request");
            try {
                pullRequest = await createPullRequest(gh, {
                    title: `${config.commitPrefix}: seed visual baselines`,
                    head: branch,
                    base: config.defaultBranch,
                    body: seedBody(first, accepts, rejects, notes, config.defaultBranch),
                });
            } catch (err) {
                const e = new AcceptError(
                    `${branch} was pushed as ${commit.slice(0, 10)}, but opening its pull request failed: ` +
                        `${err.message}. Press Finish again to open it.`,
                );
                e.committed = commit;
                e.pullRequestMissing = true;
                throw e;
            }
        }
    }
    // On a pull request, one comment holds the rejects and the accept notes; on master the accept
    // notes are in the seed pull request's description, and only rejects open the issue.
    const comment = isMaster ? rejects.length > 0 : rejects.length > 0 || notes.length > 0;
    if (comment) {
        try {
            // Master has no pull request to comment on: its rejects are stories that do not look
            // right yet, so they become one issue an agent can pick up.
            progress(isMaster ? "opening the issue for the rejects" : "posting the comment");
            // A committed record is named, not copied: a large one would pass GitHub's 65,536
            // character limit. A session of rejects alone commits nothing, so its record goes here.
            const body = rejectComment(
                target.pr,
                first,
                rejects,
                isMaster ? [] : notes,
                config.defaultBranch,
                commit === null ? { record: approval?.record } : { recordFile: record, commit },
            );
            if (isMaster) {
                issue = await createIssue(gh, {
                    title: `Visual review: ${rejects.length} ${rejects.length === 1 ? "story" : "stories"} rejected on ${config.defaultBranch}`,
                    body,
                    labels: config.issueLabels,
                });
            } else {
                await commentOnPullRequest(gh, target.pr, body);
            }
        } catch (err) {
            if (commit === null) {
                throw err;
            }
            // The accepts are pushed and cleared, so their notes are never posted again: name them.
            // On master the notes are already in the seed pull request's description.
            const lost =
                isMaster || notes.length === 0
                    ? ""
                    : ` These accept notes were not posted and are not kept: ${noteList(notes)}.`;
            if (rejects.length === 0) {
                // Only accept notes: the accepts stand, and the page says the notes were not posted.
                commentError = `${err.message}.${lost}`;
            } else {
                const withNotes =
                    isMaster || notes.length === 0
                        ? ""
                        : ` and ${notes.length === 1 ? "1 accept note" : `${notes.length} accept notes`}`;
                const opened = isMaster && pullRequest ? ` and opened ${pullRequest}` : "";
                const e = new AcceptError(
                    `the accepts were pushed as ${commit.slice(0, 10)}${opened}, but the ` +
                        `${isMaster ? "issue" : "comment"} with the rejects${withNotes} failed: ${err.message}. ` +
                        `Press Finish again to post the rejects.${lost}`,
                );
                e.committed = commit;
                throw e;
            }
        }
    }
    // One commit status per Finish, on the commit it pushed, or the captured one when it pushed
    // none. A failure here does not undo what was pushed and posted; the page shows it.
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
        await postStatus(gh, commit ?? (isMaster ? first.commit : first.headSha), { state, description: status });
    } catch (err) {
        statusError = err.message;
    }
    return {
        commit,
        branch,
        pullRequest,
        issue,
        rejects: rejects.length,
        acceptNotes: (comment && commentError === null) || (isMaster && pullRequest) ? notes.length : 0,
        state,
        status,
        statusError,
        commentError,
    };
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
    const state = rejected > 0 ? "failure" : undecided > 0 || unloaded.length > 0 ? "pending" : "success";
    const description =
        `Reviewed: ${accepted} accepted, ${rejected} rejected, ${excluded} excluded, ` +
        `${undecided} left undecided${unloaded.length > 0 ? `, not loaded: ${unloaded.join(", ")}` : ""}`;
    return { state, description };
}

/**
 * Approvals a pull request carries from before passkeys: the review records it added that the
 * gate refuses (version 1, unsigned), and the baseline changes those records covered that no
 * counted record accounts for. Uses the gate's own calculation, so a signed Finish covers exactly
 * the files the gate reports, and only files an earlier review of this pull request accepted --
 * a change nobody reviewed still has to be decided in the page.
 * @param {object} input the work
 * @param {string} input.repo the repository, with the head and the default branch fetched
 * @param {number | null} input.pr the pull request; null (master) never has any
 * @param {string} input.head the captured head of the pull request
 * @param {string} input.base the default branch's tip, as fetched
 * @param {{ baselines: string }} input.config the settings
 * @returns {{ items: object[], drop: string[] } | null} the record items to sign (base branch
 *     contents to head contents) and the refused records to remove, or null when there are none;
 *     a file the default branch changed after the branch left it is not offered (update the branch)
 */
export function legacyApprovals({ repo, pr, head, base, config }) {
    if (pr === null) {
        return null;
    }
    const run = (args) => execFileSync("git", args, { cwd: repo, maxBuffer: 1 << 26 });
    let keys;
    try {
        keys = parsePasskeys(run(["show", `${base}:${PASSKEYS_FILE}`]).toString("utf8"));
    } catch {
        return null; // no key on the default branch: the gate checks no approvals
    }
    // From where the branch left the default branch, so the default branch's later changes are not
    // counted as this pull request's. The gate compares with the default branch's tip, so a file
    // the default branch changed since then is left out: it needs the branch updated first.
    let fork;
    try {
        fork = run(["merge-base", base, head]).toString("utf8").trim();
    } catch {
        return null;
    }
    const blob = (ref, path) => {
        try {
            return run(["rev-parse", `${ref}:${path}`])
                .toString("utf8")
                .trim();
        } catch {
            return null;
        }
    };
    const { refused, missing: all } = reviewGaps(fork, head, repo, config.baselines, { keys, pr });
    const missing = fork === base ? all : all.filter((m) => blob(fork, m.path) === blob(base, m.path));
    const covered = new Set();
    const drop = [];
    for (const path of refused) {
        let record = null;
        try {
            record = JSON.parse(run(["show", `${head}:${path}`]).toString("utf8"));
        } catch {
            // unreadable: removed below like any refused record, and it covers nothing
        }
        if (record !== null && record.version !== 1) {
            continue; // only unsigned records from before passkeys are signed again
        }
        drop.push(path);
        for (const item of Array.isArray(record?.items) ? record.items : []) {
            if (typeof item?.path === "string") {
                covered.add(item.path);
            }
        }
    }
    const items = missing
        .filter((m) => m.path !== PASSKEYS_FILE && covered.has(m.path))
        .map((m) => ({ path: m.path, from: m.from, to: m.to, reason: "approved before passkeys; signed again" }));
    return items.length + drop.length > 0 ? { items, drop } : null;
}

/**
 * A Finish's record items with the legacy ones added: a file decided in this Finish too keeps its
 * decision, taken from the base branch's contents (what the gate compares) rather than from the
 * unsigned approval's.
 * @param {object[]} items the decided items
 * @param {{ items: object[] } | null} legacy as legacyApprovals returns
 * @returns {object[]} the items to record
 */
function withLegacy(items, legacy) {
    if (!legacy) {
        return items;
    }
    const old = new Map(legacy.items.map((i) => [i.path, i]));
    const out = items.map((i) => (old.has(i.path) ? { ...i, from: old.get(i.path).from } : i));
    const decided = new Set(items.map((i) => i.path));
    return [...out, ...legacy.items.filter((i) => !decided.has(i.path))];
}

/**
 * The version 2 record a Finish of these decisions will commit, without its approval, built before
 * any worktree exists so the owner's device can sign its hash.
 * @param {object} input the work
 * @param {string} input.repo the repository, with the captured head fetched
 * @param {{ pr: number | null, branch: string | null }} input.target as in finish
 * @param {Record<string, { dir: string, results: object }>} input.projects as in finish
 * @param {object[]} input.decisions as in finish
 * @param {Date} input.now the review time, which becomes the record's `reviewedAt`
 * @param {{ baselines: string }} input.config the settings
 * @param {{ items: object[], drop: string[] } | null} [input.legacy] approvals from before
 *     passkeys to sign again, as legacyApprovals returns
 * @returns {Promise<{ record: object, accepts: number, excludes: number, rejects: number }>} the
 *     record and what it holds, counted as Finish's commit status counts them
 */
export async function prepareRecord({ repo, target, projects, decisions, now, config, legacy = null }) {
    const { accepts, rejects } = check(projects, decisions);
    const first = (accepts[0] ?? rejects[0])?.capture.results ?? (legacy && firstCapture(projects));
    if (!first) {
        throw new AcceptError("nothing decided");
    }
    const base = target.pr === null ? first.commit : first.headSha;
    if (accepts.length > 0 && !(await gitOk(repo, ["cat-file", "-e", `${base}^{commit}`]))) {
        throw new AcceptError("the captured commit is not fetched here yet: reload the page and press Finish again");
    }
    const { items } = await planWrites(repo, base, accepts, config.baselines);
    return {
        record: buildRecord({
            version: 2,
            target,
            first,
            items: withLegacy(items, legacy),
            rejects,
            now,
            baselines: config.baselines,
        }),
        accepts: accepts.filter((a) => a.decision === "accept").length,
        excludes: accepts.filter((a) => a.decision !== "accept").length,
        rejects: rejects.length,
    };
}

/**
 * A review record.
 * @param {object} input what it records
 * @param {1 | 2} input.version 1 while no passkey is known, 2 for an approved record
 * @param {{ pr: number | null }} input.target the pull request, or null for master
 * @param {object} input.first the results.json of the first decided project
 * @param {object[]} input.items the record items planWrites made
 * @param {object[]} input.rejects the checked rejects
 * @param {Date} input.now the review time
 * @param {string} input.baselines the baselines directory
 * @returns {object} the record, without `approval`
 */
function buildRecord({ version, target, first, items, rejects, now, baselines }) {
    const byPath = (a, b) => a.path.localeCompare(b.path);
    return {
        version,
        ...(version === 1 && { unproven: true }),
        pr: target.pr,
        subject: {
            builtMerge: first.commit,
            head: first.headSha,
            runId: first.runId,
            runAttempt: first.runAttempt,
            environment: first.environment,
            scale: first.scale ?? 1,
        },
        items: dedupe(items).sort(byPath),
        ...(version === 2 && {
            rejects: rejects
                .map((r) => ({
                    path: `${baselines}/${r.project}/${r.item.file}`,
                    capture: r.item.capture ?? r.item.baseline ?? null,
                    reason: r.reason,
                }))
                .sort(byPath),
        }),
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
 * @param {{ pr: number | null, branch: string | null }} input.target as in finish
 * @param {object[]} input.accepts the checked accepts and exclusions
 * @param {object[]} input.rejects the checked rejects, for a version 2 record
 * @param {object} input.first the results.json of the first decided project
 * @param {Date} input.now the review time
 * @param {(step: string) => void} input.progress as in finish
 * @param {object} input.config as in finish
 * @param {{ record: object, pendingKeys?: object[], origin: string } | null} input.approval as in finish
 * @param {{ items: object[], drop: string[] } | null} [input.legacy] as in finish
 * @returns {Promise<{ commit: string, branch: string, record: string | null }>} the pushed commit
 *     and branch, and the record's path (null for a seed pushed earlier and reused)
 */
async function commitAccepts({
    repo,
    target,
    accepts,
    rejects,
    first,
    now,
    progress,
    config,
    approval,
    legacy = null,
}) {
    const { baselines, defaultBranch } = config;
    // Finish fetches into refs of its own, never the remote-tracking refs a page reload fetches
    // into at the same time (two fetches of one ref fail on its lock).
    const own = (b) => `refs/visual-review/origin/${b}`;
    const fetch = (b) => git(repo, ["fetch", "-q", "--no-write-fetch-head", "origin", `+refs/heads/${b}:${own(b)}`]);
    const tracking = own(defaultBranch);
    const isMaster = target.pr === null;
    const lfs = await lfsProblem(repo);
    if (lfs) {
        throw new AcceptError(lfs);
    }
    const base = isMaster ? first.commit : first.headSha;
    for (const { capture } of accepts) {
        const r = capture.results;
        if ((isMaster ? r.commit : r.headSha) !== base || r.runId !== first.runId) {
            throw new AcceptError("the projects of one Finish must come from one CI run");
        }
    }
    const branch = isMaster ? `visual/seed-${now.toISOString().slice(0, 10)}` : target.branch;
    if (!branch || !(await gitOk(repo, ["check-ref-format", `refs/heads/${branch}`]))) {
        throw new AcceptError(`no usable branch for this target: ${branch}`);
    }

    // Read and verify every new file before git is touched.
    const writes = [];
    for (const a of accepts) {
        if (a.decision === "accept" && a.item.status !== "removed") {
            const bytes = await readFile(join(a.capture.dir, a.item.file));
            if (sha256(bytes) !== a.item.capture) {
                throw new AcceptError(`${a.project}/${a.item.file} does not match the capture results.json names`);
            }
            writes.push({ ...a, bytes });
        } else {
            writes.push(a);
        }
    }

    await fetch(defaultBranch);
    if (isMaster) {
        if ((await git(repo, ["ls-remote", "--heads", "origin", branch])) !== "") {
            // A seed this tool pushed whose pull request failed to open is used as it is.
            // ponytail: assumes the decisions did not change since that push; compare the trees if
            // they can.
            await fetch(branch);
            const [subject, parent] = (await git(repo, ["log", "-1", "--format=%s%n%P", own(branch)])).split("\n");
            if (subject === `${config.commitPrefix}: seed visual baselines` && parent === base) {
                return { commit: await git(repo, ["rev-parse", own(branch)]), branch, record: null };
            }
            throw new AcceptError(`${branch} already exists on origin: merge or delete it first`);
        }
    } else {
        await fetch(branch);
        if ((await git(repo, ["rev-parse", own(branch)])) !== base) {
            throw new AcceptError("capture is stale, wait for CI: the branch has moved past the captured head");
        }
    }
    for (const project of new Set(accepts.map((a) => a.project))) {
        if (await behindMaster(repo, base, project, config, tracking)) {
            throw new AcceptError(
                `merge ${defaultBranch} into the branch first: ${defaultBranch} has newer ${project} baselines; ` +
                    `press "Update from ${defaultBranch}" on the review page, or run \`visual-review update ${target.pr}\``,
            );
        }
    }

    // The items come from the captured commit, as prepareRecord's did: the record built here must
    // hash to exactly what the owner approved.
    const plan = await planWrites(repo, base, writes, baselines);
    const body = buildRecord({
        version: approval ? 2 : 1,
        target,
        first,
        items: withLegacy(plan.items, legacy),
        rejects,
        now,
        baselines,
    });
    if (approval && !recordHash(body).equals(recordHash(approval.record))) {
        throw new AcceptError("the record changed after you approved it; press Finish again");
    }

    const tree = join(repo, config.workDir, "worktrees", `accept-${isMaster ? "master" : target.pr}`);
    await removeWorktree(repo, tree);
    await git(repo, ["worktree", "add", "-q", "--detach", tree, base]);
    try {
        // A seed may be built on a commit older than the rule that stores baselines in Git LFS.
        // Carry the default branch's .gitattributes into it, so the PNGs become pointers and the
        // seed merges back with the same rule.
        const rules = isMaster ? await git(repo, ["show", `${tracking}:.gitattributes`]).catch(() => "") : "";
        if (rules !== "") {
            await put(join(tree, ".gitattributes"), `${rules}\n`);
            await git(tree, ["add", "--", ".gitattributes"]);
        }
        const { items, counts } = plan;
        progress(`writing ${writes.length} ${writes.length === 1 ? "file" : "files"}`);
        for (const f of plan.files) {
            await (f.bytes === null ? rm(join(tree, f.path), { force: true }) : put(join(tree, f.path), f.bytes));
        }
        // The unsigned records this pull request added count for nothing, and the gate fails while
        // they are on the branch; the signed record replaces them.
        for (const path of legacy?.drop ?? []) {
            if (!path.startsWith(`${baselines}/reviews/`) || (await blobAt(repo, tracking, path)) !== null) {
                throw new AcceptError(
                    `${path} is not an unsigned record this pull request added; nothing was committed`,
                );
            }
            await rm(join(tree, path), { force: true });
        }
        const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
        const record = `${baselines}/reviews/${stamp}-${isMaster ? "master" : `pr${target.pr}`}.json`;
        if (approval) {
            // The gate's own check, on the bytes about to be committed, with the default branch's
            // keys as just fetched and the keys this server registered.
            const keys = [...(await keysAt(repo, tracking)), ...(approval.pendingKeys ?? [])];
            const why = verifyApproval({ ...body, approval: approval.record.approval }, keys, {
                origin: approval.origin,
            });
            if (why) {
                throw new AcceptError(`the approval does not verify (${why}); nothing was committed`);
            }
            body.approval = approval.record.approval;
        }
        await put(join(tree, record), `${JSON.stringify(body, null, 2)}\n`);
        progress("committing");
        await git(tree, ["add", "-A", "--", baselines]);
        const message = commitMessage({
            pr: target.pr,
            counts,
            runId: first.runId,
            runAttempt: first.runAttempt,
            record,
            prefix: config.commitPrefix,
            legacy,
        });
        await git(tree, ["commit", "-q", "--no-verify", "-F", "-"], message);
        for (const { path, to } of items) {
            if (
                path.endsWith(".png") &&
                to !== null &&
                !isLfsPointer(Buffer.from(await git(tree, ["cat-file", "blob", `HEAD:${path}`])))
            ) {
                throw new AcceptError(
                    `${path} was committed as a raw PNG, not a Git LFS pointer: check .gitattributes`,
                );
            }
        }
        // git lfs push reports progress only to a terminal, so the new images go up in batches the
        // page can count; the push of HEAD after them uploads whatever else the commit needs.
        const oids = [...new Set(writes.filter((w) => w.bytes).map((w) => w.item.capture))];
        for (let i = 0; i < oids.length; i += LFS_BATCH) {
            progress(`uploading images to LFS (${i} of ${oids.length} done)`);
            await git(tree, ["lfs", "push", "--object-id", "origin", ...oids.slice(i, i + LFS_BATCH)]);
        }
        progress("uploading images to LFS (checking the commit has them all)");
        await git(tree, ["lfs", "push", "origin", "HEAD"]);
        progress("pushing");
        await git(tree, ["push", "-q", "--no-verify", "origin", `HEAD:refs/heads/${branch}`]).catch((err) => {
            // git's own advice ("git pull") is wrong here: the capture no longer matches the branch.
            throw /\[rejected\].*\((fetch first|non-fast-forward)\)/.test(err.message)
                ? new AcceptError(
                      "capture is stale, wait for CI: the branch moved past the captured head while Finish ran; nothing was pushed",
                  )
                : err;
        });
        return { commit: await git(tree, ["rev-parse", "HEAD"]), branch, record };
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    } finally {
        // A cleanup failure must not hide what was pushed; the next Finish removes the tree.
        await removeWorktree(repo, tree).catch((err) =>
            console.error(`visual-review: could not remove the accept worktree ${tree}: ${err.message}`),
        );
    }
}

/**
 * Opens the pull request that registers a passkey: the default branch's passkeys.json (created
 * when absent) with the entry appended, on a new branch. Merging it is the owner's trust step;
 * from then on the gate requires approvals.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {Function} input.gh the gh runner
 * @param {{ id: string, publicKey: string, rpId: string, label: string, registeredAt: string }} input.entry
 *     the key, as verifyRegistration accepted it
 * @param {Date} [input.now] when
 * @param {{ defaultBranch: string, workDir: string, commitPrefix: string }} input.config the settings
 * @returns {Promise<{ branch: string, pullRequest: string, gated: boolean }>} the pushed branch, its
 *     pull request, and whether the visual gate fails it (the default branch already holds a key)
 */
export async function proposeKey({ repo, gh, entry, now = new Date(), config }) {
    const { defaultBranch } = config;
    const tracking = `refs/visual-review/origin/${defaultBranch}`;
    const branch = `visual/passkey-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}`;
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
                console.error(`visual-review: could not remove the passkey worktree ${tree}: ${err.message}`),
            );
        }
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    }
    const gated = keys.length > 0;
    const pullRequest = await createPullRequest(gh, {
        title: `${config.commitPrefix}: register a visual review passkey`,
        head: branch,
        base: defaultBranch,
        body: [
            `Registers the passkey "${entry.label}" for the review page on \`${entry.rpId}\`, credential id \`${entry.id}\`.`,
            "",
            gated
                ? `${PASSKEYS_FILE} on ${defaultBranch} already holds a key, so the visual gate fails this pull request: a new key is trusted only when an administrator merges it past the gate.`
                : `Merging this turns approval enforcement on: from then on the visual gate accepts a review record a pull request adds only when this passkey (or another key in \`${PASSKEYS_FILE}\` on ${defaultBranch}) approved it with Face ID or Touch ID.`,
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
 * @returns {Promise<boolean>} true when the branch must merge the default branch before an accept
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
 * It accepts nothing and writes no review record: a baseline that ends up as on the default
 * branch is no change for the gate, which diffs the pull request against its base.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {number} input.pr the pull request
 * @param {string} input.branch its branch
 * @param {{ defaultBranch: string, baselines: string, workDir: string, commitPrefix: string }} input.config
 *     the settings
 * @param {(step: string) => void} [input.progress] told each step as it starts
 * @returns {Promise<{ commit: string, branch: string, taken: string[], recapture: string[] }>} the
 *     pushed merge commit, the conflicting baseline files that took the default branch's side, and
 *     the baseline files the branch now has different from before (paths under the baselines
 *     directory), whose stories CI compares again
 */
export async function updateFromMaster({ repo, pr, branch, config, progress = () => {} }) {
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
        await git(repo, ["worktree", "add", "-q", "--detach", tree, head]);
        try {
            progress("merging");
            let conflicts = [];
            await git(tree, ["merge", "-q", "--no-ff", "--no-commit", master]).catch(async (err) => {
                conflicts = (await git(tree, ["diff", "--name-only", "-z", "--diff-filter=U"]))
                    .split("\0")
                    .filter(Boolean);
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
            for (const path of conflicts) {
                await ((await gitOk(tree, ["cat-file", "-e", `${master}:${path}`]))
                    ? git(tree, ["checkout", master, "--", path])
                    : git(tree, ["rm", "-q", "--", path]));
            }
            const recapture = (await git(tree, ["diff", "--cached", "--name-only", "-z", head, "--", `${baselines}/`]))
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
                          ...conflicts.map((p) => `- ${p}`),
                      ];
            const message = [
                `${config.commitPrefix}: merge ${defaultBranch} into ${branch} for visual review`,
                "",
                `Updates #${pr} from ${defaultBranch} (visual-review update). It accepts nothing.`,
                ...taken,
                "",
            ].join("\n");
            await git(tree, ["commit", "-q", "--no-verify", "-F", "-"], message);
            progress("pushing");
            await git(tree, ["push", "-q", "--no-verify", "origin", `HEAD:refs/heads/${branch}`]).catch((err) => {
                throw /\[rejected\].*\((fetch first|non-fast-forward)\)/.test(err.message)
                    ? new AcceptError(`${branch} moved while it was being updated; nothing was pushed: update again`)
                    : err;
            });
            return { commit: await git(tree, ["rev-parse", "HEAD"]), branch, taken: conflicts, recapture };
        } finally {
            await removeWorktree(repo, tree).catch((err) =>
                console.error(`visual-review: could not remove the update worktree ${tree}: ${err.message}`),
            );
        }
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    }
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
 *     reason: string | null, movedFrom?: string, movedTo?: string }[],
 *     files: { path: string, bytes: Buffer | string | null }[],
 *     counts: { accept: number, exclude: number, remove: number } }>} the record items (two for a
 *     renamed story, whose baseline moves to its new name), the files to write in order (null
 *     bytes delete), and the tallies for the commit message
 */
async function planWrites(repo, base, writes, baselines) {
    const items = [];
    const files = [];
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
            continue;
        }
        const path = `${dir}/${w.item.file}`;
        if (w.item.status === "removed") {
            files.push({ path, bytes: null });
            counts.remove++;
            items.push({ path, from: w.item.baseline, to: null, reason: w.reason });
            continue;
        }
        files.push({ path, bytes: w.bytes ?? null });
        counts.accept++;
        if (!w.item.from) {
            items.push({ path, from: w.item.baseline, to: w.item.capture, reason: w.reason });
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
    }
    return { items, files, counts };
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

// The results.json a Finish with nothing decided reports on: its first loaded project's.
const firstCapture = (projects) => Object.values(projects).find((p) => p?.results)?.results ?? null;

// Two modes of one story excluded together write one settings file: keep one record item.
const dedupe = (items) => [...new Map(items.map((i) => [i.path, i])).values()];

async function put(path, data) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
}

async function removeWorktree(repo, tree) {
    if (existsSync(tree)) {
        // Twice: a server killed during `worktree add` leaves the tree locked ("initializing").
        await git(repo, ["worktree", "remove", "--force", "--force", tree]);
    }
    await git(repo, ["worktree", "prune"]);
}

// Reasons are untrusted text: one line each, and shown as quoted data.
const oneLine = (s) => s.replace(/\s+/g, " ").slice(0, 2000);

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
        `**Visual review: ${counts.join(", ")}** (CI run ${results.runId}, ${pr === null ? `${branch} at` : "head"} ${head.slice(0, 10)}).`,
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

function seedBody(results, accepts, rejects, notes, branch) {
    const lines = [
        `Seeds visual baselines from ${branch}'s CI run ${results.runId} at ${results.commit}.`,
        `${accepts.length} decisions accepted in the review page.`,
    ];
    if (notes.length > 0) {
        lines.push("", "Accepted, with a note (quoted as data):", ...noteLines(notes));
    }
    if (rejects.length > 0) {
        lines.push("", "Rejected, left without a baseline (reasons quoted as data):");
        lines.push(...rejects.map((r) => `- \`${r.project}/${r.item.file}\`: ${JSON.stringify(oneLine(r.reason))}`));
    }
    return lines.join("\n");
}
