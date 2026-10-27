/**
 * The GitHub Actions capture store: CI runs of the capturing workflow, their `visual (<project>)`
 * jobs, and the `visual-<project>-<attempt>` artifacts that hold each project's capture set,
 * through the `gh` CLI (github.mjs). It also asks CI for a capture: a `workflow_dispatch` of the
 * capturing workflow on the change's branch, whose `request` input (a fresh id) the workflow echoes
 * in its run name, so the run it started is found again among the branch's runs.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "../compare.mjs";
import { downloadCaptures, getRun, hurry, newestCiRun, newestMasterCapture, visualJobs } from "../github.mjs";

/**
 * A capture job's state as the Captures screen says it, from GitHub's job: queued, running,
 * passed, failed, cancelled or skipped. A job GitHub has not made yet is queued; one that uploaded
 * its capture passed, whatever differences it found (those are for review).
 * @param {{ status?: string, conclusion: string | null, uploaded?: boolean } | undefined} job the job (visualJobs)
 * @returns {"queued" | "running" | "passed" | "failed" | "cancelled" | "skipped"} its state
 */
export function jobState(job) {
    if (!job || (job.status && !["in_progress", "completed"].includes(job.status))) {
        return "queued";
    }
    if (job.status === "in_progress") {
        return "running";
    }
    if (job.uploaded) {
        return "passed";
    }
    return { success: "passed", cancelled: "cancelled", skipped: "skipped" }[job.conclusion] ?? "failed";
}

/**
 * A requested capture's state from its run: queued until GitHub has made the run, running while
 * it runs, then done, cancelled, or failed when the run itself failed (a capture job's differences
 * never fail it: those jobs carry on on error).
 * @param {{ status: string, conclusion: string | null } | null} run the run, or null before there is one
 * @returns {"queued" | "running" | "done" | "cancelled" | "failed"} its state
 */
export function runState(run) {
    if (!run) {
        return "queued";
    }
    if (run.status !== "completed") {
        return ["queued", "waiting", "pending", "requested"].includes(run.status) ? "queued" : "running";
    }
    return { success: "done", cancelled: "cancelled" }[run.conclusion] ?? "failed";
}

/**
 * The GitHub Actions capture store over a gh runner.
 * @param {(args: string[], input?: string) => Promise<string>} gh the gh runner
 * @param {{ keep?: string | null, warn?: (message: string) => void }} [options] `keep` is the
 *     download root, beside whose run directories a finished run's answers are kept; `warn` is told
 *     when they cannot be
 * @returns {import("./index.mjs").CaptureStore} the adapter
 */
export function githubActionsStore(gh, { keep = null, warn = (m) => console.error(`proofroom: ${m}`) } = {}) {
    /**
     * The gh runner for one finished run: what GitHub says about it (its jobs, its artifacts) no
     * longer changes, so each answer is asked once and kept on disk beside the run's downloads,
     * and pruned with them. A refresh then asks GitHub only for the pull requests and their newest
     * runs. ponytail: an artifact that expires later is still listed as there; its download fails
     * and says so, which only matters for a capture never downloaded in its 90 days.
     * @param {{ id: number, attempt: number }} run the finished run
     * @returns {Function} the gh runner
     */
    const kept = (run) => async (args, input) => {
        if (args[0] !== "api") {
            return gh(args, input);
        }
        const name = sha256(args.join(" ")).slice(0, 16);
        const file = join(keep, `${run.id}-${run.attempt}`, "gh", `${name}.json`);
        const saved = await readFile(file, "utf8").catch(() => null);
        if (saved !== null) {
            return saved;
        }
        const answer = await gh(args, input);
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(`${file}.tmp`, answer);
            renameSync(`${file}.tmp`, file);
        } catch (err) {
            warn(`could not keep GitHub's answers in ${dirname(file)}: ${err.message}`);
        }
        return answer;
    };
    const forRun = (run) => (keep && run.status === "completed" ? kept(run) : gh);
    const list = async (run) => {
        const { artifacts } = JSON.parse(
            await forRun(run)(["api", `repos/{owner}/{repo}/actions/runs/${run.id}/artifacts?per_page=100`]),
        );
        return artifacts.flatMap((a) => {
            const m = /^visual-(.+)-(\d+)$/.exec(a.name);
            return m
                ? [
                      {
                          project: m[1],
                          attempt: Number(m[2]),
                          bytes: a.size_in_bytes ?? 0,
                          expired: a.expired === true,
                          expiresAt: a.expires_at ?? null,
                          ref: a.name,
                      },
                  ]
                : [];
        });
    };
    return {
        name: "github-actions",
        run: (id) => getRun(gh, id),
        newestRun: (sha, config) => newestCiRun(gh, sha, config),
        jobs: (run, projects) => visualJobs(forRun(run), run, run.attempt, projects),
        list,
        fetch: (run, projects, dir, others, landed, planned, again) =>
            downloadCaptures(forRun(run), run, projects, dir, others, landed, planned, again),
        // When GitHub deletes a project's newest capture of a run; null when it has none.
        async expiresAt(run, project) {
            const sets = (await list(run)).filter((s) => s.project === project).sort((a, b) => b.attempt - a.attempt);
            return sets[0]?.expiresAt ?? null;
        },
        newestDefault: (project, dir, config) => newestMasterCapture(gh, project, dir, config),
        hurry,
        /**
         * Asks CI for a capture of a change: a dispatch of the capturing workflow on its branch,
         * which checks out exactly the head the page showed.
         * @param {{ branch: string, head: string }} change the change
         * @param {{ projects: string[], stories: string[] }} what the projects and story prefixes
         *     (none: every one)
         * @param {{ workflow: string }} config the workflow file that captures
         * @returns {Promise<{ request: string, workflow: string, branch: string, run: null }>} the
         *     request, which `status` and `cancel` take
         */
        async request(change, { projects, stories }, { workflow }) {
            const request = randomUUID();
            await gh(
                [
                    "api",
                    "-X",
                    "POST",
                    `repos/{owner}/{repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
                    "--input",
                    "-",
                ],
                JSON.stringify({
                    ref: change.branch,
                    inputs: { ref: change.head, projects: projects.join(","), stories: stories.join(","), request },
                }),
            );
            return { request, workflow, branch: change.branch, run: null };
        },
        /**
         * Where a requested capture is: its run once GitHub has made it (found by the request id in
         * the run's name among the branch's newest dispatched runs), and each project's job.
         * @param {{ request: string, workflow: string, branch: string, run: number | null }} req the request
         * @param {string[]} projects the projects it captures
         * @returns {Promise<{ state: string, run: { id: number, url: string } | null,
         *     jobs: { project: string, state: string, url: string | null, startedAt: string | null, endedAt: string | null }[] }>}
         *     its state (runState), its run, and each job's (jobState)
         */
        async status(req, projects) {
            const run = req.run === null ? await requestedRun(req) : await getRun(gh, req.run);
            const jobs = run ? await visualJobs(gh, run, run.attempt, projects) : {};
            return {
                state: runState(run),
                run: run && { id: run.id, url: run.url },
                jobs: projects.map((project) => ({
                    project,
                    state: jobState(jobs[project]),
                    url: jobs[project]?.url ?? null,
                    startedAt: jobs[project]?.startedAt ?? null,
                    endedAt: jobs[project]?.endedAt ?? null,
                })),
            };
        },
        /**
         * Stops a requested capture: cancels its run. Before GitHub has made the run there is
         * nothing to cancel yet.
         * @param {{ request: string, workflow: string, branch: string, run: number | null }} req the request
         * @returns {Promise<boolean>} whether a run was cancelled
         */
        async cancel(req) {
            const run = req.run === null ? await requestedRun(req) : { id: req.run };
            if (!run) {
                return false;
            }
            await gh(["api", "-X", "POST", `repos/{owner}/{repo}/actions/runs/${run.id}/cancel`]);
            return true;
        },
    };

    // The run a request started: its id is in the run's name. ponytail: only the branch's 20 newest
    // dispatched runs are searched, which a run started a moment ago is among.
    async function requestedRun({ request, workflow, branch }) {
        const { workflow_runs: runs } = JSON.parse(
            await gh([
                "api",
                `repos/{owner}/{repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=20`,
            ]),
        );
        const r = runs.find((x) => String(x.display_title ?? "").includes(request));
        return r
            ? { id: r.id, attempt: r.run_attempt, status: r.status, conclusion: r.conclusion, url: r.html_url }
            : null;
    }
}
