#!/usr/bin/env node
/**
 * The pull request gate: fails while a project that has baselines on the base branch holds visual
 * changes the owner has not reviewed.
 *
 * Usage: node visual-review/trusted/gate.mjs --captures <dir> --base <ref>
 *
 * <dir> holds the downloaded `visual-<project>-<attempt>` artifacts of this CI run, every attempt
 * of it. For each project only the highest attempt counts, so re-running failed jobs (which
 * leaves the visual jobs' old attempt as the newest) can neither hide nor resurrect a capture.
 * Whether a project is seeded is read from <ref> (the base branch tip, fetched by the caller), not
 * from the pull request, so deleting a project's baselines in the pull request does not turn the
 * gate off. A seeded project with no results.json, or an incomplete one, fails: a capture that
 * crashed has shown the owner nothing. Standard library only, so it runs without an install.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PASSING = new Set(["unchanged", "excluded"]);

/**
 * The newest attempt's results.json of every project in a directory of downloaded artifacts.
 * @param {string} dir the download directory, one subdirectory per artifact
 * @returns {Record<string, { attempt: number, results: object | null }>} by project
 */
export function newestResults(dir) {
    const out = {};
    const names = existsSync(dir) ? readdirSync(dir) : [];
    for (const name of names) {
        const m = /^visual-(.+)-(\d+)$/.exec(name);
        if (!m) {
            continue;
        }
        const [, project, n] = m;
        const attempt = Number(n);
        if (out[project] && out[project].attempt > attempt) {
            continue;
        }
        const file = join(dir, name, "results.json");
        out[project] = { attempt, results: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
    }
    return out;
}

/**
 * What blocks the pull request.
 * @param {{ projects: string[], seeded: Set<string>, captures: Record<string, { attempt: number,
 *     results: object | null }> }} input every captured project, those with baselines on the base
 *     branch, and the newest capture of each
 * @returns {string[]} one line per blocked project; empty when the gate passes
 */
export function gateProblems({ projects, seeded, captures }) {
    const problems = [];
    for (const p of projects) {
        if (!seeded.has(p)) {
            continue;
        }
        const r = captures[p]?.results;
        if (!r) {
            problems.push(`${p}: no capture results (the visual job failed or uploaded nothing); re-run it`);
            continue;
        }
        if (!r.complete) {
            problems.push(`${p}: the capture did not finish (${r.items.length} of ${r.expected} items); re-run it`);
            continue;
        }
        const open = r.items.map((i) => i.status).filter((s) => !PASSING.has(s));
        if (open.length > 0) {
            // No Object.groupBy: the gate runs on the runner's own Node, which may be 20.
            const counts = new Map();
            for (const s of open) {
                counts.set(s, (counts.get(s) ?? 0) + 1);
            }
            problems.push(`${p}: ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ")} not reviewed`);
        }
    }
    return problems;
}

/**
 * The projects with at least one baseline PNG at a git ref.
 * @param {string[]} projects the project ids
 * @param {string} ref the base branch tip
 * @param {string} [cwd] the repository
 * @returns {Set<string>} the seeded ones
 */
export function seededAt(projects, ref, cwd = process.cwd()) {
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "visual-baselines/"], {
        cwd,
        encoding: "utf8",
        maxBuffer: 1 << 28,
    }).split("\n");
    return new Set(
        projects.filter((p) => files.some((f) => f.startsWith(`visual-baselines/${p}/`) && f.endsWith(".png"))),
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({ options: { captures: { type: "string" }, base: { type: "string" } } });
    if (!values.captures || !values.base) {
        console.error("usage: gate.mjs --captures <dir> --base <ref>");
        process.exit(2);
    }
    const projectsFile = join(dirname(fileURLToPath(import.meta.url)), "..", "projects.json");
    const projects = Object.keys(JSON.parse(readFileSync(projectsFile, "utf8")));
    const problems = gateProblems({
        projects,
        seeded: seededAt(projects, values.base),
        captures: newestResults(values.captures),
    });
    for (const line of problems) {
        console.log(`::error::visual changes not reviewed -- ${line}`);
    }
    if (problems.length > 0) {
        console.log("Review them with visual-review serve (visual-review/README.md).");
        process.exit(1);
    }
    console.log("No unreviewed visual changes.");
}
