/*
 * Update from master (`proofroom update <pr>`, the page's Update from master): merging the
 * default branch into a pull request's branch, taking its side for conflicting baselines, and the
 * gate's view of the result. Real repositories with a bare remote (helpers.mjs makeRepo).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { gateProblems, treeApprovalProblems } from "../trusted/gate.mjs";
import { updateFromMaster, updateReportLines } from "../trusted/lib/accept.mjs";
import { classify, sha256 } from "../trusted/lib/compare.mjs";
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
    tempDir,
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
            merged: [],
            recapture: [PATH],
            // No capture was given, so the report cannot say whether the snapshot needs a look.
            report: { match: [], decide: [], unknown: [PATH] },
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

    it("takes master's baseline, and the merged tree needs the owner's approval again: the capture shows it as changed", async () => {
        const r = conflicted();
        await update(r);
        const head = git(r.remote, "rev-parse", "feature");
        expect(git(r.remote, "show", `${head}:${PATH}`)).toBe(git(r.remote, "show", `${r.master}:${PATH}`));
        const check = treeApprovalProblems({
            base: r.master,
            head,
            cwd: r.remote,
            baselines: "visual-baselines",
            approvals: "visual-review-approvals",
            keys: [makeKey().entry],
        });
        expect(check[0]).toMatch(/approves it/);
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

    describe("with an updateCheck", () => {
        const withCheck = (r, updateCheck, steps = []) =>
            updateFromMaster({
                repo: r.repo,
                pr: 123,
                branch: "feature",
                config: { ...CONFIG, updateCheck },
                progress: (s) => steps.push(s),
            });

        it("pushes nothing and leaves the branch where it was when a clean code merge fails the check", async () => {
            const r = makeRepo();
            pushCommit(r.remote, "master", "src/layout.ts");
            const check =
                'echo "error TS1117: An object literal cannot have multiple properties with the same name"; exit 3';
            await expect(withCheck(r, check)).rejects.toThrow(
                /^the merge of master into feature fails the update check: `.*` exited with 3, so nothing was pushed and feature is as it was; merge master into it by hand and fix it\. The check's output ended:\nerror TS1117/,
            );
            expect(git(r.remote, "rev-parse", "feature")).toBe(r.head);
            expect(git(r.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
            expect(git(r.repo, "status", "--porcelain")).toBe("");
            expect(git(r.repo, "worktree", "list").split("\n")).toHaveLength(1);
        });

        it("runs the check in the merged checkout and pushes when it passes", async () => {
            const r = makeRepo();
            pushCommit(r.remote, "master", "src/layout.ts");
            const seen = join(tempDir("vr-check-"), "seen");
            const steps = [];
            const out = await withCheck(
                r,
                `test -f src/layout.ts && echo "$VISUAL_REVIEW_UPDATE_BASE" > ${seen}`,
                steps,
            );
            expect(steps).toEqual(["fetching", "merging", "committing", "checking", "pushing"]);
            expect(readFileSync(seen, "utf8").trim()).toBe(r.head);
            expect(git(r.remote, "rev-parse", "feature")).toBe(out.commit);
            expect(git(r.remote, "rev-parse", "feature^1")).toBe(r.head);
        });

        it("skips the check when the merge changed only baselines", async () => {
            const r = makeRepo();
            pushCommit(r.remote, "master", "visual-baselines/compact-mantine/other.png");
            const steps = [];
            const out = await withCheck(r, "exit 1", steps);
            expect(steps).toEqual(["fetching", "merging", "committing", "pushing"]);
            expect(git(r.remote, "rev-parse", "feature")).toBe(out.commit);
        });
    });

    it("refuses a branch that already has master", async () => {
        const r = makeRepo();
        await expect(update(r)).rejects.toThrow("feature already has everything on master: nothing to update");
        expect(git(r.remote, "rev-parse", "feature")).toBe(r.head);
    });
});

describe("update's per-path rule and its report", () => {
    const DIR = "visual-baselines/compact-mantine";

    /**
     * Commits files on a branch of the repository and pushes it; a null removes the file.
     * @param {object} r the repository
     * @param {string} branch the branch
     * @param {Record<string, string | Buffer | null>} files paths under the project's baselines
     */
    function commitOn(r, branch, files) {
        git(r.repo, "checkout", "-q", branch);
        for (const [name, data] of Object.entries(files)) {
            const path = join(r.repo, DIR, name);
            if (data === null) {
                rmSync(path);
            } else {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, data);
            }
        }
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", `${branch} changes`);
        git(r.repo, "push", "-q", "origin", branch);
        git(r.repo, "checkout", "-q", "master");
    }

    /**
     * Distinct bytes standing in for a PNG: the LFS filter stores them as a pointer to their hash.
     * @param {string} label what makes them distinct
     * @returns {Buffer} the bytes
     */
    const png = (label) => Buffer.from(`png ${label}\n`);

    /**
     * A repository whose feature and master branches change files differently, after both got
     * `shared` (committed on master and merged into feature, so it is their merge base).
     * @param {Record<string, string | Buffer | null>} shared the files both branches start with
     * @param {Record<string, string | Buffer | null>} mine the pull request's change
     * @param {Record<string, string | Buffer | null>} theirs the default branch's change
     * @returns {object} the repository
     */
    function diverged(shared, mine, theirs) {
        const r = makeRepo();
        if (Object.keys(shared).length > 0) {
            commitOn(r, "master", shared);
            git(r.repo, "checkout", "-q", "feature");
            git(r.repo, "merge", "-q", "--no-edit", "master");
            git(r.repo, "push", "-q", "origin", "feature");
            git(r.repo, "checkout", "-q", "master");
        }
        commitOn(r, "feature", mine);
        commitOn(r, "master", theirs);
        return r;
    }

    const at = (r, name) => {
        const out = spawnSync("git", ["-C", r.remote, "show", `feature:${DIR}/${name}`], { encoding: "utf8" });
        return out.status === 0 ? out.stdout : null;
    };

    it("takes the default branch's side when one side deleted a baseline the other changed", async () => {
        const r = diverged(
            { "gone.png": png("base gone"), "kept.png": png("base kept") },
            { "gone.png": png("mine gone"), "kept.png": null },
            { "gone.png": null, "kept.png": png("theirs kept") },
        );
        const out = await update(r);
        expect(out.taken.sort()).toEqual([`${DIR}/gone.png`, `${DIR}/kept.png`]);
        expect(at(r, "gone.png")).toBeNull();
        expect(at(r, "kept.png")).toBe(git(r.remote, "show", `master:${DIR}/kept.png`) + "\n");
    });

    it("takes the default branch's story settings file when both changed it", async () => {
        const r = diverged(
            {},
            { "spinner--loading.json": '{ "delay": 100 }\n' },
            { "spinner--loading.json": '{ "delay": 500 }\n' },
        );
        const out = await update(r);
        expect(out.taken).toEqual([`${DIR}/spinner--loading.json`]);
        expect(at(r, "spinner--loading.json")).toBe('{ "delay": 500 }\n');
        // A settings file is no snapshot: nothing to report.
        expect(out.report).toEqual({ match: [], decide: [], unknown: [] });
    });

    it("merges renames.json pair by pair, the default branch's pair winning for the same old id", async () => {
        const list = (pairs) =>
            `${JSON.stringify(
                pairs.map(([from, to]) => ({ from, to })),
                null,
                4,
            )}\n`;
        const r = diverged(
            { "renames.json": list([["kept", "kept-new"]]) },
            {
                "renames.json": list([
                    ["kept", "kept-new"],
                    ["both", "mine-name"],
                    ["only-mine", "mine-new"],
                ]),
            },
            {
                "renames.json": list([
                    ["kept", "kept-new"],
                    ["both", "their-name"],
                    ["only-theirs", "their-new"],
                ]),
            },
        );
        const out = await update(r);
        expect(out.taken).toEqual([`${DIR}/renames.json`]);
        expect(out.merged).toEqual([`${DIR}/renames.json`]);
        expect(git(r.remote, "log", "-1", "--format=%B", "feature")).toContain(
            `- ${DIR}/renames.json (both sides' renames merged)`,
        );
        expect(JSON.parse(at(r, "renames.json"))).toEqual([
            { from: "kept", to: "kept-new" },
            { from: "both", to: "their-name" },
            { from: "only-theirs", to: "their-new" },
            { from: "only-mine", to: "mine-new" },
        ]);
    });

    it("counts the conflicting snapshots the last capture already draws as the default branch has them", async () => {
        const names = ["a.png", "b.png", "c.png", "d.png", "e.png"];
        const r = diverged(
            Object.fromEntries(names.map((n) => [n, png(`base ${n}`)])),
            Object.fromEntries(names.map((n) => [n, png(`mine ${n}`)])),
            Object.fromEntries(names.map((n) => [n, png(`theirs ${n}`)])),
        );
        const asked = [];
        const out = await updateFromMaster({
            repo: r.repo,
            pr: 123,
            branch: "feature",
            config: CONFIG,
            captures: async (projects) => {
                asked.push(projects);
                return {
                    "compact-mantine": {
                        items: [
                            // a and b: the last capture is the image master has now.
                            { file: "a.png", capture: sha256(png("theirs a.png")) },
                            { file: "b.png", capture: sha256(png("theirs b.png")) },
                            // c: the pull request's own image; d: another; e: not captured.
                            { file: "c.png", capture: sha256(png("mine c.png")) },
                            { file: "d.png", capture: sha256(png("other d.png")) },
                        ],
                    },
                };
            },
        });
        expect(asked).toEqual([["compact-mantine"]]);
        const p = (n) => `${DIR}/${n}`;
        expect(out.report).toEqual({
            match: [p("a.png"), p("b.png")],
            decide: [p("c.png"), p("d.png"), p("e.png")],
            unknown: [],
        });
        expect(updateReportLines(out.report, "master")).toEqual([
            "2 snapshots match master now and need nothing; 3 need a decision again:",
            `  ${p("c.png")}`,
            `  ${p("d.png")}`,
            `  ${p("e.png")}`,
        ]);
    });

    it("asks for no capture when no snapshot conflicts", async () => {
        const r = makeRepo();
        pushCommit(r.remote, "master", "visual-baselines/compact-mantine/other.png");
        let asked = 0;
        const out = await updateFromMaster({
            repo: r.repo,
            pr: 123,
            branch: "feature",
            config: CONFIG,
            captures: async () => {
                asked++;
                return {};
            },
        });
        expect(asked).toBe(0);
        expect(updateReportLines(out.report, "master")).toEqual([]);
    });
});

describe("proofroom update <pr>", () => {
    /**
     * Runs the CLI in the repository, with a gh on PATH that answers the pull request's details.
     * @param {object} r the repository
     * @param {string[]} args the arguments after `update`
     * @param {{ results?: object | null }} [options] the results.json of the CI run on the head;
     *     none: CI never ran on it
     * @returns {import("node:child_process").SpawnSyncReturns<string>} the finished process
     */
    function cli(r, args, { results = null } = {}) {
        const bin = tempDir("vr-gh-");
        const gh = join(bin, "gh");
        // The pull request; its head's CI run (none unless `results` is given); the run's capture
        // artifact; and `gh run download <run> -n <name> -D <dir>`, which writes `results` there.
        const resultsFile = join(bin, "results.json");
        if (results) {
            writeFileSync(resultsFile, JSON.stringify(results));
        }
        const runs = results
            ? '{"workflow_runs":[{"id":7,"run_attempt":1,"status":"completed"}]}'
            : '{"workflow_runs":[]}';
        writeFileSync(
            gh,
            [
                "#!/bin/sh",
                'case "$1 $2" in',
                `  "api repos/{owner}/{repo}/pulls/"*) echo '{"state":"open","head":{"ref":"feature","sha":"abc"}}' ;;`,
                `  "api repos/{owner}/{repo}/actions/workflows/"*) echo '${runs}' ;;`,
                `  "api repos/{owner}/{repo}/actions/runs/7/artifacts"*) echo '{"artifacts":[{"name":"visual-compact-mantine-1","expired":false,"size_in_bytes":1}]}' ;;`,
                `  "run download") cp ${resultsFile} "$7/results.json" ;;`,
                '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
                "esac",
                "",
            ].join("\n"),
        );
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
        expect(run.stdout).toContain(`proofroom update: pushed ${head} to feature`);
        expect(run.stdout).toContain(`  took master's side: ${PATH}`);
        expect(git(r.remote, "rev-parse", "feature^1")).toBe(r.feature);
    });

    it("says the conflicting snapshot has no capture to compare with when CI never ran on the head", () => {
        const run = cli(conflicted(), ["123"]);
        expect(run.stderr).toBe("");
        expect(run.stdout).toContain(
            "1 snapshot with no capture to compare with; CI's new capture shows whether they need a decision:\n" +
                `  ${PATH}\n`,
        );
    });

    it("compares the conflicting snapshot with the last capture CI made of the head", () => {
        // The fixture's capture of button--primary.dark is the pull request's own image, not the
        // newer one master accepted: it needs a decision again.
        const results = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        const run = cli(conflicted(), ["123"], { results });
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        expect(run.stdout).toContain(
            `0 snapshots match master now and need nothing; 1 needs a decision again:\n  ${PATH}\n`,
        );
    });

    it("lists each baseline CI compares again, one per indented line", () => {
        const r = conflicted();
        const run = cli(r, ["123"]);
        expect(run.status).toBe(0);
        expect(run.stdout).toContain(`CI captures again and compares these with their new baselines:\n  ${PATH}\n`);
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
