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

import { validateResults } from "./results.mjs";

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

// How gh reports a network that failed (DNS, a dropped or refused connection, a transfer cut
// short, a call exec stopped) or a GitHub server error. A 4xx, a missing artifact or any other gh
// error is real and is never retried.
const TRANSIENT =
    /could not resolve host|no such host|error connecting to|connection (reset|refused|timed out)|i\/o timeout|TLS handshake timeout|HTTP 5\d\d|unexpected EOF|GOAWAY|stream error|context deadline exceeded|timed out after/i;

/**
 * Retries a gh runner's calls that failed on the network, after each delay in turn. A write
 * (`--input`) is never retried: GitHub may have applied it before the connection dropped. Every
 * failure and retry is logged to stderr, so the server's log shows what happened.
 * @param {(args: string[], input?: string) => Promise<string>} gh the gh runner
 * @param {number[]} [delays] milliseconds before each retry
 * @returns {(args: string[], input?: string) => Promise<string>} the retrying runner
 */
export const withRetries =
    (gh, delays = [2000, 5000, 15000]) =>
    async (args, input) => {
        for (let i = 0; ; i++) {
            try {
                return await gh(args, input);
            } catch (err) {
                const retry = i < delays.length && !args.includes("--input") && TRANSIENT.test(err.message);
                // gh's arguments never hold a token (gh keeps its own login), so they are logged whole.
                const next = retry ? `; retrying in ${delays[i] / 1000} s` : "";
                console.error(`visual-review: gh ${args.join(" ")} failed${next}: ${err.message}`);
                if (!retry) {
                    throw err;
                }
                await new Promise((resolve) => setTimeout(resolve, delays[i]));
            }
        }
    };

const api = async (gh, path) => JSON.parse(await gh(["api", path]));

/**
 * Open pull requests, newest first.
 * @param {Function} gh the gh runner
 * @returns {Promise<{ number: number, title: string, url: string, headSha: string, branch: string }[]>}
 *     the pull requests
 */
export async function openPullRequests(gh) {
    const pulls = await api(gh, "repos/{owner}/{repo}/pulls?state=open&per_page=100");
    return pulls.map((p) => ({
        number: p.number,
        title: p.title,
        url: p.html_url,
        headSha: p.head.sha,
        branch: p.head.ref,
    }));
}

const toRun = (r) => ({
    id: r.id,
    attempt: r.run_attempt,
    status: r.status,
    conclusion: r.conclusion,
    url: r.html_url,
    headSha: r.head_sha,
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
 * @returns {Promise<Record<string, { conclusion: string | null, url: string } | undefined>>} by project
 */
export async function visualJobs(gh, run, attempt, projects) {
    const { jobs } = await api(gh, `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
    const visual = jobs.filter((j) => /^visual\b/.test(j.name));
    return Object.fromEntries(
        projects.map((p) => {
            // The exact name: "visual (graphty-element)" also contains "graphty".
            const job = visual.find((j) => j.name === `visual (${p})`);
            return [p, job && { conclusion: job.conclusion, url: job.html_url }];
        }),
    );
}

// Downloads in flight, by target directory: concurrent refreshes of one run await the same one.
const downloading = new Map();

/**
 * Downloads one artifact into `dir`, unless it is already there. It is extracted into a sibling
 * temporary directory and renamed into place only once its results.json is there, so `dir` either
 * does not exist or holds a whole artifact; a failed or interrupted download leaves nothing behind.
 * An artifact without results.json is discarded, and its readers report the capture as failed.
 * @param {Function} gh the gh runner
 * @param {number} runId the run
 * @param {string} name the artifact
 * @param {string} dir where it goes
 * @returns {Promise<void>} settles when `dir` is complete, or the artifact had no results.json
 */
function download(gh, runId, name, dir) {
    if (!downloading.has(dir) && existsSync(join(dir, "results.json"))) {
        try {
            JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
            return Promise.resolve();
        } catch (err) {
            // Damaged on this disk (CI uploads only results.json it wrote): download it again.
            console.error(
                `visual-review: ${join(dir, "results.json")} is unreadable, downloading again: ${err.message}`,
            );
        }
    }
    if (!downloading.has(dir)) {
        const done = (async () => {
            // A directory without results.json is left over from before downloads were atomic,
            // and a .part- sibling from a download a killed server never finished.
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dirname(dir), { recursive: true });
            for (const f of readdirSync(dirname(dir))) {
                if (f.startsWith(`${basename(dir)}.part-`)) {
                    rmSync(join(dirname(dir), f), { recursive: true, force: true });
                }
            }
            const part = mkdtempSync(`${dir}.part-`);
            try {
                await gh(["run", "download", String(runId), "-n", name, "-D", part]);
                if (existsSync(join(part, "results.json"))) {
                    renameSync(part, dir);
                }
            } finally {
                rmSync(part, { recursive: true, force: true });
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
 * @returns {Promise<Record<string, { dir: string | null, attempt: number, error?: string,
 *     expired?: true } | null>>} null for a project with no artifact; `error` (and no `dir`) when
 *     its download failed; `expired` (and no `dir`) when GitHub deleted it and it is not on disk
 */
export async function downloadCaptures(gh, run, projects, tmp, others = []) {
    const { artifacts } = await api(gh, `repos/{owner}/{repo}/actions/runs/${run.id}/artifacts?per_page=100`);
    for (const a of artifacts) {
        const p = /^visual-(.+)-\d+$/.exec(a.name)?.[1];
        if (p && !projects.includes(p) && !others.includes(p)) {
            others.push(p);
        }
    }
    /** @type {Record<string, { dir: string | null, attempt: number, error?: string, expired?: true } | null>} */
    const out = {};
    for (const project of projects) {
        const pattern = new RegExp(`^visual-${project}-(\\d+)$`);
        const newest = artifacts
            .filter((a) => pattern.test(a.name))
            .map((a) => ({ name: a.name, expired: a.expired, attempt: Number(pattern.exec(a.name)[1]) }))
            .sort((a, b) => b.attempt - a.attempt)[0];
        if (!newest) {
            out[project] = null;
            continue;
        }
        const dir = join(tmp, `${run.id}-${newest.attempt}`, project);
        if (newest.expired) {
            out[project] = existsSync(join(dir, "results.json"))
                ? { dir, attempt: newest.attempt }
                : { dir: null, attempt: newest.attempt, expired: true };
            continue;
        }
        try {
            await download(gh, run.id, newest.name, dir);
            out[project] = { dir, attempt: newest.attempt };
        } catch (err) {
            out[project] = { dir: null, attempt: newest.attempt, error: err.message };
        }
    }
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
        const got = (await downloadCaptures(gh, run, [project], tmp))[project];
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
