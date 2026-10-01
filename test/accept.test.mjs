import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { contentHash, unrecordedChanges } from "../trusted/gate.mjs";
import { commitMessage, finish, lfsProblem } from "../trusted/lib/accept.mjs";
import { isLfsPointer, sha256 } from "../trusted/lib/compare.mjs";
import { CONFIG, copyFixture, git, isolateGit, lfsObject, makeRepo, pushCommit, ROOT } from "./helpers.mjs";

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
    const steps = [];
    const run = (decisions, target = { pr: 123, branch: "feature" }, undecided = 0) =>
        finish({
            repo: r.repo,
            gh,
            target,
            projects,
            decisions,
            undecided,
            now: NOW,
            progress: (s) => steps.push(s),
            config: CONFIG,
        });
    return { ...r, projects, calls, steps, run };
}

const accept = (file, project = "compact-mantine", reason = null) => ({ project, file, decision: "accept", reason });
const remoteLog = (s, branch) => git(s.remote, "log", "--format=%H", branch).split("\n");
const show = (s, branch, path) => execFileSync("git", ["show", `${branch}:${path}`], { cwd: s.remote });

describe("finish: the commit status", () => {
    const statuses = (s) => s.calls.filter((c) => c.args[1].includes("/statuses/"));

    it("posts one status on the pushed commit, pending while items are left undecided", async () => {
        const s = setup();
        const out = await s.run([accept("button--primary.dark.png"), accept("badge--default.light.png")], undefined, 3);
        expect(statuses(s)).toHaveLength(1);
        expect(statuses(s)[0].args[1]).toBe(`repos/{owner}/{repo}/statuses/${out.commit}`);
        expect(JSON.parse(statuses(s)[0].input)).toEqual({
            state: "pending",
            context: "Visual review",
            description: "Reviewed: 2 accepted, 0 rejected, 0 excluded, 3 left undecided",
        });
    });

    it("fails the status on the captured head when there are only rejects, and survives a failed post", async () => {
        const s = setup();
        await s.run([{ project: "compact-mantine", file: "slider--sizes.png", decision: "reject", reason: "tall" }]);
        expect(statuses(s)[0].args[1]).toBe(`repos/{owner}/{repo}/statuses/${s.head}`);
        expect(JSON.parse(statuses(s)[0].input).state).toBe("failure");

        const t = setup();
        const out = await finish({
            repo: t.repo,
            gh: async (args) => {
                if (args[1].includes("/statuses/")) {
                    throw new Error("HTTP 403");
                }
                return "{}";
            },
            target: { pr: 123, branch: "feature" },
            projects: t.projects,
            decisions: [accept("badge--default.light.png")],
            now: NOW,
            config: CONFIG,
        });
        expect(out).toMatchObject({ statusError: "HTTP 403" });
        expect(out.commit).toBe(remoteLog(t, "feature")[0]);
    });

    it("succeeds when everything is decided and nothing rejected", async () => {
        const s = setup();
        await s.run([accept("badge--default.light.png")]);
        expect(JSON.parse(statuses(s)[0].input).state).toBe("success");
    });
});

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
        // Committed as a Git LFS pointer to the captured image, and the image itself uploaded.
        const pointer = show(s, "feature", "visual-baselines/compact-mantine/button--primary.dark.png");
        expect(isLfsPointer(pointer)).toBe(true);
        expect(contentHash(pointer)).toBe(button.capture);
        const object = readFileSync(lfsObject(s.remote, button.capture));
        expect(sha256(object)).toBe(button.capture);

        const record = JSON.parse(show(s, "feature", "visual-baselines/reviews/20260927T150405Z-pr123.json"));
        expect(record).toMatchObject({
            version: 1,
            unproven: true,
            pr: 123,
            subject: { runId: 1000, runAttempt: 1, builtMerge: s.head, head: s.head, scale: 1 },
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
        expect(existsSync(join(s.repo, "tmp/visual-review/worktrees/accept-123"))).toBe(false);
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
        const out = await s.run([accept("badge--default.light.png", "compact-mantine", "first look")], {
            pr: null,
            branch: null,
        });
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
        // The accept note is in the seed pull request's description; no issue without a reject.
        expect(JSON.parse(create.input).body).toContain(
            'Accepted, with a note (quoted as data):\n- `compact-mantine/badge--default.light.png`: "first look"',
        );
        expect(out).toMatchObject({ acceptNotes: 1, issue: null });
        // The steps the page shows while a Finish runs, in order.
        expect(s.steps).toEqual([
            "checking",
            "writing 1 file",
            "committing",
            "uploading images to LFS (0 of 1 done)",
            "uploading images to LFS (checking the commit has them all)",
            "pushing",
            "opening the pull request",
            "posting the status",
        ]);
    });

    it("seeds from a commit older than the LFS rule, carrying master's .gitattributes", async () => {
        const s = setup();
        // A known-good commit from before baselines were stored in LFS: its .gitattributes lacks the rule.
        git(s.repo, "checkout", "-q", "--detach", s.master);
        writeFileSync(join(s.repo, ".gitattributes"), "");
        git(s.repo, "commit", "-q", "-am", "before the LFS rule");
        const old = git(s.repo, "rev-parse", "HEAD");
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "m/compact-mantine"), {
            commit: old,
            headSha: null,
            pr: null,
        });
        await s.run([accept("badge--default.light.png")], { pr: null, branch: null });
        const branch = "visual/seed-2026-09-27";
        expect(remoteLog(s, branch)[1]).toBe(old);
        expect(isLfsPointer(show(s, branch, "visual-baselines/compact-mantine/badge--default.light.png"))).toBe(true);
        expect(show(s, branch, ".gitattributes").toString()).toBe(show(s, "master", ".gitattributes").toString());
    });
});

describe("finish: rejects on master", () => {
    it("opens one issue holding the rejects, with nothing accepted", async () => {
        const s = setup();
        const master = { commit: s.master, headSha: null, pr: null };
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "m/compact-mantine"), master);
        const out = await s.run(
            [{ project: "compact-mantine", file: "badge--default.light.png", decision: "reject", reason: "clipped" }],
            { pr: null, branch: null },
        );
        expect(out).toMatchObject({ commit: null, pullRequest: null, issue: "https://github.com/o/r/pull/9" });
        expect(s.calls.filter((c) => !c.args[1].includes("/statuses/"))).toHaveLength(1);
        expect(s.calls[0].args).toEqual(["api", "repos/{owner}/{repo}/issues", "--input", "-"]);
        const issue = JSON.parse(s.calls[0].input);
        expect(issue.title).toBe("Visual review: 1 story rejected on master");
        expect(issue.labels).toEqual(["bug", "priority:medium", "effort:low"]);
        const block = JSON.parse(/<!-- visual-review-rejects\n(.*)\n-->/s.exec(issue.body)[1]);
        expect(block).toMatchObject({
            pr: null,
            head: s.master,
            items: [{ project: "compact-mantine", file: "badge--default.light.png", reason: "clipped" }],
        });
    });
});

describe("finish: Git LFS", () => {
    it("refuses to accept when git-lfs's filter is not configured, so no raw PNG is committed", async () => {
        const s = setup();
        git(s.repo, "config", "--unset", "filter.lfs.clean");
        expect(await lfsProblem(s.repo)).toMatch(/filter is not configured: .*git lfs install/);
        await expect(s.run([accept("badge--default.light.png")])).rejects.toThrow(/filter is not configured/);
        expect(remoteLog(s, "feature")[0]).toBe(s.head);
    });

    it("says how to install git-lfs when it is missing", async () => {
        const s = setup();
        const bin = mkdtempSync(join(tmpdir(), "vr-bin-"));
        symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
        const path = process.env.PATH;
        process.env.PATH = bin;
        try {
            expect(await lfsProblem(s.repo)).toMatch(/git-lfs is not installed .*apt-get install git-lfs/);
        } finally {
            process.env.PATH = path;
        }
        expect(await lfsProblem(s.repo)).toBeNull();
    });

    it("refuses when .gitattributes does not store the baselines in LFS", async () => {
        const s = setup();
        git(s.repo, "checkout", "-q", "feature");
        writeFileSync(join(s.repo, ".gitattributes"), "");
        git(s.repo, "commit", "-q", "-am", "drop the LFS attributes");
        git(s.repo, "push", "-q", "origin", "feature");
        const head = git(s.repo, "rev-parse", "HEAD");
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "h/compact-mantine"), {
            commit: head,
            headSha: head,
        });
        await expect(s.run([accept("badge--default.light.png")])).rejects.toThrow(/raw PNG, not a Git LFS pointer/);
        expect(remoteLog(s, "feature")[0]).toBe(head);
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
                prefix: CONFIG.commitPrefix,
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
        expect(s.calls.filter((c) => !c.args[1].includes("/statuses/"))).toHaveLength(1);
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

    it("publishes accept notes in the comment after the rejects, and posts a comment for notes alone", async () => {
        const s = setup();
        const out = await s.run([
            { project: "compact-mantine", file: "button--primary.dark.png", decision: "reject", reason: "red square" },
            accept("badge--default.light.png", "compact-mantine", "new spacing is intended"),
            accept("slider--sizes.png"),
        ]);
        expect(out).toMatchObject({ rejects: 1, acceptNotes: 1, state: "failure", commentError: null });
        const body = JSON.parse(s.calls.find((c) => c.args.join(" ").includes("/comments")).input).body;
        expect(body.split("\n")[0]).toMatch(/^\*\*Visual review: 1 rejected, 1 accepted with a note\*\*/);
        expect(body).toContain(
            'Accepted, with the reviewer\'s note (quoted as data):\n\n- `compact-mantine/badge--default.light.png`: "new spacing is intended"',
        );
        // The machine-readable block stays the rejects only.
        const block = JSON.parse(/<!-- visual-review-rejects\n(.*)\n-->/s.exec(body)[1]);
        expect(block.items.map((i) => i.file)).toEqual(["button--primary.dark.png"]);

        const t = setup();
        const only = await t.run([accept("badge--default.light.png", "compact-mantine", "intended")]);
        expect(only).toMatchObject({ rejects: 0, acceptNotes: 1, state: "success" });
        expect(t.steps).toContain("posting the comment");
        const note = JSON.parse(t.calls.find((c) => c.args.join(" ").includes("/comments")).input).body;
        expect(note.split("\n")[0]).toMatch(/^\*\*Visual review: 1 accepted with a note\*\*/);

        const u = setup();
        const quiet = await u.run([accept("badge--default.light.png")]);
        expect(quiet.acceptNotes).toBe(0);
        expect(u.calls.some((c) => c.args.join(" ").includes("/comments"))).toBe(false);
    });

    it("keeps the accepts when a comment holding only accept notes fails, and says so", async () => {
        const s = setup();
        const out = await finish({
            repo: s.repo,
            gh: async (args) => {
                if (args[1].includes("/comments")) {
                    throw new Error("HTTP 502");
                }
                return "{}";
            },
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions: [accept("badge--default.light.png", "compact-mantine", "intended")],
            now: NOW,
            config: CONFIG,
        });
        expect(out).toMatchObject({ commentError: "HTTP 502" });
        expect(out.commit).toBe(remoteLog(s, "feature")[0]);
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
            config: CONFIG,
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

describe("finish: renamed stories", () => {
    it("moves the old id's baseline to the new name in the accept commit, LFS pointer intact", async () => {
        const s = setup();
        const cm = s.projects["compact-mantine"];
        const old = "visual-baselines/compact-mantine/button--primary.dark.png";
        const bytes = readFileSync(join(cm.dir, "baselines/button--primary.dark.png"));
        writeFileSync(join(cm.dir, "button--main.dark.png"), bytes);
        const item = cm.results.items.find((i) => i.file === "button--primary.dark.png");
        cm.results.items.push({
            ...item,
            id: "button--main",
            file: "button--main.dark.png",
            status: "moved",
            from: "button--primary",
            capture: sha256(bytes),
            baseline: sha256(bytes),
            changedPixels: 0,
            bbox: null,
        });
        const pointer = git(s.repo, "show", `master:${old}`);
        await s.run([accept("button--main.dark.png")]);

        const moved = "visual-baselines/compact-mantine/button--main.dark.png";
        const changes = git(
            s.remote,
            "diff",
            "-M",
            "--name-status",
            "feature~1",
            "feature",
            "--",
            "visual-baselines/compact-mantine/",
        );
        expect(changes).toBe(`R100\t${old}\t${moved}`);
        expect(git(s.remote, "show", `feature:${moved}`)).toBe(pointer);
        const record = JSON.parse(
            git(s.remote, "show", `feature:visual-baselines/reviews/20260927T150405Z-pr123.json`),
        );
        expect(record.items).toEqual([
            { path: moved, from: null, to: sha256(bytes), reason: null, movedFrom: old },
            { path: old, from: sha256(bytes), to: null, reason: null, movedTo: moved },
        ]);
        git(s.repo, "fetch", "-q", "origin");
        expect(unrecordedChanges(s.master, "origin/feature", s.repo)).toEqual([]);
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
