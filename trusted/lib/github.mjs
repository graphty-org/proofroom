/**
 * Everything the review page needs from GitHub, through the `gh` CLI with the owner's login:
 * open pull requests, the CI run for a head, the `visual` job's outcome, the capture artifacts,
 * and the comment, issue and pull request that a Finish writes. CI uses one of these too: a pull
 * request's capture downloads master's newest capture with `newestMasterCapture`.
 *
 * Only `gh api` and `gh run download` are used, because they exist in every gh release still in
 * use (Ubuntu 22.04 ships gh 2.4, which lacks `gh run list --commit` and most `--json` fields).
 * `{owner}/{repo}` is filled in by gh from the repository's remote.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateResults } from "./results.mjs";

/**
 * Runs a program and resolves with its trimmed stdout.
 * @param {string} cmd the program
 * @param {string[]} args its arguments
 * @param {{ cwd?: string, input?: string, env?: object }} [options] stdin and environment
 * @returns {Promise<string>} stdout; rejects with an Error whose message is the program's stderr
 */
export function exec(cmd, args, { cwd, input, env } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 << 20 }, (err, out, stderr) => {
            if (err) {
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
export const ghRunner = (cwd) => (args, input) => exec("gh", args, { cwd, input });

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
 * The newest ci.yml run for a head commit.
 * @param {Function} gh the gh runner
 * @param {string} sha the pull request's head
 * @returns {Promise<object | null>} the run, or null when CI never ran on it
 */
export async function newestCiRun(gh, sha) {
    const { workflow_runs: runs } = await api(
        gh,
        `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=1`,
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
            const job = visual.find((j) => j.name.includes(p));
            return [p, job && { conclusion: job.conclusion, url: job.html_url }];
        }),
    );
}

/**
 * Downloads each project's capture artifact from the highest attempt that uploaded one, into
 * `<tmp>/<run>-<attempt>/<project>/`. An artifact already downloaded is not fetched again.
 * @param {Function} gh the gh runner
 * @param {{ id: number }} run the run
 * @param {string[]} projects project ids
 * @param {string} tmp the download root
 * @returns {Promise<Record<string, { dir: string, attempt: number } | null>>} null for a project
 *     with no unexpired artifact
 */
export async function downloadCaptures(gh, run, projects, tmp) {
    const { artifacts } = await api(gh, `repos/{owner}/{repo}/actions/runs/${run.id}/artifacts?per_page=100`);
    /** @type {Record<string, { dir: string, attempt: number } | null>} */
    const out = {};
    for (const project of projects) {
        const pattern = new RegExp(`^visual-${project}-(\\d+)$`);
        const newest = artifacts
            .filter((a) => !a.expired && pattern.test(a.name))
            .map((a) => ({ name: a.name, attempt: Number(pattern.exec(a.name)[1]) }))
            .sort((a, b) => b.attempt - a.attempt)[0];
        if (!newest) {
            out[project] = null;
            continue;
        }
        const dir = join(tmp, `${run.id}-${newest.attempt}`, project);
        if (!existsSync(join(dir, "results.json"))) {
            await gh(["run", "download", String(run.id), "-n", newest.name, "-D", dir]);
        }
        out[project] = { dir, attempt: newest.attempt };
    }
    return out;
}

/**
 * Downloads master's newest complete capture of one project: the reference a pull request's
 * capture compares stories without a baseline against.
 * ponytail: the newest master run with a complete capture, not the run of the pull request's
 * exact base; a story changed on master since then shows as `new` (it blocks, never passes).
 * @param {Function} gh the gh runner
 * @param {string} project the project id
 * @param {string} tmp the download root
 * @returns {Promise<string | null>} the capture's directory, or null when no master run has one
 */
export async function newestMasterCapture(gh, project, tmp) {
    const { workflow_runs: runs } = await api(
        gh,
        "repos/{owner}/{repo}/actions/workflows/ci.yml/runs?branch=master&event=push&per_page=10",
    );
    for (const run of runs.map(toRun)) {
        const dir = (await downloadCaptures(gh, run, [project], tmp))[project]?.dir;
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
 * Opens a pull request against master.
 * @param {Function} gh the gh runner
 * @param {{ title: string, head: string, body: string }} pr what to open
 * @returns {Promise<string>} its URL
 */
export async function createPullRequest(gh, { title, head, body }) {
    const input = JSON.stringify({ title, head, base: "master", body });
    return JSON.parse(await gh(["api", "repos/{owner}/{repo}/pulls", "--input", "-"], input)).html_url;
}
