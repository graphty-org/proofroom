import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { unrecordedChanges } from "../trusted/gate.mjs";
import { commitMessage, finish } from "../trusted/lib/accept.mjs";
import { sha256 } from "../trusted/lib/compare.mjs";
import { copyFixture, git, isolateGit, makeRepo, pushCommit, ROOT } from "./helpers.mjs";

beforeAll(isolateGit);

const NOW = new Date("2026-09-27T15:04:05Z");

/**
 * A repository, both fixture projects captured at the feature branch's head, and a fake gh that
 * records its calls.
 * @returns {object} the repository, projects, gh calls and a `run` that calls finish
 */
function setup() {
    const r = makeRepo();
    const at = { commit: r.head, headSha: r.head };
    const projects = {
        "compact-mantine": copyFixture("compact-mantine", join(r.dir, "art/compact-mantine"), at),
        "graphty-element": copyFixture("graphty-element", join(r.dir, "art/graphty-element"), at),
    };
    const calls = [];
    const gh = async (args, input) => {
        calls.push({ args, input });
        return JSON.stringify({ html_url: "https://github.com/o/r/pull/9", number: 9 });
    };
    const run = (decisions, target = { pr: 123, branch: "feature" }) =>
        finish({ repo: r.repo, gh, target, projects, decisions, now: NOW });
    return { ...r, projects, calls, run };
}

const accept = (file, project = "compact-mantine", reason = null) => ({ project, file, decision: "accept", reason });
const remoteLog = (s, branch) => git(s.remote, "log", "--format=%H", branch).split("\n");
const show = (s, branch, path) => execFileSync("git", ["show", `${branch}:${path}`], { cwd: s.remote });

describe("finish: accepts", () => {
    it("commits two PNGs and one record, once, and pushes to the pull request's branch", async () => {
        const s = setup();
        const out = await s.run([
            accept("button--primary.dark.png", "compact-mantine", "wider"),
            accept("badge--default.light.png"),
        ]);

        const log = remoteLog(s, "feature");
        expect(log[1]).toBe(s.head);
        expect(out.commit).toBe(log[0]);
        const files = git(s.remote, "show", "--name-only", "--format=", "feature").split("\n").sort();
        expect(files).toEqual([
            "visual-baselines/compact-mantine/badge--default.light.png",
            "visual-baselines/compact-mantine/button--primary.dark.png",
            "visual-baselines/reviews/20260927T150405Z-pr123.json",
        ]);
        const cm = s.projects["compact-mantine"].results;
        const button = cm.items.find((i) => i.file === "button--primary.dark.png");
        const badge = cm.items.find((i) => i.file === "badge--default.light.png");
        expect(sha256(show(s, "feature", "visual-baselines/compact-mantine/button--primary.dark.png"))).toBe(
            button.capture,
        );

        const record = JSON.parse(show(s, "feature", "visual-baselines/reviews/20260927T150405Z-pr123.json"));
        expect(record).toMatchObject({
            version: 1,
            unproven: true,
            pr: 123,
            subject: { runId: 1000, runAttempt: 1, builtMerge: s.head, head: s.head },
            reviewedAt: NOW.toISOString(),
        });
        expect(record.items).toEqual([
            {
                path: "visual-baselines/compact-mantine/badge--default.light.png",
                from: null,
                to: badge.capture,
                reason: null,
            },
            {
                path: "visual-baselines/compact-mantine/button--primary.dark.png",
                from: button.baseline,
                to: button.capture,
                reason: "wider",
            },
        ]);
        expect(existsSync(join(s.repo, ".worktrees/visual-accept-123"))).toBe(false);
    });

    it("lands decisions from every project of the pull request in one commit and one push", async () => {
        const s = setup();
        await s.run([accept("badge--default.light.png"), accept("graph--basic.png", "graphty-element")]);
        expect(remoteLog(s, "feature")[1]).toBe(s.head);
        const files = git(s.remote, "show", "--name-only", "--format=", "feature");
        expect(files).toContain("visual-baselines/compact-mantine/badge--default.light.png");
        expect(files).toContain("visual-baselines/graphty-element/graph--basic.png");
    });

    it("deletes the baseline of an accepted removal", async () => {
        const s = setup();
        await s.run([accept("card--legacy.png")]);
        expect(git(s.remote, "show", "--name-status", "--format=", "feature")).toContain(
            "D\tvisual-baselines/compact-mantine/card--legacy.png",
        );
        const record = JSON.parse(show(s, "feature", "visual-baselines/reviews/20260927T150405Z-pr123.json"));
        expect(record.items[0]).toMatchObject({ path: "visual-baselines/compact-mantine/card--legacy.png", to: null });
        expect(record.items[0].from).toMatch(/^[0-9a-f]{64}$/);
    });

    it("writes an exclusion as a settings file and a record item", async () => {
        const s = setup();
        await s.run([
            { project: "compact-mantine", file: "tooltip--hover.png", decision: "exclude", reason: "hover races" },
        ]);
        const bytes = show(s, "feature", "visual-baselines/compact-mantine/tooltip--hover.json");
        expect(JSON.parse(bytes)).toEqual({ disableSnapshot: true, reason: "hover races" });
        const record = JSON.parse(show(s, "feature", "visual-baselines/reviews/20260927T150405Z-pr123.json"));
        expect(record.items).toEqual([
            {
                path: "visual-baselines/compact-mantine/tooltip--hover.json",
                from: null,
                to: sha256(bytes),
                reason: "exclude: hover races",
            },
        ]);
    });

    it("seeds master on a new branch at the captured commit and opens a pull request", async () => {
        const s = setup();
        const master = { commit: s.master, headSha: null, pr: null };
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "m/compact-mantine"), master);
        const out = await s.run([accept("badge--default.light.png")], { pr: null, branch: null });
        const log = remoteLog(s, "visual/seed-2026-09-27");
        expect(log[1]).toBe(s.master);
        expect(git(s.remote, "log", "-1", "--format=%s", "visual/seed-2026-09-27")).toBe(
            "test(workspace): seed visual baselines",
        );
        const create = s.calls.find((c) => c.args.join(" ").includes("/pulls"));
        expect(JSON.parse(create.input)).toMatchObject({
            title: "test(workspace): seed visual baselines",
            head: "visual/seed-2026-09-27",
            base: "master",
        });
        expect(out.pullRequest).toBe("https://github.com/o/r/pull/9");
    });
});

describe("finish: refusals", () => {
    it("refuses a PNG whose bytes do not hash to the capture in results.json", async () => {
        const s = setup();
        writeFileSync(join(s.projects["compact-mantine"].dir, "badge--default.light.png"), "tampered");
        await expect(s.run([accept("badge--default.light.png")])).rejects.toThrow(/does not match/);
        expect(remoteLog(s, "feature")[0]).toBe(s.head);
    });

    it("refuses when the pull request's head moved past the captured head", async () => {
        const s = setup();
        pushCommit(s.remote, "feature", "later.txt");
        await expect(s.run([accept("badge--default.light.png")])).rejects.toThrow(/capture is stale, wait for CI/);
    });

    it("refuses when master has a baseline commit the captured head lacks", async () => {
        const s = setup();
        pushCommit(s.remote, "master", "visual-baselines/compact-mantine/other.png");
        await expect(s.run([accept("badge--default.light.png")])).rejects.toThrow(/merge master into the branch first/);
    });

    it("ignores master's baseline commits for another project", async () => {
        const s = setup();
        pushCommit(s.remote, "master", "visual-baselines/graphty-element/other.png");
        await expect(s.run([accept("badge--default.light.png")])).resolves.toBeTruthy();
    });

    it.each(["tooltip--hover.png", "menu--open.png"])(
        "refuses to accept the %s item (unstable or failed)",
        async (file) => {
            const s = setup();
            await expect(s.run([accept(file)])).rejects.toThrow(/only be excluded/);
        },
    );

    it("refuses a local capture", async () => {
        const s = setup();
        const local = { local: { describe: "abc-dirty", diff: "0".repeat(64) }, runId: null };
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "l/compact-mantine"), local);
        await expect(s.run([accept("badge--default.light.png")])).rejects.toThrow(/local preview/);
    });
});

describe("finish: git", () => {
    it("generates commit messages that pass the repository's commitlint", () => {
        const commitlint = join(ROOT, "node_modules/.bin/commitlint");
        for (const pr of [123, null]) {
            const msg = commitMessage({
                pr,
                counts: { accept: 2, exclude: 1, remove: 1 },
                runId: 1000,
                runAttempt: 2,
                record: "visual-baselines/reviews/x.json",
            });
            const r = spawnSync(commitlint, [], { cwd: ROOT, input: msg, encoding: "utf8" });
            expect(r.stdout + r.stderr).toBe("");
            expect(r.status).toBe(0);
        }
    });

    it("commits through failing hooks, and signs when signing is configured", async () => {
        const s = setup();
        const hooks = join(s.dir, "hooks");
        mkdirSync(hooks);
        for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg", "pre-push", "post-checkout"]) {
            writeFileSync(join(hooks, hook), "#!/bin/sh\nexit 1\n");
            chmodSync(join(hooks, hook), 0o755);
        }
        git(s.repo, "config", "core.hooksPath", hooks);
        const key = join(mkdtempSync(join(tmpdir(), "vr-key-")), "key");
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
        git(s.repo, "config", "gpg.format", "ssh");
        git(s.repo, "config", "user.signingkey", key);
        git(s.repo, "config", "commit.gpgsign", "true");

        await s.run([accept("badge--default.light.png")]);
        expect(git(s.remote, "cat-file", "-p", "feature")).toContain("-----BEGIN SSH SIGNATURE-----");
    });

    it("pushes nothing and returns git's stderr when the commit fails", async () => {
        const s = setup();
        git(s.repo, "config", "gpg.format", "ssh");
        // The signing program failing stands in for an expired gpg-agent or an unplugged key.
        git(s.repo, "config", "gpg.ssh.program", "false");
        git(
            s.repo,
            "config",
            "user.signingkey",
            "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderKeyNeverUsedBecauseTheProgramFails",
        );
        git(s.repo, "config", "commit.gpgsign", "true");
        await expect(s.run([accept("badge--default.light.png")])).rejects.toThrow(/failed to write commit object/);
        expect(remoteLog(s, "feature")[0]).toBe(s.head);
    });
});

describe("finish: rejects", () => {
    it("posts every reject as one pull request comment with a machine-readable block", async () => {
        const s = setup();
        const out = await s.run([
            { project: "compact-mantine", file: "button--primary.dark.png", decision: "reject", reason: "red square" },
            { project: "graphty-element", file: "graph--basic.png", decision: "reject", reason: "nodes overlap" },
        ]);
        expect(out.commit).toBeNull();
        expect(remoteLog(s, "feature")[0]).toBe(s.head);
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0].args.join(" ")).toContain("issues/123/comments");
        const body = JSON.parse(s.calls[0].input).body;
        expect(body).toContain("red square");
        const block = JSON.parse(/<!-- visual-review-rejects\n(.*)\n-->/s.exec(body)[1]);
        expect(block).toMatchObject({
            version: 1,
            pr: 123,
            runId: 1000,
            head: s.head,
            items: [
                { project: "compact-mantine", file: "button--primary.dark.png", reason: "red square" },
                { project: "graphty-element", file: "graph--basic.png", reason: "nodes overlap" },
            ],
        });
    });

    it("says the accepts landed when only the reject comment fails", async () => {
        const s = setup();
        const failing = async () => {
            throw new Error("HTTP 502");
        };
        const err = await finish({
            repo: s.repo,
            gh: failing,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions: [
                accept("badge--default.light.png"),
                { project: "compact-mantine", file: "button--primary.dark.png", decision: "reject", reason: "red" },
            ],
            now: NOW,
        }).catch((e) => e);
        expect(err.message).toMatch(/accepts were pushed .* reject comment failed: HTTP 502/);
        expect(err.committed).toBe(remoteLog(s, "feature")[0]);
    });

    it("requires a reason for a reject", async () => {
        const s = setup();
        const decision = {
            project: "compact-mantine",
            file: "badge--default.light.png",
            decision: "reject",
            reason: "",
        };
        await expect(s.run([decision])).rejects.toThrow(/reason/);
    });
});

describe("finish and the gate's record check", () => {
    it("records every baseline change it makes, and only those", async () => {
        const s = setup();
        await s.run([
            accept("button--primary.dark.png"),
            accept("card--legacy.png", "compact-mantine", "gone"),
            { project: "compact-mantine", file: "tooltip--hover.png", decision: "exclude", reason: "hover races" },
        ]);
        git(s.repo, "fetch", "-q", "origin");
        expect(unrecordedChanges(s.master, "origin/feature", s.repo)).toEqual([]);

        // A PNG and an excluding settings file without Finish; a delay-only settings file needs none.
        const clone = mkdtempSync(join(tmpdir(), "vr-forge-"));
        git(clone, "clone", "-q", "-b", "feature", s.remote, ".");
        const dir = join(clone, "visual-baselines/compact-mantine");
        writeFileSync(join(dir, "badge--default.light.png"), "copied capture");
        writeFileSync(join(dir, "slider--sizes.json"), JSON.stringify({ disableSnapshot: true }));
        writeFileSync(join(dir, "button--primary.json"), JSON.stringify({ delay: 100 }));
        git(clone, "add", "-A");
        git(clone, "-c", "user.name=A", "-c", "user.email=a@example.com", "commit", "-q", "-m", "forge");
        expect(unrecordedChanges(s.master, "HEAD", clone)).toEqual([
            "visual-baselines/compact-mantine/badge--default.light.png: changed with no review record naming its new contents",
            "visual-baselines/compact-mantine/slider--sizes.json: changed with no review record naming its new contents",
        ]);
    });
});
