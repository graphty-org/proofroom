/*
 * assertSnapshot() in Mocha: a fixture project run by Mocha as a child process.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

import { tempDir } from "../helpers.mjs";
import { BIN, expectOnePassOneFailure, expectRetried, runFixture } from "./harness.mjs";

const mocha = (...extra) => {
    const json = join(tempDir("vr-mocha-report-"), "report.json");
    const args = [BIN.mocha, "--reporter", "json", "--reporter-option", `output=${json}`, ...extra];
    return { json, args: [...args, "a-snapshots.spec.mjs", "b-later.spec.mjs"] };
};

/**
 * Mocha's JSON report, by test name.
 * @param {string} file the report
 * @returns {Record<string, { passed: boolean, message: string }>} each test's result
 */
function report(file) {
    const { passes, failures } = JSON.parse(readFileSync(file, "utf8"));
    return Object.fromEntries([
        ...passes.map((t) => [t.title, { passed: true, message: "" }]),
        ...failures.map((t) => [t.title, { passed: false, message: t.err.message }]),
    ]);
}

describe("assertSnapshot in Mocha", () => {
    it("reports one pass and one failure that names the snapshot and its status", async () => {
        const { json, args } = mocha();
        const run = await runFixture("mocha", args);
        await expectOnePassOneFailure(report(json), run);
    });

    it("with --retries 1, records each call as an attempt", async () => {
        const { json, args } = mocha("--retries", "1");
        const run = await runFixture("mocha", args, { flip: true });
        await expectRetried(report(json), run);
    });
});
