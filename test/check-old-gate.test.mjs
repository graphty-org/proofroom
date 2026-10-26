import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OLD_GATE_FILES, oldGateDifferences } from "../scripts/check-old-gate.mjs";
import { tempDir } from "./helpers.mjs";

const FIXTURE = fileURLToPath(new URL("fixtures/old-gate/", import.meta.url));

/**
 * A checkout shaped like graphty-monorepo whose visual-review/ holds the fixture's gate.
 * @returns {string} its path
 */
function checkout() {
    const dir = tempDir("vr-old-gate-");
    cpSync(FIXTURE, join(dir, "visual-review"), { recursive: true });
    return dir;
}

describe("check-old-gate", () => {
    it("finds no difference in a checkout holding the fixture's gate", () => {
        expect(oldGateDifferences(checkout())).toEqual([]);
    });

    it("names each file that differs or is missing", () => {
        const dir = checkout();
        writeFileSync(join(dir, "visual-review/trusted/lib/results.mjs"), "// changed\n");
        rmSync(join(dir, "visual-review/trusted/gate.mjs"));
        expect(oldGateDifferences(dir)).toEqual(["trusted/gate.mjs", "trusted/lib/results.mjs"]);
    });

    it("holds a gate that loads with the library files beside it", async () => {
        expect(OLD_GATE_FILES).toContain("trusted/gate.mjs");
        const gate = await import(join(FIXTURE, "trusted/gate.mjs"));
        expect(typeof gate.treeApprovalProblems).toBe("function");
        expect(typeof gate.gateProblems).toBe("function");
    });
});
