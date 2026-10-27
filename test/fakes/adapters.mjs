/*
 * The page and server tests' code host and capture store: the fakes (code-host.mjs,
 * capture-store.mjs) filled from plain data, so a test says what is open and what CI captured,
 * never what gh is asked. The data is the shape the tests already describe a repository's GitHub
 * with: pull requests, CI runs by head sha or id, `visual (<project>)` jobs and
 * `visual-<project>-<attempt>` capture sets by run id.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fakeCaptureStore } from "./capture-store.mjs";
import { fakeCodeHost } from "./code-host.mjs";
import { copyFixture, FIXTURE, job } from "../helpers.mjs";

/**
 * The code host and capture store over plain data, read again on every call: a test that changes
 * the data between requests (a newer run lands, a change closes) sees the change on the next one.
 * @param {object} [data] what is open and what CI captured
 * @param {{ number: number, head: string, branch: string, draft?: boolean, author?: string | null }[]} [data.prs]
 *     the open changes; `author` is "octocat" unless given (null: a deleted account)
 * @param {Record<string, { id: number, attempt?: number, status?: string, conclusion?: string | null }>} [data.runs]
 *     the newest CI run by head sha
 * @param {Record<string, object>} [data.runsById] more CI runs by id ({ id, head, attempt })
 * @param {{ head: string, id: number | null }[]} [data.masterRuns] the default branch's commits,
 *     newest first, each with its CI run (`id` null for a commit CI never ran on)
 * @param {Record<string, { name: string, conclusion: string | null, html_url: string }[]>} [data.jobs]
 *     each run's capture jobs
 * @param {Record<string, string[]>} [data.artifacts] each run's capture sets, by name
 * @param {Record<string, object>} [data.results] results.json fields each fetched set gets, by set name
 * @param {object[]} [data.posted] receives what the code host posted (code-host.mjs `posted`)
 * @param {string} [data.login] who the reviewer is signed in as ("owner" unless given)
 * @returns {{ codeHost: ReturnType<typeof fakeCodeHost>, captureStore: ReturnType<typeof fakeCaptureStore> }}
 *     the adapters, for createApp, each with every call by name in `calls`
 */
export function fakeAdapters(data = {}) {
    const posted = data.posted ?? [];
    const calls = { codeHost: [], captureStore: [] };
    // Each call asks fakes made from the data as it is now, and counts the call.
    const live = (kind, build) => {
        const out = { ...build(), calls: calls[kind] };
        for (const [name, value] of Object.entries(out)) {
            if (typeof value === "function") {
                out[name] = (...args) => {
                    const fresh = build();
                    const answer = fresh[name](...args);
                    calls[kind].push(...fresh.calls);
                    return answer;
                };
            }
        }
        return out;
    };
    const codeHost = live("codeHost", () => fakeCodeHost({ changes: changesOf(data), posted, login: data.login }));
    const captureStore = live("captureStore", () => storeOf(data));
    // The default branch's newest complete set of a project, newest commit first.
    captureStore.newestDefault = async (project, dir) => {
        calls.captureStore.push("newestDefault");
        for (const m of (data.masterRuns ?? []).filter((x) => x.id !== null)) {
            const run = runsOf(data).get(m.id);
            const got = (await captureStore.fetch(run, [project], dir))[project];
            const file = got?.dir && join(got.dir, "results.json");
            const set = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
            if (set?.complete && set.project === project) {
                return got.dir;
            }
        }
        return null;
    };
    return { codeHost, captureStore };
}

const asRun = (head, x) => ({
    id: x.id,
    attempt: x.attempt ?? 1,
    status: x.status ?? "completed",
    conclusion: x.conclusion === undefined ? "success" : x.conclusion,
    url: `https://gh/runs/${x.id}`,
    headSha: head,
    updatedAt: null,
});

/**
 * Every CI run the data names, by id.
 * @param {object} data the data (fakeAdapters)
 * @returns {Map<number, object>} the runs
 */
function runsOf(data) {
    const { runs = {}, runsById = {}, masterRuns = [] } = data;
    const all = new Map();
    for (const [head, x] of Object.entries(runs)) {
        all.set(x.id, asRun(head, x));
    }
    for (const x of Object.values(runsById)) {
        all.set(x.id, asRun(x.head, x));
    }
    for (const x of masterRuns.filter((m) => m.id !== null)) {
        all.set(x.id, asRun(x.head, x));
    }
    return all;
}

/**
 * The open changes, as a code host's listChanges answers them.
 * @param {object} data the data (fakeAdapters)
 * @returns {object[]} the changes
 */
function changesOf(data) {
    const { prs = [], runs = {} } = data;
    return prs.map((p) => {
        const x = runs[p.head];
        return {
            number: p.number,
            title: `PR ${p.number}`,
            url: `https://gh/pull/${p.number}`,
            headSha: p.head,
            branch: p.branch,
            draft: p.draft === true,
            author: p.author === undefined ? "octocat" : p.author,
            run: x && {
                id: x.id,
                status: x.status ?? "completed",
                conclusion: x.conclusion === undefined ? "success" : x.conclusion,
                updatedAt: `attempt ${x.attempt ?? 1}`,
            },
            visual: null,
        };
    });
}

/**
 * The capture store over the data's runs, jobs and sets.
 * @param {object} data the data (fakeAdapters)
 * @returns {ReturnType<typeof fakeCaptureStore>} the store
 */
function storeOf(data) {
    const { jobs = {}, artifacts = {}, results = {} } = data;
    const project = (name) => /^visual \((.+)\)$/.exec(name)?.[1];
    return fakeCaptureStore({
        runs: [...runsOf(data).values()],
        jobs: Object.fromEntries(
            Object.entries(jobs).map(([id, list]) => [
                id,
                Object.fromEntries(
                    list
                        .filter((j) => project(j.name))
                        .map((j) => [
                            project(j.name),
                            { ...(j.status && { status: j.status }), conclusion: j.conclusion, url: j.html_url },
                        ]),
                ),
            ]),
        ),
        sets: Object.fromEntries(
            Object.entries(artifacts).map(([id, names]) => [
                id,
                Object.fromEntries(
                    names
                        .map((name) => ({ name, m: /^visual-(.+)-(\d+)$/.exec(name) }))
                        .sort((a, b) => Number(a.m[2]) - Number(b.m[2]))
                        .map(({ name, m }) => [
                            m[1],
                            { attempt: Number(m[2]), write: (to) => copyFixture(m[1], to, results[name] ?? {}) },
                        ]),
                ),
            ]),
        ),
    });
}

/**
 * One open change (#123, branch feature) of the repository's head, with a finished CI run 1000
 * that captured both fixture projects, as `start({ fakes })` takes it.
 * @param {object} [extra] data to replace (fakeAdapters)
 * @returns {(r: { head: string }) => ReturnType<typeof fakeAdapters>} the adapters for a repository
 */
export const onePrFakes =
    (extra = {}) =>
    (r) =>
        fakeAdapters({
            prs: [{ number: 123, head: r.head, branch: "feature" }],
            runs: { [r.head]: { id: 1000, attempt: 1 } },
            jobs: { 1000: [job("compact-mantine"), job("graphty-element")] },
            artifacts: { 1000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
            results: {
                "visual-compact-mantine-1": { commit: r.head, headSha: r.head },
                "visual-graphty-element-1": { commit: r.head, headSha: r.head },
            },
            ...extra,
        });

/**
 * The fixture as pull request #123, with slider--sizes renamed from old-slider--sizes and looking
 * exactly as that old id's baseline: a moved item, whose baseline is its own capture's bytes.
 * @param {object} r the repository
 * @param {object[]} [extra] more items for compact-mantine's results.json
 * @returns {ReturnType<typeof fakeAdapters>} the adapters
 */
export const withMoved = (r, extra = []) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
    const items = fixture.items.map((i) =>
        i.file === "slider--sizes.png"
            ? {
                  ...i,
                  status: "moved",
                  from: "old-slider--sizes",
                  baseline: i.capture,
                  baselineSize: i.size,
                  changedPixels: 0,
                  bbox: null,
              }
            : i,
    );
    items.push(...extra);
    const at = { commit: r.head, headSha: r.head };
    return onePrFakes({ results: { "visual-compact-mantine-1": { ...at, items }, "visual-graphty-element-1": at } })(r);
};
