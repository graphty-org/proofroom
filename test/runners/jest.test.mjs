/*
 * assertSnapshot() in Jest: a fixture project run by Jest (ES modules) as a child process.
 */

import { join } from "node:path";
import { describe, it } from "vitest";

import { tempDir } from "../helpers.mjs";
import { BIN, expectOnePassOneFailure, expectRetried, jestJson, runFixture } from "./harness.mjs";

const jest = () => {
    const json = join(tempDir("vr-jest-report-"), "report.json");
    return { json, args: [BIN.jest, "--runInBand", "--json", `--outputFile=${json}`] };
};
const ESM = { NODE_OPTIONS: "--experimental-vm-modules --no-warnings" };

describe("assertSnapshot in Jest", () => {
    it("reports one pass and one failure that names the snapshot and its status", async () => {
        const { json, args } = jest();
        const run = await runFixture("jest", args, { env: ESM });
        await expectOnePassOneFailure(jestJson(json), run);
    });

    it("with jest.retryTimes(1), records each call as an attempt", async () => {
        const { json, args } = jest();
        const run = await runFixture("jest", args, { flip: true, env: { ...ESM, RETRIES: "1" } });
        await expectRetried(jestJson(json), run);
    });
});
