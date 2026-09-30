import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
    contentHash,
    gateProblems,
    gatedProjects,
    newestResults,
    seededAt,
    unrecordedChanges,
} from "../trusted/gate.mjs";
import { normalizeConfig } from "../trusted/lib/config.mjs";
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
        baseline: status === "new" || status === "unseeded" ? null : HASH,
        capture: status === "removed" ? null : HASH,
        ...(status === "moved" && { from: `old--s${i}` }),
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
    // compact-mantine alone; the fail-closed tests below add projects with no baselines.
    const config = normalizeConfig({ defaultBranch: "master", projects: { "compact-mantine": { storybook: "a" } } });
    const seeded = new Set(["compact-mantine"]);

    it("passes when a seeded project holds only unchanged and excluded items", () => {
        const captures = { "compact-mantine": { attempt: 1, results: results(["unchanged", "excluded"]) } };
        expect(gateProblems({ config, seeded, captures })).toEqual([]);
    });

    it("blocks a renamed story until it is accepted, even when it looks the same", () => {
        const captures = { "compact-mantine": { attempt: 1, results: results(["moved", "moved", "unchanged"]) } };
        expect(gateProblems({ config, seeded, captures })).toEqual([
            "compact-mantine: 2 moved (not accepted; a rejected item needs a code change, not another review)",
        ]);
    });

    it("counts unreviewed items of a seeded project", () => {
        const captures = {
            "compact-mantine": { attempt: 2, results: results(["changed", "changed", "removed", "unchanged"]) },
        };
        expect(gateProblems({ config, seeded, captures })).toEqual([
            "compact-mantine: 2 changed, 1 removed (not accepted; a rejected item needs a code change, not another review)",
        ]);
    });

    it("blocks stories with no baseline yet even when the pull request does not change them", () => {
        // Every story needs an approved baseline; one nobody accepted was never checked.
        const captures = { "compact-mantine": { attempt: 1, results: results(["unchanged", "unseeded", "unseeded"]) } };
        expect(gateProblems({ config, seeded, captures })).toEqual([
            "compact-mantine: 2 unseeded (not accepted; a rejected item needs a code change, not another review)",
        ]);
    });

    it("blocks a story with no baseline that the pull request adds or changes", () => {
        const captures = { "compact-mantine": { attempt: 1, results: results(["unseeded", "new"]) } };
        expect(gateProblems({ config, seeded, captures })).toEqual([
            "compact-mantine: 1 unseeded, 1 new (not accepted; a rejected item needs a code change, not another review)",
        ]);
    });

    it("fails a seeded project whose capture is missing or unfinished", () => {
        expect(gateProblems({ config, seeded, captures: {} })[0]).toMatch(/compact-mantine: no capture results/);
        const partial = {
            "compact-mantine": { attempt: 1, results: results(["unchanged"], { complete: false, expected: 9 }) },
        };
        expect(gateProblems({ config, seeded, captures: partial })[0]).toMatch(/did not finish \(1 of 9/);
    });

    it("treats an invalid results.json as missing, even when it says complete", () => {
        const bad = results(["unchanged"]);
        bad.items[0].file = "../escape.png";
        const captures = { "compact-mantine": { attempt: 1, results: bad } };
        expect(gateProblems({ config, seeded, captures })[0]).toMatch(/compact-mantine: results.json is invalid/);
    });
});

describe("gateProblems fails closed", () => {
    const config = normalizeConfig({
        defaultBranch: "master",
        projects: {
            "compact-mantine": { storybook: "a" },
            "graphty-element": { storybook: "b" },
            layout: { storybook: "c", seedFromDefaultBranch: false },
        },
    });
    const seeded = new Set(["compact-mantine"]);
    const ok = { attempt: 1, results: results(["unchanged"]) };

    it("blocks a story that a pull request changes in a project with no baselines, and says how to seed", () => {
        const captures = {
            "compact-mantine": ok,
            "graphty-element": { attempt: 1, results: results(["unseeded", "new", "new"]) },
            layout: { attempt: 1, results: results(["unseeded"]) },
        };
        const problems = gateProblems({ config, seeded, captures });
        expect(problems).toHaveLength(2);
        expect(problems[0]).toMatch(
            /^graphty-element: 1 unseeded, 2 new \(not accepted; graphty-element has no baselines on master/,
        );
        expect(problems[1]).toMatch(/^layout: 1 unseeded \(not accepted; layout has no baselines on master/);
        expect(problems[0]).toMatch(/gh workflow run visual-seed\.yml --ref master -f ref=<sha>/);
        expect(problems[0]).toMatch(/visual-review serve --master-run <run id>/);
    });

    it("tells a project seeded on pull requests to accept its first baselines there", () => {
        const captures = {
            "compact-mantine": ok,
            "graphty-element": ok,
            layout: { attempt: 1, results: results(["new"]) },
        };
        expect(gateProblems({ config, seeded, captures })).toEqual([
            "layout: 1 new (not accepted; layout has no baselines on master yet, so accept them on this pull " +
                "request with `visual-review serve` to create its first ones)",
        ]);
    });

    it("fails a project with no baselines whose capture is missing", () => {
        expect(gateProblems({ config, seeded, captures: { "compact-mantine": ok, layout: ok } })).toEqual([
            "graphty-element: no capture results (the visual job failed or uploaded nothing); re-run it",
        ]);
    });

    it("gates every project of either config, and a seeded one dropped from both", () => {
        const head = normalizeConfig({ projects: { graphty: { storybook: "d" } } });
        expect(gatedProjects(config, new Set(), head)).toEqual(["compact-mantine", "graphty-element", "layout", "graphty"]);
        // A seeded project dropped from the config is still gated.
        expect(gatedProjects(normalizeConfig({ projects: { layout: { storybook: "c" } } }), seeded)).toEqual([
            "compact-mantine",
            "layout",
        ]);
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

    // The fixture repository's config is the monorepo's: graphty-element and layout have no baselines.
    const unseededCaptures = {
        "visual-graphty-element-1": results(["unchanged"]),
        "visual-layout-1": results(["unchanged"]),
    };

    it("passes a pull request whose seeded capture is unchanged", () => {
        const r = makeRepo();
        const out = run(r.repo, artifacts({ "visual-compact-mantine-1": results(["unchanged"]), ...unseededCaptures }));
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

    it("fails a pull request that changes a story of a project with no baselines", () => {
        const r = makeRepo();
        const out = run(
            r.repo,
            artifacts({
                "visual-compact-mantine-1": results(["unchanged"]),
                ...unseededCaptures,
                "visual-layout-2": results(["new"]),
            }),
        );
        expect(out.stdout).toMatch(
            /::error::visual changes not accepted -- layout: 1 new \(not accepted; layout has no baselines/,
        );
        expect(out.status).toBe(1);
    });

    it("prints its usage without both arguments", () => {
        const out = spawnSync(process.execPath, [GATE], { encoding: "utf8" });
        expect(out.status).toBe(2);
    });
});

describe("contentHash", () => {
    it("reads the image's hash from a Git LFS pointer and hashes anything else", () => {
        const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${HASH}\nsize 5\n`);
        expect(contentHash(pointer)).toBe(HASH);
        expect(contentHash(Buffer.from("plain"))).toMatch(/^[0-9a-f]{64}$/);
        expect(contentHash(Buffer.from("plain"))).not.toBe(HASH);
    });
});

describe("unrecordedChanges", () => {
    it("accepts a record naming the image's hash when the baseline is committed as an LFS pointer", () => {
        const r = makeRepo();
        git(r.repo, "checkout", "-q", "feature");
        const path = "visual-baselines/compact-mantine/card--legacy.png";
        writeFileSync(join(r.repo, path), "new image");
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "accept");
        const blob = execFileSync("git", ["cat-file", "blob", `HEAD:${path}`], { cwd: r.repo });
        expect(blob.toString()).toMatch(/^version https:\/\/git-lfs.github.com\/spec\/v1\n/);
        expect(unrecordedChanges("master", "feature", r.repo)).toEqual([
            `${path}: changed with no review record naming its new contents`,
        ]);
        const to = createHash("sha256").update("new image").digest("hex");
        mkdirSync(join(r.repo, "visual-baselines/reviews"));
        writeFileSync(join(r.repo, "visual-baselines/reviews/r.json"), JSON.stringify({ items: [{ path, to }] }));
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "record");
        expect(unrecordedChanges("master", "feature", r.repo)).toEqual([]);
    });

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
