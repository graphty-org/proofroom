/**
 * Everything the review page needs from GitHub, through the `gh` CLI with the reviewer's login:
 * open pull requests, the CI run for a head, the `visual` job's outcome, the capture artifacts,
 * and the comment, issue and pull request that a Finish writes. CI uses one of these too: a pull
 * request's capture downloads master's newest capture with `newestMasterCapture`.
 *
 * Only `gh api` and `gh run download` are used, because they exist in every gh release still in
 * use (Ubuntu 22.04 ships gh 2.4, which lacks `gh run list --commit` and most `--json` fields).
 * `{owner}/{repo}` is filled in by gh from the repository's remote.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { SKIPPED_FILE, validateResults } from "./results.mjs";

/**
 * Runs a program and resolves with its trimmed stdout. A program that runs longer than
 * VISUAL_REVIEW_TIMEOUT_MS (10 minutes by default) is killed: a gh or git call that stalls on a
 * dead network, or waits on a prompt nobody sees, would otherwise hold the page or Finish forever.
 * @param {string} cmd the program
 * @param {string[]} args its arguments
 * @param {{ cwd?: string, input?: string, env?: object }} [options] stdin and environment
 * @returns {Promise<string>} stdout; rejects with an Error whose message is the program's stderr
 */
export function exec(cmd, args, { cwd, input, env } = {}) {
    const timeout = Number(process.env.VISUAL_REVIEW_TIMEOUT_MS) || 600000;
    return new Promise((resolve, reject) => {
        // SIGTERM (the default) lets git remove its lock files as it exits.
        const options = { cwd, env, encoding: /** @type {const} */ ("utf8"), maxBuffer: 64 << 20, timeout };
        const child = execFile(cmd, args, options, (err, out, stderr) => {
            if (err?.killed) {
                reject(new Error(`${cmd} ${args.join(" ")} timed out after ${timeout / 1000} s and was stopped`));
            } else if (err) {
                reject(new Error(stderr.trim() || err.message));
            } else {
                resolve(out.trim());
            }
        });
        // A program that exits without reading stdin closes the pipe; its exit status reports that.
        child.stdin.on("error", () => {});
        child.stdin.end(input ?? "");
    });
}

/**
 * The real gh, run in the repository so `{owner}/{repo}` resolves.
 * @param {string} cwd the repository
 * @returns {(args: string[], input?: string) => Promise<string>} runs gh and returns its stdout
 */
export const ghRunner = (cwd) => withRetries((args, input) => exec("gh", args, { cwd, input }));

// How gh and git report a network that failed (DNS, a dropped or refused connection, a transfer
// cut short) or a GitHub server error. A 4xx, an authentication failure, a rejected push, a
// missing artifact or any other error is real and is never retried.
export const NETWORK =
    /could not resolve host|no such host|error connecting to|connection (reset|refused|timed out)|i\/o timeout|TLS handshake timeout|HTTP 5\d\d|returned error: 5\d\d|unexpected EOF|GOAWAY|stream error|context deadline exceeded/i;

// The network failures that happen before a request reaches GitHub (gh's "error connecting to" is
// its DNS failure), so even a write that is not safe to repeat can be sent again.
export const UNSENT = /could not resolve host|no such host|error connecting to|connection refused/i;

// A gh read is also retried after exec stopped it for running too long.
const TRANSIENT = new RegExp(`${NETWORK.source}|timed out after`, "i");

/**
 * The gh and git calls waiting to retry after a network failure, newest last, each with its error, which
 * try it waits for and until when: the review page shows the newest, so a dropped DNS lookup reads
 * as "retrying" and never as a hang.
 * @type {Set<{ error: string, attempt: number, of: number, until: number }>}
 */
export const retrying = new Set();

/** Milliseconds before each retry of a call that failed on the network. */
export const RETRY_DELAYS = [2000, 5000, 15000];

/**
 * Runs `run` again, after each delay in turn, while it fails on the network. Every failure and
 * retry is logged to stderr, so the server's log shows what happened.
 * @template T
 * @param {(attempt: number) => Promise<T>} run the call; `attempt` counts from 1, so a step that
 *     may have landed before its connection dropped can check that on a later attempt
 * @param {object} options how
 * @param {string} options.label the call, for the log
 * @param {number[]} [options.delays] milliseconds before each retry
 * @param {RegExp} [options.on] the errors to retry: gh reads' transient failures by default,
 *     NETWORK, or UNSENT for a write that is not safe to repeat
 * @param {(wait: { error: string, attempt: number, of: number, until: number }) => void} [options.onRetry]
 *     told before each wait
 * @returns {Promise<T>} what `run` returned
 */
export async function retryOnNetwork(run, { label, delays = RETRY_DELAYS, on = TRANSIENT, onRetry = () => {} }) {
    for (let i = 0; ; i++) {
        try {
            return await run(i + 1);
        } catch (err) {
            const retry = i < delays.length && on.test(err.message);
            const next = retry ? `; retrying in ${delays[i] / 1000} s` : "";
            console.error(`proofroom: ${label} failed${next}: ${err.message}`);
            if (!retry) {
                throw err;
            }
            const wait = {
                error: err.message.split("\n")[0],
                attempt: i + 2,
                of: delays.length + 1,
                until: Date.now() + delays[i],
            };
            retrying.add(wait);
            onRetry(wait);
            await new Promise((resolve) => setTimeout(resolve, delays[i]));
            retrying.delete(wait);
        }
    }
}

/**
 * Retries a gh runner's calls that failed on the network, after each delay in turn. A write
 * (`--input`) is never retried here: GitHub may have applied it before the connection dropped
 * (Finish retries its own writes where that is safe).
 * @param {(args: string[], input?: string) => Promise<string>} gh the gh runner
 * @param {number[]} [delays] milliseconds before each retry
 * @returns {(args: string[], input?: string) => Promise<string>} the retrying runner
 */
export const withRetries =
    (gh, delays = RETRY_DELAYS) =>
    (args, input) =>
        // gh's arguments never hold a token (gh keeps its own login), so they are logged whole.
        retryOnNetwork(() => gh(args, input), {
            label: `gh ${args.join(" ")}`,
            delays: args.includes("--input") ? [] : delays,
        });

const api = async (gh, path) => JSON.parse(await gh(["api", path]));

// GitHub Actions' app id: check suites are asked only of it, so the runs below them stay few.
const ACTIONS_APP_ID = 15368;

// Every open pull request with its author and its head commit's check suites of GitHub Actions,
// one page of 100 at a time. A check suite carries its workflow run, and its newest check runs
// (the jobs, by name), so the list shows each project's capture job without a call per pull
// request. GraphQL has no run attempt, so the caller asks REST for a run only when it changed since
// the previous refresh (serve.mjs). The query costs 12 points by GitHub's formula (one request per
// connection page: 1 + 100 + 100 + 1,000, divided by 100); the narrowing filters keep it there.
const PULLS_QUERY = `query($owner: String!, $name: String!, $after: String, $appId: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url headRefName headRefOid isDraft
        author { login }
        commits(last: 1) { nodes { commit { checkSuites(first: 10, filterBy: { appId: $appId }) { nodes {
          databaseId status conclusion
          workflowRun { databaseId url updatedAt workflow { resourcePath } }
          checkRuns(first: 50, filterBy: { checkType: LATEST }) { nodes { name status conclusion } }
        } } } } }
      }
    }
  }
}`;

/**
 * The capture jobs among a check suite's runs, by project: only runs named `visual (<project>)`.
 * @param {{ checkRuns?: { nodes: { name: string, status: string, conclusion: string | null }[] } }} suite
 *     the check suite
 * @returns {Record<string, { status: string, conclusion: string | null }> | null} each project's job,
 *     lowercase as REST spells it; null when GitHub gave no runs (the caller asks the jobs instead)
 */
function visualRuns(suite) {
    const runs = suite.checkRuns?.nodes ?? [];
    const visual = runs.flatMap((r) => {
        const m = /^visual \((.+)\)$/.exec(r.name);
        return m ? [[m[1], { status: r.status.toLowerCase(), conclusion: r.conclusion?.toLowerCase() ?? null }]] : [];
    });
    return visual.length > 0 ? Object.fromEntries(visual) : null;
}

/**
 * Open pull requests, newest first, each with the newest run of the capturing workflow on its head
 * commit, in one GraphQL query per 100 pull requests: one REST call per pull request spent about
 * 1,500 of the account's 5,000 calls an hour with 50 of them open.
 * @param {Function} gh the gh runner
 * @param {{ workflow: string, ignoreBranches?: string[] }} config the workflow file that captures (the
 *     config's `workflow`), and the branch-name prefixes whose pull requests are left out
 * @returns {Promise<{ number: number, title: string, url: string, headSha: string, branch: string, draft: boolean,
 *     author: string | null, run: { id: number, status: string, conclusion: string | null, updatedAt: string } | null,
 *     visual: Record<string, { status: string, conclusion: string | null }> | null }[]>}
 *     the pull requests; `run` is null when CI never ran on the head, and its status and
 *     conclusion are lowercase, as REST spells them; `visual` is each project's capture job in
 *     that run (visualRuns)
 */
export async function openPullRequests(gh, { workflow, ignoreBranches = [] }) {
    const out = [];
    for (let after = null; ;) {
        const args = [
            "api",
            "graphql",
            "-F",
            "owner={owner}",
            "-F",
            "name={repo}",
            "-F",
            `appId=${ACTIONS_APP_ID}`,
            "-f",
            `query=${PULLS_QUERY}`,
        ];
        if (after) {
            args.push("-f", `after=${after}`);
        }
        const page = JSON.parse(await gh(args)).data.repository.pullRequests;
        for (const p of page.nodes) {
            if (ignoreBranches.some((prefix) => p.headRefName.startsWith(prefix))) {
                continue;
            }
            const suites = (p.commits.nodes[0]?.commit.checkSuites.nodes ?? []).filter((s) =>
                s.workflowRun?.workflow.resourcePath.endsWith(`/${workflow}`),
            );
            const newest = suites.reduce((a, b) => (b.databaseId > (a?.databaseId ?? -1) ? b : a), null);
            out.push({
                number: p.number,
                title: p.title,
                url: p.url,
                headSha: p.headRefOid,
                branch: p.headRefName,
                draft: p.isDraft === true,
                // null for a deleted account ("ghost").
                author: p.author?.login ?? null,
                run: newest && {
                    id: newest.workflowRun.databaseId,
                    status: newest.status.toLowerCase(),
                    conclusion: newest.conclusion?.toLowerCase() ?? null,
                    updatedAt: newest.workflowRun.updatedAt,
                },
                visual: newest && visualRuns(newest),
            });
        }
        if (!page.pageInfo.hasNextPage) {
            return out;
        }
        after = page.pageInfo.endCursor;
    }
}

const toRun = (r) => ({
    id: r.id,
    attempt: r.run_attempt,
    status: r.status,
    conclusion: r.conclusion,
    url: r.html_url,
    headSha: r.head_sha,
    updatedAt: r.updated_at ?? null,
});

/**
 * The newest run of the capturing workflow for a head commit.
 * @param {Function} gh the gh runner
 * @param {string} sha the pull request's head
 * @param {{ workflow: string }} config the workflow file that captures (the config's `workflow`)
 * @returns {Promise<object | null>} the run, or null when CI never ran on it
 */
export async function newestCiRun(gh, sha, { workflow }) {
    const { workflow_runs: runs } = await api(
        gh,
        `repos/{owner}/{repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=1`,
    );
    return runs.length > 0 ? toRun(runs[0]) : null;
}

/**
 * One run by id.
 * @param {Function} gh the gh runner
 * @param {number} id the run id
 * @returns {Promise<object>} the run
 */
export const getRun = async (gh, id) => toRun(await api(gh, `repos/{owner}/{repo}/actions/runs/${id}`));

/**
 * The `visual` matrix job of each project in one attempt of a run.
 * @param {Function} gh the gh runner
 * @param {{ id: number }} run the run
 * @param {number} attempt the attempt
 * @param {string[]} projects project ids
 * @returns {Promise<Record<string, { status?: string, conclusion: string | null, url: string } | undefined>>} by project
 */
export async function visualJobs(gh, run, attempt, projects) {
    // Every page: a run that calls the workflow beside other lanes can have more than 100 jobs.
    const jobs = [];
    for (let page = 1; ; page++) {
        const got = await api(
            gh,
            `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
        );
        jobs.push(...got.jobs);
        if (got.jobs.length < 100 || jobs.length >= (got.total_count ?? 0)) {
            break;
        }
    }
    // A called workflow's jobs are named "<caller job> / visual (<project>)".
    const visual = jobs.filter((j) => /(^| \/ )visual\b/.test(j.name));
    return Object.fromEntries(
        projects.map((p) => {
            // The exact name: "visual (graphty-element)" also contains "graphty".
            const job = visual.find((j) => j.name === `visual (${p})` || j.name.endsWith(` / visual (${p})`));
            return [p, job && { ...(job.status && { status: job.status }), conclusion: job.conclusion, url: job.html_url }];
        }),
    );
}

// Downloads in flight, by target directory: concurrent refreshes of one run await the same one.
const downloading = new Map();

// At most this many `gh run download` at once: every open pull request's captures start at once,
// and dozens of parallel transfers only slow each other (and the one the reviewer is waiting for).
const DOWNLOADS = 8;
let active = 0;
/** Downloads waiting for a slot, by target directory, in the order they start. */
const queued = [];
const pump = () => {
    while (active < DOWNLOADS && queued.length > 0) {
        active++;
        queued.shift().start();
    }
};

/**
 * Moves the waiting downloads whose directory `wanted` picks to the front of the queue: the
 * project the reviewer is opening downloads next, before the ones nobody is waiting for.
 * @param {(dir: string) => boolean} wanted picks the directories to hurry
 */
export function hurry(wanted) {
    const first = queued.filter((q) => wanted(q.dir));
    queued.splice(0, queued.length, ...first, ...queued.filter((q) => !wanted(q.dir)));
}

// An artifact directory that holds a capture's results.json or the not-affected marker.
const whole = (d) => existsSync(join(d, "results.json")) || existsSync(join(d, SKIPPED_FILE));

/**
 * Marks a capture directory whose images the disk budget removed (budget.mjs): its results.json
 * is still there, so it counts as downloaded until a download is asked for `again`.
 */
export const EVICTED_FILE = "evicted.json";
const evicted = (d) => existsSync(join(d, EVICTED_FILE));

/**
 * Downloads one artifact into `dir`, unless it is already there. It is extracted into a sibling
 * temporary directory and renamed into place only once its results.json is there, so `dir` either
 * does not exist or holds a whole artifact; a failed or interrupted download leaves nothing behind.
 * An artifact with neither results.json nor the not-affected marker (skipped.json, written for a
 * project the run left out) is discarded, and its readers report the capture as failed.
 * @param {Function} gh the gh runner
 * @param {number} runId the run
 * @param {string} name the artifact
 * @param {string} dir where it goes
 * @param {boolean} [again] download an evicted directory again (it stays as it is until the new
 *     copy is complete)
 * @returns {Promise<void>} settles when `dir` is complete, or the artifact had no results.json
 */
function download(gh, runId, name, dir, again = false) {
    const away = !downloading.has(dir) && evicted(dir);
    if (away && !again) {
        return Promise.resolve(); // Evicted: its counts are on disk, its images come on open.
    }
    if (!away && !downloading.has(dir) && !existsSync(join(dir, "results.json")) && whole(dir)) {
        return Promise.resolve(); // The not-affected marker: nothing to validate.
    }
    if (!away && !downloading.has(dir) && existsSync(join(dir, "results.json"))) {
        try {
            JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
            return Promise.resolve();
        } catch (err) {
            // Damaged on this disk (CI uploads only results.json it wrote): download it again.
            console.error(
                `proofroom: ${join(dir, "results.json")} is unreadable, downloading again: ${err.message}`,
            );
        }
    }
    if (!downloading.has(dir)) {
        const done = (async () => {
            // A directory without results.json is left over from before downloads were atomic,
            // and a .part- sibling from a download a killed server never finished. An evicted one
            // keeps its counts until the new copy replaces it.
            if (!away) {
                rmSync(dir, { recursive: true, force: true });
            }
            mkdirSync(dirname(dir), { recursive: true });
            for (const f of readdirSync(dirname(dir))) {
                if (f.startsWith(`${basename(dir)}.part-`)) {
                    rmSync(join(dirname(dir), f), { recursive: true, force: true });
                }
            }
            await new Promise((start) => {
                queued.push({ dir, start });
                pump();
            });
            const part = mkdtempSync(`${dir}.part-`);
            try {
                await gh(["run", "download", String(runId), "-n", name, "-D", part]);
                if (whole(part)) {
                    rmSync(dir, { recursive: true, force: true });
                    renameSync(part, dir);
                }
            } finally {
                rmSync(part, { recursive: true, force: true });
                active--;
                pump();
            }
        })().finally(() => downloading.delete(dir));
        downloading.set(dir, done);
    }
    return downloading.get(dir);
}

/**
 * Downloads each project's capture artifact from the highest attempt that uploaded one, into
 * `<tmp>/<run>-<attempt>/<project>/`. An artifact already downloaded is not fetched again, and
 * concurrent calls for the same one share a single download. A failed download fails only its
 * project, which the next call tries again. An expired artifact is used from disk when it was
 * downloaded before.
 * @param {Function} gh the gh runner
 * @param {{ id: number }} run the run
 * @param {string[]} projects project ids
 * @param {string} tmp the download root
 * @param {string[]} [others] receives the projects the run captured that are not in `projects`
 * @param {(project: string, got: object | null) => void} [landed] told as each project's download
 *     ends, with what the result holds for it, so a page can fill rows in one by one
 * @param {(sizes: Record<string, number>) => void} [planned] told first, with the size in bytes
 *     of each project's artifact, so a page can count the bytes still to come
 * @param {boolean} [again] download the evicted ones again (EVICTED_FILE)
 * @returns {Promise<Record<string, { dir: string | null, attempt: number, bytes: number,
 *     error?: string, expired?: true, deleted?: true } | null>>} null for a project with no
 *     artifact; `error` (and no `dir`) when its download failed; `expired` (and no `dir`) when
 *     GitHub deleted it and it is not on disk; `deleted` when GitHub deleted it and only its
 *     evicted directory (counts, no images) is on disk
 */
export async function downloadCaptures(
    gh,
    run,
    projects,
    tmp,
    others = [],
    landed = () => {},
    planned = () => {},
    again = false,
) {
    const { artifacts } = await api(gh, `repos/{owner}/{repo}/actions/runs/${run.id}/artifacts?per_page=100`);
    for (const a of artifacts) {
        const p = /^visual-(.+)-\d+$/.exec(a.name)?.[1];
        if (p && !projects.includes(p) && !others.includes(p)) {
            others.push(p);
        }
    }
    const newestOf = (pattern) =>
        artifacts
            .filter((x) => pattern.test(x.name))
            .map((x) => ({
                name: x.name,
                // The list a finished run keeps on disk says false for ever: its date says when.
                expired: x.expired || Date.parse(x.expires_at) <= Date.now(),
                bytes: x.size_in_bytes ?? 0,
                attempt: Number(pattern.exec(x.name)[1]),
            }))
            .sort((x, y) => y.attempt - x.attempt)[0];
    const newest = Object.fromEntries(
        projects.map((project) => {
            const a = newestOf(new RegExp(String.raw`^visual-${project}-(\d+)$`));
            return [project, a ?? null];
        }),
    );
    planned(Object.fromEntries(Object.entries(newest).flatMap(([p, a]) => (a ? [[p, a.bytes]] : []))));
    /** @type {Record<string, { dir: string | null, attempt: number, bytes: number, error?: string, expired?: true } | null>} */
    const out = {};
    // Every project at once: the shared cap on downloads keeps the number of transfers sane.
    await Promise.all(
        projects.map(async (project) => {
            const a = newest[project];
            if (!a) {
                out[project] = null;
            } else {
                const dir = join(tmp, `${run.id}-${a.attempt}`, project);
                const got = { attempt: a.attempt, bytes: a.bytes };
                if (a.expired) {
                    out[project] = whole(dir)
                        ? { dir, ...got, ...(evicted(dir) && { deleted: true }) }
                        : { dir: null, ...got, expired: true };
                } else {
                    try {
                        await download(gh, run.id, a.name, dir, again);
                        out[project] = { dir, ...got };
                    } catch (err) {
                        // ponytail: an evicted copy whose download failed stays evicted, with its
                        // counts, and the next open tries again; the error is only logged.
                        if (evicted(dir)) {
                            console.error(`proofroom: downloading ${a.name} again failed: ${err.message}`);
                        }
                        out[project] = evicted(dir) ? { dir, ...got } : { dir: null, ...got, error: err.message };
                    }
                }
            }
            landed(project, out[project]);
        }),
    );
    return out;
}

/**
 * Downloads the default branch's newest complete capture of one project: the reference a pull
 * request's capture compares stories without a baseline against.
 * ponytail: the newest default-branch run with a complete capture, not the run of the pull
 * request's exact base; a story changed there since then shows as `new` (it blocks, never passes).
 * @param {Function} gh the gh runner
 * @param {string} project the project id
 * @param {string} tmp the download root
 * @param {{ workflow: string, defaultBranch: string }} config the capturing workflow and the branch
 * @returns {Promise<string | null>} the capture's directory, or null when no run has one
 */
export async function newestMasterCapture(gh, project, tmp, { workflow, defaultBranch }) {
    // The branch's newest commits, then each one's run: GitHub's list of a workflow's runs filtered
    // by branch now and then answers with a stale page (runs from weeks ago), which made a pull
    // request compare with an old capture or none. Commits and a run by head sha answer consistently.
    const commits = await api(gh, `repos/{owner}/{repo}/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=10`);
    for (const { sha } of commits) {
        const run = await newestCiRun(gh, sha, { workflow });
        if (!run) {
            continue;
        }
        // A copy the disk budget evicted is downloaded again: this one's images are compared with.
        const got = (await downloadCaptures(gh, run, [project], tmp, [], undefined, undefined, true))[project];
        if (got?.error) {
            // Not skipped: an older capture would be compared instead of this one.
            throw new Error(got.error);
        }
        const dir = got?.dir;
        let results = null;
        try {
            results = dir ? JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) : null;
        } catch {
            // An unreadable capture is skipped like a missing one.
        }
        if (results && validateResults(results).length === 0 && results.complete && results.project === project) {
            return dir;
        }
    }
    return null;
}

/**
 * Opens an issue.
 * @param {Function} gh the gh runner
 * @param {{ title: string, body: string, labels: string[] }} issue what to open
 * @returns {Promise<string>} its URL
 */
export async function createIssue(gh, { title, body, labels }) {
    const input = JSON.stringify({ title, body, labels });
    return JSON.parse(await gh(["api", "repos/{owner}/{repo}/issues", "--input", "-"], input)).html_url;
}

/**
 * Posts a comment on a pull request.
 * @param {Function} gh the gh runner
 * @param {number} pr the pull request
 * @param {string} body Markdown
 * @returns {Promise<void>}
 */
export async function commentOnPullRequest(gh, pr, body) {
    await gh(["api", `repos/{owner}/{repo}/issues/${pr}/comments`, "--input", "-"], JSON.stringify({ body }));
}

/**
 * Sets the "Visual review" commit status on one commit. Finish posts it once, when it completes,
 * never per decision.
 * @param {Function} gh the gh runner
 * @param {string} sha the commit
 * @param {{ state: "success" | "failure" | "pending", description: string }} status what to post;
 *     GitHub cuts the description at 140 characters
 * @returns {Promise<void>}
 */
export async function postStatus(gh, sha, { state, description }) {
    const input = JSON.stringify({ state, context: "Visual review", description: description.slice(0, 140) });
    await gh(["api", `repos/{owner}/{repo}/statuses/${sha}`, "--input", "-"], input);
}

/**
 * Opens a pull request.
 * @param {Function} gh the gh runner
 * @param {{ title: string, head: string, base: string, body: string }} pr what to open, and the
 *     branch it merges into
 * @returns {Promise<string>} its URL
 */
export async function createPullRequest(gh, { title, head, base, body }) {
    const input = JSON.stringify({ title, head, base, body });
    return JSON.parse(await gh(["api", "repos/{owner}/{repo}/pulls", "--input", "-"], input)).html_url;
}

/**
 * A pull request's title, description and comments, oldest comment first, for the review page's
 * context panel: one call for the pull request and one for its comments (the first 100). Every
 * text in it is untrusted, written by whoever opened or commented on the pull request.
 * @param {Function} gh the gh runner
 * @param {number} pr the pull request
 * @param {string | null} reviewer the login of the person reviewing (gh's own login, `GET /user`),
 *     taken as the owner when the repository belongs to an organization
 * @returns {Promise<{ title: string, body: string, author: string | null, owner: string | null,
 *     createdAt: string | null, comments: { author: string | null, at: string | null, body: string,
 *     byOwner: boolean }[] }>} the context; `owner` is the repository owner's login
 */
export async function pullRequestContext(gh, pr, reviewer) {
    const p = await api(gh, `repos/{owner}/{repo}/pulls/${pr}`);
    const comments = await api(gh, `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`);
    const repoOwner = p.base?.repo?.owner;
    const owner = repoOwner?.type === "User" ? (repoOwner.login ?? null) : reviewer;
    const text = (v) => (typeof v === "string" ? v : "");
    return {
        title: text(p.title),
        body: text(p.body),
        author: p.user?.login ?? null,
        owner,
        createdAt: p.created_at ?? null,
        comments: (Array.isArray(comments) ? comments : []).map((c) => ({
            author: c.user?.login ?? null,
            at: c.created_at ?? null,
            body: text(c.body),
            byOwner: owner !== null && c.user?.login === owner,
        })),
    };
}

/**
 * The login gh is signed in as.
 * @param {Function} gh the gh runner
 * @returns {Promise<string | null>} the login
 */
export const reviewerLogin = async (gh) => (await api(gh, "user")).login ?? null;

/**
 * The repository's GitHub id, which a rename or a transfer does not change: what change statements
 * name on GitHub (`github:<id>`, gate.mjs repositoryOf).
 * @param {Function} gh the gh runner
 * @returns {Promise<number | null>} the id
 */
export const repositoryNumber = async (gh) => {
    const { id } = await api(gh, "repos/{owner}/{repo}");
    return Number.isInteger(id) ? id : null;
};
