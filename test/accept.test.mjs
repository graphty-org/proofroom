import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { contentHash, gateProblems, treeApprovalProblems, treeAt } from "../trusted/gate.mjs";
import {
    commitMessage,
    commitStatus,
    finish,
    lfsProblem,
    prepareApproval,
    proposeKey,
    rejectComment,
    signRecord,
    treeSignedRecords,
    treeStatement,
    unsignedRecordAt,
    updateFromMaster,
} from "../trusted/lib/accept.mjs";
import { parsePasskeys, recordHash, verifyRecord } from "../trusted/lib/approval.mjs";
import { classify, isLfsPointer, sha256 } from "../trusted/lib/compare.mjs";
import { approvalIndex } from "../trusted/lib/filters.mjs";
import {
    CONFIG,
    copyFixture,
    FIXTURE,
    git,
    isolateGit,
    lfsObject,
    makeRepo,
    pushCommit,
    ROOT,
    tempDir,
} from "./helpers.mjs";
import { approve, makeKey, passkeysJson } from "./passkey-vectors.mjs";

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
    const run = (decisions, target = { pr: 123, branch: "feature" }, undecided = 0, extra = {}) =>
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
            ...extra,
        });
    return { ...r, projects, calls, steps, run, gh };
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

    it("fails the status on the captured head when there are only rejects", async () => {
        const s = setup();
        await s.run([{ project: "compact-mantine", file: "slider--sizes.png", decision: "reject", reason: "tall" }]);
        expect(statuses(s)[0].args[1]).toBe(`repos/{owner}/{repo}/statuses/${s.head}`);
        expect(JSON.parse(statuses(s)[0].input).state).toBe("failure");
    });

    it("survives a failed status post", async () => {
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
            version: 3,
            rejects: [],
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

describe("finish: a candidate of master", () => {
    const candidateSetup = () => {
        const s = setup();
        const master = { commit: s.master, headSha: null, pr: null };
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "m/compact-mantine"), master);
        return s;
    };
    const changed = (s, branch) => git(s.remote, "diff", "--name-only", s.master, branch).split("\n").filter(Boolean);

    it("commits on the candidate, pushes visual/approve-<sha> and opens an accept-only pull request", async () => {
        const s = candidateSetup();
        const out = await s.run([accept("badge--default.light.png")], { pr: null, branch: null, candidate: s.master });
        const branch = `visual/approve-${s.master.slice(0, 12)}`;
        expect(out.branch).toBe(branch);
        expect(remoteLog(s, branch)[1]).toBe(s.master);
        expect(changed(s, branch).length).toBeGreaterThan(0);
        expect(
            changed(s, branch).every(
                (f) => f.startsWith("visual-baselines/") || f.startsWith("visual-review-approvals/"),
            ),
        ).toBe(true);
        const create = s.calls.find((c) => c.args.join(" ").includes("/pulls"));
        expect(JSON.parse(create.input)).toMatchObject({
            title: `test(workspace): approve visual baselines at ${s.master.slice(0, 12)}`,
            head: branch,
            base: "master",
        });
        expect(JSON.parse(create.input).body).toContain(
            "It changes only visual-baselines/ and visual-review-approvals/.",
        );
        expect(JSON.parse(create.input).body).toMatch(/^No issue$/m);
        expect(out.pullRequest).toBe("https://github.com/o/r/pull/9");
    });

    it("refuses accepts beside a reject: a candidate with a rejected image never promotes", async () => {
        const s = candidateSetup();
        const reject = { project: "compact-mantine", file: "slider--sizes.png", decision: "reject", reason: "tall" };
        await expect(
            s.run([accept("badge--default.light.png"), reject], { pr: null, branch: null, candidate: s.master }),
        ).rejects.toThrow(/posts only its rejects/);
        expect(s.calls).toHaveLength(0);
    });

    it("replaces the branch an earlier Finish of the same candidate left, and reuses its open pull request", async () => {
        const s = candidateSetup();
        const branch = `visual/approve-${s.master.slice(0, 12)}`;
        await s.run([accept("badge--default.light.png")], { pr: null, branch: null, candidate: s.master });
        // A signed Finish's approval commit on top, then its pull request failed to open.
        git(s.repo, "fetch", "-q", "origin", branch);
        git(s.repo, "checkout", "-q", "--detach", "FETCH_HEAD");
        mkdirSync(join(s.repo, "visual-review-approvals"), { recursive: true });
        writeFileSync(join(s.repo, "visual-review-approvals/t.json"), "{}\n");
        git(s.repo, "add", "-A");
        git(s.repo, "commit", "-q", "-m", "test(workspace): approve the visual baselines of the seed");
        git(s.repo, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        const before = git(s.remote, "rev-parse", branch);
        const open = [{ number: 8, head: { ref: branch }, html_url: "https://github.com/o/r/pull/8" }];
        const gh = async (args, input) => {
            s.calls.push({ args, input });
            if (args[1].endsWith("/pulls")) {
                throw new Error("HTTP 422: A pull request already exists");
            }
            return JSON.stringify(args[1].includes("pulls?state=open") ? open : {});
        };
        const out = await s.run(
            [
                accept("badge--default.light.png"),
                accept("button--primary.dark.png", "compact-mantine", "the border is darker now"),
            ],
            {
                pr: null,
                branch: null,
                candidate: s.master,
            },
            0,
            { gh },
        );
        expect(out.pullRequest).toBe("https://github.com/o/r/pull/8");
        // The reused pull request's description is rewritten with this Finish's, so its notes are published.
        const patch = s.calls.find((c) => c.args.includes("PATCH"));
        expect(patch.args).toContain("repos/{owner}/{repo}/pulls/8");
        expect(JSON.parse(patch.input).body).toContain("the border is darker now");
        expect(git(s.remote, "rev-parse", branch)).not.toBe(before);
        expect(remoteLog(s, branch)[1]).toBe(s.master);
    });

    it("forgets a branch deleted from origin since an earlier Finish, and pushes again", async () => {
        const s = candidateSetup();
        const branch = `visual/approve-${s.master.slice(0, 12)}`;
        await s.run([accept("badge--default.light.png")], { pr: null, branch: null, candidate: s.master });
        git(s.remote, "branch", "-D", branch);
        const out = await s.run([accept("badge--default.light.png")], { pr: null, branch: null, candidate: s.master });
        expect(git(s.remote, "rev-parse", branch)).toBe(out.commit);
    });

    it("rebuilds a candidate's branch that its pull request's Update branch merged master into", async () => {
        const s = candidateSetup();
        const branch = `visual/approve-${s.master.slice(0, 12)}`;
        await s.run([accept("badge--default.light.png")], { pr: null, branch: null, candidate: s.master });
        git(s.repo, "checkout", "-q", "master");
        writeFileSync(join(s.repo, "README.md"), "moved on\n");
        git(s.repo, "commit", "-q", "-am", "master moves on");
        git(s.repo, "push", "-q", "origin", "master");
        git(s.repo, "fetch", "-q", "origin", branch);
        git(s.repo, "checkout", "-q", "--detach", "FETCH_HEAD");
        git(s.repo, "merge", "-q", "--no-edit", "master");
        git(s.repo, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        const out = await s.run([accept("badge--default.light.png")], { pr: null, branch: null, candidate: s.master });
        expect(git(s.remote, "rev-parse", branch)).toBe(out.commit);
        expect(git(s.remote, "log", "--format=%P", "-1", `${branch}~0`).split(" ")).toHaveLength(1);
    });

    it("refuses a capture that is not of the candidate", async () => {
        const s = candidateSetup();
        await expect(
            s.run([accept("badge--default.light.png")], { pr: null, branch: null, candidate: s.head }),
        ).rejects.toThrow(/not of the candidate/);
        expect(s.calls).toHaveLength(0);
    });

    it("refuses to push an accept commit that changes anything else", async () => {
        const s = candidateSetup();
        // An approval commit holding a change outside the two directories.
        git(s.repo, "checkout", "-q", "--detach", s.master);
        writeFileSync(join(s.repo, "README.md"), "changed\n");
        git(s.repo, "commit", "-q", "-am", "not a baseline");
        const commit = git(s.repo, "rev-parse", "HEAD");
        const branch = `visual/approve-${s.master.slice(0, 12)}`;
        await expect(
            s.run([accept("badge--default.light.png")], { pr: null, branch: null, candidate: s.master }, 0, {
                approval: { commit, branch, record: null },
            }),
        ).rejects.toThrow(/would change README\.md, outside visual-baselines\/ and visual-review-approvals\//);
        expect(git(s.remote, "ls-remote", "--heads", ".", branch)).toBe("");
    });
});

describe("finish: a rolling render of master", () => {
    const rollingSetup = () => {
        const s = setup();
        const master = { commit: s.master, headSha: null, pr: null };
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "m/compact-mantine"), master);
        return s;
    };

    it("commits on the render commit, pushes visual/approve-rolling-<sha> with its own subject", async () => {
        const s = rollingSetup();
        const short = s.master.slice(0, 12);
        const out = await s.run([accept("badge--default.light.png")], {
            pr: null,
            branch: null,
            candidate: s.master,
            rolling: true,
        });
        const branch = `visual/approve-rolling-${short}`;
        expect(out.branch).toBe(branch);
        expect(remoteLog(s, branch)[1]).toBe(s.master);
        const subject = `test(workspace): rolling approval of visual baselines rendered at ${short}`;
        expect(git(s.remote, "log", "-1", "--format=%s", branch)).toBe(subject);
        const create = s.calls.find((c) => c.args.join(" ").includes("/pulls"));
        expect(JSON.parse(create.input)).toMatchObject({ title: subject, head: branch, base: "master" });
        // never a candidate approval: release-due and promote-nightly look for this phrase
        expect(subject).not.toContain("approve visual baselines at");
        expect(JSON.parse(create.input).body).toMatch(/^No issue$/m);
    });

    it("closes the open rolling approval pull requests when a candidate's Finish pushes", async () => {
        const s = rollingSetup();
        const open = [
            { number: 41, html_url: "https://github.com/o/r/pull/41", head: { ref: "visual/approve-rolling-abc" } },
            { number: 42, html_url: "https://github.com/o/r/pull/42", head: { ref: "feat/other" } },
        ];
        const gh = async (args, input) => {
            s.calls.push({ args, input });
            if (args.some((a) => String(a).includes("pulls?state=open"))) {
                return JSON.stringify(open);
            }
            return JSON.stringify({ html_url: "https://github.com/o/r/pull/9", number: 9 });
        };
        const out = await s.run(
            [accept("badge--default.light.png")],
            { pr: null, branch: null, candidate: s.master },
            0,
            {
                gh,
            },
        );
        expect(out.closedRolling).toEqual(["https://github.com/o/r/pull/41"]);
        const closes = s.calls.filter((c) => c.args.includes("state=closed"));
        expect(closes.map((c) => c.args[3])).toEqual(["repos/{owner}/{repo}/pulls/41"]);
    });

    it("leaves other approval pull requests open when a rolling Finish pushes", async () => {
        const s = rollingSetup();
        const out = await s.run([accept("badge--default.light.png")], {
            pr: null,
            branch: null,
            candidate: s.master,
            rolling: true,
        });
        expect(out.closedRolling).toBeUndefined();
        expect(s.calls.filter((c) => c.args.includes("state=closed"))).toHaveLength(0);
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

describe("finish: a seed whose rejects issue fails", () => {
    it("names the issue and the seed pull request, and does not call the accept notes lost", async () => {
        const s = setup();
        const master = { commit: s.master, headSha: null, pr: null };
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "m/compact-mantine"), master);
        const err = await finish({
            repo: s.repo,
            gh: async (args) => {
                if (args[1].includes("/issues")) {
                    throw new Error("HTTP 502");
                }
                return JSON.stringify({ html_url: "https://github.com/o/r/pull/9", number: 9 });
            },
            target: { pr: null, branch: null },
            projects: s.projects,
            decisions: [
                accept("badge--default.light.png", "compact-mantine", "first look"),
                { project: "compact-mantine", file: "button--primary.dark.png", decision: "reject", reason: "red" },
            ],
            now: NOW,
            config: CONFIG,
        }).catch((e) => e);
        expect(err.message).toMatch(
            /^the accepts were pushed as \w{10} and opened https:\/\/github\.com\/o\/r\/pull\/9, but the issue with the rejects failed: HTTP 502\. Press Finish again to post the rejects\.$/,
        );
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
        const bin = tempDir("vr-bin-");
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

describe("finish: a Finish sent again after it succeeded", () => {
    const B = "badge--default.light.png";
    const P = "button--primary.dark.png";

    it("reports the same decisions as already finished, and pushes and posts nothing", async () => {
        const s = setup();
        const first = await s.run([accept(B), accept(P, "compact-mantine", "wider")]);
        const calls = s.calls.length;
        const again = await s.run([accept(B), accept(P, "compact-mantine", "wider")]);
        expect(again).toMatchObject({ commit: first.commit, branch: "feature", alreadyFinished: true });
        expect(remoteLog(s, "feature")[0]).toBe(first.commit);
        expect(s.calls).toHaveLength(calls);
    });

    it("reports part of the same decisions as already finished", async () => {
        const s = setup();
        const first = await s.run([accept(B), accept(P)]);
        await expect(s.run([accept(B)])).resolves.toMatchObject({ commit: first.commit, alreadyFinished: true });
    });

    it("still refuses as stale when the branch moved by anything else", async () => {
        const s = setup();
        await s.run([accept(B)]);
        pushCommit(s.remote, "feature", "later.txt");
        await expect(s.run([accept(B)])).rejects.toThrow(/capture is stale, wait for CI/);
    });

    it("still refuses as stale when the decisions differ", async () => {
        const s = setup();
        const first = await s.run([accept(B)]);
        await expect(s.run([accept(B), accept(P)])).rejects.toThrow(/capture is stale, wait for CI/);
        await expect(s.run([accept(B, "compact-mantine", "a note")])).rejects.toThrow(/capture is stale/);
        await expect(
            s.run([accept(B), { project: "compact-mantine", file: P, decision: "reject", reason: "no" }]),
        ).rejects.toThrow(/capture is stale/);
        expect(remoteLog(s, "feature")[0]).toBe(first.commit);
    });
});

describe("finish: git", () => {
    // commitlint's own load and lint, as its CLI runs them, in this process: the CLI started once
    // per message loaded node and the configuration three times over. Loaded once for the file,
    // before the test: loading commitlint and the repository's configuration is most of the work.
    let lint;
    let config;
    let options;
    beforeAll(async () => {
        const from = createRequire(ROOT);
        const load = (await import(pathToFileURL(from.resolve("@commitlint/load")).href)).default;
        lint = (await import(pathToFileURL(from.resolve("@commitlint/lint")).href)).default;
        config = await load({}, { cwd: ROOT });
        options = {
            parserOpts: config.parserPreset?.parserOpts,
            plugins: config.plugins,
            ignores: config.ignores,
            defaultIgnores: config.defaultIgnores,
        };
    });

    it("generates commit messages that pass the repository's commitlint", async () => {
        const local = [
            { project: "compact-mantine", merge: "3".repeat(40) },
            { project: "graphty-element", merge: "3".repeat(40) },
        ];
        for (const [pr, previews] of [
            [123, []],
            [null, []],
            [123, local],
        ]) {
            const msg = commitMessage({
                pr,
                local: previews,
                counts: { accept: 2, exclude: 1, remove: 1 },
                runId: 1000,
                runAttempt: 2,
                record: "visual-baselines/reviews/x.json",
                prefix: CONFIG.commitPrefix,
            });
            const r = await lint(msg, config.rules, options);
            expect([...r.errors, ...r.warnings].map((p) => p.message)).toEqual([]);
            expect(r.valid).toBe(true);
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
        const key = join(tempDir("vr-key-"), "key");
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

    it("publishes accept notes in the comment after the rejects", async () => {
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
    });

    it("posts a comment for accept notes alone", async () => {
        const t = setup();
        const only = await t.run([accept("badge--default.light.png", "compact-mantine", "intended")]);
        expect(only).toMatchObject({ rejects: 0, acceptNotes: 1, state: "success" });
        expect(t.steps).toContain("posting the comment");
        const note = JSON.parse(t.calls.find((c) => c.args.join(" ").includes("/comments")).input).body;
        expect(note.split("\n")[0]).toMatch(/^\*\*Visual review: 1 accepted with a note\*\*/);
    });

    it("posts no comment for accepts without notes", async () => {
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
        // Not reported as posted, and named, since the cleared accepts never post them again.
        expect(out).toMatchObject({ acceptNotes: 0 });
        expect(out.commentError).toBe(
            'HTTP 502. These accept notes were not posted and are not kept: compact-mantine/badge--default.light.png: "intended".',
        );
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
                accept("badge--default.light.png", "compact-mantine", "intended"),
                { project: "compact-mantine", file: "button--primary.dark.png", decision: "reject", reason: "red" },
            ],
            now: NOW,
            config: CONFIG,
        }).catch((e) => e);
        expect(err.message).toMatch(
            /accepts were pushed .* comment with the rejects and 1 accept note failed: HTTP 502/,
        );
        expect(err.message).toContain(
            'These accept notes were not posted and are not kept: compact-mantine/badge--default.light.png: "intended".',
        );
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
    });
});

describe("finish and the gate's tree check", () => {
    // The gate's check of the pushed branch, while no key is known (an unsigned statement counts).
    const gate = (s, base = s.master, head = "origin/feature") => {
        git(s.repo, "fetch", "-q", "origin");
        return treeApprovalProblems({
            base,
            head,
            cwd: s.repo,
            baselines: CONFIG.baselines,
            approvals: CONFIG.approvals,
            keys: null,
        });
    };

    it("approves the tree it leaves when it signs, outside the baselines, and nothing else", async () => {
        const s = setup();
        await s.run(
            [
                accept("button--primary.dark.png"),
                accept("card--legacy.png", "compact-mantine", "gone"),
                { project: "compact-mantine", file: "tooltip--hover.png", decision: "exclude", reason: "hover races" },
            ],
            undefined,
            0,
            { sign: true },
        );
        expect(gate(s)).toEqual([]);
        const [approval, accepts] = remoteLog(s, "feature");
        const tree = treeAt(accepts, CONFIG.baselines, s.remote);
        expect(git(s.remote, "show", "--name-only", "--format=", approval)).toBe(
            `visual-review-approvals/${tree}.json`,
        );
        expect(JSON.parse(show(s, "feature", `visual-review-approvals/${tree}.json`))).toEqual({
            version: 1,
            commit: accepts,
            tree,
            baselines: "visual-baselines",
            pr: 123,
            approvedAt: NOW.toISOString(),
        });

        // A PNG and a settings file committed without Finish: another tree, which nobody approved.
        const clone = tempDir("vr-forge-");
        git(clone, "clone", "-q", "-b", "feature", s.remote, ".");
        const dir = join(clone, "visual-baselines/compact-mantine");
        writeFileSync(join(dir, "badge--default.light.png"), "copied capture");
        writeFileSync(join(dir, "slider--sizes.json"), JSON.stringify({ disableSnapshot: true }));
        git(clone, "add", "-A");
        git(clone, "-c", "user.name=A", "-c", "user.email=a@example.com", "commit", "-q", "-m", "forge");
        git(clone, "push", "-q", "origin", "feature");
        expect(gate(s)[0]).toMatch(/approves it/);
    });

    it("signs nothing when it leaves images undecided or rejects any", async () => {
        const s = setup();
        await s.run([accept("button--primary.dark.png")], undefined, 1);
        const files = git(s.remote, "show", "--name-only", "--format=", "feature");
        expect(files).not.toContain("visual-review-approvals/");
        expect(gate(s)[0]).toMatch(/approves it/);
    });
});

describe("finish when master has newer baselines", () => {
    const BUTTON = "visual-baselines/compact-mantine/button--primary.dark.png";
    // The merge the merge queue makes before it merges: master into the pull request, in the remote.
    const queueMerge = (s) => {
        const merged = spawnSync("git", ["merge-tree", "--write-tree", "master", "feature"], {
            cwd: s.remote,
            encoding: "utf8",
        });
        if (merged.status !== 0) {
            return null;
        }
        const tree = merged.stdout.split("\n")[0];
        return git(
            s.remote,
            "-c",
            "user.name=Q",
            "-c",
            "user.email=q@example.com",
            "commit-tree",
            tree,
            "-p",
            "master",
            "-p",
            "feature",
            "-m",
            "merge master",
        );
    };

    it("needs a new approval once master's newer baselines are merged in: the merged tree is another tree", async () => {
        const s = setup();
        await s.run([accept("button--primary.dark.png")], undefined, 0, { sign: true });
        const check = (base, head) =>
            treeApprovalProblems({
                base,
                head,
                cwd: s.remote,
                baselines: CONFIG.baselines,
                approvals: CONFIG.approvals,
                keys: null,
            });
        expect(check("master", queueMerge(s))).toEqual([]);
        const master = pushCommit(s.remote, "master", "visual-baselines/compact-mantine/card--legacy.png");
        const merged = queueMerge(s);
        expect(merged).not.toBeNull();
        expect(check(master, merged)[0]).toMatch(/approves it/);
    });

    describe("an accept of a story master also changed", () => {
        // Another pull request's accept on master: a different image of the same story.
        const theirs = readFileSync(join(FIXTURE, "compact-mantine/second/tooltip--hover.png"));
        // The Finish, shared by the two tests below so each holds one git-heavy step of its own.
        let s;
        beforeAll(async () => {
            s = setup();
            const other = tempDir("vr-other-");
            git(other, "clone", "-q", "-b", "master", s.remote, ".");
            writeFileSync(join(other, BUTTON), theirs);
            git(other, "-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-q", "-am", "accept");
            git(other, "push", "-q", "origin", "master");
            await s.run([accept("button--primary.dark.png")]);
        });

        it("is recorded, and the queue cannot merge it", () => {
            // Both sides changed the baseline: the queue cannot merge, so the branch is updated
            // from master.
            expect(queueMerge(s)).toBeNull();
        });

        it("is replaced by master's side with no record on an update, and the next capture brings it back", async () => {
            const out = await updateFromMaster({ repo: s.repo, pr: 123, branch: "feature", config: CONFIG });
            expect(out.taken).toEqual([BUTTON]);
            const head = git(s.remote, "rev-parse", "feature");
            // Master's side of the baseline, and the pull request's record: a tree nobody approved yet.
            expect(git(s.remote, "show", `${head}:${BUTTON}`)).toBe(git(s.remote, "show", `master:${BUTTON}`));
            // The capture of the merged tree compares the accepted image with master's baseline: changed,
            // so it is undecided again and the gate blocks until the owner decides it.
            const item = classify({
                baseline: theirs,
                first: readFileSync(join(s.projects["compact-mantine"].dir, "button--primary.dark.png")),
                threshold: 0.063,
                includeAA: false,
            });
            expect(item.status).toBe("changed");
            const fixture = s.projects["compact-mantine"].results;
            const results = {
                ...fixture,
                expected: 1,
                items: [
                    { ...fixture.items.find((i) => i.file === "button--primary.dark.png"), ...item, threshold: 0.063 },
                ],
            };
            expect(
                gateProblems({
                    config: { ...CONFIG, projects: { "compact-mantine": CONFIG.projects["compact-mantine"] } },
                    headConfig: undefined,
                    seeded: new Set(["compact-mantine"]),
                    captures: { "compact-mantine": { attempt: 1, results } },
                }),
            ).toEqual([expect.stringMatching(/^compact-mantine: 1 changed \(not accepted/)]);
        });
    });
});

describe("finish with a signed tree approval", () => {
    const KEY = makeKey();
    const ORIGIN = "https://dev.ato.ms:9443";
    const RECORD = "visual-baselines/reviews/20260927T150405Z-pr123.json";
    const DECISIONS = [
        accept("button--primary.dark.png", "compact-mantine", "wider"),
        accept("card--legacy.png"),
        { project: "compact-mantine", file: "tooltip--hover.png", decision: "exclude", reason: "hover races" },
        accept("graph--basic.png", "graphty-element"),
    ];
    const REJECT = { project: "compact-mantine", file: "slider--sizes.png", decision: "reject", reason: "tall" };

    /**
     * prepareApproval, then (with `tree`) the statement about its accept commit's tree signed by the
     * key, or else its record signed, as the review server hands it to finish: one approval.
     * @param {object} s the setup
     * @param {object[]} decisions the decisions
     * @param {object} [target] the target
     * @param {boolean} [tree] whether the Finish signs the tree too
     * @returns {Promise<object>} finish's `approval`, and what prepareApproval returned
     */
    async function approved(s, decisions, target = { pr: 123, branch: "feature" }, tree = true) {
        const prepared = await prepareApproval({
            repo: s.repo,
            target,
            projects: s.projects,
            decisions,
            now: NOW,
            config: CONFIG,
        });
        const statement = tree
            ? await treeStatement({ repo: s.repo, commit: prepared.commit, config: CONFIG, pr: target.pr, now: NOW })
            : null;
        const { commit } = tree
            ? prepared
            : await signRecord({
                  repo: s.repo,
                  target,
                  prepared,
                  approval: approve(prepared.recordBody, KEY, { origin: ORIGIN }),
                  keys: [KEY.entry],
                  origin: ORIGIN,
                  config: CONFIG,
              });
        return {
            ...(tree && { statement: { ...statement, approval: approve(statement, KEY, { origin: ORIGIN }) } }),
            commit,
            branch: prepared.branch,
            record: prepared.record,
            resign: !tree && prepared.pushed,
            pendingKeys: [KEY.entry],
            origin: ORIGIN,
            prepared,
        };
    }
    // The images approvalIndex counts as approved before from the records at the branch's tip, as
    // the review server reads them: signed themselves, or held by a baselines tree the owner signed.
    const approvedBefore = async (s) => {
        const signed = await treeSignedRecords(s.remote, "feature", CONFIG, [KEY.entry]);
        const lines = git(s.remote, "ls-tree", "feature", "visual-baselines/reviews/").split("\n");
        const records = lines.map((line) => {
            const [meta, path] = line.split("\t");
            return {
                ref: "feature",
                commit: "feature",
                path,
                record: JSON.parse(show(s, "feature", path)),
                main: false,
                treeSigned: signed.has(meta.split(" ")[2]),
            };
        });
        return [...approvalIndex(records, [KEY.entry]).keys()].map((k) => k.split(" ")[0]).sort();
    };
    const run = (s, decisions, approval) =>
        finish({
            repo: s.repo,
            gh: s.gh,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions,
            now: NOW,
            config: CONFIG,
            sign: true,
            approval,
        });
    const gate = (s) => {
        git(s.repo, "fetch", "-q", "origin");
        return treeApprovalProblems({
            base: s.master,
            head: "origin/feature",
            cwd: s.repo,
            baselines: CONFIG.baselines,
            approvals: CONFIG.approvals,
            keys: [KEY.entry],
        });
    };

    it("commits the accepts first, signs that commit's baselines tree, then commits the signature outside it", async () => {
        const s = setup();
        const approval = await approved(s, DECISIONS);
        // Prepared, signed, and nothing pushed yet.
        expect(remoteLog(s, "feature")[0]).toBe(s.head);
        const { statement } = approval;
        expect(statement).toMatchObject({
            version: 1,
            commit: approval.commit,
            tree: treeAt(approval.commit, CONFIG.baselines, s.repo),
            baselines: "visual-baselines",
            pr: 123,
            approvedAt: NOW.toISOString(),
        });
        expect(git(s.repo, "rev-parse", `${approval.commit}^`)).toBe(s.head);
        expect(approval.record).toBe(RECORD);

        const out = await run(s, DECISIONS, approval);
        const [signed, accepts, head] = remoteLog(s, "feature");
        expect([out.commit, accepts, head]).toEqual([signed, approval.commit, s.head]);
        const file = `visual-review-approvals/${statement.tree}.json`;
        expect(git(s.remote, "show", "--name-only", "--format=", signed)).toBe(file);
        expect(treeAt(signed, CONFIG.baselines, s.remote)).toBe(statement.tree);
        expect(JSON.parse(show(s, "feature", file))).toEqual(statement);
        expect(recordHash(JSON.parse(show(s, "feature", file)))).toEqual(recordHash(statement));
        // The record of the decisions is in the signed tree, so the one approval signs it too.
        const record = JSON.parse(show(s, "feature", RECORD));
        expect(record).toMatchObject({ version: 2, pr: 123, rejects: [] });
        expect(record.approval).toBeUndefined();
        expect(await approvedBefore(s)).toHaveLength(3);
        // Only a statement signed by a known key covers the records in its tree.
        expect((await treeSignedRecords(s.remote, "feature", CONFIG, [makeKey().entry])).size).toBe(0);
        expect(gate(s)).toEqual([]);
    });

    it("prepares a rename's accept commit as it pushes it", async () => {
        const s = setup();
        const cm = s.projects["compact-mantine"];
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
        const approval = await approved(s, [accept("button--main.dark.png")]);
        await run(s, [accept("button--main.dark.png")], approval);
        expect(remoteLog(s, "feature")[1]).toBe(approval.commit);
        expect(gate(s)).toEqual([]);
    });

    it("prepares on a merge of the default branch into the pull request, and the gate passes it", async () => {
        const s = setup();
        pushCommit(s.remote, "master", "visual-baselines/graphty-element/other.png");
        const clone = tempDir("vr-merge-");
        git(clone, "clone", "-q", "-b", "feature", s.remote, ".");
        git(clone, "-c", "user.name=O", "-c", "user.email=o@example.com", "merge", "-q", "--no-edit", "origin/master");
        git(clone, "push", "-q", "origin", "feature");
        const merge = git(clone, "rev-parse", "HEAD");
        const approval = await approved(s, [accept("card--legacy.png")]);
        expect(git(s.repo, "rev-parse", `${approval.commit}^`)).toBe(merge);
        await run(s, [accept("card--legacy.png")], approval);
        git(s.repo, "fetch", "-q", "origin");
        expect(
            treeApprovalProblems({
                base: "origin/master",
                head: "origin/feature",
                cwd: s.repo,
                baselines: CONFIG.baselines,
                approvals: CONFIG.approvals,
                keys: [KEY.entry],
            }),
        ).toEqual([]);
    });

    it("pushes nothing when the branch moved after the approval was prepared", async () => {
        const s = setup();
        const approval = await approved(s, [accept("card--legacy.png")]);
        const later = pushCommit(s.remote, "feature", "later.txt");
        await expect(run(s, [accept("card--legacy.png")], approval)).rejects.toThrow(/capture is stale/);
        expect(remoteLog(s, "feature")[0]).toBe(later);
    });

    it("signs the accept commit an earlier, unsigned Finish of the same decisions pushed", async () => {
        const s = setup();
        const decisions = [accept("badge--default.light.png")];
        const first = await finish({
            repo: s.repo,
            gh: s.gh,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions,
            undecided: 1,
            now: NOW,
            config: CONFIG,
        });
        const approval = await approved(s, decisions);
        // Pushed already: the statement signs that commit's tree, and only the approval goes on top.
        expect(approval.commit).toBe(first.commit);
        await run(s, decisions, approval);
        expect(remoteLog(s, "feature").slice(1, 2)).toEqual([first.commit]);
        expect(gate(s)).toEqual([]);
    });

    it("signs the record of a Finish with a reject, and not the tree; its accepts then count as approved before", async () => {
        const s = setup();
        const decisions = [...DECISIONS, REJECT];
        const approval = await approved(s, decisions, undefined, false);
        expect(approval.statement).toBeUndefined();
        const out = await finish({
            repo: s.repo,
            gh: s.gh,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions,
            now: NOW,
            config: CONFIG,
            approval,
        });
        // One commit: the accepts with the signed record, amended before it was pushed.
        expect(remoteLog(s, "feature").slice(0, 2)).toEqual([out.commit, s.head]);
        expect(out.commit).toBe(approval.commit);
        expect(git(s.remote, "show", "--name-only", "--format=", "feature")).not.toContain("visual-review-approvals/");
        const record = JSON.parse(show(s, "feature", RECORD));
        expect(record).toMatchObject({ version: 2, pr: 123, reviewedAt: NOW.toISOString() });
        expect(record.rejects).toHaveLength(1);
        expect(verifyRecord(record, [KEY.entry], { pr: 123 })).toBeNull();
        expect(await approvedBefore(s)).toEqual([
            "visual-baselines/compact-mantine/button--primary.dark.png",
            "visual-baselines/compact-mantine/tooltip--hover.json",
            "visual-baselines/graphty-element/graph--basic.png",
        ]);
        // The rejects are posted as before; the tree is not approved, so the gate still holds it.
        expect(s.calls.some((c) => c.args[1].includes("/comments"))).toBe(true);
        expect(gate(s).length).toBeGreaterThan(0);
    });

    it("signs the record an earlier Finish pushed unsigned, once, with no decision added or posted again", async () => {
        const s = setup();
        const decisions = [...DECISIONS, REJECT];
        const first = await s.run(decisions);
        const unsigned = JSON.parse(show(s, "feature", RECORD));
        expect(unsigned.approval).toBeUndefined();
        expect(await approvedBefore(s)).toEqual([]);
        git(s.repo, "fetch", "-q", "origin");
        expect(await unsignedRecordAt(s.repo, "origin/feature", 123, CONFIG)).toBe(RECORD);
        const calls = s.calls.length;

        const approval = await approved(s, decisions, undefined, false);
        expect(approval.resign).toBe(true);
        expect(approval.prepared.recordBody).toEqual({ ...unsigned, version: 2 });
        const out = await finish({
            repo: s.repo,
            gh: s.gh,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions,
            now: NOW,
            config: CONFIG,
            approval,
        });
        expect(out).toMatchObject({ resigned: true, commit: approval.commit, rejects: 0 });
        expect(s.calls).toHaveLength(calls);
        // Only the record changed: the same file, now signed, and still the only record.
        expect(remoteLog(s, "feature").slice(0, 2)).toEqual([approval.commit, first.commit]);
        expect(git(s.remote, "show", "--name-only", "--format=", "feature")).toBe(RECORD);
        expect(git(s.remote, "ls-tree", "--name-only", "feature", "visual-baselines/reviews/")).toBe(RECORD);
        const signed = JSON.parse(show(s, "feature", RECORD));
        expect({ ...signed, approval: undefined, version: 3 }).toEqual({ ...unsigned, approval: undefined });
        expect(await approvedBefore(s)).toHaveLength(3);
        git(s.repo, "fetch", "-q", "origin");
        expect(await unsignedRecordAt(s.repo, "origin/feature", 123, CONFIG)).toBeNull();
    });

    it("never signs an earlier record that holds more than the decisions sent", async () => {
        const s = setup();
        await s.run([accept("badge--default.light.png"), accept("card--legacy.png")]);
        await expect(approved(s, [accept("badge--default.light.png")], undefined, false)).rejects.toThrow(
            /capture is stale/,
        );
    });

    it.each([
        [
            "from a key not in passkeys.json",
            (a) => ({ ...a, pendingKeys: [] }),
            /the approval does not verify \(approval is from a key not in passkeys.json/,
        ],
        ["made on another origin", (a) => ({ ...a, origin: "https://other:1" }), /not on the review page's origin/],
        [
            "for another statement",
            (a) => ({ ...a, statement: { ...a.statement, pr: 124 } }),
            /the challenge does not match/,
        ],
    ])("refuses, before pushing, an approval that does not verify: %s", async (_, change, error) => {
        const s = setup();
        const approval = await approved(s, [accept("badge--default.light.png")]);
        await expect(run(s, [accept("badge--default.light.png")], change(approval))).rejects.toThrow(error);
        expect(remoteLog(s, "feature")[0]).toBe(s.head);
    });

    it("takes the keys from the default branch as fetched", async () => {
        const s = setup();
        const other = tempDir("vr-keys-");
        git(other, "clone", "-q", "-b", "master", s.remote, ".");
        mkdirSync(join(other, "visual-review"));
        writeFileSync(join(other, "visual-review/passkeys.json"), passkeysJson(KEY));
        git(other, "add", "-A");
        git(other, "-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-q", "-m", "keys");
        git(other, "push", "-q", "origin", "master");
        const approval = await approved(s, [accept("badge--default.light.png")]);
        await run(s, [accept("badge--default.light.png")], { ...approval, pendingKeys: [] });
        const file = `visual-review-approvals/${approval.statement.tree}.json`;
        expect(JSON.parse(show(s, "feature", file)).approval).toEqual(approval.statement.approval);
    });

    it("signs nothing with a reject: it commits the accepts and names the record and commit in the reject comment", async () => {
        const s = setup();
        await finish({
            repo: s.repo,
            gh: s.gh,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions: [...DECISIONS, REJECT],
            now: NOW,
            config: CONFIG,
        });
        expect(git(s.remote, "show", "--name-only", "--format=", "feature")).not.toContain("visual-review-approvals/");
        const comment = s.calls.find((c) => c.args[1].includes("/comments"));
        const block = JSON.parse(/<!-- visual-review-rejects\n(.*)\n-->/s.exec(JSON.parse(comment.input).body)[1]);
        expect(block.record).toBeUndefined();
        expect(block.recordFile).toBe(RECORD);
        expect(block.commit).toBe(remoteLog(s, "feature")[0]);
    });

    it("leaves out a record that would pass GitHub's comment limit", () => {
        const results = { runId: 1, runAttempt: 1, headSha: "a".repeat(40) };
        const rejects = [{ project: "p", item: { file: "s.png", capture: "c".repeat(64) }, reason: "tall" }];
        const items = Array.from({ length: 900 }, (_, i) => ({
            path: `visual-baselines/p/s${i}.png`,
            from: null,
            to: "f".repeat(64),
            reason: null,
        }));
        const body = rejectComment(5, results, rejects, [], "master", { record: { version: 2, items } });
        expect(body.length).toBeLessThan(65536);
        expect(JSON.parse(/<!-- visual-review-rejects\n(.*)\n-->/s.exec(body)[1]).record).toBeUndefined();
        const small = rejectComment(5, results, rejects, [], "master", { record: { version: 2, items: [] } });
        expect(JSON.parse(/<!-- visual-review-rejects\n(.*)\n-->/s.exec(small)[1]).record).toEqual({
            version: 2,
            items: [],
        });
    });

    it("counts accepts, exclusions and rejects as Finish's status does", async () => {
        const s = setup();
        const out = await prepareApproval({
            repo: s.repo,
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions: [...DECISIONS, REJECT],
            now: NOW,
            config: CONFIG,
        });
        expect([out.accepts, out.excludes, out.rejects]).toEqual([3, 1, 1]);
    });

    it("refuses to prepare nothing to accept", async () => {
        const s = setup();
        const prepare = (decisions) =>
            prepareApproval({
                repo: s.repo,
                target: { pr: 123, branch: "feature" },
                projects: s.projects,
                decisions,
                now: NOW,
                config: CONFIG,
            });
        await expect(prepare([])).rejects.toThrow("nothing to accept");
        await expect(prepare([REJECT])).rejects.toThrow("nothing to accept");
    });
});

describe("proposeKey", () => {
    it("pushes passkeys.json with the key appended on a new branch and opens its pull request", async () => {
        const s = setup();
        const first = makeKey();
        const out = await proposeKey({
            repo: s.repo,
            gh: s.gh,
            entry: first.entry,
            now: NOW,
            config: CONFIG,
        });
        expect(out).toEqual({
            branch: "visual/passkey-20260927T150405Z",
            pullRequest: "https://github.com/o/r/pull/9",
            gated: false,
        });
        expect(parsePasskeys(show(s, out.branch, "visual-review/passkeys.json").toString())).toEqual([first.entry]);
        expect(git(s.remote, "log", "-1", "--format=%s", out.branch)).toBe(
            "test(workspace): register a visual review passkey",
        );
        const pr = JSON.parse(s.calls.find((c) => c.args[1].endsWith("/pulls")).input);
        expect(pr).toMatchObject({ head: out.branch, base: "master" });
        expect(pr.body).toContain(first.entry.id);
        expect(pr.body).toContain("turns approval enforcement on");
    });

    // One proposal per test: master already holds `first`, pushed after an unrelated commit.
    const FIRST = makeKey();
    const later = new Date(NOW.getTime() + 1000);
    const withFirstKey = () => {
        const s = setup();
        pushCommit(s.remote, "master", "unrelated.txt");
        const clone = tempDir("vr-keys-");
        git(clone, "clone", "-q", "-b", "master", s.remote, ".");
        mkdirSync(join(clone, "visual-review"));
        writeFileSync(join(clone, "visual-review/passkeys.json"), passkeysJson(FIRST));
        git(clone, "add", "-A");
        git(clone, "-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-q", "-m", "keys");
        git(clone, "push", "-q", "origin", "master");
        return s;
    };

    it("appends a second key to what master holds, and says the gate fails that pull request", async () => {
        const s = withFirstKey();
        const second = makeKey();
        const asked = [];
        const two = await proposeKey({
            repo: s.repo,
            gh: async (args, input) => (asked.push(input), JSON.stringify({ html_url: "x" })),
            entry: second.entry,
            now: later,
            config: CONFIG,
        });
        // master already holds a key, so the gate fails this pull request, and it says so.
        expect(two.gated).toBe(true);
        expect(JSON.parse(asked[0]).body).toContain("the visual gate fails this pull request");
        expect(parsePasskeys(show(s, two.branch, "visual-review/passkeys.json").toString())).toEqual([
            FIRST.entry,
            second.entry,
        ]);
    });

    it("refuses a key master already holds", async () => {
        const s = withFirstKey();
        await expect(
            proposeKey({ repo: s.repo, gh: async () => "{}", entry: FIRST.entry, now: later, config: CONFIG }),
        ).rejects.toThrow("already registered");
    });
});

describe("finish: the less travelled paths", () => {
    const reject = (file, reason = "wrong") => ({ project: "compact-mantine", file, decision: "reject", reason });
    const atMaster = (s) => {
        const master = { commit: s.master, headSha: null, pr: null };
        s.projects["compact-mantine"] = copyFixture("compact-mantine", join(s.dir, "m/compact-mantine"), master);
    };

    it("refuses projects captured by different CI runs", async () => {
        const s = setup();
        s.projects["graphty-element"].results.runId = 999;
        const err = await s
            .run([accept("badge--default.light.png"), accept("graph--basic.png", "graphty-element")])
            .catch((e) => e);
        expect(err.message).toBe(
            "the projects of one Finish must come from one CI run, or one head of the pull request",
        );
        expect(remoteLog(s, "feature")[0]).toBe(s.head);
    });

    it.each([
        [null, "no usable branch for this target: null"],
        ["bad..name", "no usable branch for this target: bad..name"],
    ])("refuses a target branch git cannot name: %s", async (branch, message) => {
        const s = setup();
        const err = await s.run([accept("badge--default.light.png")], { pr: 123, branch }).catch((e) => e);
        expect(err.message).toBe(message);
    });

    it("refuses a seed when its branch already exists on origin and is not this tool's seed", async () => {
        const s = setup();
        atMaster(s);
        git(s.repo, "push", "-q", "origin", `${s.master}:refs/heads/visual/seed-2026-09-27`);
        pushCommit(s.remote, "visual/seed-2026-09-27", "other.txt");
        const err = await s.run([accept("badge--default.light.png")], { pr: null, branch: null }).catch((e) => e);
        expect(err.message).toBe("visual/seed-2026-09-27 already exists on origin: merge or delete it first");
    });

    it("titles master's rejects issue in the plural for more than one story", async () => {
        const s = setup();
        atMaster(s);
        await s.run([reject("badge--default.light.png"), reject("button--primary.dark.png")], {
            pr: null,
            branch: null,
        });
        const issue = s.calls.find((c) => c.args[1].endsWith("/issues"));
        expect(JSON.parse(issue.input).title).toBe("Visual review: 2 stories rejected on master");
    });

    it("passes a failed reject comment through unchanged when nothing was committed", async () => {
        const s = setup();
        const failure = new Error("HTTP 502");
        const err = await finish({
            repo: s.repo,
            gh: async () => {
                throw failure;
            },
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions: [reject("slider--sizes.png")],
            now: NOW,
            config: CONFIG,
        }).catch((e) => e);
        expect(err).toBe(failure);
        expect(remoteLog(s, "feature")[0]).toBe(s.head);
    });

    it("counts several accept notes when the reject comment fails after the accepts landed", async () => {
        const s = setup();
        const err = await finish({
            repo: s.repo,
            gh: async (args) => {
                if (args[1].includes("/comments")) {
                    throw new Error("HTTP 502");
                }
                return "{}";
            },
            target: { pr: 123, branch: "feature" },
            projects: s.projects,
            decisions: [
                accept("badge--default.light.png", "compact-mantine", "one"),
                accept("button--primary.dark.png", "compact-mantine", "two"),
                reject("slider--sizes.png"),
            ],
            now: NOW,
            config: CONFIG,
        }).catch((e) => e);
        expect(err.message).toMatch(/comment with the rejects and 2 accept notes failed: HTTP 502\. /);
        expect(err.committed).toBe(remoteLog(s, "feature")[0]);
    });

    it("uploads more images than one LFS batch in counted batches before the push", async () => {
        const s = setup();
        const cm = s.projects["compact-mantine"];
        const template = cm.results.items.find((i) => i.file === "badge--default.light.png");
        const decisions = [];
        for (let i = 0; i < 51; i++) {
            const file = `many--story-${i}.png`;
            const bytes = Buffer.from(`image ${i}`);
            writeFileSync(join(cm.dir, file), bytes);
            cm.results.items.push({
                ...template,
                id: `many--story-${i}`,
                file,
                status: "new",
                baseline: null,
                capture: sha256(bytes),
            });
            decisions.push(accept(file));
        }
        const out = await s.run(decisions);
        expect(out.commit).toBe(remoteLog(s, "feature")[0]);
        expect(s.steps.filter((x) => x.startsWith("uploading images to LFS"))).toEqual([
            "uploading images to LFS (0 of 51 done)",
            "uploading images to LFS (50 of 51 done)",
            "uploading images to LFS (checking the commit has them all)",
        ]);
    });
});

describe("commitStatus", () => {
    const counts = { accepted: 2, rejected: 0, excluded: 1, undecided: 0, unloaded: [] };

    it("is success when everything was decided and loaded", () => {
        expect(commitStatus(counts)).toEqual({
            state: "success",
            description: "Reviewed: 2 accepted, 0 rejected, 1 excluded, 0 left undecided",
        });
    });

    it("is pending while a story is undecided or a project did not load", () => {
        expect(commitStatus({ ...counts, undecided: 3 }).state).toBe("pending");
        expect(commitStatus({ ...counts, unloaded: ["layout", "graphty"] })).toEqual({
            state: "pending",
            description: "Reviewed: 2 accepted, 0 rejected, 1 excluded, 0 left undecided, not loaded: layout, graphty",
        });
    });

    it("is failure on any reject, even with stories undecided", () => {
        expect(commitStatus({ ...counts, rejected: 1, undecided: 3, unloaded: ["layout"] }).state).toBe("failure");
    });
});
