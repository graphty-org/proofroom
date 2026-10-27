/*
 * An in-memory capture store with the GitHub Actions adapter's functions: runs, their capture
 * jobs and their capture sets are plain objects, and a fetched set is copied from a directory on
 * disk. Every call is recorded by name.
 */

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The fake capture store.
 * @param {object} [state] what it holds
 * @param {object[]} [state.runs] CI runs: { id, attempt, status, conclusion, url, headSha, updatedAt }
 * @param {Record<number, Record<string, object>>} [state.jobs] each run's capture job by project
 * @param {Record<number, Record<string, string | { attempt: number, write: (dir: string) => void }>>} [state.sets]
 *     each run's capture set by project: the directory holding its results.json and images, or
 *     the attempt that captured it and what writes it into a directory
 * @returns {import("../../trusted/lib/adapters/index.mjs").CaptureStore & { calls: string[] }} the adapter
 */
export function fakeCaptureStore({ runs = [], jobs = {}, sets = {} } = {}) {
    const calls = [];
    const call =
        (name, fn) =>
        async (...args) => {
            calls.push(name);
            return fn(...args);
        };
    const runOf = (id) => {
        const r = runs.find((x) => x.id === id);
        if (!r) {
            throw new Error(`fake capture store: no run ${id}`);
        }
        return structuredClone(r);
    };
    const list = (run) =>
        Object.entries(sets[run.id] ?? {}).map(([project, set]) => ({
            project,
            attempt: typeof set === "string" ? run.attempt : set.attempt,
            bytes: 1000,
            expired: false,
            expiresAt: null,
            ref: set,
        }));
    return {
        name: "fake",
        calls,
        run: call("run", runOf),
        newestRun: call("newestRun", (sha) => {
            const r = runs.filter((x) => x.headSha === sha).sort((a, b) => b.id - a.id)[0];
            return r ? structuredClone(r) : null;
        }),
        jobs: call("jobs", (run, projects) => Object.fromEntries(projects.map((p) => [p, jobs[run.id]?.[p]]))),
        list: call("list", list),
        fetch: call("fetch", async (run, projects, dir, others = [], landed = () => {}, planned = () => {}) => {
            const listed = list(run);
            for (const s of listed) {
                if (!projects.includes(s.project) && !others.includes(s.project)) {
                    others.push(s.project);
                }
            }
            planned(
                Object.fromEntries(listed.filter((s) => projects.includes(s.project)).map((s) => [s.project, s.bytes])),
            );
            const out = {};
            for (const project of projects) {
                const s = listed.find((x) => x.project === project);
                if (s) {
                    const to = join(dir, `${run.id}-${s.attempt}`, project);
                    if (!existsSync(join(to, "results.json"))) {
                        if (typeof s.ref === "string") {
                            cpSync(s.ref, to, { recursive: true });
                        } else {
                            s.ref.write(to);
                        }
                    }
                    out[project] = { dir: to, attempt: s.attempt, bytes: s.bytes };
                } else {
                    out[project] = null;
                }
                landed(project, out[project]);
            }
            return out;
        }),
        expiresAt: call("expiresAt", () => null),
        newestDefault: call("newestDefault", () => null),
        hurry: () => {},
    };
}
