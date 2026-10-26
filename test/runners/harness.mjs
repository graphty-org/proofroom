/**
 * Runs a fixture project (fixtures/<runner>/) with its own test runner as a child process, the way
 * a user's CI would, and reads back what the runner reported and what proofroom wrote.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { collect } from "../../trusted/lib/collect.mjs";
import { tempDir } from "../helpers.mjs";
import { png } from "../story-test-fakes.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MODULES = fileURLToPath(new URL("../../node_modules/", import.meta.url));

/** The command line of each runner's own binary, run with this Node. */
export const BIN = {
    vitest: join(MODULES, "vitest/vitest.mjs"),
    jest: join(MODULES, "jest/bin/jest.js"),
    mocha: join(MODULES, "mocha/bin/mocha.js"),
    playwright: join(MODULES, "@playwright/test/cli.js"),
};

/**
 * Runs one fixture project.
 * @param {string} runner the fixture's directory under fixtures/
 * @param {string[]} args the Node arguments (the runner's binary and its options)
 * @param {{ flip?: boolean, env?: Record<string, string> }} [options] whether the flipping
 *     snapshot runs too, and more environment
 * @returns {Promise<{ status: number, stdout: string, stderr: string, out: string, baselines: string }>}
 *     how the runner ended, what it printed, and where the result lines and the baselines are
 */
export async function runFixture(runner, args, { flip = false, env = {} } = {}) {
    const baselines = tempDir("vr-runner-bl-");
    for (const id of ["same", "changed", "flip"]) {
        writeFileSync(join(baselines, `${id}.png`), png(10));
    }
    const out = tempDir("vr-runner-out-");
    const child = spawn(process.execPath, args, {
        cwd: join(HERE, "fixtures", runner),
        env: {
            ...process.env,
            CI: "",
            FORCE_COLOR: "0",
            NO_COLOR: "1",
            BASELINES: baselines,
            PROOFROOM_OUT: out,
            FIXTURE_STATE: tempDir("vr-runner-state-"),
            FLIP: flip ? "1" : "",
            ...env,
        },
    });
    const run = { stdout: "", stderr: "" };
    child.stdout.on("data", (d) => (run.stdout += d));
    child.stderr.on("data", (d) => (run.stderr += d));
    const status = await new Promise((r) => child.on("close", r));
    return { status, ...run, out, baselines };
}

/**
 * The results collect makes of a fixture run's result lines.
 * @param {{ out: string, baselines: string }} run what runFixture returned
 * @returns {Promise<{ items: Record<string, object>, junit: string, complete: boolean }>} the
 *     items by snapshot id, the JUnit file's text, and whether the capture is complete
 */
export async function collected({ out, baselines }) {
    const into = tempDir("vr-runner-collected-");
    const { results } = await collect({ project: "app", baselines, out: into, dirs: [out] });
    return {
        items: Object.fromEntries(results.items.map((i) => [i.id, i])),
        junit: readFileSync(join(into, "junit.xml"), "utf8"),
        complete: results.complete,
    };
}

/** The failure message assertSnapshot() gives the changed snapshot. */
export const CHANGED = "proofroom: app/changed: changed: 16 pixels differ";

/**
 * Checks a run without retries: one pass and one failure naming the snapshot and its status,
 * and the later file saw the failing line on disk before it started.
 * @param {Record<string, { passed: boolean, message: string }>} report the runner's report, by test name
 * @param {object} run what runFixture returned
 * @returns {Promise<void>} once checked
 */
export async function expectOnePassOneFailure(report, run) {
    expect(run.status, run.stdout + run.stderr).not.toBe(0);
    expect(Object.keys(report).sort()).toEqual(["changed", "later", "same"]);
    expect(report.same.passed).toBe(true);
    expect(report.later.passed).toBe(true);
    expect(report.changed.passed).toBe(false);
    expect(report.changed.message).toContain(CHANGED);
    const { items } = await collected(run);
    expect(items.changed).toMatchObject({ status: "changed", flaky: false });
    expect(items.same).toMatchObject({ status: "unchanged" });
    expect(items.changed.attempts).toBeUndefined();
}

/**
 * Checks a run with the runner's retry set to 1: the changed snapshot's two calls are attempts 1
 * and 2 (a <rerunFailure>), and the one that failed then matched passed with a <flakyFailure>,
 * which nothing calls flaky.
 * @param {Record<string, { passed: boolean }>} report the runner's report, by test name
 * @param {object} run what runFixture returned
 * @returns {Promise<void>} once checked
 */
export async function expectRetried(report, run) {
    expect(run.status, run.stdout + run.stderr).not.toBe(0);
    expect(report.same.passed).toBe(true);
    expect(report.flip.passed).toBe(true);
    expect(report.changed.passed).toBe(false);
    const { items, junit, complete } = await collected(run);
    expect(complete).toBe(true);
    expect(items.changed.attempts).toEqual([expect.objectContaining({ status: "changed" })]);
    expect(items.flip).toMatchObject({ status: "unchanged", flaky: false });
    expect(items.flip.attempts).toEqual([expect.objectContaining({ status: "changed" })]);
    expect(items.same.attempts).toBeUndefined();
    expect(junit).toMatch(/<testcase name="changed"[^>]*>\s*<failure[\s\S]*?<rerunFailure/);
    expect(junit).toMatch(/<testcase name="flip"[^>]*>\s*<flakyFailure/);
}

/**
 * The report of a runner that writes the Jest JSON format (Jest, and Vitest's json reporter).
 * @param {string} file the JSON file
 * @returns {Record<string, { passed: boolean, message: string }>} by test name
 */
export function jestJson(file) {
    const report = JSON.parse(readFileSync(file, "utf8"));
    return Object.fromEntries(
        report.testResults
            .flatMap((f) => f.assertionResults)
            .map((t) => [t.title, { passed: t.status === "passed", message: t.failureMessages.join("\n") }]),
    );
}

export const fixtureDir = (runner) => join(HERE, "fixtures", runner);
