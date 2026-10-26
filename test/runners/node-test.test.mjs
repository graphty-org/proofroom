/*
 * assertSnapshot() in node:test: a fixture project run by `node --test` as a child process.
 * node:test has no retry of its own, so only the plain run is checked here.
 */

import { describe, it } from "vitest";

import { expectOnePassOneFailure, runFixture } from "./harness.mjs";

/**
 * node:test's TAP report, by test name.
 * @param {string} tap the report
 * @returns {Record<string, { passed: boolean, message: string }>} each test's result
 */
function report(tap) {
    const tests = {};
    for (const [, not, name] of tap.matchAll(/^ *(not )?ok \d+ - (.+)$/gm)) {
        tests[name] = { passed: !not, message: not ? tap : "" };
    }
    return tests;
}

describe("assertSnapshot in node:test", () => {
    it("reports one pass and one failure that names the snapshot and its status", async () => {
        const args = [
            "--test",
            "--test-concurrency=1",
            "--test-reporter=tap",
            "a-snapshots.spec.mjs",
            "b-later.spec.mjs",
        ];
        const run = await runFixture("node-test", args);
        await expectOnePassOneFailure(report(run.stdout), run);
    });
});
