/*
 * assertSnapshot() in Vitest: a fixture project run by Vitest as a child process.
 */

import { join } from "node:path";
import { describe, it } from "vitest";

import { tempDir } from "../helpers.mjs";
import { BIN, expectOnePassOneFailure, expectRetried, jestJson, runFixture } from "./harness.mjs";

const vitest = (...extra) => {
    const json = join(tempDir("vr-vitest-report-"), "report.json");
    return { json, args: [BIN.vitest, "run", "--reporter=json", `--outputFile=${json}`, ...extra] };
};

describe("assertSnapshot in Vitest", () => {
    it("reports one pass and one failure that names the snapshot and its status", async () => {
        const { json, args } = vitest();
        const run = await runFixture("vitest", args);
        await expectOnePassOneFailure(jestJson(json), run);
    });

    it("with --retry=1, records each call as an attempt", async () => {
        const { json, args } = vitest("--retry=1");
        const run = await runFixture("vitest", args, { flip: true });
        await expectRetried(jestJson(json), run);
    });
});
