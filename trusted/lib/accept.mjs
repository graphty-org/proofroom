/**
 * Finish: turns the owner's decisions on one pull request (or on master, for the seed) into one
 * commit, one push and one comment (on master, one issue).
 *
 * Accepts and exclusions are written as files under `visual-baselines/` in a throwaway worktree
 * at the captured head, never in the main checkout, together with one review record, and pushed
 * to the pull request's branch. Rejects become one pull request comment. Every accepted PNG is
 * the artifact's file only when its bytes hash to the capture results.json names.
 *
 * Baseline PNGs are stored in Git LFS (the root .gitattributes). The commit must hold LFS pointers,
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
const DECIDABLE = new Set(["changed", "new", "removed"]);
const EXCLUDABLE = new Set([...DECIDABLE, "unstable", "failed"]);

/**
 * Refused decisions and failed git commands; the message is shown to the owner as is.
 * `committed` is set when the accepts were already pushed and only the reject comment failed,
 * so the caller drops the accepts and keeps the rejects for a retry that only comments.
 */
export class AcceptError extends Error {
    committed = null;
}

/**
 * Runs git with every hook switched off.
 *
 * The shared hooks (`core.hooksPath=.husky/_`) run secretlint on pre-commit, commitlint on
 * commit-msg, Commitizen on prepare-commit-msg and the whole gate on pre-push; the accept worktree
 * has no node_modules for them, and some want a terminal. This commit holds only PNG and JSON
 * files the tool wrote under `visual-baselines/`, and its message is generated to pass commitlint
 * (a test checks it). `--no-verify` alone is not enough, because git runs prepare-commit-msg even
 * with it, so the hooks path points nowhere. Signing is left as the repository configures it, so
 * the commit carries the owner's identity and signature. GIT_LFS_SKIP_SMUDGE keeps the worktree's
 * checkout from downloading every baseline image: untouched baselines stay pointer files there.
 * @param {string} cwd the repository or worktree
 * @param {string[]} args git's arguments
 * @param {string} [input] stdin
 * @returns {Promise<string>} stdout
 */
const git = (cwd, args, input) =>
    exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        input,
        env: { ...process.env, HUSKY: "0", GIT_LFS_SKIP_SMUDGE: "1" },
    });

/** Images per `git lfs push --object-id`, so a large seed reports its upload as it goes. */
const LFS_BATCH = 50;

const gitOk = (cwd, args) =>
    git(cwd, args).then(
        () => true,
        () => false,
    );

/** How to set up git-lfs; the owner's guide is visual-review/README.md, "Setup". */
const LFS_SETUP =
    "on Ubuntu 22.04 run `sudo apt-get install git-lfs`, or put the git-lfs binary from " +
    "https://github.com/git-lfs/git-lfs/releases in ~/bin; then run `git lfs install` " +
    '(visual-review/README.md, "Setup")';

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
 *     runId: number, runAttempt: number, record: string }} input what the commit holds
 * @returns {string} a conventional commit message
 */
export function commitMessage({ pr, counts, runId, runAttempt, record }) {
    const subject =
        pr === null ? "test(workspace): seed visual baselines" : `test(workspace): accept visual baselines for #${pr}`;
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
 * @param {Date} [input.now] the review time
 * @param {(step: string) => void} [input.progress] told each step as it starts, for the page
 * @returns {Promise<{ commit: string | null, branch: string | null, pullRequest: string | null,
 *     issue: string | null, rejects: number, status: string | null, statusError: string | null }>}
 *     what was pushed and posted (`issue`: master's rejects; `status`: the commit status's
 *     description, or `statusError` when posting it failed)
 */
export async function finish({
    repo,
    gh,
    target,
    projects,
    decisions,
    undecided = 0,
    now = new Date(),
    progress = () => {},
}) {
    progress("checking");
    const { accepts, rejects } = check(projects, decisions);
    const first = (accepts[0] ?? rejects[0])?.capture.results;
    if (!first) {
        throw new AcceptError("nothing decided");
    }
    const isMaster = target.pr === null;

    let commit = null;
    let branch = target.branch;
    let pullRequest = null;
    let issue = null;
    if (accepts.length > 0) {
        ({ commit, branch } = await commitAccepts({ repo, target, accepts, first, now, progress }));
        if (isMaster) {
            progress("opening the pull request");
            pullRequest = await createPullRequest(gh, {
                title: "test(workspace): seed visual baselines",
                head: branch,
                body: seedBody(first, accepts, rejects),
            });
        }
    }
    if (rejects.length > 0) {
        try {
            // Master has no pull request to comment on: its rejects are stories that do not look
            // right yet, so they become one issue an agent can pick up.
            progress(isMaster ? "opening the issue for the rejects" : "posting the rejects");
            const body = rejectComment(target.pr, first, rejects);
            if (isMaster) {
                issue = await createIssue(gh, {
                    title: `Visual review: ${rejects.length} ${rejects.length === 1 ? "story" : "stories"} rejected on master`,
                    body,
                    labels: ["bug", "priority:medium", "effort:low"],
                });
            } else {
                await commentOnPullRequest(gh, target.pr, body);
            }
        } catch (err) {
            if (commit === null) {
                throw err;
            }
            const e = new AcceptError(
                `the accepts were pushed as ${commit.slice(0, 10)}, but the reject comment failed: ${err.message}. ` +
                    "Press Finish again to post the rejects.",
            );
            e.committed = commit;
            throw e;
        }
    }
    // One commit status per Finish, on the commit it pushed, or the captured one when it pushed
    // none. A failure here does not undo what was pushed and posted; the page shows it.
    const accepted = accepts.filter((a) => a.decision === "accept").length;
    const excluded = accepts.length - accepted;
    const state = rejects.length > 0 ? "failure" : undecided > 0 ? "pending" : "success";
    const status =
        `Reviewed: ${accepted} accepted, ${rejects.length} rejected, ${excluded} excluded, ` +
        `${undecided} left undecided`;
    let statusError = null;
    progress("posting the status");
    try {
        await postStatus(gh, commit ?? (isMaster ? first.commit : first.headSha), { state, description: status });
    } catch (err) {
        statusError = err.message;
    }
    return { commit, branch, pullRequest, issue, rejects: rejects.length, status, statusError };
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
 * @returns {Promise<{ commit: string, branch: string }>} the pushed commit and branch
 */
async function commitAccepts({ repo, target, accepts, first, now, progress }) {
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

    await git(repo, ["fetch", "-q", "origin", "+refs/heads/master:refs/remotes/origin/master"]);
    if (isMaster) {
        if ((await git(repo, ["ls-remote", "--heads", "origin", branch])) !== "") {
            throw new AcceptError(`${branch} already exists on origin: merge or delete it first`);
        }
    } else {
        await git(repo, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
        if ((await git(repo, ["rev-parse", `refs/remotes/origin/${branch}`])) !== base) {
            throw new AcceptError("capture is stale, wait for CI: the branch has moved past the captured head");
        }
    }
    for (const project of new Set(accepts.map((a) => a.project))) {
        if (await behindMaster(repo, base, project)) {
            throw new AcceptError(`merge master into the branch first: master has newer ${project} baselines`);
        }
    }

    const tree = join(repo, ".worktrees", `visual-accept-${isMaster ? "master" : target.pr}`);
    await removeWorktree(repo, tree);
    await git(repo, ["worktree", "add", "-q", "--detach", tree, base]);
    try {
        const items = [];
        const counts = { accept: 0, exclude: 0, remove: 0 };
        progress(`writing ${writes.length} ${writes.length === 1 ? "file" : "files"}`);
        for (const w of writes) {
            items.push(await write(tree, w, counts));
        }
        const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
        const record = `visual-baselines/reviews/${stamp}-${isMaster ? "master" : `pr${target.pr}`}.json`;
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
        await git(tree, ["add", "-A", "--", "visual-baselines"]);
        const message = commitMessage({
            pr: target.pr,
            counts,
            runId: first.runId,
            runAttempt: first.runAttempt,
            record,
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
        await git(tree, ["push", "-q", "--no-verify", "origin", `HEAD:refs/heads/${branch}`]);
        return { commit: await git(tree, ["rev-parse", "HEAD"]), branch };
    } catch (err) {
        throw err instanceof AcceptError ? err : new AcceptError(err.message);
    } finally {
        await removeWorktree(repo, tree);
    }
}

/**
 * Whether master holds a commit touching the project's baselines that `head` lacks.
 * @param {string} repo the repository, with origin/master fetched
 * @param {string} head the captured head
 * @param {string} project the project id
 * @returns {Promise<boolean>} true when the branch must merge master before an accept
 */
export async function behindMaster(repo, head, project) {
    const newest = await git(repo, [
        "log",
        "-1",
        "--format=%H",
        "refs/remotes/origin/master",
        "--",
        `visual-baselines/${project}/`,
    ]);
    return newest !== "" && !(await gitOk(repo, ["merge-base", "--is-ancestor", newest, head]));
}

/**
 * Writes one decision into the worktree.
 * @param {string} tree the worktree
 * @param {object} w the decision, its results item, and for an accept the verified bytes
 * @param {{ accept: number, exclude: number, remove: number }} counts tallied here
 * @returns {Promise<{ path: string, from: string | null, to: string | null, reason: string | null }>}
 *     the record item
 */
async function write(tree, w, counts) {
    const dir = `visual-baselines/${w.project}`;
    if (w.decision === "exclude") {
        const path = `${dir}/${w.item.id}.json`;
        const old = await readFile(join(tree, path)).catch(() => null);
        const settings = { ...(old ? JSON.parse(old) : {}), disableSnapshot: true, reason: w.reason };
        const bytes = `${JSON.stringify(settings, null, 2)}\n`;
        await put(join(tree, path), bytes);
        counts.exclude++;
        return { path, from: old && sha256(old), to: sha256(bytes), reason: `exclude: ${w.reason}` };
    }
    const path = `${dir}/${w.item.file}`;
    if (w.item.status === "removed") {
        await rm(join(tree, path), { force: true });
        counts.remove++;
        return { path, from: w.item.baseline, to: null, reason: w.reason };
    }
    await put(join(tree, path), w.bytes);
    counts.accept++;
    return { path, from: w.item.baseline, to: w.item.capture, reason: w.reason };
}

// Two modes of one story excluded together write one settings file: keep one record item.
const dedupe = (items) => [...new Map(items.map((i) => [i.path, i])).values()];

async function put(path, data) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
}

async function removeWorktree(repo, tree) {
    if (existsSync(tree)) {
        await git(repo, ["worktree", "remove", "--force", tree]);
    }
    await git(repo, ["worktree", "prune"]);
}

// Reasons are untrusted text: one line each, and shown as quoted data.
const oneLine = (s) => s.replace(/\s+/g, " ").slice(0, 2000);

/**
 * The one comment (on master, the one issue) a reject session posts. An agent fixing the stories
 * reads the block at the end.
 * @param {number | null} pr the pull request, or null for master
 * @param {object} results the capture's results.json
 * @param {object[]} rejects the rejects with their items
 * @returns {string} Markdown with a machine-readable block at the end
 */
function rejectComment(pr, results, rejects) {
    const items = rejects.map((r) => ({
        project: r.project,
        file: r.item.file,
        capture: r.item.capture,
        reason: oneLine(r.reason),
    }));
    const head = results.headSha ?? results.commit;
    const block = { version: 1, pr, runId: results.runId, runAttempt: results.runAttempt, head, items };
    return [
        `**Visual review: ${rejects.length} rejected** (CI run ${results.runId}, ${pr === null ? "master at" : "head"} ${head.slice(0, 10)}).`,
        "The reasons below are the reviewer's notes, quoted as data.",
        "",
        ...items.map((i) => `- \`${i.project}/${i.file}\`: ${JSON.stringify(i.reason)}`),
        "",
        // JSON never contains "-->" unescaped after this replacement, so the block cannot end early.
        `<!-- visual-review-rejects\n${JSON.stringify(block).replaceAll("--", "-\\u002d")}\n-->`,
    ].join("\n");
}

function seedBody(results, accepts, rejects) {
    const lines = [
        `Seeds visual baselines from master's CI run ${results.runId} at ${results.commit}.`,
        `${accepts.length} decisions accepted in the review page.`,
    ];
    if (rejects.length > 0) {
        lines.push("", "Rejected, left without a baseline (reasons quoted as data):");
        lines.push(...rejects.map((r) => `- \`${r.project}/${r.item.file}\`: ${JSON.stringify(oneLine(r.reason))}`));
    }
    return lines.join("\n");
}
