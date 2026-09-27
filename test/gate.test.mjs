import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { gateProblems, newestResults, seededAt } from "../trusted/gate.mjs";
import { git, isolateGit, makeRepo } from "./helpers.mjs";

beforeAll(isolateGit);

const results = (statuses, extra = {}) => ({
    complete: true,
    expected: statuses.length,
    items: statuses.map((status) => ({ status })),
    ...extra,
});

function artifacts(map) {
    const dir = mkdtempSync(join(tmpdir(), "vr-gate-"));
    for (const [name, r] of Object.entries(map)) {
        mkdirSync(join(dir, name));
        if (r) {
            writeFileSync(join(dir, name, "results.json"), JSON.stringify(r));
        }
    }
    return dir;
}

describe("newestResults", () => {
    it("keeps only each project's highest attempt", () => {
        const dir = artifacts({
            "visual-compact-mantine-1": results(["changed"]),
            "visual-compact-mantine-3": results(["unchanged"]),
            "visual-compact-mantine-2": results(["new"]),
            "visual-graphty-element-1": null,
        });
        const out = newestResults(dir);
        expect(out["compact-mantine"].attempt).toBe(3);
        expect(out["compact-mantine"].results.items[0].status).toBe("unchanged");
        expect(out["graphty-element"]).toEqual({ attempt: 1, results: null });
    });

    it("finds nothing in a missing directory", () => {
        expect(newestResults(join(tmpdir(), "vr-gate-missing-dir"))).toEqual({});
    });
});

describe("gateProblems", () => {
    const projects = ["compact-mantine", "graphty-element"];
    const seeded = new Set(["compact-mantine"]);

    it("passes when a seeded project holds only unchanged and excluded items", () => {
        const captures = { "compact-mantine": { attempt: 1, results: results(["unchanged", "excluded"]) } };
        expect(gateProblems({ projects, seeded, captures })).toEqual([]);
    });

    it("counts unreviewed items of a seeded project and ignores an unseeded one", () => {
        const captures = {
            "compact-mantine": { attempt: 2, results: results(["changed", "changed", "removed", "unchanged"]) },
            "graphty-element": { attempt: 2, results: results(["new"]) },
        };
        expect(gateProblems({ projects, seeded, captures })).toEqual([
            "compact-mantine: 2 changed, 1 removed not reviewed",
        ]);
    });

    it("fails a seeded project whose capture is missing or unfinished", () => {
        expect(gateProblems({ projects, seeded, captures: {} })[0]).toMatch(/compact-mantine: no capture results/);
        const partial = {
            "compact-mantine": { attempt: 1, results: results(["unchanged"], { complete: false, expected: 9 }) },
        };
        expect(gateProblems({ projects, seeded, captures: partial })[0]).toMatch(/did not finish \(1 of 9/);
    });
});

describe("seededAt", () => {
    it("reads seeded projects from the base ref, not the working tree", () => {
        const r = makeRepo();
        expect(seededAt(["compact-mantine", "graphty-element"], r.master, r.repo)).toEqual(
            new Set(["compact-mantine"]),
        );
        git(r.repo, "rm", "-q", "-r", "visual-baselines");
        git(r.repo, "commit", "-q", "-m", "delete baselines");
        expect(seededAt(["compact-mantine"], "HEAD", r.repo)).toEqual(new Set());
        expect(seededAt(["compact-mantine"], r.master, r.repo)).toEqual(new Set(["compact-mantine"]));
    });
});
