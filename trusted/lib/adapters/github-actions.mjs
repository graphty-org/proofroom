/**
 * The GitHub Actions capture store: CI runs of the capturing workflow, their `visual (<project>)`
 * jobs, and the `visual-<project>-<attempt>` artifacts that hold each project's capture set,
 * through the `gh` CLI (github.mjs).
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "../compare.mjs";
import { downloadCaptures, getRun, hurry, newestCiRun, newestMasterCapture, visualJobs } from "../github.mjs";

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
        fetch: (run, projects, dir, others, landed, planned) =>
            downloadCaptures(forRun(run), run, projects, dir, others, landed, planned),
        // When GitHub deletes a project's newest capture of a run; null when it has none.
        async expiresAt(run, project) {
            const sets = (await list(run)).filter((s) => s.project === project).sort((a, b) => b.attempt - a.attempt);
            return sets[0]?.expiresAt ?? null;
        },
        newestDefault: (project, dir, config) => newestMasterCapture(gh, project, dir, config),
        hurry,
    };
}
