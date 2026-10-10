/*
 * Seeded random journeys through the review server, as the owner uses it: load the targets, open
 * projects, decide, undo, Accept all, restart the server, and finally Finish, with gh, git and the
 * state file failing at random. The invariants (faults.mjs) are checked after every step.
 *
 * A journey that breaks one returns its seed, its steps and the faults it met; the same seed
 * replays the same faults. To replay one with the server's log shown:
 *   FAULT_SEED=7 pnpm exec vitest run test/fault-journey.test.mjs
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { withRetries } from "../trusted/lib/github.mjs";
import { hooks } from "./fault-hooks.mjs";
import {
    assertDecisionsKept,
    assertOneCommitOrNone,
    assertOthersIntact,
    assertVisible,
    captureLog,
    endedJob,
    injector,
    random,
    startApp,
    Violation,
    world,
} from "./faults.mjs";
import { git, isolateGit, job, keepTiles, makeRepo, seedTiles } from "./helpers.mjs";

vi.mock("node:fs", async (importOriginal) => (await import("./fault-hooks.mjs")).faultyFs(await importOriginal()));
vi.mock("../trusted/lib/github.mjs", async (importOriginal) =>
    (await import("./fault-hooks.mjs")).faultyGithub(await importOriginal()),
);

isolateGit();

const REVIEWABLE = new Set(["changed", "moved", "new", "removed", "unstable", "failed"]);
const DECIDABLE = new Set(["changed", "moved", "new", "removed"]);
const PROJECTS = ["compact-mantine", "graphty-element"];
const OTHER = "4".repeat(40);
// The git commands whose answer is the same until git next writes: reads of refs, objects and
// git's config (git-lfs's too), a diff between two commits (no working tree), and a fetch, since
// the remote changes only when this journey pushes. Every other git command is a write, and
// forgets every answer but the config's. A fetch git runs and that succeeds changes refs, so it
// forgets the reads, but no other fetch: one fetch's refspecs are not another's. The injector
// decides its faults before this, so remembering changes no fault and no answer; it only saves
// git processes. On a busy machine each costs tens of milliseconds, and a journey's page loads
// repeated about a hundred of them, most of its five seconds.
const READS = new Set(["ls-tree", "show", "cat-file", "merge-base", "rev-parse", "rev-list", "log", "for-each-ref"]);
const kindOf = (args) => {
    // Finish's git runs with `-c core.hooksPath=/dev/null` first.
    const [command, ...rest] = args.filter((a, i) => a !== "-c" && args[i - 1] !== "-c");
    if (
        (command === "config" && rest.includes("--get")) ||
        (command === "lfs" && rest[0] === "env") ||
        command === "check-ref-format"
    ) {
        return "config";
    }
    if (command === "fetch") {
        return "fetch";
    }
    return READS.has(command) || (command === "diff" && rest.some((a) => a.includes("..."))) ? "read" : "write";
};

/**
 * `exec` with every git read and fetch answered from memory after the first time, until git next
 * writes.
 * @param {Map<string, { out?: string, err?: Error, kind: string }>} memory the answers, by working
 *     directory and arguments
 * @returns {(real: Function, cmd: string, args: string[], options: object) => Promise<string>} it
 */
const remembering = (memory) => {
    // Writes running now: an answer read while one runs may be from before it, so none is kept.
    let writing = 0;
    const forget = (kinds) => {
        for (const [key, answer] of memory) {
            if (kinds.includes(answer.kind)) {
                memory.delete(key);
            }
        }
    };
    return (real, cmd, args, options = {}) => {
        const kind = cmd === "git" ? kindOf(args) : null;
        if (kind === null) {
            return real(cmd, args, options);
        }
        const key = `${options.cwd}\0${args.join("\0")}`;
        const known = memory.get(key);
        if (known) {
            return known.err ? Promise.reject(known.err) : Promise.resolve(known.out);
        }
        const forgets = kind === "write" ? ["read", "fetch"] : kind === "fetch" ? ["read"] : [];
        const changes = forgets.length > 0;
        if (kind === "write") {
            forget(forgets);
        }
        writing += changes ? 1 : 0;
        const settle = (answer) => {
            if (changes) {
                writing--;
                // A fetch that failed changed no ref (a pull request head GitHub does not have).
                if (kind === "write" || !answer.err) {
                    forget(forgets);
                }
            }
            if (kind !== "write" && writing === 0) {
                memory.set(key, { ...answer, kind });
            }
        };
        return real(cmd, args, options).then(
            (out) => {
                settle({ out });
                return out;
            },
            (err) => {
                settle({ err });
                throw err;
            },
        );
    };
};

// One repository for every journey, copied for each: making it costs more git processes than a
// journey's reads. Its two directories hold one absolute path, the remote's in the clone's config.
// Its tmp directory holds the captures' grid tiles, which every journey's server would otherwise
// make again in child processes: more CPU than the journey's own.
let template;
beforeAll(async () => {
    template = makeRepo();
    git(template.repo, "push", "-q", "origin", "feature:refs/heads/other");
    const token = "t".repeat(43);
    const s = await startApp(freshRepo(), { gh: world(template).gh, token, patience: Infinity });
    try {
        seedTiles(await keepTiles({ ...s, token }, 123), join(template.repo, "tmp/visual-review"));
    } finally {
        await s.close();
    }
    // One journey before the tests, its result unchecked: the server code's first run, and the
    // thumbnail processes it starts, cost the first test half a second the others do not pay.
    await walk({ stopped: false }, 0);
});
function freshRepo() {
    const dir = mkdtempSync(join(tmpdir(), "vr-journey-"));
    cpSync(template.dir, dir, { recursive: true });
    const config = join(dir, "repo/.git/config");
    writeFileSync(config, readFileSync(config, "utf8").replaceAll(template.remote, join(dir, "remote.git")));
    return { ...template, dir, repo: join(dir, "repo"), remote: join(dir, "remote.git") };
}

const RANDOM_STEPS = ["load", "open", "decide", "decide", "decide", "undo", "acceptAll", "restart"];

/**
 * The journey running now. A test that times out leaves its journey running, and that journey's
 * faults, server log and teardown landed in the next test's (a "failure invisible" there), so
 * afterEach stops it at its next step and waits for it to end.
 * @type {{ stopped: boolean, done: Promise<unknown> } | null}
 */
let current = null;

/**
 * One journey, which afterEach can stop: see `walk`.
 * @param {...any} args walk's, after the first
 * @returns {ReturnType<typeof walk>} walk's
 */
function journey(...args) {
    const run = { stopped: false, done: null };
    run.done = walk(run, ...args);
    current = run;
    return run.done;
}

afterEach(async () => {
    if (current) {
        current.stopped = true;
        await current.done.catch(() => {});
        current = null;
    }
    vi.restoreAllMocks();
});

/**
 * One journey: two pull requests (#123 is finished at the end, #124 is only reviewed).
 * @param {{ stopped: boolean }} run set `stopped` to end it before its next step
 * @param {number} seed picks the steps and the faults
 * @param {object} [faults] the injector's random faults: `rate`, `where`, `kinds`; `quiet` looks
 *     past failures that are shown but not logged, or swallowed, to the other invariants
 * @param {number} [length] how many random steps come before Finish
 * @returns {Promise<{ violation: string | null, steps: string[], faults: string[], log: string[] }>}
 *     the first broken invariant, what each step answered, the faults met (sorted) and the log
 */
async function walk(run, seed, faults = {}, length = 9) {
    const pick = random(seed);
    const choose = (list) => (list.length === 0 ? undefined : list[Math.floor(pick() * list.length)]);
    const r = freshRepo();
    const w = world(r);
    w.data.prs.push({ number: 124, head: OTHER, branch: "other" });
    w.data.runs[OTHER] = { id: 1001, attempt: 1 };
    w.data.jobs[1001] = [job("compact-mantine"), job("graphty-element")];
    w.data.artifacts[1001] = ["visual-compact-mantine-1", "visual-graphty-element-1"];

    const where = faults.where ?? (() => false);
    const quiet = faults.quiet === true;
    const inj = injector({
        seed,
        rate: faults.rate ?? 0,
        kinds: faults.kinds ?? null,
        where,
        normalize: (l) =>
            l
                .replaceAll(r.dir, "<dir>")
                .replaceAll(r.head, "<head>")
                .replaceAll(r.master, "<master>")
                .replace(/\.part-\w+/g, ".part-*")
                .replace(/\b(?!4{40}\b)[0-9a-f]{40}\b/g, "<sha>"),
    }).install();
    const injected = hooks.exec;
    const remember = remembering(new Map());
    hooks.exec = (real, cmd, args, options) => injected((c, a, o) => remember(real, c, a, o), cmd, args, options);
    const log = captureLog(vi);
    // A page load waits for the captures to download, however long that takes: with the server's
    // one second, a download slowed by a busy machine went on after its step had been checked,
    // and the failure it met was logged in the next step's window.
    const options = { gh: withRetries(inj.gh(w.gh), [0, 0, 0]), retryDelays: [0, 0, 0], patience: Infinity };
    let s = await startApp(r, options);

    /** Decisions the API accepted, by `<target>|<project>|<file>`. */
    const model = new Map();
    /** The items of each project last opened, by `<target>|<project>`. */
    const views = new Map();
    let listed = new Map();
    const steps = [];
    const mark = () => ({ log: inj.log.length, lines: log.lines.length });
    const since = (m) => ({ faults: inj.unrecovered(m.log), lines: log.lines.slice(m.lines) });
    const faultedIds = (list) => {
        const ids = new Set();
        for (const f of list) {
            if (/\b1001\b|4{40}/.test(f.label)) {
                ids.add("124");
            } else if (/\b1000\b|<head>/.test(f.label)) {
                ids.add("123");
            } else {
                ids.add("123").add("124");
            }
        }
        return ids;
    };
    const loaded = (id, project) => listed.get(id)?.projects.find((p) => p.project === project)?.problem === null;

    async function check() {
        inj.paused = true;
        try {
            for (const id of ["123", "124"]) {
                await assertDecisionsKept(
                    s,
                    model,
                    id,
                    PROJECTS.filter((p) => views.has(`${id}|${p}`) && loaded(id, p)),
                );
            }
        } finally {
            inj.paused = false;
        }
    }

    // A write, and the same write again when it failed: a retried operation must be safe.
    async function send(path, body, onOk) {
        for (const attempt of ["", " (retried)"]) {
            const m = mark();
            const res = await s.api("POST", path, body);
            if (res.status === 200) {
                onOk(res.body);
                return `${res.status}${attempt}`;
            }
            const got = since(m);
            assertVisible(`POST ${path}${attempt}`, res, got.lines, got.faults, false, quiet);
        }
        return "failed twice";
    }

    const viewOf = () => choose([...views.keys()].filter((v) => loaded(...v.split("|"))));

    const act = {
        async load() {
            const m = mark();
            const res = await s.api("GET", "/api/prs");
            const got = since(m);
            if (res.status !== 200) {
                assertVisible("GET /api/prs", res, got.lines, got.faults, false, quiet);
                return res.status;
            }
            // Shown: a project's problem, a target kept from before with why it was not refreshed,
            // or the pull request list that could not be read.
            const shown =
                res.body.warning !== null ||
                res.body.targets.some((t) => t.warnings.length > 0 || t.projects.some((p) => p.problem !== null));
            assertVisible("GET /api/prs", res, got.lines, got.faults, shown, quiet);
            assertOthersIntact(listed, res.body.targets, faultedIds(got.faults));
            listed = new Map(res.body.targets.map((t) => [t.id, t]));
            return res.status;
        },
        async open() {
            const t = choose([...listed.values()]);
            const p = t && choose(t.projects.filter((x) => x.problem === null && x.reviewable > 0));
            if (!p) {
                return act.load();
            }
            const m = mark();
            const res = await s.api("GET", `/api/pr/${t.id}/${p.project}`);
            if (res.status === 200) {
                views.set(`${t.id}|${p.project}`, res.body.items);
            } else {
                const got = since(m);
                assertVisible(`GET /api/pr/${t.id}/${p.project}`, res, got.lines, got.faults, false, quiet);
            }
            return res.status;
        },
        async decide() {
            const view = viewOf();
            if (!view) {
                return act.open();
            }
            const [id, project] = view.split("|");
            const item = choose(
                views.get(view).filter((i) => REVIEWABLE.has(i.status) && !model.has(`${view}|${i.file}`)),
            );
            if (!item) {
                return "nothing to decide";
            }
            const decision = DECIDABLE.has(item.status) ? choose(["accept", "accept", "reject", "exclude"]) : "exclude";
            const reason = decision === "accept" ? null : `seed ${seed} says no`;
            const body = { id, project, file: item.file, decision, reason };
            return send("/api/decide", body, () => model.set(`${view}|${item.file}`, { decision, reason }));
        },
        async undo() {
            const key = choose([...model.keys()].filter((k) => loaded(...k.split("|").slice(0, 2))));
            if (!key) {
                return "nothing to undo";
            }
            const [id, project, file] = key.split("|");
            return send("/api/decide", { id, project, file, decision: null }, () => model.delete(key));
        },
        async acceptAll() {
            const view = viewOf();
            if (!view) {
                return act.open();
            }
            const [id, project] = view.split("|");
            const fresh = views.get(view).filter((i) => DECIDABLE.has(i.status) && !model.has(`${view}|${i.file}`));
            return send("/api/accept-all", { id, project }, (body) => {
                if (body.accepted !== fresh.length) {
                    throw new Violation(
                        `wrong verdict: Accept all accepted ${body.accepted}, ${fresh.length} were undecided`,
                    );
                }
                for (const i of fresh) {
                    model.set(`${view}|${i.file}`, { decision: "accept", reason: null });
                }
            });
        },
        async restart() {
            await s.close();
            s = await startApp(r, options);
            return "restarted";
        },
    };

    async function finishOnce() {
        const mine = [...model].filter(([k]) => k.startsWith("123|"));
        const itemOf = (k) => views.get(k.split("|").slice(0, 2).join("|"))?.find((i) => i.file === k.split("|")[2]);
        const paths = mine
            .filter(([k, d]) => d.decision === "accept" && itemOf(k)?.status !== "removed")
            .map(([k]) => `visual-baselines/${k.split("|")[1]}/${k.split("|")[2]}`);
        const m = mark();
        const res = await s.api("POST", "/api/finish", { id: "123" });
        const j = res.status === 202 ? await endedJob(s) : null;
        const got = since(m);
        if (!j) {
            assertVisible("POST /api/finish", res, got.lines, got.faults, false, quiet);
            return { status: res.status, error: res.body.error };
        }
        assertOneCommitOrNone(r.remote, "feature", r.head, j, paths);
        const problem = j.error ?? j.result?.statusError ?? (j.warnings.join("; ") || null);
        assertVisible(
            "Finish",
            { status: 202, body: { error: problem } },
            got.lines,
            got.faults,
            problem !== null,
            quiet,
        );
        // What Finish pushed stays shown, marked finished, until a new CI run replaces the capture.
        return { status: res.status, error: j.error };
    }

    const halt = () => {
        if (run.stopped) {
            throw new Error("stopped: its test ended");
        }
    };

    try {
        steps.push(`load ${await act.load()}`);
        await check();
        for (let i = 0; i < length; i++) {
            halt();
            const name = choose(RANDOM_STEPS);
            steps.push(`${name} ${await act[name]()}`);
            await check();
        }
        halt();
        if ([...model.keys()].some((k) => k.startsWith("123|"))) {
            let out = await finishOnce();
            steps.push(`finish ${out.status} ${(out.error ?? "").replaceAll(r.dir, "<dir>")}`.trim());
            if (out.error) {
                out = await finishOnce();
                steps.push(`finish again ${out.status} ${(out.error ?? "").replaceAll(r.dir, "<dir>")}`.trim());
            }
        }
        halt();
        steps.push(`load ${await act.load()}`);
        await check();
        return { violation: null, steps, faults: inj.trace().split("\n").filter(Boolean).sort(), log: log.lines };
    } catch (err) {
        if (!(err instanceof Violation)) {
            throw err;
        }
        return {
            violation: `seed ${seed}, step ${steps.length + 1}: ${err.message}\nsteps: ${steps.join(", ")}\nfaults:\n${inj.trace()}`,
            steps,
            faults: inj.trace().split("\n").filter(Boolean).sort(),
            log: log.lines,
        };
    } finally {
        inj.uninstall();
        log.restore();
        await s.close();
    }
}

const only = process.env.FAULT_SEED ? [Number(process.env.FAULT_SEED)] : null;
const report = (out) => {
    if (only && out.violation) {
        console.error(`${out.violation}\nserver log:\n${out.log.join("\n")}`);
    }
    return out.violation;
};

describe("random journeys", () => {
    it.each(only ?? [1, 2, 3, 4])("keeps every invariant with nothing failing (seed %i)", async (seed) => {
        expect(report(await journey(seed))).toBeNull();
    });

    it.each(only ?? [5, 6, 7, 8])(
        "keeps every invariant when every gh failure is one a retry recovers from (seed %i)",
        async (seed) => {
            const transient = {
                rate: 0.3,
                kinds: ["network", "5xx", "timeout"],
                where: (on, _, n) => on === "gh" && n <= 2,
            };
            const out = await journey(seed, transient);
            expect(out.faults.length).toBeGreaterThan(0);
            expect(report(out)).toBeNull();
        },
    );

    // Three random steps, then Finish twice over a failing push: every kind of call a journey
    // makes, at a third of the git processes of a full one. Each run is a test of its own, so a
    // test holds one journey's work, not two.
    describe("replays a seed exactly", () => {
        const all = { rate: 0.15, where: () => true };
        let first = null;

        it("runs seed 22 once, through Finish twice and gh, git and state-file faults", async () => {
            first = await journey(22, all, 3);
            expect(first.steps.filter((x) => x.startsWith("finish"))).toHaveLength(2);
            // A trace line is "<kind> <- <on> <label>", and a kind can be two words ("partial write").
            expect(new Set(first.faults.map((f) => f.split(" <- ")[1].split(" ")[0]))).toEqual(
                new Set(["gh", "git", "fs"]),
            );
        });

        it("runs it again: the same faults, the same answers", async () => {
            expect(first, "the first run did not finish").not.toBeNull();
            const again = await journey(22, all, 3);
            expect(again.faults).toEqual(first.faults);
            expect(again.steps).toEqual(first.steps);
            expect(again.violation).toBe(first.violation);
        });
    });

    const SEEDS = only ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    it.each(SEEDS)("keeps every invariant under random gh, git and state-file failures (seed %i)", async (seed) => {
        expect(report(await journey(seed, { rate: 0.12, where: () => true }))).toBeNull();
    });

    // The same journeys, looking past unlogged and swallowed failures to the decisions and the
    // commits.
    it.each(SEEDS)(
        "keeps every decision and every commit whole under random gh, git and state-file failures (seed %i)",
        async (seed) => {
            expect(report(await journey(seed, { rate: 0.12, where: () => true, quiet: true }))).toBeNull();
        },
    );
});
