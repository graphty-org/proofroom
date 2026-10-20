import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
    approvalKeys,
    baselinesChangedBetween,
    contentHash,
    gateProblems,
    gatedProjects,
    MAX_THRESHOLD,
    newestResults,
    queueBaseSha,
    queuePullRequests,
    seededAt,
    treeApprovalProblems,
    treeAt,
    trustFilesChanged,
} from "../trusted/gate.mjs";
import { PASSKEYS_FILE } from "../trusted/lib/approval.mjs";
import { normalizeConfig } from "../trusted/lib/config.mjs";
import { CONFIG, FIXTURE, git, isolateGit, makeRepo, tempDir } from "./helpers.mjs";
import { approve, makeKey, passkeysJson } from "./passkey-vectors.mjs";

beforeAll(isolateGit);

const FIXTURE_RESULTS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
const HASH = "a".repeat(64);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
// card--legacy.png as makeRepo's master holds it.
const LEGACY = sha256(readFileSync(join(FIXTURE, "compact-mantine/baselines/card--legacy.png")));

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
    const dir = tempDir("vr-gate-");
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

describe("gateProblems refuses a loosened comparison", () => {
    const config = normalizeConfig({ defaultBranch: "master", projects: { p: { storybook: "s" } } });
    const seeded = new Set(["p"]);

    it("fails a story compared at a diffThreshold above the cap", () => {
        const r = results(["unchanged", "unchanged"]);
        r.items[1].threshold = 1;
        expect(gateProblems({ config, seeded, captures: { p: { attempt: 1, results: r } } })).toEqual([
            `p: 1 item is compared at a diffThreshold above ${MAX_THRESHOLD}, which hides real changes; lower it in the story's parameters or its settings file`,
        ]);
        r.items[1].threshold = MAX_THRESHOLD;
        expect(gateProblems({ config, seeded, captures: { p: { attempt: 1, results: r } } })).toEqual([]);
    });

    it("fails a pull request that moves the baselines directory", () => {
        const headConfig = normalizeConfig({
            defaultBranch: "master",
            baselines: "vb2",
            projects: { p: { storybook: "s" } },
        });
        const captures = { p: { attempt: 1, results: results(["unchanged"]) } };
        expect(gateProblems({ config, headConfig, seeded, captures })[0]).toMatch(
            /^this pull request moves the baselines directory from visual-baselines to vb2/,
        );
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
        expect(gatedProjects(config, new Set(), head)).toEqual([
            "compact-mantine",
            "graphty-element",
            "layout",
            "graphty",
        ]);
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

    // The fixture repository's config is the monorepo's: only compact-mantine has baselines.
    // Every other project in the monorepo's config, read from the config so a project added there
    // does not break these tests.
    const unseededCaptures = Object.fromEntries(
        Object.keys(CONFIG.projects)
            .filter((p) => p !== "compact-mantine")
            .map((p) => [`visual-${p}-1`, results(["unchanged"])]),
    );

    it("passes a pull request whose seeded capture is unchanged", () => {
        const r = makeRepo();
        const out = run(r.repo, artifacts({ "visual-compact-mantine-1": results(["unchanged"]), ...unseededCaptures }));
        expect(out.stdout).toMatch(/No unaccepted visual changes/);
        expect(out.status).toBe(0);
    });

    it("fails on an unaccepted change and on a baseline committed without the owner's approval", () => {
        const r = makeRepo();
        git(r.repo, "checkout", "-q", "feature");
        writeFileSync(join(r.repo, "visual-baselines/compact-mantine/card--legacy.png"), "copied capture");
        git(r.repo, "commit", "-q", "-am", "copy a capture into the baselines");
        const out = run(r.repo, artifacts({ "visual-compact-mantine-1": results(["changed"]) }));
        expect(out.stdout).toMatch(/::error::visual changes not accepted -- compact-mantine: 1 changed/);
        expect(out.stdout).toMatch(
            /::error::baselines not approved -- visual-baselines\/ differs from the base \(tree [0-9a-f]{40}\), and no visual-review-approvals\/[0-9a-f]{40}\.json approves it/,
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

describe("the not-affected marker (skipped.json)", () => {
    const GATE = fileURLToPath(new URL("../trusted/gate.mjs", import.meta.url));
    // An artifact holding only the marker the visual job writes for a project it did not capture.
    const marked = (dir, name, marker) => {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, "skipped.json"), JSON.stringify(marker));
        return dir;
    };
    const MARKER = { skipped: "not affected", project: "compact-mantine" };
    const config = normalizeConfig({ defaultBranch: "master", projects: { "compact-mantine": { storybook: "a" } } });
    const seeded = new Set(["compact-mantine"]);
    const skipped = { "compact-mantine": { attempt: 1, results: null, skipped: true } };

    it("is read only from an artifact with no results.json, and only when it names the artifact's project", () => {
        expect(newestResults(marked(artifacts({}), "visual-compact-mantine-1", MARKER))["compact-mantine"]).toEqual({
            attempt: 1,
            results: null,
            skipped: true,
        });
        const other = marked(artifacts({}), "visual-compact-mantine-1", { ...MARKER, project: "layout" });
        expect(newestResults(other)["compact-mantine"].skipped).toBeUndefined();
        const extra = marked(artifacts({}), "visual-compact-mantine-1", { ...MARKER, all: true });
        expect(newestResults(extra)["compact-mantine"].skipped).toBeUndefined();
        // A capture that also left a marker (or a broken results.json beside one) is a capture.
        const both = artifacts({});
        marked(both, "visual-compact-mantine-1", MARKER);
        writeFileSync(join(both, "visual-compact-mantine-1", "results.json"), "{");
        expect(newestResults(both)["compact-mantine"]).toEqual({ attempt: 1, results: null });
    });

    it("counts only in the newest attempt", () => {
        const dir = marked(
            artifacts({ "visual-compact-mantine-2": results(["changed"]) }),
            "visual-compact-mantine-1",
            MARKER,
        );
        expect(gateProblems({ config, seeded, captures: newestResults(dir) })[0]).toMatch(/1 changed/);
    });

    it("stands in for the capture of a seeded project on a pull request's own run", () => {
        expect(gateProblems({ config, seeded, captures: skipped })).toEqual([]);
    });

    it("fails in a merge-queue run, for a project with no baselines, and for one whose baselines change", () => {
        expect(gateProblems({ config, seeded, captures: skipped, queue: true })).toEqual([
            "compact-mantine: not captured (marked not affected by this pull request), but a merge-queue run must capture every project; re-run it",
        ]);
        expect(gateProblems({ config, seeded: new Set(), captures: skipped })[0]).toMatch(
            /not captured .*but it has no baselines on master yet, so every pull request captures it$/,
        );
        expect(
            gateProblems({ config, seeded, captures: skipped, baselinesChanged: new Set(["compact-mantine"]) })[0],
        ).toMatch(/not captured .*but this pull request changes its baselines, so it must be captured$/);
    });

    it("leaves a project with neither a capture nor a marker failing", () => {
        expect(
            gateProblems({ config, seeded, captures: { "compact-mantine": { attempt: 1, results: null } } }),
        ).toEqual(["compact-mantine: no capture results (the visual job failed or uploaded nothing); re-run it"]);
    });

    it("finds the projects whose baselines a pull request changes, review records left out", () => {
        const r = makeRepo();
        expect(baselinesChangedBetween("master", "feature", r.repo)).toEqual(new Set());
        git(r.repo, "checkout", "-q", "feature");
        writeFileSync(join(r.repo, "visual-baselines/compact-mantine/card--legacy.png"), "other");
        mkdirSync(join(r.repo, "visual-baselines/reviews"), { recursive: true });
        writeFileSync(join(r.repo, "visual-baselines/reviews/r.json"), "{}");
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "change a baseline");
        expect(baselinesChangedBetween("master", "feature", r.repo)).toEqual(new Set(["compact-mantine"]));
    });

    describe("the gate command", () => {
        const others = Object.fromEntries(
            Object.keys(CONFIG.projects)
                .filter((p) => p !== "compact-mantine")
                .map((p) => [`visual-${p}-1`, results(["unchanged"])]),
        );
        const run = (repo, ...extra) =>
            spawnSync(
                process.execPath,
                [
                    GATE,
                    "--captures",
                    marked(artifacts(others), "visual-compact-mantine-1", MARKER),
                    "--base",
                    "master",
                    "--head",
                    "feature",
                    ...extra,
                ],
                { cwd: repo, encoding: "utf8" },
            );

        it("passes a pull request that leaves out a project it cannot affect, and says so", () => {
            const out = run(makeRepo().repo);
            expect(out.stdout).toContain(
                "::notice::compact-mantine was not captured: this pull request does not affect it",
            );
            expect(out.status).toBe(0);
        });

        it("fails the same artifacts in a merge-queue run", () => {
            const file = join(tempDir("vr-event-"), "event.json");
            const r = makeRepo();
            const body = `\`\`\`yaml\nchecking_base_sha: ${git(r.repo, "rev-parse", "master")}\npull_requests:\n  - number: 7\n\`\`\`\n`;
            writeFileSync(file, JSON.stringify({ pull_request: { number: 995, body } }));
            const out = run(r.repo, "--queue-event", file);
            expect(out.stdout).toMatch(
                /::error::visual changes not accepted -- compact-mantine: not captured .*merge-queue run/,
            );
            expect(out.stdout).not.toContain("::notice::");
            expect(out.status).toBe(1);
        });
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

describe("signed tree approvals", () => {
    const KEY = makeKey();
    const BASELINES = "visual-baselines";
    const APPROVALS = "visual-review-approvals";
    const PATH = `${BASELINES}/compact-mantine/card--legacy.png`;

    /**
     * master with passkeys.json (when given) and branch `pr` from it, checked out.
     * @param {string} [passkeys] passkeys.json on master
     * @returns {object} the repository
     */
    function repoWith(passkeys) {
        const r = makeRepo();
        if (passkeys !== undefined) {
            mkdirSync(join(r.repo, "visual-review"), { recursive: true });
            writeFileSync(join(r.repo, PASSKEYS_FILE), passkeys);
            git(r.repo, "add", "-A");
            git(r.repo, "commit", "-q", "-m", "keys");
        }
        git(r.repo, "checkout", "-q", "-b", "pr");
        return r;
    }

    /**
     * Commits files on the current branch.
     * @param {object} r the repository
     * @param {Record<string, string | object | null>} files contents by path (objects as JSON, null deletes)
     */
    function commit(r, files) {
        for (const [path, data] of Object.entries(files)) {
            if (data === null) {
                git(r.repo, "rm", "-q", path);
                continue;
            }
            mkdirSync(join(r.repo, path, ".."), { recursive: true });
            const text = typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2);
            writeFileSync(join(r.repo, path), text);
        }
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "change");
    }

    /**
     * The statement Finish signs for a commit: its baselines tree, and the pull request.
     * @param {object} r the repository
     * @param {string} at the commit reviewed
     * @returns {object} the statement
     */
    const statementOf = (r, at) => ({
        version: 1,
        commit: git(r.repo, "rev-parse", at),
        tree: treeAt(at, BASELINES, r.repo),
        baselines: BASELINES,
        pr: 7,
        approvedAt: "2026-10-19T12:00:00.000Z",
    });

    /**
     * Commits an approval of the tree at `at` on the current branch, as Finish does: outside the
     * baselines directory, named by the tree.
     * @param {object} r the repository
     * @param {{ at?: string, key?: object | null, statement?: object }} [o] the commit reviewed,
     *     the key that signs (null: unsigned), and a statement to use instead
     * @returns {object} the committed statement
     */
    function approveTree(r, { at = "HEAD", key = KEY, statement = statementOf(r, at) } = {}) {
        const file = { ...statement, ...(key && { approval: approve(statement, key) }) };
        commit(r, { [`${APPROVALS}/${treeAt("HEAD", BASELINES, r.repo)}.json`]: file });
        return file;
    }

    const check = (r, { head = "pr", keys = [KEY.entry] } = {}) =>
        treeApprovalProblems({ base: "master", head, cwd: r.repo, baselines: BASELINES, approvals: APPROVALS, keys });

    it("passes a tree signed at an ancestor, and the approval commit leaves the signed tree alone", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PATH]: "new image" });
        const signed = approveTree(r);
        expect(treeAt("pr", BASELINES, r.repo)).toBe(signed.tree);
        expect(check(r)).toEqual([]);
        // Commits after the approval that leave the baselines alone keep it.
        commit(r, { "src.txt": "more code" });
        expect(check(r)).toEqual([]);
    });

    it("fails a tree other than the one signed", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PATH]: "new image" });
        approveTree(r);
        commit(r, { [PATH]: "another image" });
        const tree = treeAt("pr", BASELINES, r.repo);
        expect(check(r)).toEqual([
            `${BASELINES}/ differs from the base (tree ${tree}), and no ${APPROVALS}/${tree}.json approves it: review the changes with \`visual-review serve\` and Finish, which signs the tree`,
        ]);
        // A statement filed under the head's tree that signs another one.
        const other = repoWith(passkeysJson(KEY));
        commit(other, { [PATH]: "new image" });
        const statement = { ...statementOf(other, "HEAD"), tree: "f".repeat(40) };
        approveTree(other, { statement });
        expect(check(other)[0]).toMatch(
            /it signs visual-baselines\/ at tree f{40}, not visual-baselines\/ at [0-9a-f]{40}/,
        );
    });

    it("fails an approval whose commit is not an ancestor of the head, even of an equal tree", () => {
        const r = repoWith(passkeysJson(KEY));
        // The same baseline change on a branch of its own, approved there.
        git(r.repo, "checkout", "-q", "-b", "side", "master");
        commit(r, { [PATH]: "new image" });
        const signed = statementOf(r, "side");
        git(r.repo, "checkout", "-q", "pr");
        commit(r, { [PATH]: "new image", "src.txt": "the pull request's own code" });
        expect(treeAt("pr", BASELINES, r.repo)).toBe(signed.tree);
        approveTree(r, { statement: signed });
        expect(check(r)[0]).toContain(`its commit ${signed.commit} is not an ancestor of pr`);
    });

    it("fails a statement whose commit does not hold the tree it signs", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PATH]: "new image" });
        const statement = { ...statementOf(r, "HEAD"), commit: git(r.repo, "rev-parse", "master") };
        approveTree(r, { statement });
        expect(check(r)[0]).toContain(`${BASELINES}/ at its commit ${statement.commit} is not the tree it signs`);
    });

    it("fails a bad signature: another key, a statement changed after signing, none at all", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PATH]: "new image" });
        approveTree(r, { key: makeKey() });
        expect(check(r)[0]).toContain("approval is from a key not in passkeys.json on the base branch");

        const changed = repoWith(passkeysJson(KEY));
        commit(changed, { [PATH]: "new image" });
        const statement = statementOf(changed, "HEAD");
        const approval = approve(statement, KEY);
        commit(changed, {
            [`${APPROVALS}/${statement.tree}.json`]: { ...statement, pr: 8, approval },
        });
        expect(check(changed)[0]).toContain("the challenge does not match");

        const unsigned = repoWith(passkeysJson(KEY));
        commit(unsigned, { [PATH]: "new image" });
        approveTree(unsigned, { key: null });
        expect(check(unsigned)[0]).toContain("the record has no passkey approval");
        // Before the base holds a key, an unsigned statement is enough.
        expect(check(unsigned, { keys: null })).toEqual([]);
    });

    it("needs no approval when the baselines tree is the base's", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { "src.txt": "code" });
        expect(check(r)).toEqual([]);
        // Changed, then changed back: the tree is the base's again.
        commit(r, { [PATH]: "new image" });
        commit(r, { [PATH]: readFileSync(join(FIXTURE, "compact-mantine/baselines/card--legacy.png")) });
        expect(treeAt("pr", BASELINES, r.repo)).toBe(treeAt("master", BASELINES, r.repo));
        expect(check(r)).toEqual([]);
    });

    it("gives the per-pull-request review records no meaning of their own", () => {
        // A record a pull request's earlier Finish signed, naming the change exactly: not enough.
        const r = repoWith(passkeysJson(KEY));
        const record = {
            version: 2,
            pr: 7,
            subject: { builtMerge: "1".repeat(40), head: "2".repeat(40), runId: 9, runAttempt: 1, scale: 2 },
            items: [{ path: PATH, from: LEGACY, to: sha256("new image"), reason: null }],
            rejects: [],
            reviewedAt: "2026-09-28T12:00:00.000Z",
        };
        commit(r, {
            [PATH]: "new image",
            [`${BASELINES}/reviews/r.json`]: { ...record, approval: approve(record, KEY) },
        });
        expect(check(r)[0]).toMatch(/and no visual-review-approvals\/[0-9a-f]{40}\.json approves it/);
        // A signed tree passes, whatever the records in it say, an unreadable one included; and
        // deleting a record is a change of the tree like any other.
        commit(r, { [`${BASELINES}/reviews/junk.json`]: "{" });
        approveTree(r);
        expect(check(r)).toEqual([]);
        commit(r, { [`${BASELINES}/reviews/junk.json`]: null });
        expect(check(r)[0]).toMatch(/approves it/);
    });

    it("covers every pixel: a baseline is a Git LFS pointer naming its image's SHA-256, so another image is another tree", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PATH]: "new image" });
        const pointer = execFileSync("git", ["cat-file", "blob", `pr:${PATH}`], { cwd: r.repo }).toString();
        expect(pointer).toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${sha256("new image")}\nsize 9\n`);
        approveTree(r);
        // One byte of the image differs: its pointer, so the tree, so the approval no longer holds.
        commit(r, { [PATH]: "new imagf" });
        expect(contentHash(execFileSync("git", ["cat-file", "blob", `pr:${PATH}`], { cwd: r.repo }))).toBe(
            sha256("new imagf"),
        );
        expect(check(r)[0]).toMatch(/and no visual-review-approvals\/[0-9a-f]{40}\.json approves it/);
    });

    it("fails a change to passkeys.json once the base holds a key, and not before", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PASSKEYS_FILE]: passkeysJson(KEY, makeKey()) });
        expect(check(r)).toEqual([
            `${PASSKEYS_FILE}: changed; once a key is registered, adding or replacing one is merged by an administrator (the README, "Replacing the passkey")`,
        ]);
        const first = repoWith();
        commit(first, { [PASSKEYS_FILE]: passkeysJson(KEY) });
        expect(check(first, { keys: null })).toEqual([]);
    });

    it.each([
        ["emptied", '{ "version": 1, "keys": [] }'],
        ["deleted", null],
        ["broken", "{"],
    ])("fails closed on switching enforcement off: passkeys.json %s", (_, change) => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PASSKEYS_FILE]: change });
        expect(approvalKeys("master", "pr", r.repo).problems).toEqual([
            "this pull request would switch approval enforcement off: its visual-review/passkeys.json is missing, invalid or holds no key",
        ]);
    });

    it("reads keys only from the base, and fails closed on an invalid base file", () => {
        const r = repoWith();
        expect(approvalKeys("master", "pr", r.repo)).toEqual({ keys: null, problems: [] });
        const k = repoWith(passkeysJson(KEY));
        commit(k, { [PASSKEYS_FILE]: passkeysJson(makeKey()) });
        expect(approvalKeys("master", "pr", k.repo)).toEqual({ keys: [KEY.entry], problems: [] });
        const bad = repoWith('{ "version": 1, "keys": [{ "id": "x" }] }');
        expect(approvalKeys("master", "pr", bad.repo).problems[0]).toMatch(
            /^visual-review\/passkeys.json on the base branch is invalid: keys\[0\]\.rpId/,
        );
    });

    it("warns about a change to any of the tool's code, its capture, passkeys.json or the workflow", () => {
        const r = repoWith();
        commit(r, {
            "visual-review/trusted/cli.mjs": "x",
            "visual-review/capture/capture.mjs": "x",
            ".github/workflows/ci.yml": "x",
            "visual-review/README.md": "x",
        });
        expect(trustFilesChanged("master", "pr", "ci.yml", r.repo)).toEqual([
            ".github/workflows/ci.yml",
            "visual-review/capture/capture.mjs",
            "visual-review/trusted/cli.mjs",
        ]);
    });

    describe("the gate command", () => {
        const GATE = fileURLToPath(new URL("../trusted/gate.mjs", import.meta.url));
        const captures = (statuses = ["unchanged"]) =>
            artifacts(
                Object.fromEntries(Object.keys(CONFIG.projects).map((p) => [`visual-${p}-1`, results(statuses)])),
            );
        const run = (r, extra = [], dir = captures()) =>
            spawnSync(process.execPath, [GATE, "--captures", dir, "--base", "master", "--head", "pr", ...extra], {
                cwd: r.repo,
                encoding: "utf8",
            });

        it("passes a signed tree whose captures match its baselines, and fails a capture that differs", () => {
            const r = repoWith(passkeysJson(KEY));
            commit(r, { [PATH]: "new image" });
            const unsigned = run(r, ["--pr", "7"]);
            expect(unsigned.stdout).toContain(
                "::error::baselines not approved -- visual-baselines/ differs from the base",
            );
            expect(unsigned.status).toBe(1);
            approveTree(r);
            const out = run(r, ["--pr", "7"]);
            expect(out.stdout).toContain("the baselines are the base's or approved by the owner");
            expect(out.status).toBe(0);
            // --pr is reported only: the approval is not for one pull request.
            expect(run(r).status).toBe(0);
            const differs = run(r, [], captures(["unchanged", "changed"]));
            expect(differs.stdout).toMatch(/::error::visual changes not accepted -- .*1 changed/);
            expect(differs.status).toBe(1);
            expect(run(r, ["--pr", "seven"]).status).toBe(2);
        });

        it("fails a pull request that moves the approvals directory", () => {
            const r = repoWith(passkeysJson(KEY));
            const config = JSON.parse(readFileSync(join(r.repo, "visual-review.config.json"), "utf8"));
            commit(r, { "visual-review.config.json": { ...config, approvals: "elsewhere" } });
            const out = run(r);
            expect(out.stdout).toContain(
                "::error::passkey approval -- this pull request moves the approvals directory from visual-review-approvals to elsewhere",
            );
            expect(out.status).toBe(1);
        });

        describe("a merge-queue batch (--queue-event)", () => {
            // The draft's event; the batch sits on `base` (a ref of r, or null for no checking_base_sha).
            const event = (r, base, ...prs) => {
                const file = join(tempDir("vr-event-"), "event.json");
                const list = prs.map((n) => `  - number: ${n}\n    scopes: []\n`).join("");
                const sha = base === null ? "" : `checking_base_sha: ${git(r.repo, "rev-parse", base)}\n`;
                const body = `### Queue\n\n\`\`\`yaml\n---\n${sha}pull_requests:\n${list}scopes: []\n...\n\n\`\`\`\n`;
                writeFileSync(file, JSON.stringify({ pull_request: { number: 995, body } }));
                return file;
            };

            it("passes a batch whose tree the owner signed, and compares it with the commit it sits on", () => {
                const r = repoWith(passkeysJson(KEY));
                commit(r, { [PATH]: "new image" });
                git(r.repo, "branch", "first");
                const out = run(r, ["--queue-event", event(r, "master", 7, 8)]);
                expect(out.stdout).toContain("Merge-queue batch: #7, #8");
                expect(out.status).toBe(1);
                // Stacked on a batch with the same baselines, it changes none.
                const stacked = run(r, ["--queue-event", event(r, "first", 8)]);
                expect(stacked.stdout).toContain("Baseline changes compared with the batch's base");
                expect(stacked.status).toBe(0);
                approveTree(r);
                expect(run(r, ["--queue-event", event(r, "master", 7, 8)]).status).toBe(0);
            });

            it("fails closed on an event that names no pull request, and refuses --pr with it", () => {
                const r = repoWith(passkeysJson(KEY));
                const empty = join(tempDir("vr-event-"), "event.json");
                writeFileSync(empty, JSON.stringify({ pull_request: { body: "no yaml here" } }));
                expect(run(r, ["--queue-event", empty]).status).toBe(1);
                expect(run(r, ["--queue-event", join(r.repo, "missing.json")]).status).toBe(1);
                expect(run(r, ["--pr", "7", "--queue-event", event(r, "master", 7)]).status).toBe(2);
            });

            it("fails closed when the draft names no checking_base_sha, or one that is not in the repository", () => {
                const r = repoWith(passkeysJson(KEY));
                const missing = run(r, ["--queue-event", event(r, null, 7, 8)]);
                expect(missing.stdout).toContain("names no checking_base_sha the gate can read (missing)");
                expect(missing.status).toBe(1);
                const file = join(tempDir("vr-event-"), "event.json");
                const body = `\`\`\`yaml\nchecking_base_sha: ${"f".repeat(40)}\npull_requests:\n  - number: 7\n\`\`\`\n`;
                writeFileSync(file, JSON.stringify({ pull_request: { body } }));
                const unknown = run(r, ["--queue-event", file]);
                expect(unknown.stdout).toContain(`names no checking_base_sha the gate can read (${"f".repeat(40)})`);
                expect(unknown.status).toBe(1);
                expect(queueBaseSha({ pull_request: { body: "```yaml\nchecking_base_sha: c0f44c1da\n```" } })).toBe(
                    null,
                );
            });

            it("reads the pull requests from the last yaml block of the queue draft's body only", () => {
                const body = (yaml) => ({ pull_request: { body: `text\n\`\`\`yaml\n${yaml}\`\`\`\n` } });
                expect(
                    queuePullRequests(body("pull_requests:\n  - number: 988\n    scopes: []\nscopes: []\n")),
                ).toEqual([988]);
                expect(
                    queuePullRequests({
                        pull_request: {
                            body: "```yaml\npull_requests:\n  - number: 1\n```\n```yaml\npull_requests:\n  - number: 2\n  - number: 3\n```",
                        },
                    }),
                ).toEqual([2, 3]);
                expect(queuePullRequests(body("previous_failed_batches:\n  - number: 5\npull_requests: []\n"))).toEqual(
                    [],
                );
                expect(queuePullRequests(null)).toEqual([]);
            });
        });

        it("warns, and still passes, when the pull request changes a file that decides what the gate accepts", () => {
            const r = repoWith();
            commit(r, { [PASSKEYS_FILE]: passkeysJson(KEY) });
            const out = run(r, ["--pr", "7"]);
            expect(out.stdout).toContain(
                "::warning::this pull request changes visual-review/passkeys.json, which decides what the visual gate accepts: review that change with care",
            );
            expect(out.status).toBe(0);
        });
    });
});
