/*
 * Seeded random journeys through the review server, as the owner uses it: load the targets, open
 * projects, decide, undo, Accept all, restart the server, and finally Finish, with gh, git and the
 * state file failing at random. The invariants (faults.mjs) are checked after every step.
 *
 * A journey that breaks one returns its seed, its steps and the faults it met; the same seed
 * replays the same faults. To replay one with the server's log shown:
 *   FAULT_SEED=7 pnpm exec vitest run test/fault-journey.test.mjs
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { withRetries } from "../trusted/lib/github.mjs";
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
import { git, isolateGit, job, makeRepo } from "./helpers.mjs";

vi.mock("node:fs", async (importOriginal) => (await import("./fault-hooks.mjs")).faultyFs(await importOriginal()));
vi.mock("../trusted/lib/github.mjs", async (importOriginal) =>
    (await import("./fault-hooks.mjs")).faultyGithub(await importOriginal()),
);

isolateGit();

const REVIEWABLE = new Set(["changed", "moved", "new", "removed", "unstable", "failed"]);
const DECIDABLE = new Set(["changed", "moved", "new", "removed"]);
const PROJECTS = ["compact-mantine", "graphty-element"];
const OTHER = "4".repeat(40);
const RANDOM_STEPS = ["load", "open", "decide", "decide", "decide", "undo", "acceptAll", "restart"];

/**
 * One journey: two pull requests (#123 is finished at the end, #124 is only reviewed).
 * @param {number} seed picks the steps and the faults
 * @param {object} [faults] the injector's random faults: `rate`, `where`, `kinds`; `quiet` looks
 *     past failures that are shown but not logged, or swallowed, to the other invariants
 * @param {number} [length] how many random steps come before Finish
 * @returns {Promise<{ violation: string | null, steps: string[], faults: string[], log: string[] }>}
 *     the first broken invariant, what each step answered, the faults met (sorted) and the log
 */
async function journey(seed, faults = {}, length = 9) {
    const pick = random(seed);
    const choose = (list) => (list.length === 0 ? undefined : list[Math.floor(pick() * list.length)]);
    const r = makeRepo();
    git(r.repo, "push", "-q", "origin", "feature:refs/heads/other");
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
    const log = captureLog(vi);
    const gh = withRetries(inj.gh(w.gh), [0, 0, 0]);
    let s = await startApp(r, { gh });

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
            s = await startApp(r, { gh });
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

    try {
        steps.push(`load ${await act.load()}`);
        await check();
        for (let i = 0; i < length; i++) {
            const name = choose(RANDOM_STEPS);
            steps.push(`${name} ${await act[name]()}`);
            await check();
        }
        if ([...model.keys()].some((k) => k.startsWith("123|"))) {
            let out = await finishOnce();
            steps.push(`finish ${out.status} ${(out.error ?? "").replaceAll(r.dir, "<dir>")}`.trim());
            if (out.error) {
                out = await finishOnce();
                steps.push(`finish again ${out.status} ${(out.error ?? "").replaceAll(r.dir, "<dir>")}`.trim());
            }
        }
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

afterEach(() => vi.restoreAllMocks());

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

    it("replays a seed exactly: the same faults, the same answers", async () => {
        const all = { rate: 0.15, where: () => true };
        const [a, b] = [await journey(11, all), await journey(11, all)];
        expect(a.faults.length).toBeGreaterThan(0);
        expect(b.faults).toEqual(a.faults);
        expect(b.steps).toEqual(a.steps);
        expect(b.violation).toBe(a.violation);
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
