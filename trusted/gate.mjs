#!/usr/bin/env node
/**
 * The pull request gate: fails while a project holds visual changes the owner has not reviewed.
 *
 * It fails closed: nothing merges with an image nobody approved. Every project with baselines on the
 * base branch, and every project in the base branch's config or the pull request's, is gated, seeded
 * or not. Every story needs an approved baseline. A story with none blocks: `new` when the pull
 * request adds or changes it, `unseeded` when it looks as in master's newest capture. Either way
 * the owner accepts it (on the pull request, or by seeding it from the default branch), which
 * creates its first baseline.
 *
 * <dir> holds the downloaded `visual-<project>-<attempt>` artifacts of this CI run, every attempt
 * of it. For each project only the highest attempt counts, so re-running failed jobs (which
 * leaves the visual jobs' old attempt as the newest) can neither hide nor resurrect a capture.
 * Which projects exist and are seeded is read from <ref> (the base branch tip, fetched by the
 * caller), and so is visual-review.config.json (the projects and where the baselines live), so
 * neither deleting a project's baselines nor removing it from the config turns the gate off, and a
 * pull request that moves the baselines directory fails. The pull request's config can only add
 * projects. A gated project with no results.json, or an incomplete one, fails: a capture that
 * crashed has shown the owner nothing. An invalid results.json counts as missing. So does a story
 * compared at a diffThreshold above MAX_THRESHOLD, which would hide real changes.
 *
 * It also fails when a baseline PNG or a story's settings file differs from the base without the
 * review records added in the pull request (<baselines>/reviews/*.json) taking that path from its
 * contents on the base branch to its new ones: each record item moves a path `from` one hash `to`
 * another, replayed in `reviewedAt` order, so a record approved for other contents (an old seed,
 * a decision a later one replaced) moves nothing. Without that, committing the captured PNGs
 * straight into the baselines directory would turn the capture check green with no review at all.
 *
 * Once visual-review/passkeys.json on the base branch holds a key, every record the pull request
 * adds must also be version 2, for this pull request (`--pr`) or for none (a seed), with a passkey
 * approval by one of the base branch's keys over exactly that record (approval.mjs), and not a
 * copy of a record already on the base branch; a record that fails is reported and moves nothing.
 * Keys are never read from the pull request, a pull request that would leave no key fails, and a
 * change to passkeys.json itself needs an approved record like a baseline. Records already on the
 * base branch are never checked again. Before that, records are read but not verified, so the gate
 * proves a record names the change, not that the owner approved it (the README, "What the gate
 * does and does not guarantee").
 *
 * CI runs this file as the base branch has it, never the pull request's copy, so a pull request
 * cannot loosen the gate that judges it.
 *
 * Usage: visual-review gate --captures <dir> --base <ref> [--head <ref>] [--pr <number>], or node
 * gate.mjs with the same options. Standard library only (results.mjs, config.mjs and approval.mjs
 * have no dependencies), so it runs from a checkout of this package without an install.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PASSKEYS_FILE, parsePasskeys, recordHash, verifyRecord } from "./lib/approval.mjs";
import { loadConfigAt, repoRoot } from "./lib/config.mjs";
import { validateResults } from "./lib/results.mjs";

const PASSING = new Set(["unchanged", "excluded"]);

/**
 * The loosest diffThreshold the gate trusts, the highest a story here uses. At 1 pixelmatch counts
 * no pixel as changed, so a settings file or a story's parameters could switch comparison off.
 */
export const MAX_THRESHOLD = 0.8;

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
        let results = null;
        try {
            results = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            // Missing or not JSON: counted as missing, like any invalid results.json.
        }
        out[project] = { attempt, results };
    }
    return out;
}

/**
 * The projects the gate checks: every project with baselines at the base, and every project of the
 * base's config and of the pull request's.
 * @param {{ projects: Record<string, object> }} config the base branch's config
 * @param {Set<string>} seeded the projects with baselines at the base
 * @param {{ projects: Record<string, object> }} [headConfig] the pull request's config
 * @returns {string[]} the gated project ids
 */
export function gatedProjects(config, seeded, headConfig) {
    return [...new Set([...seeded, ...Object.keys(config.projects), ...Object.keys(headConfig?.projects ?? {})])];
}

/**
 * What blocks the pull request.
 * @param {{ config: { defaultBranch: string, baselines: string,
 *     projects: Record<string, { seedFromDefaultBranch: boolean }> },
 *     headConfig: { baselines: string, projects: Record<string, object> } | undefined, seeded: Set<string>,
 *     captures: Record<string, { attempt: number, results: object | null }> }} input the base
 *     branch's config, the pull request's config (if any), the projects with baselines on the base
 *     branch, and the newest capture of each project
 * @returns {string[]} one line per blocked project; empty when the gate passes
 */
export function gateProblems({ config, headConfig, seeded, captures }) {
    const problems = [];
    if (headConfig && headConfig.baselines !== config.baselines) {
        // Capture reads the pull request's config, so its baselines would be compared, not the base's.
        problems.push(
            `this pull request moves the baselines directory from ${config.baselines} to ${headConfig.baselines}; ` +
                "move it in a pull request of its own that changes nothing else, merged with an administrator's review",
        );
    }
    for (const p of gatedProjects(config, seeded, headConfig)) {
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
        const loose = r.items.filter((i) => i.threshold > MAX_THRESHOLD).length;
        if (loose > 0) {
            problems.push(
                `${p}: ${loose} ${loose === 1 ? "item is" : "items are"} compared at a diffThreshold above ${MAX_THRESHOLD}, ` +
                    "which hides real changes; lower it in the story's parameters or its settings file",
            );
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
 * Baseline changes between two refs that the review records added between them do not account
 * for. A changed PNG, story settings file (and, once approvals are enforced, passkeys.json) counts
 * as reviewed only when the added records' items, replayed oldest `reviewedAt` first, take it from
 * its hash on the base branch (null when absent) to its hash at the head (null when deleted); an
 * item whose `from` is not the path's current hash moves nothing. A deleted settings file and
 * renames.json need no record: the captures they cause are reviewed.
 * @param {string} base the base branch tip
 * @param {string} head the pull request's checkout
 * @param {string} [cwd] the repository
 * @param {string} [baselines] the baselines directory
 * @param {{ keys?: object[] | null, pr?: number }} [approvals] with `keys`, every added record must
 *     carry a passkey approval by one of them for pull request `pr` (verifyRecord) and not copy a
 *     record already on the base branch, or it counts for nothing
 * @returns {string[]} one line per unaccounted change; empty when every change has a record
 */
export function unrecordedChanges(base, head, cwd = process.cwd(), baselines = "visual-baselines", approvals = {}) {
    const enforced = Boolean(approvals.keys);
    const fields = gitOut(cwd, [
        "diff",
        "-z",
        "--no-renames",
        "--name-status",
        base,
        head,
        "--",
        `${baselines}/`,
        ...(enforced ? [PASSKEYS_FILE] : []),
    ])
        .toString("utf8")
        .split("\0");
    const show = (ref, path) => gitOut(cwd, ["show", `${ref}:${path}`]);
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
        } else if (
            path.endsWith(".png") ||
            path === PASSKEYS_FILE ||
            (path.endsWith(".json") && status !== "D" && !path.endsWith("/renames.json"))
        ) {
            const hash = path.endsWith(".png") ? contentHash : sha256;
            changed.push({
                path,
                from: status === "A" ? null : hash(show(base, path)),
                to: status === "D" ? null : hash(show(head, path)),
            });
        }
    }
    let onBase = null;
    const entries = [];
    for (const path of records) {
        const record = parseOr(show(head, path));
        if (enforced) {
            let why = record === null ? "not valid JSON" : verifyRecord(record, approvals.keys, { pr: approvals.pr });
            if (!why) {
                onBase ??= baseRecordHashes(base, cwd, baselines);
                if (onBase.has(recordHash(record).toString("hex"))) {
                    why = "a copy of a record already on the base branch: an approval counts once";
                }
            }
            if (why) {
                problems.push(`${path}: ${why}`);
                continue;
            }
        }
        const items = record?.items;
        entries.push({ at: String(record?.reviewedAt ?? ""), items: Array.isArray(items) ? items : [] });
    }
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const missing = changed.filter((c) => {
        let now = c.from;
        for (const { items } of entries) {
            for (const item of items) {
                if (item?.path === c.path && (item.from ?? null) === now) {
                    now = item.to ?? null;
                }
            }
        }
        return now !== c.to;
    });
    for (const { path } of missing.slice(0, 20)) {
        problems.push(
            path === PASSKEYS_FILE
                ? `${path}: changed with no record approved by a key on the base branch; once a key is registered, adding or replacing one is merged by an administrator (the README, "Replacing the passkey")`
                : `${path}: changed with no review record taking it from its base branch contents to these`,
        );
    }
    if (missing.length > 20) {
        problems.push(`... and ${missing.length - 20} more baseline files with no review record`);
    }
    return problems;
}

/**
 * The record hashes of the version 2 records on the base branch.
 * @param {string} base the base branch tip
 * @param {string} cwd the repository
 * @param {string} baselines the baselines directory
 * @returns {Set<string>} hex hashes
 */
function baseRecordHashes(base, cwd, baselines) {
    const out = new Set();
    const files = gitOut(cwd, ["ls-tree", "-r", "--name-only", base, "--", `${baselines}/reviews/`])
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
    for (const path of files) {
        const r = parseOr(gitOut(cwd, ["show", `${base}:${path}`]));
        if (r?.version === 2) {
            try {
                out.add(recordHash(r).toString("hex"));
            } catch {
                // A number canonical() refuses: no approval can cover it, so nothing can copy it.
            }
        }
    }
    return out;
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

/**
 * A file at a git ref, or null when the ref does not hold it.
 * @param {string} ref the commit
 * @param {string} path the path
 * @param {string} cwd the repository
 * @returns {string | null} its text
 */
function fileAt(ref, path, cwd) {
    const listed = gitOut(cwd, ["ls-tree", "--name-only", ref, "--", path]).toString("utf8").trim();
    return listed === "" ? null : gitOut(cwd, ["show", `${ref}:${path}`]).toString("utf8");
}

/**
 * Whether approvals are enforced, and the keys they must come from: those of passkeys.json on the
 * base branch, never the pull request's. Absent, or with no key, enforcement is off.
 * @param {string} base the base branch tip
 * @param {string} head the pull request's checkout
 * @param {number | undefined} pr the pull request (`--pr`)
 * @param {string} [cwd] the repository
 * @returns {{ keys: object[] | null, problems: string[] }} the keys (null when off), and what fails
 *     the gate: an invalid base file, no `--pr`, or a pull request that would switch enforcement off
 */
export function approvalKeys(base, head, pr, cwd = process.cwd()) {
    const text = fileAt(base, PASSKEYS_FILE, cwd);
    let keys = [];
    try {
        keys = text === null ? [] : parsePasskeys(text);
    } catch (err) {
        return { keys: null, problems: [`${PASSKEYS_FILE} on the base branch is invalid: ${err.message}`] };
    }
    if (keys.length === 0) {
        return { keys: null, problems: [] };
    }
    const problems = [];
    if (pr === undefined) {
        problems.push(
            `approvals are enforced (${PASSKEYS_FILE} on the base branch holds a key), so the gate needs --pr <number>`,
        );
    }
    let left = 0;
    try {
        const own = fileAt(head, PASSKEYS_FILE, cwd);
        left = own === null ? 0 : parsePasskeys(own).length;
    } catch {
        // Invalid: counts as no key.
    }
    if (left === 0) {
        problems.push(
            `this pull request would switch approval enforcement off: its ${PASSKEYS_FILE} is missing, invalid or holds no key`,
        );
    }
    return { keys, problems };
}

/**
 * The files a pull request could loosen the gate with: passkeys.json, the tool's trusted code and
 * its capture, and the workflow that runs them. A change to one is a warning, never a failure (CI
 * runs the base branch's copy of the code, and work on the tool changes it), so code review looks
 * at it.
 * @param {string} base the base branch tip
 * @param {string} head the pull request's checkout
 * @param {string} workflow the workflow file that runs the gate
 * @param {string} [cwd] the repository
 * @returns {string[]} the changed ones
 */
export function trustFilesChanged(base, head, workflow, cwd = process.cwd()) {
    const files = [PASSKEYS_FILE, "visual-review/trusted/", "visual-review/capture/", `.github/workflows/${workflow}`];
    return gitOut(cwd, ["diff", "--name-only", base, head, "--", ...files])
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
}

export const GATE_USAGE = `usage: visual-review gate --captures <dir> --base <ref> [--head <ref>] [--pr <number>]

Fails (exit 1) while a pull request holds visual changes nobody accepted, or a baseline change
with no review record. Once ${PASSKEYS_FILE} on the base branch holds a key, every review
record the pull request adds must also carry a passkey approval for this pull request. Run it in
CI after the capture jobs, on the pull request's merge commit.

  --captures <dir>  the downloaded visual-<project>-<attempt> artifacts of this run
  --base <ref>      the base branch tip (HEAD^1 on a pull request's merge commit)
  --head <ref>      the pull request's checkout (default HEAD)
  --pr <number>     the pull request's number (required once approvals are enforced)`;

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
            pr: { type: "string" },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log(GATE_USAGE);
        return 0;
    }
    const pr = values.pr === undefined ? undefined : Number(values.pr);
    if (!values.captures || !values.base || (pr !== undefined && !(Number.isInteger(pr) && pr > 0))) {
        console.error(GATE_USAGE);
        return 2;
    }
    const root = repoRoot();
    const config = loadConfigAt(values.base, root);
    const seeded = seededAt(values.base, root, config.baselines);
    const headConfig = loadConfigAt(values.head, root);
    const problems = gateProblems({ config, headConfig, seeded, captures: newestResults(values.captures) });
    for (const line of problems) {
        console.log(`::error::visual changes not accepted -- ${line}`);
    }
    const { keys, problems: approval } = approvalKeys(values.base, values.head, pr, root);
    for (const line of approval) {
        console.log(`::error::passkey approval -- ${line}`);
    }
    const unrecorded = unrecordedChanges(values.base, values.head, root, config.baselines, { keys, pr });
    for (const line of unrecorded) {
        console.log(`::error::baseline without a review -- ${line}`);
    }
    for (const file of trustFilesChanged(values.base, values.head, config.workflow, root)) {
        console.log(
            `::warning::this pull request changes ${file}, which decides what the visual gate accepts: review that change with care`,
        );
    }
    if (problems.length + approval.length + unrecorded.length > 0) {
        console.log("Review them with `visual-review serve` (the @graphty/visual-review README).");
        return 1;
    }
    console.log("No unaccepted visual changes, and every baseline change has a review record.");
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = runGate(process.argv.slice(2));
}
