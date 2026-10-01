/**
 * Fault injection for the review server: a fake GitHub ("world") the tests can change between
 * requests, an injector that fails chosen gh, git and state-file calls, a server starter that can
 * restart on the same work directory, and the invariants every fault test checks.
 *
 * The injector fails a call matched by a rule (a label pattern, optionally its Nth match), or calls
 * picked at random from a seed. A random pick hashes (seed, call label, how many times that label
 * was called), never a shared random stream, so concurrent calls that interleave differently from
 * run to run still get the same faults: a failing seed replays exactly.
 *
 * git and node:fs are reached through two vi.mock lines each test file declares (see
 * fault-journey.test.mjs), which route into fault-hooks.mjs.
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { createApp } from "../trusted/lib/serve.mjs";
import { hooks } from "./fault-hooks.mjs";
import { copyFixture, FIXTURE_CONFIG, git, job } from "./helpers.mjs";

// ---------------------------------------------------------------- the injector

/** What each kind of failure looks like, as gh and git print it. */
const MESSAGES = {
    gh: {
        network: "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
        "5xx": "HTTP 502: Bad Gateway (https://api.github.com/repos/o/r)",
        "4xx": "HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/repos/o/r)",
        timeout: "read tcp 10.0.0.2:51234->140.82.112.6:443: i/o timeout",
        "partial write": "unexpected EOF",
    },
    git: {
        network: "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
        "5xx": "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500",
        "4xx": "remote: Permission to o/r.git denied.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
        timeout:
            "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 130000 ms: Connection timed out",
        "rejected push":
            " ! [rejected]        HEAD -> feature (fetch first)\nerror: failed to push some refs to 'https://github.com/o/r.git'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. You may want to first integrate the remote changes\nhint: (e.g., 'git pull ...') before pushing again.",
        "hook refusal":
            "remote: error: GH013: Repository rule violations found for refs/heads/feature.\n ! [remote rejected] HEAD -> feature (push declined due to repository rule violations)\nerror: failed to push some refs to 'https://github.com/o/r.git'",
        "partial write": "error: unable to write file: No space left on device\nfatal: unable to write new index file",
    },
};

/**
 * The failure kinds a call can meet: a local git command never meets a network error.
 * @param {string} on gh, git or fs
 * @param {string} label the call
 * @returns {string[]} the kinds
 */
function kindsFor(on, label) {
    if (on === "gh") {
        return /^gh run download/.test(label)
            ? ["network", "5xx", "timeout", "partial write"]
            : ["network", "5xx", "4xx", "timeout"];
    }
    if (on === "git") {
        if (/^git push /.test(label)) {
            return ["network", "5xx", "4xx", "timeout", "rejected push", "hook refusal"];
        }
        if (/^git (fetch|ls-remote|lfs push) /.test(label)) {
            return ["network", "5xx", "4xx", "timeout"];
        }
        // A local command fails only when it writes (a full disk); one that only reads does not.
        return /^git (add|commit|worktree add) /.test(label) ? ["partial write"] : [];
    }
    return ["partial write", "denied"];
}

/**
 * 32-bit FNV-1a of a string, as a number in [0, 1).
 * @param {string} text the string
 * @returns {number} its hash
 */
function unit(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    }
    return (h >>> 0) / 2 ** 32;
}

/**
 * A seeded random generator (mulberry32), for a journey's own choices.
 * @param {number} seed the seed
 * @returns {() => number} the next number in [0, 1)
 */
export function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
}

const fsError = (code, text, path) => Object.assign(new Error(`${code}: ${text}, open '${path}'`), { code });

/**
 * A fault injector.
 * @param {object} [options] what to fail
 * @param {{ on: "gh" | "git" | "fs", match: RegExp | string | ((label: string) => boolean),
 *     nth?: number, kind: string, before?: () => unknown }[]} [options.rules] fail the calls whose
 *     label matches (the `nth` match only, when given) with `kind`; `stall` never answers (a git
 *     stall is a real child process that sleeps, so a timeout in exec can kill it). `before` runs
 *     first, for a test that changes the world just before a call
 * @param {number} [options.seed] the random seed
 * @param {number} [options.rate] the share of eligible calls that fail at random
 * @param {(on: string, label: string, n: number) => boolean} [options.where] which calls are
 *     eligible (`n`: how many times this label has been called, this call included)
 * @param {string[]} [options.kinds] the failure kinds a random fault may take (default: all)
 * @param {(label: string) => string} [options.normalize] strips what differs between runs (temp
 *     paths, commit shas) from a label, so a seed replays
 * @returns {object} the injector
 */
export function injector({
    rules = [],
    seed = 0,
    rate = 0,
    where = () => false,
    kinds: allowed = null,
    normalize = (l) => l,
} = {}) {
    const seen = new Map();
    const matched = rules.map(() => 0);
    const stalls = [];
    const inj = {
        /** Every call made while installed, in order: { on, label, kind } (kind null: passed). */
        log: [],
        paused: false,
        decide(on, raw) {
            const label = normalize(raw);
            const n = (seen.get(`${on} ${label}`) ?? 0) + 1;
            seen.set(`${on} ${label}`, n);
            let kind = null;
            let before = null;
            let chosen = false;
            rules.forEach((r, i) => {
                const hit =
                    r.on === on &&
                    (typeof r.match === "function"
                        ? r.match(label)
                        : typeof r.match === "string"
                          ? label.includes(r.match)
                          : r.match.test(label));
                if (hit) {
                    matched[i]++;
                    if (!chosen && (r.nth === undefined || r.nth === matched[i])) {
                        chosen = true;
                        kind = r.kind ?? null;
                        before = r.before ?? null;
                    }
                }
            });
            if (kind === null && !inj.paused && rate > 0 && where(on, label, n)) {
                const kinds = kindsFor(on, label).filter((k) => allowed === null || allowed.includes(k));
                if (kinds.length > 0 && unit(`${seed}|${on}|${label}|${n}`) < rate) {
                    kind = kinds[Math.floor(unit(`${seed}|kind|${on}|${label}|${n}`) * kinds.length)];
                }
            }
            const entry = { on, label, kind };
            inj.log.push(entry);
            return { kind, before, entry };
        },
        /**
         * Wraps a gh runner.
         * @param {Function} gh the runner
         * @returns {Function} the runner with faults
         */
        gh(gh) {
            return async (args, input) => {
                const { kind, before } = inj.decide("gh", `gh ${args.join(" ")}`);
                await before?.();
                if (kind === null) {
                    return gh(args, input);
                }
                if (kind === "stall") {
                    return new Promise((resolve) => stalls.push(resolve));
                }
                if (kind === "partial write" && args[0] === "run") {
                    // Part of the artifact extracted, then the stream broke: no results.json yet.
                    writeFileSync(join(args[6], "partial.png"), "half a PNG");
                }
                if (kind === "timeout") {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                }
                throw new Error(MESSAGES.gh[kind]);
            };
        },
        /**
         * The failures injected so far, after log entry `from`.
         * @param {number} [from] the first log entry to look at
         * @returns {object[]} the log entries that failed
         */
        faults(from = 0) {
            return inj.log.slice(from).filter((e) => e.kind !== null);
        },
        /**
         * The failures after log entry `from` that no later call with the same label recovered
         * from (a retried gh call that then answered, say).
         * @param {number} [from] the first log entry to look at
         * @returns {object[]} the log entries
         */
        unrecovered(from = 0) {
            const tail = inj.log.slice(from);
            return tail.filter(
                (e, i) => e.kind !== null && !tail.slice(i + 1).some((l) => l.label === e.label && l.kind === null),
            );
        },
        /**
         * The faults, one line each, for a failure message.
         * @param {number} [from] the first log entry to look at
         * @returns {string} the lines
         */
        trace(from = 0) {
            return inj
                .faults(from)
                .map((e) => `  ${e.kind} <- ${e.on} ${e.label}`)
                .join("\n");
        },
        install() {
            hooks.exec = (real, cmd, args, options) => {
                if (cmd !== "git") {
                    return real(cmd, args, options);
                }
                // Finish's git runs with `-c core.hooksPath=/dev/null` first; the label leaves it out.
                const shown = args.filter((a, i) => a !== "-c" && args[i - 1] !== "-c");
                const { kind, before } = inj.decide("git", `git ${shown.join(" ")}`);
                return Promise.resolve(before?.()).then(() => {
                    if (kind === null) {
                        return real(cmd, args, options);
                    }
                    if (kind === "stall") {
                        // A real child that hangs, as git waiting on a dead network or a prompt.
                        return real("sleep", ["8"], options);
                    }
                    throw new Error(MESSAGES.git[kind]);
                });
            };
            hooks.fs = (name, real, args) => {
                const path = String(args[0]);
                if (!path.includes("/state/")) {
                    return real(...args);
                }
                const { kind } = inj.decide("fs", `fs.${name} ${path}`);
                if (kind === null) {
                    return real(...args);
                }
                if (kind === "partial write" && name === "writeFileSync") {
                    real(path, String(args[1]).slice(0, Math.floor(String(args[1]).length / 2)));
                    throw fsError("ENOSPC", "no space left on device", path);
                }
                throw kind === "partial write"
                    ? fsError("EIO", "i/o error", path)
                    : fsError("EACCES", "permission denied", path);
            };
            return inj;
        },
        uninstall() {
            hooks.exec = (real, cmd, args, options) => real(cmd, args, options);
            hooks.fs = (name, real, args) => real(...args);
            for (const resolve of stalls.splice(0)) {
                resolve("");
            }
        },
    };
    return inj;
}

// ---------------------------------------------------------------- the fake GitHub

/**
 * A fake gh over plain data the test changes between requests. By default it serves pull request
 * #123 (branch feature, head `r.head`) with CI run 1000 attempt 1, both fixture projects captured.
 *
 * `data.runs` is the newest run by head sha ({ id, attempt, status, conclusion }); `data.jobs` and
 * `data.artifacts` are by run id (an artifact is a name or { name, expired }); `data.results` and
 * `data.files` override a download's results.json fields and files (by `<run id>/<artifact>`, or
 * by artifact name). A download's results.json says the run, attempt and head it came from.
 * @param {{ head: string }} r the repository
 * @returns {{ gh: Function, data: object }} the runner and its data
 */
export function world(r) {
    const data = {
        prs: [{ number: 123, head: r.head, branch: "feature" }],
        runs: { [r.head]: { id: 1000, attempt: 1 } },
        jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
        artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
        results: {},
        files: {},
        posted: [],
        calls: [],
    };
    const runFor = (id) => {
        const [head, run] = Object.entries(data.runs).find(([, x]) => String(x.id) === String(id)) ?? [];
        return run && { head, run };
    };
    const asRun = (head, x) => ({
        id: x.id,
        run_attempt: x.attempt ?? 1,
        status: x.status ?? "completed",
        conclusion: x.conclusion === undefined ? "success" : x.conclusion,
        html_url: `https://gh/runs/${x.id}`,
        head_sha: head,
    });
    const gh = async (args, input) => {
        data.calls.push(args.join(" "));
        const path = args[0] === "api" ? args[1] : "";
        let m;
        if (path.startsWith("repos/{owner}/{repo}/pulls?")) {
            return JSON.stringify(
                data.prs.map((p) => ({
                    number: p.number,
                    title: `PR ${p.number}`,
                    html_url: `https://gh/pull/${p.number}`,
                    head: { sha: p.head, ref: p.branch },
                })),
            );
        }
        if ((m = /workflows\/[^/]+\/runs\?head_sha=(\w+)/.exec(path))) {
            const x = data.runs[m[1]];
            return JSON.stringify({ workflow_runs: x ? [asRun(m[1], x)] : [] });
        }
        if ((m = /actions\/runs\/(\d+)\/attempts\/\d+\/jobs/.exec(path))) {
            return JSON.stringify({ jobs: data.jobs[m[1]] ?? [] });
        }
        if ((m = /actions\/runs\/(\d+)\/artifacts/.exec(path))) {
            const list = (data.artifacts[m[1]] ?? []).map((a) =>
                typeof a === "string" ? { name: a, expired: false } : a,
            );
            return JSON.stringify({ artifacts: list });
        }
        if ((m = /actions\/runs\/(\d+)$/.exec(path))) {
            const found = runFor(m[1]);
            return JSON.stringify(asRun(found.head, found.run));
        }
        if (args.includes("--input")) {
            data.posted.push({ path, body: JSON.parse(input ?? "{}") });
            return JSON.stringify({ html_url: `https://gh/${path}/1`, number: 1 });
        }
        if (args[0] === "run" && args[1] === "download") {
            const [id, name, dir] = [args[2], args[4], args[6]];
            const [, project, attempt] = /^visual-(.+)-(\d+)$/.exec(name);
            const head = runFor(id)?.head ?? r.head;
            const key = data.results[`${id}/${name}`] ? `${id}/${name}` : name;
            copyFixture(project, dir, {
                commit: head,
                headSha: head,
                runId: Number(id),
                runAttempt: Number(attempt),
                ...data.results[key],
            });
            for (const [file, from] of Object.entries(data.files[`${id}/${name}`] ?? data.files[name] ?? {})) {
                copyFileSync(from, join(dir, file));
            }
            return "";
        }
        throw new Error(`fake gh: unexpected ${args.join(" ")}`);
    };
    return { gh, data };
}

// ---------------------------------------------------------------- the server

/**
 * Starts the app on a random port over a repository's work directory. Starting again on the same
 * `tmp` is a restart: the state files are kept.
 * @param {{ repo: string }} r the repository
 * @param {object} options passed to createApp (gh, masterRun, ...)
 * @returns {Promise<{ api: Function, close: () => Promise<void>, origin: string, tmp: string }>}
 *     `api(method, path, body)` answers { status, body }
 */
export async function startApp(r, options) {
    const tmp = options.tmp ?? join(r.repo, "tmp/visual-review");
    const box = {};
    const server = createServer((req, res) => box.app(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const token = options.token ?? "t".repeat(43);
    try {
        box.app = createApp({ repo: r.repo, tmp, config: FIXTURE_CONFIG, token, origin, ...options });
    } catch (err) {
        server.close();
        throw err;
    }
    const api = async (method, path, body, headers = {}) => {
        const res = await fetch(`${origin}${path}`, {
            method,
            headers: { "x-review-token": token, origin, "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const type = res.headers.get("content-type") ?? "";
        return {
            status: res.status,
            body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
        };
    };
    const close = () => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(() => resolve()));
    };
    return { api, close, origin, tmp, server };
}

/**
 * Waits for the newest Finish to end, as the page does.
 * @param {{ api: Function }} s the server
 * @returns {Promise<object | null>} the ended job
 */
export async function endedJob(s) {
    for (;;) {
        const { job: j } = (await s.api("GET", "/api/finish-status")).body;
        if (!j?.running) {
            return j;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/**
 * Captures what the server logs, without printing it.
 * @param {import("vitest").vi} vi vitest's vi
 * @returns {{ lines: string[], restore: () => void }} every line written to console.error or
 *     console.warn, in order
 */
export function captureLog(vi) {
    const lines = [];
    const spies = ["error", "warn", "log"].map((m) =>
        vi.spyOn(console, m).mockImplementation((...a) => lines.push(a.join(" "))),
    );
    return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

// ---------------------------------------------------------------- the invariants

/** A broken invariant, named as the scenarios name them. */
export class Violation extends Error {}

const fail = (invariant, message) => {
    throw new Violation(`${invariant}: ${message}`);
};

/**
 * No decision is ever lost (and none comes back after an Undo): the decisions the server shows
 * for a project, and the state file on disk, are exactly the ones the API accepted.
 * @param {object} s the server
 * @param {Map<string, { decision: string, reason: string | null }>} model accepted decisions, by
 *     `<target>|<project>|<file>`
 * @param {string} id the target
 * @param {string[]} projects the projects to check through the API (others: the state file only)
 */
export async function assertDecisionsKept(s, model, id, projects) {
    const want = [...model].filter(([k]) => k.startsWith(`${id}|`));
    for (const project of projects) {
        const res = await s.api("GET", `/api/pr/${id}/${project}`);
        if (res.status !== 200) {
            continue;
        }
        const shown = Object.fromEntries(
            Object.entries(res.body.decisions).map(([f, d]) => [f, `${d.decision}:${d.reason}`]),
        );
        const expected = Object.fromEntries(
            want
                .filter(([k]) => k.startsWith(`${id}|${project}|`))
                .map(([k, d]) => [k.split("|")[2], `${d.decision}:${d.reason}`]),
        );
        if (JSON.stringify(sortKeys(shown)) !== JSON.stringify(sortKeys(expected))) {
            fail(
                "decision lost",
                `${id}/${project} shows ${JSON.stringify(sortKeys(shown))}, expected ${JSON.stringify(sortKeys(expected))}`,
            );
        }
    }
    let saved = {};
    try {
        saved = JSON.parse(readFileSync(join(s.tmp, "state", `${id}.json`), "utf8"));
    } catch {
        // No state file yet: nothing was saved.
    }
    for (const [k, d] of want) {
        const [, project, file] = k.split("|");
        const got = saved[`${project}/${file}`];
        if (got?.decision !== d.decision) {
            fail("decision lost", `state/${id}.json lacks ${project}/${file} (${d.decision}): ${JSON.stringify(got)}`);
        }
    }
    for (const key of Object.keys(saved)) {
        if (!want.some(([k]) => k === `${id}|${key.replace("/", "|")}`)) {
            fail("decision lost", `state/${id}.json holds ${key}, which was never decided or was undone`);
        }
    }
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Finish yields one whole commit or none: at most one commit past the captured head, holding
 * every accepted image and its review record, and the job says so when it pushed one.
 * @param {string} remote the bare origin
 * @param {string} branch the branch
 * @param {string} head the captured head
 * @param {object} j the ended job
 * @param {string[]} paths the baseline paths the accepts must commit
 */
export function assertOneCommitOrNone(remote, branch, head, j, paths) {
    const tip = git(remote, "rev-parse", branch);
    const added = tip === head ? [] : git(remote, "rev-list", `${head}..${tip}`).split("\n");
    if (added.length > 1) {
        fail("partial commit", `${added.length} commits pushed past the captured head`);
    }
    if (added.length === 0) {
        if (j.error === null && j.result?.commit) {
            fail("partial commit", `the job reports commit ${j.result.commit}, but nothing was pushed`);
        }
        return;
    }
    const files = git(remote, "show", "--name-only", "--format=", added[0]).split("\n");
    const missing = paths.filter((p) => !files.includes(p));
    if (missing.length > 0 || !files.some((f) => f.includes("/reviews/"))) {
        fail("partial commit", `the pushed commit lacks ${missing.join(", ") || "its review record"}`);
    }
    if (j.error !== null && !j.error.includes(added[0].slice(0, 10))) {
        fail("partial commit", `Finish pushed ${added[0].slice(0, 10)} but reported only: ${j.error}`);
    }
}

/**
 * Every failure is visible in the API response the page shows AND in the server log.
 * @param {string} what the request
 * @param {{ status: number, body: object }} res its response
 * @param {string[]} logged the server's log lines during the request
 * @param {object[]} faults the injected faults no retry recovered from
 * @param {boolean} shown whether the response reports a problem (a project's problem, a job error)
 * @param {boolean} [quietOk] accept a failure the response shows but the log does not, and a
 *     swallowed failure nothing shows (to look past them at the other invariants)
 */
export function assertVisible(what, res, logged, faults, shown = false, quietOk = false) {
    if (quietOk) {
        if (res.status >= 400 && typeof res.body?.error !== "string") {
            fail("failure invisible", `${what} answered ${res.status} without an error message`);
        }
        return;
    }
    const failed = res.status >= 400 || shown;
    if (failed && typeof res.body?.error !== "string" && !shown) {
        fail("failure invisible", `${what} answered ${res.status} without an error message`);
    }
    if (failed && faults.length === 0) {
        fail("unexpected failure", `${what} answered ${res.status} with no fault injected: ${res.body?.error}`);
    }
    if (faults.length > 0 && !failed) {
        fail(
            "failure invisible",
            `${what} answered ${res.status} as if nothing failed, after ${faults.map((f) => `${f.kind} on ${f.label}`).join("; ")}`,
        );
    }
    if (failed && logged.length === 0) {
        fail(
            "failure invisible",
            `${what} failed (${res.body?.error ?? "a problem shown"}) but the server logged nothing`,
        );
    }
}

/**
 * One target's failure never blanks other targets: every target listed before is listed again,
 * and one whose own calls did not fail keeps its run and every project that had loaded.
 * @param {Map<string, object>} before the targets listed last time, by id
 * @param {object[]} after the targets listed now
 * @param {Set<string>} faulted the ids whose own calls failed (all of them for a shared call)
 */
export function assertOthersIntact(before, after, faulted) {
    const now = new Map(after.map((t) => [t.id, t]));
    for (const [id, t] of before) {
        const n = now.get(id);
        if (!n) {
            fail("one failure blanks others", `target ${id} vanished from the list`);
        }
        if (faulted.has(id) || t.runId === null) {
            continue; // Its own calls failed, or it had not loaded: nothing of it to keep.
        }
        if (n.runId !== t.runId) {
            fail("one failure blanks others", `target ${id} went from run ${t.runId} to ${n.runId}`);
        }
        for (const p of t.projects.filter((x) => x.problem === null)) {
            const q = n.projects.find((x) => x.project === p.project);
            if (q?.problem !== null) {
                fail("one failure blanks others", `${id}/${p.project} stopped loading: ${q?.problem}`);
            }
        }
    }
}
