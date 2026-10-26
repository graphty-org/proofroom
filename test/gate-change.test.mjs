/*
 * The gate's second way to pass (design 12.7): change statements beside tree statements, on
 * fixture repositories. master is the default branch, `pr` the change (pr:7).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { approvalMode, approvalProblems, repositoryOf, treeAt } from "../trusted/gate.mjs";
import { PASSKEYS_FILE, verifyApproval } from "../trusted/lib/approval.mjs";
import { statementPath } from "../trusted/lib/change-approval.mjs";
import { CONFIG_FILE } from "../trusted/lib/config.mjs";
import { CONFIG, FIXTURE, git, tempDir } from "./helpers.mjs";
import {
    APPROVALS,
    BASELINES,
    CARD,
    KEY,
    REPO_ID,
    TOOLTIP,
    changeRepo,
    check,
    checkInput,
    commit,
    entry,
    finish,
    makeKey,
    passkeysJson,
    sign,
    statementOf,
} from "./change-statements.mjs";
import { approve } from "./passkey-vectors.mjs";

const CARD_FILE = `${BASELINES}/${CARD}`;
const TOOLTIP_FILE = `${BASELINES}/${TOOLTIP}`;
const NOT_REVIEWED = `${CARD_FILE}: not reviewed; review it with \`proofroom serve\` and Finish`;

/**
 * The change writes a new image of CARD and Finish accepts it.
 * @param {{ repo: string }} r the repository
 * @param {string} [image] the image's bytes
 * @param {object} [more] statement fields to override
 * @returns {{ statement: object, id: string, file: string }} the statement
 */
function acceptCard(r, image = "new image", more = {}) {
    commit(r, { [CARD_FILE]: image });
    return finish(r, statementOf(r, [entry(r, CARD)], more));
}

/**
 * Lands `pr` on master as a merge commit, then starts a new `pr` branch from master.
 * @param {{ repo: string }} r the repository
 * @param {string} [next] the next branch's name
 */
/**
 * The other valid ECDSA signature of the same message: (r, n - s) for a DER signature (r, s).
 * @param {string} der the signature, base64url DER
 * @returns {string} the other one, base64url DER
 */
function otherSignature(der) {
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const b = Buffer.from(der, "base64url");
    const rLen = b[3];
    const r = b.subarray(4, 4 + rLen);
    const s = BigInt(`0x${b.subarray(6 + rLen, 6 + rLen + b[5 + rLen]).toString("hex")}`);
    let hex = (n - s).toString(16);
    hex = hex.length % 2 ? `0${hex}` : hex;
    const t = Buffer.from(Number.parseInt(hex.slice(0, 2), 16) & 0x80 ? `00${hex}` : hex, "hex");
    const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, t.length]), t]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString("base64url");
}

function land(r, next = "pr") {
    git(r.repo, "checkout", "-q", "master");
    git(r.repo, "merge", "-q", "--no-ff", "-m", "land", "pr");
    git(r.repo, "branch", "-q", "-D", "pr");
    git(r.repo, "checkout", "-q", "-b", next);
}

describe("change statements in the gate", () => {
    it("pass a change whose statement accepts exactly each file it alters, kept across later code and master merges", () => {
        const r = changeRepo();
        expect(check(r)).toEqual([]);
        acceptCard(r);
        expect(check(r)).toEqual([]);
        commit(r, { "src.txt": "more code" });
        expect(check(r)).toEqual([]);
        // Another change lands an unrelated baseline; merging master keeps this approval.
        git(r.repo, "checkout", "-q", "master");
        commit(r, { [TOOLTIP_FILE]: "landed elsewhere" });
        git(r.repo, "checkout", "-q", "pr");
        git(r.repo, "merge", "-q", "--no-edit", "master");
        expect(check(r)).toEqual([]);
    });

    it("passes an empty change to the baselines with no statement at all", () => {
        const r = changeRepo();
        commit(r, { "src.txt": "code", [`${BASELINES}/reviews/old.json`]: "{}" });
        expect(check(r)).toEqual([]);
    });

    it("fails an altered file with no decision as not reviewed, naming each file", () => {
        const r = changeRepo();
        commit(r, { [CARD_FILE]: "new image", [TOOLTIP_FILE]: null });
        expect(check(r)).toEqual([
            NOT_REVIEWED,
            `${TOOLTIP_FILE}: not reviewed; review it with \`proofroom serve\` and Finish`,
        ]);
    });

    it("refuses an approval moved to another story: the path is matched exactly", () => {
        const r = changeRepo();
        commit(r, { [CARD_FILE]: "new image" });
        const moved = { ...entry(r, CARD), path: TOOLTIP };
        finish(r, statementOf(r, [moved]));
        expect(check(r)).toEqual([NOT_REVIEWED]);
    });

    it("refuses a statement whose folder or name does not match its content", () => {
        const r = changeRepo();
        commit(r, { [CARD_FILE]: "new image" });
        const s = sign(statementOf(r, [entry(r, CARD)]));
        const right = statementPath(APPROVALS, s);
        const wrongFolder = right.replace("/pr-7/", "/pr-8/");
        commit(r, { [wrongFolder]: s });
        expect(check(r)).toContain(
            `${wrongFolder}: its content belongs at ${right}: a statement is never moved or copied`,
        );
        // The same statement under another name in the right folder.
        const r2 = changeRepo();
        commit(r2, { [CARD_FILE]: "new image" });
        const done = finish(r2, statementOf(r2, [entry(r2, CARD)]), { file: `${APPROVALS}/pr-7/mine.json` });
        expect(check(r2)[0]).toBe(
            `${done.file}: its content belongs at ${statementPath(APPROVALS, done.statement)}: a statement is never moved or copied`,
        );
        // Unreadable, and not a statement.
        const r3 = changeRepo();
        commit(r3, { [`${APPROVALS}/pr-7/junk.json`]: "{", [`${APPROVALS}/pr-7/old.json`]: { version: 1 } });
        expect(check(r3)).toEqual([
            `${APPROVALS}/pr-7/junk.json: not JSON`,
            `${APPROVALS}/pr-7/old.json: not a change statement (not a version 2 change-approval statement)`,
        ]);
    });

    it("refuses a statement for another repository, and two plain-git repositories refuse each other's", () => {
        const r = changeRepo();
        acceptCard(r, "new image", { repository: "github:42" });
        expect(check(r)).toEqual([
            expect.stringContaining(`it approves repository github:42, not ${REPO_ID}`),
            NOT_REVIEWED,
        ]);
        // Repository B (its own id) holds a statement repository A made: the same key, the same file.
        const a = changeRepo({ config: { repositoryId: "repo-a", approvalFormat: "change" } });
        const made = acceptCard(a, "new image", { repository: "repo-a" });
        const b = changeRepo({ config: { repositoryId: "repo-b", approvalFormat: "change" } });
        commit(b, { [CARD_FILE]: "new image" });
        commit(b, { [made.file]: made.statement });
        expect(check(a, { repository: "repo-a" })).toEqual([]);
        expect(check(b, { repository: "repo-b" })[0]).toContain("it approves repository repo-a, not repo-b");
    });

    it("refuses every statement when the repository has no id", () => {
        const r = changeRepo({ config: { approvalFormat: "change" } });
        const done = acceptCard(r);
        expect(check(r, { repository: null })).toEqual([
            `${done.file}: this repository has no id, so no statement can name it (docs/approval-format.md, "Repository")`,
            NOT_REVIEWED,
        ]);
    });

    it("refuses a statement for another baselines directory", () => {
        const r = changeRepo();
        acceptCard(r, "new image", { baselines: "screens" });
        expect(check(r)[0]).toContain(`it approves screens/, not ${BASELINES}/`);
    });

    it("does not count another open change's statements merged into this one", () => {
        const r = changeRepo();
        git(r.repo, "checkout", "-q", "-b", "other", "master");
        const theirs = acceptCard(r, "new image", { change: "pr:8" });
        git(r.repo, "checkout", "-q", "pr");
        git(r.repo, "merge", "-q", "--no-edit", "other");
        const found = approvalProblems(checkInput(r));
        expect(found.problems).toEqual([NOT_REVIEWED]);
        expect(found.notices).toEqual([`${theirs.file} approves pr:8, not this change, so it is not counted`]);
        // This change's own Finish of the same file passes, beside the other's.
        finish(r, statementOf(r, [entry(r, CARD)]));
        expect(check(r)).toEqual([]);
    });

    it("refuses a landed statement replayed: kept under its own name it is not new, copied under another it is misplaced", () => {
        const r = changeRepo();
        const landed = acceptCard(r);
        land(r);
        // The default branch goes Y to Z (landed) and back to Y.
        git(r.repo, "checkout", "-q", "master");
        git(r.repo, "checkout", "-q", "master~1", "--", CARD_FILE);
        git(r.repo, "commit", "-q", "-m", "revert the card to Y");
        git(r.repo, "branch", "-q", "-D", "pr");
        git(r.repo, "checkout", "-q", "-b", "pr");
        // A change that writes Z again: the landed Y-to-Z statement still sits on the base, so it
        // is not added by this change and does not count.
        commit(r, { [CARD_FILE]: "new image" });
        expect(check(r)).toEqual([NOT_REVIEWED]);
        // Copied under a new name.
        const copy = `${APPROVALS}/pr-7/20261025T140211Z-000000000000.json`;
        commit(r, { [copy]: landed.statement });
        expect(check(r)).toContain(
            `${copy}: its content belongs at ${landed.file}: a statement is never moved or copied`,
        );
    });

    it("refuses a squash-landed statement replayed with other approval bytes, however it is re-signed", () => {
        const r = changeRepo();
        const y = readFileSync(join(r.repo, CARD_FILE));
        const landed = acceptCard(r);
        // Squash-landed, so its capturedHead is not on master; then master goes back to Y.
        git(r.repo, "checkout", "-q", "master");
        git(r.repo, "merge", "-q", "--squash", "pr");
        git(r.repo, "commit", "-q", "-m", "land, squashed");
        commit(r, { [CARD_FILE]: y }, "revert the card to Y");
        // The same change merges master and sets Z again.
        git(r.repo, "checkout", "-q", "pr");
        git(r.repo, "merge", "-q", "--no-edit", "master");
        expect(check(r)).toEqual([NOT_REVIEWED]);
        // The alternate signature verifies, and gives the copy another id and place.
        const approval = { ...landed.statement.approval, signature: otherSignature(landed.statement.approval.signature) };
        const highS = { ...landed.statement, approval };
        expect(verifyApproval(highS, [KEY.entry])).toBe(null);
        const highFile = statementPath(APPROVALS, highS);
        expect(highFile).not.toBe(landed.file);
        // A field added inside approval also gives another id; the shape check refuses it.
        const noted = { ...landed.statement, approval: { ...landed.statement.approval, note: "x" } };
        const notedFile = statementPath(APPROVALS, noted);
        commit(r, { [highFile]: highS, [notedFile]: noted });
        expect(check(r).sort()).toEqual(
            [
                NOT_REVIEWED,
                `${highFile}: it is already in the default branch's history, and a landed statement never counts again`,
                `${notedFile}: not a change statement (approval: unknown field "note")`,
            ].sort(),
        );
    });

    it("refuses a statement whose path is in the base's history, even after the base deleted it", () => {
        const r = changeRepo();
        const landed = acceptCard(r);
        land(r);
        git(r.repo, "checkout", "-q", "master");
        commit(r, { [landed.file]: null }, "an administrator removes it");
        git(r.repo, "branch", "-q", "-D", "pr");
        git(r.repo, "checkout", "-q", "-b", "pr");
        commit(r, { [CARD_FILE]: "a newer image" });
        commit(r, { [landed.file]: landed.statement });
        expect(check(r)).toContain(
            `${landed.file}: it is already in the default branch's history, and a landed statement never counts again`,
        );
    });

    it("does not revive an abandoned branch's statements under a branch name used again", () => {
        const r = changeRepo();
        const changes = ["branch:feat/x"];
        git(r.repo, "checkout", "-q", "-b", "feat/x", "master");
        const old = acceptCard(r, "new image", { change: "branch:feat/x" });
        expect(check(r, { head: "feat/x", changes })).toEqual([]);
        // The branch is abandoned and a new one of the same name starts from master, holding the file.
        git(r.repo, "checkout", "-q", "master");
        git(r.repo, "branch", "-q", "-D", "feat/x");
        git(r.repo, "checkout", "-q", "-b", "feat/x");
        commit(r, { [CARD_FILE]: "new image" }, "a new start");
        commit(r, { [old.file]: old.statement });
        expect(check(r, { head: "feat/x", changes })[0]).toBe(
            `${old.file}: its capturedHead ${old.statement.capturedHead} is not in this change's history`,
        );
    });

    it("refuses a capturedHead that is already on the base, or not in the repository", () => {
        const r = changeRepo();
        commit(r, { [CARD_FILE]: "new image" });
        const master = git(r.repo, "rev-parse", "master");
        finish(r, statementOf(r, [entry(r, CARD)], { capturedHead: master }));
        expect(check(r)[0]).toContain(
            `its capturedHead ${master} is already on the base, so it reviewed an earlier change`,
        );
        const r2 = changeRepo();
        commit(r2, { [CARD_FILE]: "new image" });
        finish(r2, statementOf(r2, [entry(r2, CARD)], { capturedHead: "c".repeat(40) }));
        expect(check(r2)[0]).toContain(`its capturedHead ${"c".repeat(40)} is not in this repository`);
    });

    it("fails a superseded image as stale once the default branch changed that file", () => {
        const r = changeRepo();
        const first = acceptCard(r, "my image");
        // Another change lands its own image of the same story first.
        git(r.repo, "checkout", "-q", "master");
        commit(r, { [CARD_FILE]: "their image" });
        git(r.repo, "checkout", "-q", "pr");
        // update: master's side wins the pointer conflict, then the change's code draws its own again.
        git(r.repo, "merge", "-q", "--no-edit", "-X", "theirs", "master");
        commit(r, { [CARD_FILE]: "my image" });
        expect(check(r)).toEqual([
            `the default branch changed ${CARD_FILE} after the review; update and decide it again`,
        ]);
        // Deciding it again against the new base passes.
        finish(r, statementOf(r, [entry(r, CARD)], { previous: first.id, approvedAt: "2026-10-26T09:00:00Z" }));
        expect(check(r)).toEqual([]);
    });

    it("voids a removed key's statements, and fails a bad signature in a statement nothing needs", () => {
        const removed = makeKey();
        const r = changeRepo();
        commit(r, { [CARD_FILE]: "new image" });
        finish(r, statementOf(r, [entry(r, CARD)]), { key: removed });
        expect(check(r)[0]).toContain("approval is from a key not in passkeys.json on the base branch");
        // D is empty, but the statement is altered after signing.
        const r2 = changeRepo();
        commit(r2, { "src.txt": "code" });
        const s = statementOf(r2, []);
        const tampered = { ...s, approval: approve({ ...s, change: "pr:9" }, KEY) };
        commit(r2, { [statementPath(APPROVALS, tampered)]: tampered });
        expect(check(r2)[0]).toContain("the challenge does not match");
        // While the base holds no key, the signature is not checked, as for tree statements.
        const r3 = changeRepo({ passkeys: null });
        commit(r3, { [CARD_FILE]: "new image" });
        finish(r3, statementOf(r3, [entry(r3, CARD)]), { key: null });
        expect(check(r3, { keys: null })).toEqual([]);
    });

    it("orders by the chain, never by approvedAt, and closes a fork with an array previous", () => {
        const r = changeRepo();
        const first = acceptCard(r, "new image", { approvedAt: "2099-01-01T00:00:00Z" });
        finish(r, statementOf(r, [entry(r, CARD, { decision: "reject", reason: "blurry" })], { previous: first.id }));
        expect(check(r)).toEqual([
            `${CARD_FILE}: rejected (blurry); a rejected item needs a code change, not another review`,
        ]);
        // Two Finishes of one change made at once.
        const f = changeRepo();
        const a = acceptCard(f);
        const b = finish(f, statementOf(f, [entry(f, CARD)], { previous: null, approvedAt: "2026-10-25T14:05:00Z" }));
        expect(check(f)).toEqual(["two Finishes of this change were made at once; finish again"]);
        finish(f, statementOf(f, [], { previous: [a.id, b.id], approvedAt: "2026-10-25T15:00:00Z" }));
        expect(check(f)).toEqual([]);
    });

    it("fails a change that modifies or deletes a landed statement or review record", () => {
        const r = changeRepo();
        const landed = acceptCard(r);
        commit(r, { [`${BASELINES}/reviews/r.json`]: { version: 2 } });
        land(r);
        commit(r, { [landed.file]: { ...landed.statement, entries: [] }, [`${BASELINES}/reviews/r.json`]: null });
        expect(check(r)).toEqual([
            `${BASELINES}/reviews/r.json: deleted; approvals and review records on the base are history, never changed`,
            `${landed.file}: modified; approvals and review records on the base are history, never changed`,
        ]);
    });
});

describe("tree statements beside change statements", () => {
    const treeStatement = (r) => {
        const s = {
            version: 1,
            commit: git(r.repo, "rev-parse", "HEAD"),
            tree: treeAt("HEAD", BASELINES, r.repo),
            baselines: BASELINES,
            pr: 7,
            approvedAt: "2026-10-19T12:00:00.000Z",
        };
        return { file: `${APPROVALS}/${s.tree}.json`, statement: sign(s) };
    };
    const treeRepo = () => changeRepo({ config: {} });

    it("passes one the change adds, in tree mode, as before", () => {
        const r = treeRepo();
        commit(r, { [CARD_FILE]: "new image" });
        const t = treeStatement(r);
        commit(r, { [t.file]: t.statement });
        expect(check(r, { mode: "tree" })).toEqual([]);
        // Change statements pass in tree mode too.
        const c = treeRepo();
        acceptCard(c);
        expect(check(c, { mode: "tree" })).toEqual([]);
    });

    it("fails one already on the base: no rollback to an earlier approved tree", () => {
        const r = treeRepo();
        const before = treeAt("master", BASELINES, r.repo);
        commit(r, { [CARD_FILE]: "new image" });
        const t = treeStatement(r);
        commit(r, { [t.file]: t.statement });
        land(r);
        // The default branch moves on, then a change restores the approved tree of the landing.
        git(r.repo, "checkout", "-q", "master");
        commit(r, { [CARD_FILE]: "newer image" });
        git(r.repo, "branch", "-q", "-D", "pr");
        git(r.repo, "checkout", "-q", "-b", "pr");
        commit(r, { [CARD_FILE]: "new image" });
        expect(treeAt("pr", BASELINES, r.repo)).toBe(t.statement.tree);
        expect(treeAt("pr", BASELINES, r.repo)).not.toBe(before);
        expect(check(r, { mode: "tree" })).toEqual([
            `${t.file}: already on the base, and a tree statement counts only when this change adds it, so an earlier approved tree cannot come back without a review; review the changes with \`proofroom serve\` and Finish, which signs the tree`,
        ]);
    });

    it("refuses one in change mode, even of exactly the head's tree", () => {
        const r = treeRepo();
        commit(r, { [CARD_FILE]: "new image" });
        const t = treeStatement(r);
        commit(r, { [t.file]: t.statement });
        expect(check(r, { mode: "change" })).toEqual([
            `${t.file}: a version 1 tree statement, refused: this repository's approvals are change statements (approvalFormat "change"); Finish again`,
            NOT_REVIEWED,
        ]);
    });

    it("reports the tree's problem when the change was finished the old way, and the statements' when it has some", () => {
        const r = treeRepo();
        commit(r, { [CARD_FILE]: "new image" });
        expect(check(r, { mode: "tree" })[0]).toMatch(/differs from the base \(tree [0-9a-f]{40}\), and no/);
        commit(r, { [TOOLTIP_FILE]: "another" });
        finish(r, statementOf(r, [entry(r, CARD)]));
        expect(check(r, { mode: "tree" })).toEqual([
            `${TOOLTIP_FILE}: not reviewed; review it with \`proofroom serve\` and Finish`,
        ]);
    });

    it("picks the mode from the base: approvalFormat when set, else tree only for tree statements and no change statement", () => {
        const r = treeRepo();
        // No tree statement: a new repository gets change statements.
        expect(approvalMode(CONFIG, "master", r.repo)).toBe("change");
        expect(approvalMode({ ...CONFIG, approvalFormat: "tree" }, "master", r.repo)).toBe("tree");
        commit(r, { [CARD_FILE]: "new image" });
        const t = treeStatement(r);
        commit(r, { [t.file]: t.statement });
        expect(approvalMode(CONFIG, "pr", r.repo)).toBe("tree");
        expect(approvalMode({ ...CONFIG, approvalFormat: "change" }, "pr", r.repo)).toBe("change");
        finish(r, statementOf(r, [entry(r, CARD)]));
        expect(approvalMode(CONFIG, "pr", r.repo)).toBe("change");
        expect(approvalMode({ ...CONFIG, approvalFormat: "tree" }, "pr", r.repo)).toBe("tree");
    });
});

describe("the repository id", () => {
    it("is GitHub's numeric id on GitHub Actions, never the config's, and the config's elsewhere", () => {
        const config = { repositoryId: "abc" };
        expect(repositoryOf(config, { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY_ID: "123" })).toBe("github:123");
        expect(repositoryOf(config, { GITHUB_ACTIONS: "true" })).toBe(null);
        expect(repositoryOf(config, {})).toBe("abc");
        expect(repositoryOf({}, {})).toBe(null);
    });
});

describe("the gate command with change statements", () => {
    const GATE = fileURLToPath(new URL("../trusted/gate.mjs", import.meta.url));
    // Every project captured, every story unchanged: only the approval check can fail.
    const FIXTURE_RESULTS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
    const captures = () => {
        const dir = tempDir("vr-artifacts-");
        const item = {
            ...FIXTURE_RESULTS.items[0],
            status: "unchanged",
            baseline: "a".repeat(64),
            capture: "a".repeat(64),
        };
        for (const p of Object.keys(CONFIG.projects)) {
            mkdirSync(join(dir, `visual-${p}-1`));
            const results = { ...FIXTURE_RESULTS, complete: true, expected: 1, items: [item] };
            writeFileSync(join(dir, `visual-${p}-1`, "results.json"), JSON.stringify(results));
        }
        return dir;
    };
    const env = { ...process.env, GITHUB_ACTIONS: "", GITHUB_REPOSITORY_ID: "" };
    const run = (r, extra, more = {}) =>
        spawnSync(process.execPath, [GATE, "--captures", captures(), "--base", "master", "--head", "pr", ...extra], {
            cwd: r.repo,
            encoding: "utf8",
            env: { ...env, ...more },
        });

    it("passes with --change or --pr naming the statement's change, and fails without", () => {
        const r = changeRepo();
        acceptCard(r);
        const passed = run(r, ["--change", "pr:7"]);
        expect(passed.stdout).toContain("approved by the owner");
        expect(passed.status).toBe(0);
        expect(run(r, ["--pr", "7"]).status).toBe(0);
        const other = run(r, ["--pr", "8"]);
        expect(other.stdout).toContain("::notice::");
        expect(other.stdout).toContain(`::error::baselines not approved -- ${NOT_REVIEWED}`);
        expect(other.status).toBe(1);
        const none = run(r, []);
        expect(none.stdout).toContain("the gate was run without --change (or --pr), so no change statement can count");
        expect(none.status).toBe(1);
        expect(run(r, ["--change", "pr:7", "--pr", "7"]).status).toBe(2);
        expect(run(r, ["--change", "seven"]).status).toBe(2);
    });

    it("names the repository from GITHUB_REPOSITORY_ID on GitHub Actions", () => {
        const r = changeRepo();
        acceptCard(r, "new image", { repository: "github:555" });
        expect(run(r, ["--pr", "7"]).status).toBe(1);
        expect(run(r, ["--pr", "7"], { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY_ID: "555" }).status).toBe(0);
        expect(run(r, ["--pr", "7"], { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY_ID: "556" }).status).toBe(1);
    });

    it("fails a change whose config changes repositoryId, and reads approvalFormat from the base only", () => {
        const r = changeRepo();
        acceptCard(r);
        const config = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
        commit(r, { [CONFIG_FILE]: { ...config, repositoryId: "mine", approvalFormat: "tree" } });
        const out = run(r, ["--pr", "7"]);
        expect(out.stdout).toContain(
            `::error::passkey approval -- this pull request changes repositoryId from ${REPO_ID} to mine; a repository's id never changes`,
        );
        expect(out.status).toBe(1);
        // The head's approvalFormat "tree" does not let a tree statement in.
        const t = changeRepo();
        commit(t, { [CARD_FILE]: "new image" });
        const tconfig = JSON.parse(readFileSync(join(t.repo, CONFIG_FILE), "utf8"));
        const tree = treeAt("HEAD", BASELINES, t.repo);
        const s = {
            version: 1,
            commit: git(t.repo, "rev-parse", "HEAD"),
            tree,
            baselines: BASELINES,
            pr: 7,
            approvedAt: "2026-10-19T12:00:00.000Z",
        };
        commit(t, { [CONFIG_FILE]: { ...tconfig, approvalFormat: "tree" }, [`${APPROVALS}/${tree}.json`]: sign(s) });
        expect(run(t, ["--pr", "7"]).stdout).toContain("a version 1 tree statement, refused");
    });

    it("leaves passkeys.json's rule as it was: a change to it fails once the base holds a key", () => {
        const r = changeRepo();
        acceptCard(r);
        commit(r, { [PASSKEYS_FILE]: passkeysJson(KEY, makeKey()) });
        expect(run(r, ["--pr", "7"]).stdout).toContain(`::error::baselines not approved -- ${PASSKEYS_FILE}: changed`);
    });
});
