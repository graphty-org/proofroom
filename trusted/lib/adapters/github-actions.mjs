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
import { download, downloadCaptures, getRun, hurry, newestCiRun, newestMasterCapture, visualJobs } from "../github.mjs";

/**
 * A capture job's state as the Captures screen says it, from GitHub's job and, once it ended, the
 * capture it uploaded: queued, running, passed, failed, cancelled or skipped. A job GitHub has not
 * made yet is queued. One that ended passed when its capture is complete with no story that failed
 * to render, whatever differences it found (those are for review), and failed when the capture is
 * incomplete, has such a story, or is missing (the tool crashed before writing it). Without its
 * capture (`results` undefined: not read), only GitHub's conclusion says.
 * @param {{ status?: string, conclusion: string | null } | undefined} job the job (visualJobs)
 * @param {{ complete: boolean, items: { status: string }[] } | null} [results] its capture's
 *     results.json; null when it uploaded none
 * @returns {"queued" | "running" | "passed" | "failed" | "cancelled" | "skipped"} its state
 */
export function jobState(job, results) {
    if (!job || (job.status && !["in_progress", "completed"].includes(job.status))) {
        return "queued";
    }
    if (job.status === "in_progress") {
        return "running";
    }
    if (job.conclusion === "cancelled" || job.conclusion === "skipped") {
        return job.conclusion;
    }
    if (results !== undefined) {
        return results?.complete === true && !results.items.some((i) => i.status === "failed") ? "passed" : "failed";
    }
    return job.conclusion === "success" ? "passed" : "failed";
}

// The most failed stories one job's answer lists; `failures` counts them all.
const FAILED_SENT = 50;

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
        // One capture set by its artifact's name (a rolling render's slice, serve's `rolling`).
        artifact: (runId, name, dir) => download(gh, runId, name, dir),
        hurry,
        /**
         * Asks CI for a capture of a pull request of this repository (never a fork's, whose branch
         * name is not a branch here): a dispatch of the capturing workflow on its branch, which
         * captures the pull request's merge at exactly the head the page showed, as its own run
         * does, and records the pull request in the capture.
         * @param {{ pr: number, branch: string, head: string }} change the change
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
                    inputs: {
                        ref: change.head,
                        pr: String(change.pr),
                        projects: projects.join(","),
                        stories: stories.join(","),
                        request,
                    },
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
         *     jobs: { project: string, state: string, url: string | null, startedAt: string | null, endedAt: string | null,
         *     failures: number, failed: { story: string, reason: string }[] }[] }>}
         *     its state (runState), its run, and each job's (jobState) with the stories that failed
         *     to render in its capture
         */
        async status(req, projects) {
            const run = req.run === null ? await requestedRun(req) : await getRun(gh, req.run);
            const jobs = run ? await visualJobs(gh, run, run.attempt, projects) : {};
            return {
                state: runState(run),
                run: run && { id: run.id, url: run.url },
                jobs: await Promise.all(
                    projects.map(async (project) => {
                        const job = jobs[project];
                        // An ended job's capture, downloaded where the review reads it.
                        const results =
                            job?.status === "completed" && keep ? await capturedBy(run, project) : undefined;
                        const failed = (results?.items ?? []).filter((i) => i.status === "failed");
                        return {
                            project,
                            state: jobState(job, results),
                            url: job?.url ?? null,
                            startedAt: job?.startedAt ?? null,
                            endedAt: job?.endedAt ?? null,
                            failures: failed.length,
                            failed: failed
                                .slice(0, FAILED_SENT)
                                .map((i) => ({ story: i.id, reason: String(i.reason ?? "failed") })),
                        };
                    }),
                ),
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

    // A project's capture of a run, once its job uploaded it: results.json, or null when there is
    // none (the job crashed before writing it, or uploaded nothing).
    async function capturedBy(run, project) {
        const got = (await downloadCaptures(forRun(run), run, [project], keep))[project];
        if (got?.error) {
            throw new Error(got.error);
        }
        try {
            return got?.dir ? JSON.parse(await readFile(join(got.dir, "results.json"), "utf8")) : null;
        } catch {
            return null;
        }
    }

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
