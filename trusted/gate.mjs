#!/usr/bin/env node
/**
 * The pull request gate: fails while a project holds visual changes the owner has not reviewed.
 *
 * It fails closed. Every project in the base branch's config is gated, seeded or not, unless its
 * config says `"gate": false`, and a project with baselines on the base branch is gated even then.
 * Seeding is per story, so a project can hold stories with no baseline yet. Those that the pull
 * request did not change are `unseeded` (capture compared them with master's newest capture) and
 * pass; a story the pull request adds or changes is `new` and blocks until the owner accepts it
 * there, which creates its first baseline. In a project with no baselines at all, every story the
 * pull request changes is `new`, so such a pull request blocks until the project is seeded.
 *
 * <dir> holds the downloaded `visual-<project>-<attempt>` artifacts of this CI run, every attempt
 * of it. For each project only the highest attempt counts, so re-running failed jobs (which
 * leaves the visual jobs' old attempt as the newest) can neither hide nor resurrect a capture.
 * Which projects exist and are seeded is read from <ref> (the base branch tip, fetched by the
 * caller), not from the pull request, and so is visual-review.config.json (the projects, their
 * `gate` switch, where the baselines live), so neither deleting a project's baselines, nor
 * removing it from the config, nor moving the baselines directory in the pull request turns the
 * gate off. A gated project with no results.json, or an incomplete one, fails: a capture that
 * crashed has shown the owner nothing. An invalid results.json counts as missing.
 *
 * It also fails when a baseline PNG, or a settings file that excludes a story, differs from the
 * base without a review record added in the pull request (<baselines>/reviews/*.json) naming
 * that path and its new hash. Without that, committing the captured PNGs straight into
 * the baselines directory would turn the capture check green with no review at all. Only a
 * record's items[].path and items[].to are read, so this proves a record names the change, not
 * that Finish wrote it or the owner pressed it (the README, "What the gate does and does not
 * guarantee").
 *
 * Usage: visual-review gate --captures <dir> --base <ref> [--head <ref>], or node gate.mjs with
 * the same options. Standard library only (results.mjs and config.mjs have no dependencies), so
 * it runs from a checkout of this package without an install.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfigAt, repoRoot } from "./lib/config.mjs";
import { validateResults } from "./lib/results.mjs";

const PASSING = new Set(["unchanged", "excluded", "unseeded"]);

/**
 * The newest attempt's results.json of every project in a directory of downloaded artifacts.
 * @param {string} dir the download directory, one subdirectory per artifact
 * @returns {Record<string, { attempt: number, results: object | null }>} by project
 */
export function newestResults(dir) {
    /** @type {Record<string, { attempt: number, results: object | null }>} */
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
 * The projects the gate checks: every project with baselines at the base, and every project of the
 * base's config that does not say `"gate": false`.
 * @param {{ projects: Record<string, { gate: boolean }> }} config the base branch's config
 * @param {Set<string>} seeded the projects with baselines at the base
 * @returns {string[]} the gated project ids
 */
export function gatedProjects(config, seeded) {
    const configured = Object.entries(config.projects).filter(([, p]) => p.gate !== false);
    return [...new Set([...seeded, ...configured.map(([id]) => id)])];
}

/**
 * What blocks the pull request.
 * @param {{ config: { defaultBranch: string, projects: Record<string, { gate: boolean,
 *     seedFromDefaultBranch: boolean }> }, seeded: Set<string>, captures: Record<string,
 *     { attempt: number, results: object | null }> }} input the base branch's config, the projects
 *     with baselines on the base branch, and the newest capture of each project
 * @returns {string[]} one line per blocked project; empty when the gate passes
 */
export function gateProblems({ config, seeded, captures }) {
    const problems = [];
    for (const p of gatedProjects(config, seeded)) {
        const r = captures[p]?.results;
        if (!r) {
            problems.push(`${p}: no capture results (the visual job failed or uploaded nothing); re-run it`);
            continue;
        }
        const invalid = validateResults(r);
        if (invalid.length > 0) {
            problems.push(`${p}: results.json is invalid (${invalid[0]}); re-run the visual job`);
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
            const what = [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
            problems.push(`${p}: ${what} ${seeded.has(p) ? NOT_ACCEPTED : notSeeded(config, p)}`);
        }
    }
    return problems;
}

const NOT_ACCEPTED = "(not accepted; a rejected item needs a code change, not another review)";

/**
 * Why an unseeded project blocks, and how to seed it.
 * @param {{ defaultBranch: string, projects: Record<string, { seedFromDefaultBranch: boolean }> }} config the
 *     base branch's config
 * @param {string} p the project
 * @returns {string} the rest of the gate's line
 */
function notSeeded(config, p) {
    const branch = config.defaultBranch;
    const here = "accept them on this pull request with `visual-review serve`";
    if (config.projects[p]?.seedFromDefaultBranch === false) {
        return `(not accepted; ${p} has no baselines on ${branch} yet, so ${here} to create its first ones)`;
    }
    return (
        `(not accepted; ${p} has no baselines on ${branch} yet. Seed it: capture a known-good commit with ` +
        `\`gh workflow run visual-seed.yml --ref ${branch} -f ref=<sha>\` (or take ${branch}'s newest run), ` +
        `review that run with \`visual-review serve --master-run <run id>\` and merge the seed pull ` +
        `request, then merge ${branch} into this branch; or ${here})`
    );
}

const gitOut = (cwd, args) => execFileSync("git", args, { cwd, maxBuffer: 1 << 28 });

/**
 * Baseline changes between two refs that no review record added between them accounts for.
 * @param {string} base the base branch tip
 * @param {string} head the pull request's checkout
 * @param {string} [cwd] the repository
 * @param {string} [baselines] the baselines directory
 * @returns {string[]} one line per unaccounted change; empty when every change has a record
 */
export function unrecordedChanges(base, head, cwd = process.cwd(), baselines = "visual-baselines") {
    const fields = gitOut(cwd, ["diff", "-z", "--no-renames", "--name-status", base, head, "--", `${baselines}/`])
        .toString("utf8")
        .split("\0");
    const show = (path) => gitOut(cwd, ["show", `${head}:${path}`]);
    const problems = [];
    const records = [];
    const changed = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const [status, path] = [fields[i], fields[i + 1]];
        if (path.startsWith(`${baselines}/reviews/`)) {
            if (status === "A") {
                records.push(path);
            } else {
                problems.push(`${path}: review records are append-only, but this one was changed or deleted`);
            }
        } else if (path.endsWith(".png")) {
            changed.push({ path, hash: status === "D" ? null : contentHash(show(path)) });
        } else if (path.endsWith(".json") && status !== "D") {
            // ponytail: only settings that exclude a story need a record. Any other settings edit,
            // and deleting a settings file, passes: the capture it causes is itself reviewed.
            const bytes = show(path);
            if (parseOr(bytes)?.disableSnapshot === true) {
                changed.push({ path, hash: sha256(bytes) });
            }
        }
    }
    const reviewed = new Set();
    for (const path of records) {
        const items = parseOr(show(path))?.items;
        for (const item of Array.isArray(items) ? items : []) {
            reviewed.add(`${item?.path}\0${item?.to ?? null}`);
        }
    }
    const missing = changed.filter((c) => !reviewed.has(`${c.path}\0${c.hash}`)).map((c) => c.path);
    for (const path of missing.slice(0, 20)) {
        problems.push(`${path}: changed with no review record naming its new contents`);
    }
    if (missing.length > 20) {
        problems.push(`... and ${missing.length - 20} more baseline files with no review record`);
    }
    return problems;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The SHA-256 of the file a blob stands for. Baseline PNGs are Git LFS pointers in git, and a
 * pointer names its object's SHA-256 (`oid sha256:<hex>`), which is the PNG's own hash, so no
 * LFS object is ever downloaded to check a record. Any other blob is hashed as it is.
 * @param {Buffer} bytes the blob
 * @returns {string} the hex SHA-256 of the content
 */
export function contentHash(bytes) {
    const text = bytes.subarray(0, 200).toString("latin1");
    const oid = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\n/.exec(text);
    return oid ? oid[1] : sha256(bytes);
}

function parseOr(bytes) {
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch {
        return null;
    }
}

/**
 * The projects with at least one baseline PNG at a git ref: the directories under the baselines
 * directory at the base tip. They are gated whatever the config says.
 * @param {string} ref the base branch tip
 * @param {string} [cwd] the repository
 * @param {string} [baselines] the baselines directory
 * @returns {Set<string>} the seeded ones
 */
export function seededAt(ref, cwd = process.cwd(), baselines = "visual-baselines") {
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", `${baselines}/`], {
        cwd,
        encoding: "utf8",
        maxBuffer: 1 << 28,
    }).split("\n");
    const prefix = `${baselines}/`;
    return new Set(
        files
            .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
            .map((f) => f.slice(prefix.length).split("/"))
            .filter((parts) => parts.length > 1)
            .map((parts) => parts[0]),
    );
}

export const GATE_USAGE = `usage: visual-review gate --captures <dir> --base <ref> [--head <ref>]

Fails (exit 1) while a pull request holds visual changes nobody accepted, or a baseline change
with no review record. Run it in CI after the capture jobs, on the pull request's merge commit.

  --captures <dir>  the downloaded visual-<project>-<attempt> artifacts of this run
  --base <ref>      the base branch tip (HEAD^1 on a pull request's merge commit)
  --head <ref>      the pull request's checkout (default HEAD)`;

/**
 * The gate as a command.
 * @param {string[]} args the command line after "gate"
 * @returns {number} the exit code
 */
export function runGate(args) {
    const { values } = parseArgs({
        args,
        options: {
            captures: { type: "string" },
            base: { type: "string" },
            head: { type: "string", default: "HEAD" },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log(GATE_USAGE);
        return 0;
    }
    if (!values.captures || !values.base) {
        console.error(GATE_USAGE);
        return 2;
    }
    const root = repoRoot();
    const config = loadConfigAt(values.base, root);
    const seeded = seededAt(values.base, root, config.baselines);
    const problems = gateProblems({ config, seeded, captures: newestResults(values.captures) });
    for (const line of problems) {
        console.log(`::error::visual changes not accepted -- ${line}`);
    }
    const unrecorded = unrecordedChanges(values.base, values.head, root, config.baselines);
    for (const line of unrecorded) {
        console.log(`::error::baseline without a review -- ${line}`);
    }
    if (problems.length + unrecorded.length > 0) {
        console.log("Review them with `visual-review serve` (the @graphty/visual-review README).");
        return 1;
    }
    console.log("No unaccepted visual changes, and every baseline change has a review record.");
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = runGate(process.argv.slice(2));
}
