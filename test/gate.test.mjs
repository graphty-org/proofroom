import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
    approvalKeys,
    contentHash,
    gateProblems,
    gatedProjects,
    MAX_THRESHOLD,
    newestResults,
    queuePullRequests,
    reviewGaps,
    seededAt,
    trustFilesChanged,
    unrecordedChanges,
} from "../trusted/gate.mjs";
import { PASSKEYS_FILE } from "../trusted/lib/approval.mjs";
import { normalizeConfig } from "../trusted/lib/config.mjs";
import { CONFIG, FIXTURE, git, isolateGit, makeRepo } from "./helpers.mjs";
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
            `${path}: changed with no review record taking it from its base branch contents to these`,
        ]);
        const to = createHash("sha256").update("new image").digest("hex");
        mkdirSync(join(r.repo, "visual-baselines/reviews"));
        writeFileSync(
            join(r.repo, "visual-baselines/reviews/r.json"),
            JSON.stringify({ items: [{ path, from: LEGACY, to }] }),
        );
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

describe("passkey approvals", () => {
    const KEY = makeKey();
    const PATH = "visual-baselines/compact-mantine/card--legacy.png";
    const TO = createHash("sha256").update("new image").digest("hex");
    const v2 = (pr = 7, to = TO) => ({
        version: 2,
        pr,
        subject: { builtMerge: "1".repeat(40), head: "2".repeat(40), runId: 9, runAttempt: 1, scale: 2 },
        items: [{ path: PATH, from: LEGACY, to, reason: null }],
        rejects: [],
        reviewedAt: "2026-09-28T12:00:00.000Z",
    });
    const signed = (record, key = KEY) => ({ ...record, approval: approve(record, key) });

    /**
     * master with passkeys.json (when given) and branch `pr` from it.
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
            writeFileSync(join(r.repo, path), typeof data === "string" ? data : JSON.stringify(data));
        }
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "change");
    }

    const check = (r, pr = 7) =>
        unrecordedChanges("master", "pr", r.repo, "visual-baselines", { keys: [KEY.entry], pr });

    it("words the same messages from reviewGaps' data as before it was split out, and names the refused records", () => {
        const r = repoWith(passkeysJson(KEY));
        const files = { [PATH]: "new image", "visual-baselines/reviews/old.json": { version: 1, items: [] } };
        for (let i = 0; i < 22; i++) {
            files[`visual-baselines/compact-mantine/extra-${String(i).padStart(2, "0")}.png`] = `image ${i}`;
        }
        commit(r, files);
        const gaps = reviewGaps("master", "pr", r.repo, "visual-baselines", { keys: [KEY.entry], pr: 7 });
        expect(gaps.refused).toEqual(["visual-baselines/reviews/old.json"]);
        expect(gaps.missing).toHaveLength(23);
        expect(gaps.missing).toContainEqual({ path: PATH, from: LEGACY, to: TO });
        // The exact lines the gate printed before reviewGaps existed: records first, then at most
        // twenty files in path order, then the count of the rest.
        const unrecorded = (p) =>
            `${p}: changed with no review record taking it from its base branch contents to these`;
        expect(check(r)).toEqual(
            [
                "visual-baselines/reviews/old.json: a version 1 record has no passkey approval; review it again with Face ID",
                PATH,
                ...Array.from(
                    { length: 19 },
                    (_, i) => `visual-baselines/compact-mantine/extra-${String(i).padStart(2, "0")}.png`,
                ),
            ]
                .map((p, i) => (i === 0 ? p : unrecorded(p)))
                .concat(["... and 3 more baseline files with no review record"]),
        );
    });

    it("passes version 1 records while the base has no passkeys.json or no keys", () => {
        for (const passkeys of [undefined, '{ "version": 1, "keys": [] }\n']) {
            const r = repoWith(passkeys);
            commit(r, {
                [PATH]: "new image",
                "visual-baselines/reviews/r.json": {
                    version: 1,
                    unproven: true,
                    items: [{ path: PATH, from: LEGACY, to: TO }],
                },
            });
            expect(approvalKeys("master", "pr", undefined, r.repo)).toEqual({ keys: null, problems: [] });
            expect(unrecordedChanges("master", "pr", r.repo)).toEqual([]);
        }
    });

    it("passes an approved version 2 record naming the changed baseline", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PATH]: "new image", "visual-baselines/reviews/r.json": signed(v2()) });
        expect(approvalKeys("master", "pr", 7, r.repo)).toEqual({ keys: [KEY.entry], problems: [] });
        expect(check(r)).toEqual([]);
    });

    it("fails an old-format record added after enforcement, and reports its baseline unrecorded", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, {
            [PATH]: "new image",
            "visual-baselines/reviews/r.json": {
                version: 1,
                unproven: true,
                items: [{ path: PATH, from: LEGACY, to: TO }],
            },
        });
        expect(check(r)).toEqual([
            "visual-baselines/reviews/r.json: a version 1 record has no passkey approval; review it again with Face ID",
            `${PATH}: changed with no review record taking it from its base branch contents to these`,
        ]);
    });

    it("fails a version 2 record without an approval, and a replayed one from another pull request", () => {
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PATH]: "new image", "visual-baselines/reviews/r.json": v2() });
        expect(check(r)[0]).toBe("visual-baselines/reviews/r.json: the record has no passkey approval");
        const s = repoWith(passkeysJson(KEY));
        commit(s, { [PATH]: "new image", "visual-baselines/reviews/r.json": signed(v2(5)) });
        expect(check(s, 6)[0]).toBe("visual-baselines/reviews/r.json: the record is for pull request #5, not #6");
    });

    it("never takes keys from the pull request", () => {
        const k2 = makeKey();
        const r = repoWith(passkeysJson(KEY));
        commit(r, {
            [PATH]: "new image",
            [PASSKEYS_FILE]: passkeysJson(KEY, k2),
            "visual-baselines/reviews/r.json": signed(v2(), k2),
        });
        expect(check(r)[0]).toBe(
            "visual-baselines/reviews/r.json: approval is from a key not in passkeys.json on the base branch",
        );
    });

    it("leaves records already on the base alone, and fails an added record that names nothing changed", () => {
        const r = makeRepo();
        commit(r, {
            [PASSKEYS_FILE]: passkeysJson(KEY),
            "visual-baselines/reviews/old.json": { version: 1, unproven: true, items: [] },
        });
        git(r.repo, "checkout", "-q", "-b", "pr");
        commit(r, { "src.txt": "code" });
        expect(check(r)).toEqual([]);
        commit(r, { "visual-baselines/reviews/extra.json": { version: 1, items: [] } });
        expect(check(r)).toEqual([
            "visual-baselines/reviews/extra.json: a version 1 record has no passkey approval; review it again with Face ID",
        ]);
        commit(r, { "visual-baselines/reviews/junk.json": "{" });
        expect(check(r)).toContain("visual-baselines/reviews/junk.json: not valid JSON");
    });

    it("fails closed on an invalid base file, on switching enforcement off, and without --pr", () => {
        const bad = repoWith('{ "version": 1, "keys": [{ "id": "x" }] }');
        expect(approvalKeys("master", "pr", 7, bad.repo).problems[0]).toMatch(
            /^visual-review\/passkeys.json on the base branch is invalid: keys\[0\]\.rpId/,
        );
        for (const change of ['{ "version": 1, "keys": [] }', null, "{"]) {
            const r = repoWith(passkeysJson(KEY));
            commit(r, { [PASSKEYS_FILE]: change });
            expect(approvalKeys("master", "pr", 7, r.repo).problems).toEqual([
                "this pull request would switch approval enforcement off: its visual-review/passkeys.json is missing, invalid or holds no key",
            ]);
        }
        const r = repoWith(passkeysJson(KEY));
        expect(approvalKeys("master", "pr", undefined, r.repo).problems).toEqual([
            "approvals are enforced (visual-review/passkeys.json on the base branch holds a key), so the gate needs --pr <number>",
        ]);
    });

    describe("records count only from the base branch's contents", () => {
        const OLD = sha256("old image");
        const NOW = sha256("current image");
        const at = (t) => `2026-09-${t}T12:00:00.000Z`;
        const rec = (pr, from, to, t = "28") => ({
            ...v2(pr, to),
            items: [{ path: PATH, from, to, reason: null }],
            reviewedAt: at(t),
        });
        const SEED = signed(rec(null, LEGACY, OLD, "20"));

        // master: a seed approved old image, then pull request 7 approved the current one.
        function history() {
            const r = makeRepo();
            commit(r, {
                [PASSKEYS_FILE]: passkeysJson(KEY),
                [PATH]: "old image",
                "visual-baselines/reviews/seed.json": SEED,
            });
            commit(r, { [PATH]: "current image", "visual-baselines/reviews/pr7.json": signed(rec(7, OLD, NOW, "21")) });
            git(r.repo, "checkout", "-q", "-b", "pr");
            return r;
        }

        it("fails a seed record replayed to roll a baseline back past a newer approval", () => {
            const r = history();
            commit(r, { [PATH]: "old image", "visual-baselines/reviews/copy.json": SEED });
            expect(check(r, 20)).toEqual([
                "visual-baselines/reviews/copy.json: a copy of a record already on the base branch: an approval counts once",
                `${PATH}: changed with no review record taking it from its base branch contents to these`,
            ]);
        });

        it("fails an approved record whose from is not the base branch's contents", () => {
            const r = history();
            // Approved by the owner, but for a change from the image the seed replaced.
            commit(r, { [PATH]: "old image", "visual-baselines/reviews/r.json": signed(rec(null, LEGACY, OLD, "22")) });
            expect(check(r, 20)).toEqual([
                `${PATH}: changed with no review record taking it from its base branch contents to these`,
            ]);
        });

        it("follows two sessions of one pull request, and refuses the decision a later one replaced", () => {
            const r = history();
            const NEXT = sha256("next image");
            commit(r, {
                [PATH]: "next image",
                "visual-baselines/reviews/a.json": signed(rec(8, NOW, OLD, "22")),
                "visual-baselines/reviews/b.json": signed(rec(8, OLD, NEXT, "23")),
            });
            expect(check(r, 8)).toEqual([]);
            commit(r, { [PATH]: "old image" });
            expect(check(r, 8)).toEqual([
                `${PATH}: changed with no review record taking it from its base branch contents to these`,
            ]);
            // A cycle that never starts at the base counts for nothing.
            const c = history();
            commit(c, {
                [PATH]: "next image",
                "visual-baselines/reviews/a.json": signed(rec(8, NEXT, OLD, "22")),
                "visual-baselines/reviews/b.json": signed(rec(8, OLD, NEXT, "23")),
            });
            expect(check(c, 8)).toEqual([
                `${PATH}: changed with no review record taking it from its base branch contents to these`,
            ]);
        });
    });

    it("needs a record for any settings file the pull request adds or changes, not for a deletion or renames.json", () => {
        const r = repoWith(passkeysJson(KEY));
        const SETTINGS = "visual-baselines/compact-mantine/card--legacy.json";
        commit(r, { [SETTINGS]: { diffThreshold: 1 }, "visual-baselines/compact-mantine/renames.json": [] });
        expect(check(r)).toEqual([
            `${SETTINGS}: changed with no review record taking it from its base branch contents to these`,
        ]);
        const item = { path: SETTINGS, from: null, to: sha256(JSON.stringify({ diffThreshold: 1 })), reason: "x" };
        commit(r, { "visual-baselines/reviews/r.json": signed({ ...v2(), items: [item] }) });
        expect(check(r)).toEqual([]);
        git(r.repo, "checkout", "-q", "master");
        commit(r, { [SETTINGS]: { delay: 100 } });
        git(r.repo, "checkout", "-q", "-b", "drop");
        commit(r, { [SETTINGS]: null });
        expect(unrecordedChanges("master", "drop", r.repo, "visual-baselines", { keys: [KEY.entry], pr: 7 })).toEqual(
            [],
        );
    });

    it("needs an approved record for a change to passkeys.json once the base holds a key", () => {
        const k2 = makeKey();
        const r = repoWith(passkeysJson(KEY));
        commit(r, { [PASSKEYS_FILE]: passkeysJson(k2) });
        expect(check(r)).toEqual([
            `${PASSKEYS_FILE}: changed with no record approved by a key on the base branch; once a key is registered, adding or replacing one is merged by an administrator (the README, "Replacing the passkey")`,
        ]);
        const item = {
            path: PASSKEYS_FILE,
            from: sha256(passkeysJson(KEY)),
            to: sha256(passkeysJson(k2)),
            reason: null,
        };
        commit(r, { "visual-baselines/reviews/r.json": signed({ ...v2(null), items: [item] }) });
        expect(check(r)).toEqual([]);
        // Before the base holds a key, adding the first one is the owner's merge.
        const first = repoWith();
        commit(first, { [PASSKEYS_FILE]: passkeysJson(KEY) });
        expect(unrecordedChanges("master", "pr", first.repo)).toEqual([]);
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
        const captures = () =>
            artifacts(
                Object.fromEntries(Object.keys(CONFIG.projects).map((p) => [`visual-${p}-1`, results(["unchanged"])])),
            );
        const run = (r, ...extra) =>
            spawnSync(
                process.execPath,
                [GATE, "--captures", captures(), "--base", "master", "--head", "pr", ...extra],
                {
                    cwd: r.repo,
                    encoding: "utf8",
                },
            );

        it("fails an unapproved record once enforced, and passes an approved one", () => {
            const r = repoWith(passkeysJson(KEY));
            commit(r, { [PATH]: "new image", "visual-baselines/reviews/r.json": v2() });
            const out = run(r, "--pr", "7");
            expect(out.stdout).toContain(
                "::error::baseline without a review -- visual-baselines/reviews/r.json: the record has no passkey approval",
            );
            expect(out.status).toBe(1);
            const s = repoWith(passkeysJson(KEY));
            commit(s, { [PATH]: "new image", "visual-baselines/reviews/r.json": signed(v2()) });
            expect(run(s, "--pr", "7").status).toBe(0);
            const noPr = run(s);
            expect(noPr.stdout).toMatch(/::error::.*needs --pr <number>/);
            expect(noPr.status).toBe(1);
            expect(run(s, "--pr", "seven").status).toBe(2);
        });

        describe("a merge-queue batch (--queue-event)", () => {
            const ADDED = "visual-baselines/compact-mantine/card--added.png";
            const added = (pr) => ({
                ...v2(pr),
                items: [{ path: ADDED, from: null, to: sha256("added image"), reason: null }],
                reviewedAt: "2026-09-28T13:00:00.000Z",
            });
            const event = (...prs) => {
                const file = join(mkdtempSync(join(tmpdir(), "vr-event-")), "event.json");
                const list = prs.map((n) => `  - number: ${n}\n    scopes: []\n`).join("");
                const body = `### Queue\n\n\`\`\`yaml\n---\nchecking_base_sha: ${"f".repeat(40)}\npull_requests:\n${list}scopes: []\n...\n\n\`\`\`\n`;
                writeFileSync(file, JSON.stringify({ pull_request: { number: 995, body } }));
                return file;
            };
            // Two pull requests merged into one queue tree: #7 changes a baseline, #8 adds one.
            const batch = (sign8 = true) => {
                const r = repoWith(passkeysJson(KEY));
                commit(r, {
                    [PATH]: "new image",
                    "visual-baselines/reviews/r7.json": signed(v2(7)),
                    [ADDED]: "added image",
                    "visual-baselines/reviews/r8.json": sign8 ? signed(added(8)) : added(8),
                });
                return r;
            };

            it("passes when every record is approved for a pull request of the batch", () => {
                const out = run(batch(), "--queue-event", event(7, 8, 9));
                expect(out.stdout).toContain("Merge-queue batch: #7, #8, #9");
                expect(out.status).toBe(0);
            });

            it("fails a record for a pull request outside the batch, and one with no approval", () => {
                const outside = run(batch(), "--queue-event", event(7));
                expect(outside.stdout).toContain("visual-baselines/reviews/r8.json: the record is for pull request #8, not #7");
                expect(outside.status).toBe(1);
                const unsigned = run(batch(false), "--queue-event", event(7, 8));
                expect(unsigned.stdout).toContain("visual-baselines/reviews/r8.json: the record has no passkey approval");
                expect(unsigned.status).toBe(1);
            });

            it("fails a batch whose capture differs from the approved images", () => {
                const changed = artifacts(
                    Object.fromEntries(
                        Object.keys(CONFIG.projects).map((p) => [`visual-${p}-1`, results(["unchanged", "changed"])]),
                    ),
                );
                const out = spawnSync(
                    process.execPath,
                    [GATE, "--captures", changed, "--base", "master", "--head", "pr", "--queue-event", event(7, 8)],
                    { cwd: batch().repo, encoding: "utf8" },
                );
                expect(out.stdout).toMatch(/::error::visual changes not accepted -- .*1 changed/);
                expect(out.status).toBe(1);
            });

            it("fails closed on an event that names no pull request, and refuses --pr with it", () => {
                const r = batch();
                const empty = join(mkdtempSync(join(tmpdir(), "vr-event-")), "event.json");
                writeFileSync(empty, JSON.stringify({ pull_request: { body: "no yaml here" } }));
                expect(run(r, "--queue-event", empty).status).toBe(1);
                expect(run(r, "--queue-event", join(r.repo, "missing.json")).status).toBe(1);
                expect(run(r, "--pr", "7", "--queue-event", event(7)).status).toBe(2);
            });

            it("reads the pull requests from the last yaml block of the queue draft's body only", () => {
                const body = (yaml) => ({ pull_request: { body: `text\n\`\`\`yaml\n${yaml}\`\`\`\n` } });
                expect(queuePullRequests(body("pull_requests:\n  - number: 988\n    scopes: []\nscopes: []\n"))).toEqual([988]);
                expect(
                    queuePullRequests({
                        pull_request: {
                            body: "```yaml\npull_requests:\n  - number: 1\n```\n```yaml\npull_requests:\n  - number: 2\n  - number: 3\n```",
                        },
                    }),
                ).toEqual([2, 3]);
                expect(queuePullRequests(body("previous_failed_batches:\n  - number: 5\npull_requests: []\n"))).toEqual([]);
                expect(queuePullRequests(null)).toEqual([]);
            });
        });

        it("warns, and still passes, when the pull request changes a file that decides what the gate accepts", () => {
            const r = repoWith();
            commit(r, { [PASSKEYS_FILE]: passkeysJson(KEY) });
            const out = run(r, "--pr", "7");
            expect(out.stdout).toContain(
                "::warning::this pull request changes visual-review/passkeys.json, which decides what the visual gate accepts: review that change with care",
            );
            expect(out.status).toBe(0);
        });
    });
});
