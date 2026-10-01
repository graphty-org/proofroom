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
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { commentOnPullRequest, createIssue, createPullRequest, exec, postStatus } from "./github.mjs";
import { isLfsPointer } from "./compare.mjs";

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
 *     runId: number, runAttempt: number, record: string, prefix: string }} input what the commit
 *     holds, and the conventional-commit type and scope it starts with (`commitPrefix`)
 * @returns {string} a conventional commit message
 */
export function commitMessage({ pr, counts, runId, runAttempt, record, prefix }) {
    const subject = pr === null ? `${prefix}: seed visual baselines` : `${prefix}: accept visual baselines for #${pr}`;
    const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    return [
        subject,
        "",
        `Accepted in the review page: ${n(counts.accept, "image", "images")}, ` +
            `${n(counts.exclude, "exclusion", "exclusions")}, ${n(counts.remove, "removal", "removals")}.`,
        `Captured by CI run ${runId}, attempt ${runAttempt}.`,
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
}) {
    progress("checking");
    const { accepts, rejects } = check(projects, decisions);
    const first = (accepts[0] ?? rejects[0])?.capture.results;
    if (!first) {
        throw new AcceptError("nothing decided");
    }
    const isMaster = target.pr === null;
    const notes = accepts.filter((a) => a.decision === "accept" && a.reason !== null);

    let commit = null;
    let commentError = null;
    let branch = target.branch;
    let pullRequest = null;
    let issue = null;
    if (accepts.length > 0) {
        ({ commit, branch } = await commitAccepts({ repo, target, accepts, first, now, progress, config }));
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
            const body = rejectComment(target.pr, first, rejects, isMaster ? [] : notes, config.defaultBranch);
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
            if (rejects.length === 0) {
                // Only accept notes: the accepts stand, and the page says the notes were not posted.
                commentError = err.message;
            } else {
                const e = new AcceptError(
                    `the accepts were pushed as ${commit.slice(0, 10)}, but the reject comment failed: ${err.message}. ` +
                        "Press Finish again to post the rejects.",
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
        acceptNotes: comment || (isMaster && pullRequest) ? notes.length : 0,
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
 * Writes, commits and pushes the accepts. Every check runs before the worktree is created.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {{ pr: number | null, branch: string | null }} input.target as in finish
 * @param {object[]} input.accepts the checked accepts and exclusions
 * @param {object} input.first the results.json of the first decided project
 * @param {Date} input.now the review time
 * @param {(step: string) => void} input.progress as in finish
 * @param {object} input.config as in finish
 * @returns {Promise<{ commit: string, branch: string }>} the pushed commit and branch
 */
async function commitAccepts({ repo, target, accepts, first, now, progress, config }) {
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
                return { commit: await git(repo, ["rev-parse", own(branch)]), branch };
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
                `merge ${defaultBranch} into the branch first: ${defaultBranch} has newer ${project} baselines`,
            );
        }
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
        const items = [];
        const counts = { accept: 0, exclude: 0, remove: 0 };
        progress(`writing ${writes.length} ${writes.length === 1 ? "file" : "files"}`);
        for (const w of writes) {
            items.push(...(await write(tree, w, counts, baselines)));
        }
        const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
        const record = `${baselines}/reviews/${stamp}-${isMaster ? "master" : `pr${target.pr}`}.json`;
        const body = {
            version: 1,
            unproven: true,
            pr: target.pr,
            subject: {
                builtMerge: first.commit,
                head: first.headSha,
                runId: first.runId,
                runAttempt: first.runAttempt,
                environment: first.environment,
                scale: first.scale ?? 1,
            },
            items: dedupe(items).sort((a, b) => a.path.localeCompare(b.path)),
            reviewedAt: now.toISOString(),
        };
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
        return { commit: await git(tree, ["rev-parse", "HEAD"]), branch };
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
 * Writes one decision into the worktree.
 * @param {string} tree the worktree
 * @param {object} w the decision, its results item, and for an accept the verified bytes
 * @param {{ accept: number, exclude: number, remove: number }} counts tallied here
 * @param {string} baselines the baselines directory
 * @returns {Promise<{ path: string, from: string | null, to: string | null, reason: string | null,
 *     movedFrom?: string, movedTo?: string }[]>} its record items: two for a renamed story, whose
 *     baseline moves to its new name
 */
async function write(tree, w, counts, baselines) {
    const dir = `${baselines}/${w.project}`;
    if (w.decision === "exclude") {
        const path = `${dir}/${w.item.id}.json`;
        const old = await readFile(join(tree, path)).catch(() => null);
        const settings = { ...(old ? JSON.parse(old) : {}), disableSnapshot: true, reason: w.reason };
        const bytes = `${JSON.stringify(settings, null, 2)}\n`;
        await put(join(tree, path), bytes);
        counts.exclude++;
        return [{ path, from: old && sha256(old), to: sha256(bytes), reason: `exclude: ${w.reason}` }];
    }
    const path = `${dir}/${w.item.file}`;
    if (w.item.status === "removed") {
        await rm(join(tree, path), { force: true });
        counts.remove++;
        return [{ path, from: w.item.baseline, to: null, reason: w.reason }];
    }
    await put(join(tree, path), w.bytes);
    counts.accept++;
    if (!w.item.from) {
        return [{ path, from: w.item.baseline, to: w.item.capture, reason: w.reason }];
    }
    // A rename: the old id's baseline (of this mode) goes, the new one takes its place. For a
    // moved item the bytes are the same, so git sees a rename and the LFS pointer is unchanged.
    const oldPath = `${dir}/${w.item.mode === null ? w.item.from : `${w.item.from}.${w.item.mode}`}.png`;
    await rm(join(tree, oldPath), { force: true });
    return [
        { path: oldPath, from: w.item.baseline, to: null, reason: w.reason, movedTo: path },
        { path, from: null, to: w.item.capture, reason: w.reason, movedFrom: oldPath },
    ];
}

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
 * @returns {string} Markdown with a machine-readable block at the end
 */
function rejectComment(pr, results, rejects, notes, branch) {
    const items = rejects.map((r) => ({
        project: r.project,
        file: r.item.file,
        capture: r.item.capture,
        reason: oneLine(r.reason),
    }));
    const head = results.headSha ?? results.commit;
    const block = { version: 1, pr, runId: results.runId, runAttempt: results.runAttempt, head, items };
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
    return lines.join("\n");
}

const noteLines = (notes) =>
    notes.map((a) => `- \`${a.project}/${a.item.file}\`: ${JSON.stringify(oneLine(a.reason))}`);

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
