/*
 * Update from master (`visual-review update <pr>`, the page's Update from master): merging the
 * default branch into a pull request's branch, taking its side for conflicting baselines, and the
 * gate's view of the result. Real repositories with a bare remote (helpers.mjs makeRepo).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { gateProblems, reviewGaps, unrecordedChanges } from "../trusted/gate.mjs";
import { updateFromMaster } from "../trusted/lib/accept.mjs";
import { classify } from "../trusted/lib/compare.mjs";
import {
    CONFIG,
    CONFLICT_MINE as MINE,
    CONFLICT_PATH as PATH,
    CONFLICT_THEIRS as THEIRS,
    FIXTURE,
    git,
    isolateGit,
    makeRepo,
    pushCommit,
} from "./helpers.mjs";
import { makeKey } from "./passkey-vectors.mjs";

beforeAll(isolateGit);

const CLI = new URL("../trusted/cli.mjs", import.meta.url).pathname;
// The pull request accepted MINE for PATH, then master accepted THEIRS (helpers.mjs buildConflicted).
const conflicted = ({ code = false } = {}) => makeRepo(code ? "conflictedCodeRepo" : "conflictedRepo");

const update = (r) => updateFromMaster({ repo: r.repo, pr: 123, branch: "feature", config: CONFIG });

describe("update from master", () => {
    it("merges master, takes master's side for a conflicting baseline, and pushes one merge commit", async () => {
        const r = conflicted();
        const steps = [];
        const out = await updateFromMaster({
            repo: r.repo,
            pr: 123,
            branch: "feature",
            config: CONFIG,
            progress: (s) => steps.push(s),
        });
        expect(steps).toEqual(["fetching", "merging", "committing", "pushing"]);
        expect(out).toEqual({
            commit: git(r.remote, "rev-parse", "feature"),
            branch: "feature",
            taken: [PATH],
            recapture: [PATH],
        });
        // A merge commit on top of the branch, never a rebase.
        expect(git(r.remote, "rev-parse", "feature^1", "feature^2")).toBe(`${r.feature}\n${r.master}`);
        expect(git(r.remote, "show", `feature:${PATH}`)).toBe(git(r.remote, "show", `master:${PATH}`));
        const message = git(r.remote, "log", "-1", "--format=%B", "feature");
        expect(message).toMatch(/^test\(workspace\): merge master into feature for visual review\n/);
        expect(message).toContain(`- ${PATH}`);
        // The record the pull request already had stays; no record is added.
        expect(git(r.remote, "diff", "--name-only", r.feature, "feature", "--", "visual-baselines/reviews/")).toBe("");
        // The owner's checkout is untouched, and the throwaway worktree is gone.
        expect(git(r.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
        expect(git(r.repo, "status", "--porcelain")).toBe("");
        expect(git(r.repo, "worktree", "list").split("\n")).toHaveLength(1);
    });

    it("needs no review record: the gate finds the baseline unchanged and the capture shows it as changed", async () => {
        const r = conflicted();
        // Before the update, the branch's baseline is not what master's record approved.
        expect(unrecordedChanges(r.master, r.feature, r.remote)).toEqual([
            `${PATH}: changed with no review record taking it from its base branch contents to these`,
        ]);
        await update(r);
        const head = git(r.remote, "rev-parse", "feature");
        expect(unrecordedChanges(r.master, head, r.remote)).toEqual([]);
        // With approvals enforced too: the update itself needs none (the old unsigned record is
        // the pull request's own, refused as before, and covers nothing the gate needs).
        const gaps = reviewGaps(r.master, head, r.remote, "visual-baselines", { keys: [makeKey().entry], pr: 123 });
        expect(gaps.missing).toEqual([]);
        expect(gaps.refused).toEqual(["visual-baselines/reviews/20260927T150405Z-pr123.json"]);
        // CI captures the story again against master's baseline: the pull request's image differs,
        // so it is `changed`, and the gate blocks until the owner reviews it.
        const item = classify({
            baseline: readFileSync(THEIRS),
            first: readFileSync(MINE),
            threshold: 0.063,
            includeAA: false,
        });
        expect(item.status).toBe("changed");
        const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        const results = {
            ...fixture,
            expected: 1,
            items: [{ ...fixture.items.find((i) => i.file === "button--primary.dark.png"), ...item, threshold: 0.063 }],
        };
        const problems = gateProblems({
            config: { ...CONFIG, projects: { "compact-mantine": CONFIG.projects["compact-mantine"] } },
            headConfig: undefined,
            seeded: new Set(["compact-mantine"]),
            captures: { "compact-mantine": { attempt: 1, results } },
        });
        expect(problems).toEqual([expect.stringMatching(/^compact-mantine: 1 changed \(not accepted/)]);
    });

    it("refuses a conflict outside the baselines, lists it, and changes nothing", async () => {
        const r = conflicted({ code: true });
        await expect(update(r)).rejects.toThrow(
            "feature conflicts with master outside visual-baselines/, so nothing was changed; merge master into it by hand: src.txt",
        );
        expect(git(r.remote, "rev-parse", "feature")).toBe(r.feature);
        expect(git(r.repo, "rev-parse", "HEAD")).toBe(r.master);
        expect(git(r.repo, "status", "--porcelain")).toBe("");
        expect(git(r.repo, "worktree", "list").split("\n")).toHaveLength(1);
    });

    it("merges a stale branch with no conflict", async () => {
        const r = makeRepo();
        pushCommit(r.remote, "master", "visual-baselines/compact-mantine/other.png");
        const out = await update(r);
        expect(out.taken).toEqual([]);
        expect(out.recapture).toEqual(["visual-baselines/compact-mantine/other.png"]);
        expect(git(r.remote, "rev-parse", "feature^1")).toBe(r.head);
        expect(git(r.remote, "log", "-1", "--format=%B", "feature")).toContain("No conflicts.");
    });

    it("refuses a branch that already has master", async () => {
        const r = makeRepo();
        await expect(update(r)).rejects.toThrow("feature already has everything on master: nothing to update");
        expect(git(r.remote, "rev-parse", "feature")).toBe(r.head);
    });
});

describe("visual-review update <pr>", () => {
    /**
     * Runs the CLI in the repository, with a gh on PATH that answers the pull request's details.
     * @param {object} r the repository
     * @param {string[]} args the arguments after `update`
     * @returns {import("node:child_process").SpawnSyncReturns<string>} the finished process
     */
    function cli(r, args) {
        const bin = mkdtempSync(join(tmpdir(), "vr-gh-"));
        const gh = join(bin, "gh");
        writeFileSync(gh, `#!/bin/sh\necho '{"state":"open","head":{"ref":"feature"}}'\n`);
        chmodSync(gh, 0o755);
        return spawnSync(process.execPath, [CLI, "update", ...args], {
            cwd: r.repo,
            encoding: "utf8",
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
    }

    it("updates the pull request and says which baselines took master's side", () => {
        const r = conflicted();
        const run = cli(r, ["123"]);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        const head = git(r.remote, "rev-parse", "feature");
        expect(run.stdout).toContain(`visual-review update: pushed ${head} to feature`);
        expect(run.stdout).toContain(`  took master's side: ${PATH}`);
        expect(git(r.remote, "rev-parse", "feature^1")).toBe(r.feature);
    });

    it("exits 1 with the files on a code conflict, and 2 without a pull request number", () => {
        const r = conflicted({ code: true });
        const run = cli(r, ["123"]);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("merge master into it by hand: src.txt");
        expect(git(r.remote, "rev-parse", "feature")).toBe(r.feature);
        expect(cli(r, []).status).toBe(2);
    });
});
