import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { gateProblems, newestResults, seededAt, unrecordedChanges } from "../trusted/gate.mjs";
import { FIXTURE, git, isolateGit, makeRepo } from "./helpers.mjs";

beforeAll(isolateGit);

const FIXTURE_RESULTS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
const HASH = "a".repeat(64);

// A valid results.json whose items have these statuses.
const results = (statuses, extra = {}) => ({
    ...FIXTURE_RESULTS,
    complete: true,
    expected: statuses.length,
    items: statuses.map((status, i) => ({
        ...FIXTURE_RESULTS.items[0],
        id: `story--s${i}`,
        mode: null,
        file: `story--s${i}.png`,
        status,
        baseline: status === "new" ? null : HASH,
        capture: status === "removed" ? null : HASH,
    })),
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
            "compact-mantine: 2 changed, 1 removed (not accepted; a rejected item needs a code change, not another review)",
        ]);
    });

    it("fails a seeded project whose capture is missing or unfinished", () => {
        expect(gateProblems({ projects, seeded, captures: {} })[0]).toMatch(/compact-mantine: no capture results/);
        const partial = {
            "compact-mantine": { attempt: 1, results: results(["unchanged"], { complete: false, expected: 9 }) },
        };
        expect(gateProblems({ projects, seeded, captures: partial })[0]).toMatch(/did not finish \(1 of 9/);
    });

    it("treats an invalid results.json as missing, even when it says complete", () => {
        const bad = results(["unchanged"]);
        bad.items[0].file = "../escape.png";
        const captures = { "compact-mantine": { attempt: 1, results: bad } };
        expect(gateProblems({ projects, seeded, captures })[0]).toMatch(/compact-mantine: results.json is invalid/);
    });
});

describe("seededAt", () => {
    it("reads seeded projects from the base ref, not the working tree", () => {
        const r = makeRepo();
        expect(seededAt(r.master, r.repo)).toEqual(new Set(["compact-mantine"]));
        git(r.repo, "rm", "-q", "-r", "visual-baselines");
        git(r.repo, "commit", "-q", "-m", "delete baselines");
        expect(seededAt("HEAD", r.repo)).toEqual(new Set());
        expect(seededAt(r.master, r.repo)).toEqual(new Set(["compact-mantine"]));
    });
});

describe("gate command", () => {
    const GATE = fileURLToPath(new URL("../trusted/gate.mjs", import.meta.url));
    const run = (repo, captures) =>
        spawnSync(process.execPath, [GATE, "--captures", captures, "--base", "master", "--head", "feature"], {
            cwd: repo,
            encoding: "utf8",
        });

    it("passes a pull request whose seeded capture is unchanged", () => {
        const r = makeRepo();
        const out = run(r.repo, artifacts({ "visual-compact-mantine-1": results(["unchanged"]) }));
        expect(out.stdout).toMatch(/No unaccepted visual changes/);
        expect(out.status).toBe(0);
    });

    it("fails on an unaccepted change and on a baseline committed without a review record", () => {
        const r = makeRepo();
        git(r.repo, "checkout", "-q", "feature");
        writeFileSync(join(r.repo, "visual-baselines/compact-mantine/card--legacy.png"), "copied capture");
        git(r.repo, "commit", "-q", "-am", "copy a capture into the baselines");
        const out = run(r.repo, artifacts({ "visual-compact-mantine-1": results(["changed"]) }));
        expect(out.stdout).toMatch(/::error::visual changes not accepted -- compact-mantine: 1 changed/);
        expect(out.stdout).toMatch(
            /::error::baseline without a review -- visual-baselines\/compact-mantine\/card--legacy.png/,
        );
        expect(out.status).toBe(1);
    });

    it("prints its usage without both arguments", () => {
        const out = spawnSync(process.execPath, [GATE], { encoding: "utf8" });
        expect(out.status).toBe(2);
    });
});

describe("unrecordedChanges", () => {
    it("fails a pull request that deletes a review record the base holds", () => {
        const r = makeRepo();
        mkdirSync(join(r.repo, "visual-baselines/reviews"));
        writeFileSync(join(r.repo, "visual-baselines/reviews/old.json"), "{}");
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "record");
        git(r.repo, "checkout", "-q", "-b", "drop");
        git(r.repo, "rm", "-q", "visual-baselines/reviews/old.json");
        git(r.repo, "commit", "-q", "-m", "drop the record");
        expect(unrecordedChanges("master", "drop", r.repo)).toEqual([
            "visual-baselines/reviews/old.json: review records are append-only, but this one was changed or deleted",
        ]);
    });
});
