/*
 * assertSnapshot() in Playwright Test: a fixture project run by Playwright Test as a child process.
 * Playwright Test retries a failed test in a new worker process, so the attempt is counted from
 * the result lines on disk.
 */

import { describe, it } from "vitest";

import { BIN, expectOnePassOneFailure, expectRetried, runFixture } from "./harness.mjs";

/**
 * Playwright Test's JSON report, by test name: a test passed when its last run did.
 * @param {string} text the report
 * @returns {Record<string, { passed: boolean, message: string }>} each test's result
 */
function report(text) {
    const tests = {};
    const walk = (suite) => {
        for (const spec of suite.specs ?? []) {
            const { results } = spec.tests[0];
            tests[spec.title] = {
                passed: results.at(-1).status === "passed",
                message: results.map((r) => r.error?.message ?? "").join("\n"),
            };
        }
        (suite.suites ?? []).forEach(walk);
    };
    JSON.parse(text).suites.forEach(walk);
    return tests;
}

describe("assertSnapshot in Playwright Test", () => {
    it("reports one pass and one failure that names the snapshot and its status", async () => {
        const run = await runFixture("playwright", [BIN.playwright, "test"]);
        await expectOnePassOneFailure(report(run.stdout), run);
    });

    it("with --retries=1, records each call as an attempt, also from the new worker", async () => {
        const run = await runFixture("playwright", [BIN.playwright, "test", "--retries=1"], { flip: true });
        await expectRetried(report(run.stdout), run);
    });
});
