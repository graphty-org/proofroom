/*
 * The self-approval policy ("selfApproval": "forbid", design 12.7): keys name an identity, and the
 * gate refuses a statement signed by a key whose identity contributed to the change. It fails
 * closed wherever identities could be forged. master is the default branch, `pr` the change
 * (pr:7); alice writes the change and rita reviews it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalProblems, contributorsOf, treeAt } from "../trusted/gate.mjs";
import { parsePasskeys } from "../trusted/lib/approval.mjs";
import { contentHash, gitIn, selfApprovalProblems, statementPath } from "../trusted/lib/change-approval.mjs";
import { CONFIG_FILE, normalizeConfig } from "../trusted/lib/config.mjs";
import { CONFIG, FIXTURE, git, tempDir } from "./helpers.mjs";
import {
    APPROVALS,
    BASELINES,
    CARD,
    REPO_ID,
    changeRepo,
    checkInput,
    hashAt,
    makeKey,
    passkeysJson,
    sign,
    statementOf,
} from "./change-statements.mjs";

const CARD_FILE = `${BASELINES}/${CARD}`;
const FORBID = { repositoryId: REPO_ID, approvalFormat: "change", selfApproval: "forbid" };
const PLAIN = { GITHUB_ACTIONS: "" };

/**
 * A new SSH signing key.
 * @param {string} name its file name
 * @returns {{ file: string, line: string }} its private key file and its public key line
 */
function sshKey(name) {
    const file = join(tempDir("vr-ssh-"), name);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file]);
    return { file, line: readFileSync(`${file}.pub`, "utf8").trim() };
}

let people;
beforeAll(() => {
    const person = (user, more = {}) => {
        const ssh = sshKey(user);
        const passkey = makeKey();
        const identity = { user, emails: [`${user}@example.com`], signingKeys: [ssh.line], ...more };
        passkey.entry = { ...passkey.entry, label: user, identity };
        return { user, email: `${user}@example.com`, ssh, passkey };
    };
    people = { alice: person("alice"), rita: person("rita"), bob: person("bob") };
});

/**
 * A repository whose base forbids self-approval and trusts these keys.
 * @param {object[]} [keys] the passkeys (default alice's and rita's)
 * @param {object} [config] the base config's approval settings
 * @returns {{ repo: string }} the repository, on `pr`
 */
const repoWith = (keys = [people.alice.passkey, people.rita.passkey], config = FORBID) =>
    changeRepo({ config, passkeys: passkeysJson(...keys) });

/**
 * Commits files as someone, signed with their SSH key unless `signed` is false.
 * @param {{ repo: string }} r the repository
 * @param {Record<string, string | object>} files contents by path (objects as JSON)
 * @param {{ as: object, email?: string, signed?: boolean, by?: object }} o who commits; another
 *     e-mail on the commit; whether it is signed; and whose SSH key signs it (default theirs)
 * @returns {string} the commit
 */
function commitAs(r, files, { as, email = as.email, signed = true, by = as }) {
    for (const [path, data] of Object.entries(files)) {
        mkdirSync(join(r.repo, path, ".."), { recursive: true });
        writeFileSync(join(r.repo, path), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
    }
    git(r.repo, "add", "-A");
    const signing = signed ? ["-c", "gpg.format=ssh", "-c", `user.signingkey=${by.ssh.file}`] : [];
    git(
        r.repo,
        "-c",
        `user.name=${as.user}`,
        "-c",
        `user.email=${email}`,
        ...signing,
        "commit",
        "-q",
        ...(signed ? ["-S"] : []),
        "-m",
        "change",
    );
    return git(r.repo, "rev-parse", "HEAD");
}

/**
 * Finish: one commit holding the new image and the statement accepting it, signed by a passkey,
 * as the review page commits it.
 * @param {{ repo: string }} r the repository
 * @param {object} reviewer whose passkey signs, and whose git identity commits
 * @param {{ image?: string, extra?: object, signed?: boolean, seed?: boolean }} [o] the image; other
 *     files the commit also writes; whether the commit is signed; whether it is a seed statement (of
 *     a capture of master)
 * @returns {string} the statement's path
 */
function finishAs(r, reviewer, { image = "new image", extra = {}, signed = false, seed = false } = {}) {
    const e = { path: CARD, from: hashAt(r, "master", CARD), to: contentHash(Buffer.from(image)), decision: "accept" };
    const more = seed ? { type: "seed-approval", capturedHead: git(r.repo, "rev-parse", "master") } : {};
    const statement = sign(statementOf(r, [e], more), reviewer.passkey);
    const file = statementPath(APPROVALS, statement);
    commitAs(r, { [CARD_FILE]: image, [file]: statement, ...extra }, { as: reviewer, signed });
    return file;
}

const keysOf = (r) => parsePasskeys(git(r.repo, "show", "master:visual-review/passkeys.json"));

/**
 * What the gate's approval check and the self-approval rule say about `pr`.
 * @param {{ repo: string }} r the repository
 * @param {{ env?: object, fetchJson?: Function, git?: Function }} [o] the environment and stand-ins
 * @returns {Promise<{ problems: string[], self: string[] }>} both
 */
async function check(r, { env = PLAIN, fetchJson, git: runner } = {}) {
    const keys = keysOf(r);
    const found = approvalProblems(checkInput(r, { keys }));
    const contributors = await contributorsOf({
        base: "master",
        head: "pr",
        cwd: r.repo,
        changes: ["pr:7"],
        keys,
        baselines: BASELINES,
        approvals: APPROVALS,
        env,
        fetchJson,
        ...(runner && { git: runner }),
    });
    return {
        problems: found.problems,
        self: selfApprovalProblems({ statements: found.statements, keys, contributors }),
    };
}

const refused = (file, who) =>
    `${file}: signed by ${who} (${people[who].passkey.entry.id}), who contributed to pr:7; this repository forbids approving your own change`;

/**
 * A stand-in for GitHub's API: the pull request's opener and, for each of `pr`'s commits, what
 * GitHub says about it.
 * @param {{ repo: string }} r the repository
 * @param {{ opener?: string, commit?: (sha: string) => object }} o the opener, and each commit's fields
 * @returns {{ fetchJson: (path: string) => Promise<any>, asked: string[] }} the getter, and what it was asked
 */
function github(r, { opener = "bob", commit = () => ({}) }) {
    // Oldest first, as GitHub lists them.
    const shas = git(r.repo, "rev-list", "--reverse", "master..pr").split("\n").filter(Boolean);
    const asked = [];
    const fetchJson = async (path) => {
        asked.push(path);
        if (path === "pulls/7") {
            return { user: { login: opener } };
        }
        if (path.startsWith("pulls/7/commits")) {
            const page = Number(/[?&]page=(\d+)/.exec(path)[1]);
            return shas.slice((page - 1) * 100, page * 100).map((sha) => ({
                sha,
                author: { login: "alice" },
                committer: { login: "alice" },
                commit: {
                    author: { email: "alice@example.com" },
                    committer: { email: "alice@example.com" },
                    verification: { verified: true, reason: "valid" },
                },
                ...commit(sha),
            }));
        }
        throw new Error(`unexpected ${path}`);
    };
    return { fetchJson, asked };
}
const GITHUB = { GITHUB_ACTIONS: "true" };

describe("the self-approval rule, plain git", () => {
    it("refuses the author's own key, and passes a key whose identity contributed nothing", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice });
        const mine = finishAs(r, people.alice);
        expect(await check(r)).toEqual({ problems: [], self: [refused(mine, "alice")] });

        const s = repoWith();
        commitAs(s, { "src.txt": "code" }, { as: people.alice });
        finishAs(s, people.rita);
        expect(await check(s)).toEqual({ problems: [], self: [] });
    });

    it("refuses a commit carrying someone else's e-mail but the author's signature", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.bob, by: people.alice });
        const mine = finishAs(r, people.alice);
        expect((await check(r)).self).toEqual([refused(mine, "alice")]);
    });

    it("refuses by e-mail: a commit in the reviewer's name, signed by the author", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice, email: people.rita.email });
        const theirs = finishAs(r, people.rita);
        expect((await check(r)).self).toEqual([refused(theirs, "rita")]);
    });

    it("fails closed on an unsigned commit, and on one signed by a key no identity names", async () => {
        const r = repoWith();
        const code = commitAs(r, { "src.txt": "code" }, { as: people.alice, signed: false });
        finishAs(r, people.rita);
        expect((await check(r)).self).toEqual([
            `commit ${code.slice(0, 12)} carries no signature by a signing key an identity in visual-review/passkeys.json names`,
        ]);
        // bob signs, but no key in the base's list names bob's signing key.
        const s = repoWith();
        const other = commitAs(s, { "src.txt": "code" }, { as: people.bob });
        finishAs(s, people.rita);
        expect((await check(s)).self).toEqual([
            `commit ${other.slice(0, 12)} carries no signature by a signing key an identity in visual-review/passkeys.json names`,
        ]);
    });

    it("fails closed when a base key has no identity, or no key is registered", async () => {
        const plain = makeKey();
        const r = repoWith([people.alice.passkey, people.rita.passkey, plain]);
        commitAs(r, { "src.txt": "code" }, { as: people.alice });
        finishAs(r, people.rita);
        expect((await check(r)).self).toEqual([
            `the key test (${plain.entry.id}) in visual-review/passkeys.json names no identity, so it could be anyone's`,
        ]);
        expect(
            selfApprovalProblems({ statements: [{ file: "f", change: "pr:7" }], keys: null, contributors: new Map() }),
        ).toEqual([
            "no passkey is registered in visual-review/passkeys.json on the base, so who signed a statement cannot be known",
        ]);
    });

    it("does not count the tool's own commit, whoever's name is on it, but counts one that touches anything else", async () => {
        // rita's Finish commit is unsigned and in her name, yet holds only the statement and its image.
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice });
        finishAs(r, people.rita);
        expect((await check(r)).self).toEqual([]);
        // The same Finish commit also changing code: rita contributed, and it is unsigned.
        const s = repoWith();
        commitAs(s, { "src.txt": "code" }, { as: people.alice });
        const file = finishAs(s, people.rita, { extra: { "src.txt": "more code" } });
        const finishCommit = git(s.repo, "rev-parse", "pr");
        expect((await check(s)).self).toEqual([
            `commit ${finishCommit.slice(0, 12)} carries no signature by a signing key an identity in visual-review/passkeys.json names`,
            refused(file, "rita"),
        ]);
        // An author's Finish-shaped commit of their own approval is still the tool's: their key is refused for the code commit.
        const t = repoWith();
        commitAs(t, { "src.txt": "code" }, { as: people.alice });
        const mine = finishAs(t, people.alice);
        expect((await check(t)).self).toEqual([refused(mine, "alice")]);
    });

    it("needs no signature on a clean merge of the default branch", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice });
        git(r.repo, "checkout", "-q", "master");
        commitAs(r, { "other.txt": "landed elsewhere" }, { as: people.bob, signed: false });
        git(r.repo, "checkout", "-q", "pr");
        git(r.repo, "-c", "user.name=x", "-c", "user.email=x@example.com", "merge", "-q", "--no-edit", "master");
        finishAs(r, people.rita);
        expect((await check(r)).self).toEqual([]);
    });

    it("asks git a fixed number of times, however many commits the change has", async () => {
        const counted = async (n) => {
            const r = repoWith();
            for (let i = 0; i < n; i++) {
                commitAs(r, { "src.txt": `code ${i}` }, { as: people.alice });
            }
            finishAs(r, people.rita);
            const run = gitIn(r.repo);
            let calls = 0;
            const result = await check(r, {
                git: (args, input) => {
                    calls++;
                    return run(args, input);
                },
            });
            expect(result.self).toEqual([]);
            return calls;
        };
        expect(await counted(1)).toBe(5);
        expect(await counted(6)).toBe(5);
    });

    it("fails closed on an e-mail that would forge the commit list", async () => {
        // The e-mail holds the separators of a one-line log: a fake merge with no files, then a made-up commit.
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice, email: "a@x\x02P1 P2\x01deadbeef", signed: false });
        finishAs(r, people.alice);
        const forged =
            "could not read who contributed to pr:7: git log of master..pr prints a commit whose e-mails do not parse";
        expect((await check(r)).self).toEqual([forged]);
        expect((await check(r, { env: GITHUB, fetchJson: github(r, {}).fetchJson })).self).toEqual([forged]);
        // A control character alone fails closed too.
        const s = repoWith();
        const code = commitAs(s, { "src.txt": "code" }, { as: people.alice, email: "a@x\x02y" });
        finishAs(s, people.rita);
        expect((await check(s)).self).toEqual([
            `could not read who contributed to pr:7: commit ${code.slice(0, 12)} carries an e-mail address holding a control character`,
        ]);
    });
});

describe("the self-approval rule on GitHub", () => {
    it("refuses by user name, whatever the e-mails", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice, signed: false });
        const mine = finishAs(r, people.alice);
        const { fetchJson } = github(r, {
            commit: () => ({
                author: { login: "Alice" },
                commit: {
                    author: { email: "1+a@users.noreply.github.com" },
                    committer: { email: "noreply@github.com" },
                    verification: { verified: true },
                },
                committer: { login: "web-flow" },
            }),
        });
        expect((await check(r, { env: GITHUB, fetchJson })).self).toEqual([refused(mine, "alice")]);
    });

    it("refuses by e-mail, when GitHub links the commit to no account", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice, signed: false });
        const mine = finishAs(r, people.alice);
        const { fetchJson } = github(r, { commit: () => ({ author: null, committer: { login: "web-flow" } }) });
        expect((await check(r, { env: GITHUB, fetchJson })).self).toEqual([refused(mine, "alice")]);
    });

    it("refuses the author's key when another account opened the pull request", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice, signed: false });
        const mine = finishAs(r, people.alice);
        const { fetchJson, asked } = github(r, { opener: "bob" });
        expect((await check(r, { env: GITHUB, fetchJson })).self).toEqual([refused(mine, "alice")]);
        expect(asked).toEqual(["pulls/7", "pulls/7/commits?per_page=100&page=1"]);
        // The opener counts too: bob opened alice's work, and bob's key is refused.
        const s = repoWith([people.alice.passkey, people.bob.passkey]);
        commitAs(s, { "src.txt": "code" }, { as: people.alice, signed: false });
        const bobs = finishAs(s, people.bob);
        expect((await check(s, { env: GITHUB, fetchJson: github(s, { opener: "bob" }).fetchJson })).self).toEqual([
            refused(bobs, "bob"),
        ]);
    });

    it("passes a seed pull request its reviewer opened, and refuses it once the reviewer adds code", async () => {
        // A seed brings no code: only Finish's own commit, so its opener contributed nothing.
        const r = repoWith();
        finishAs(r, people.rita, { seed: true });
        const opened = github(r, { opener: "rita", commit: () => ({ author: { login: "rita" } }) });
        expect(await check(r, { env: GITHUB, fetchJson: opened.fetchJson })).toEqual({ problems: [], self: [] });
        // One code commit of the reviewer's own makes the opener and that commit's people contributors.
        const seed = git(r.repo, "ls-tree", "-r", "--name-only", "pr", "--", `${APPROVALS}/`);
        commitAs(r, { "src.txt": "code" }, { as: people.rita, signed: false });
        const withCode = github(r, { opener: "rita", commit: () => ({ author: { login: "rita" } }) });
        expect((await check(r, { env: GITHUB, fetchJson: withCode.fetchJson })).self).toEqual([refused(seed, "rita")]);
    });

    it("counts a seed commit that changes a story settings file other than as Finish's exclusion does", async () => {
        const legacy = "compact-mantine/card--legacy.json";
        const seedWith = (settings) => {
            const r = repoWith();
            const bytes = `${JSON.stringify(settings, null, 2)}\n`;
            const entry = { path: legacy, from: null, to: contentHash(Buffer.from(bytes)), decision: "accept" };
            const more = { type: "seed-approval", capturedHead: git(r.repo, "rev-parse", "master") };
            const statement = sign(statementOf(r, [entry], more), people.rita.passkey);
            const file = statementPath(APPROVALS, statement);
            commitAs(
                r,
                { [`${BASELINES}/${legacy}`]: settings, [file]: statement },
                { as: people.rita, signed: false },
            );
            const opened = github(r, { opener: "rita", commit: () => ({ author: { login: "rita" } }) });
            return { file, run: () => check(r, { env: GITHUB, fetchJson: opened.fetchJson }) };
        };
        // A raised threshold is code the reviewer brings: she opened it, so her key is refused.
        const raised = seedWith({ diffThreshold: 1 });
        expect((await raised.run()).self).toEqual([refused(raised.file, "rita")]);
        // Finish's own exclusion of the story is still the tool's commit.
        expect(await seedWith({ disableSnapshot: true, reason: "noisy" }).run()).toEqual({ problems: [], self: [] });
    });

    it("reads the opener from the event payload when it is this pull request's", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice, signed: false });
        finishAs(r, people.rita);
        const event = join(tempDir("vr-event-"), "event.json");
        writeFileSync(event, JSON.stringify({ pull_request: { number: 7, user: { login: "carol" } } }));
        const { fetchJson, asked } = github(r, {});
        const env = { ...GITHUB, GITHUB_EVENT_PATH: event };
        expect((await check(r, { env, fetchJson })).self).toEqual([]);
        expect(asked).toEqual(["pulls/7/commits?per_page=100&page=1"]);
    });

    it("fails closed on a commit GitHub does not verify: someone else's e-mail with the author's signature", async () => {
        const r = repoWith();
        const code = commitAs(r, { "src.txt": "code" }, { as: people.alice, email: people.bob.email, signed: false });
        finishAs(r, people.rita);
        const { fetchJson } = github(r, {
            commit: (sha) =>
                sha === code
                    ? {
                          author: { login: "bob" },
                          committer: { login: "bob" },
                          commit: { author: {}, committer: {}, verification: { verified: false, reason: "bad_email" } },
                      }
                    : {},
        });
        expect((await check(r, { env: GITHUB, fetchJson })).self).toEqual([
            `commit ${code.slice(0, 12)} is not signed, or GitHub does not verify its signature (bad_email)`,
        ]);
    });

    it("fails closed on a counted commit in the checkout that GitHub does not list", async () => {
        const r = repoWith();
        const code = commitAs(r, { "src.txt": "code" }, { as: people.alice, signed: false });
        finishAs(r, people.rita);
        const { fetchJson: all } = github(r, {});
        const fetchJson = async (path) => {
            const got = await all(path);
            return Array.isArray(got) ? got.filter((c) => c.sha !== code) : got;
        };
        expect((await check(r, { env: GITHUB, fetchJson })).self).toEqual([
            `commit ${code.slice(0, 12)} is in this checkout but GitHub does not list it in pr:7`,
        ]);
    });

    it("lets through the merge result CI builds, though GitHub does not list it", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice, signed: false });
        finishAs(r, people.rita);
        const { fetchJson } = github(r, {});
        const prHead = git(r.repo, "rev-parse", "pr");
        git(r.repo, "checkout", "-q", "master");
        commitAs(r, { "other.txt": "landed elsewhere" }, { as: people.bob, signed: false });
        // A merge of the base and the head whose tree differs from both parents in a file of its own.
        git(r.repo, "checkout", "-q", "pr");
        git(r.repo, "-c", "user.name=x", "-c", "user.email=x@example.com", "merge", "-q", "--no-commit", "master");
        writeFileSync(join(r.repo, "src.txt"), "merged code");
        git(r.repo, "add", "-A");
        const tree = git(r.repo, "write-tree");
        const merge = git(
            r.repo,
            "-c",
            "user.name=x",
            "-c",
            "user.email=x@example.com",
            "commit-tree",
            tree,
            "-p",
            "master",
            "-p",
            prHead,
            "-m",
            "merge",
        );
        git(r.repo, "merge", "--abort");
        git(r.repo, "update-ref", "refs/heads/pr", merge);
        expect((await check(r, { env: GITHUB, fetchJson })).self).toEqual([]);
    });

    it("fails closed when GitHub cannot be asked, or lists too many commits to be sure", async () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice, signed: false });
        finishAs(r, people.rita);
        expect((await check(r, { env: GITHUB })).self).toEqual([
            "could not ask GitHub who contributed to pr:7: the gate step needs GITHUB_TOKEN (and GITHUB_REPOSITORY) to read the pull request",
        ]);
        const many = async (path) =>
            path === "pulls/7" ? { user: { login: "bob" } } : Array.from({ length: 100 }, () => ({}));
        let pages = 0;
        const counting = async (path) => {
            pages += path.includes("/commits") ? 1 : 0;
            return pages > 3 && path.includes("/commits") ? [] : many(path);
        };
        expect((await check(r, { env: GITHUB, fetchJson: counting })).self).toEqual([
            "could not ask GitHub who contributed to pr:7: #7 has 250 commits or more, and GitHub lists no more than that",
        ]);
    });
});

describe("keys, the setting and the gate command", () => {
    it("parses a passkey list without identities, and refuses a malformed identity", () => {
        const plain = makeKey();
        expect(parsePasskeys(passkeysJson(plain))).toEqual([plain.entry]);
        const list = (identity) => passkeysJson({ entry: { ...plain.entry, identity } });
        expect(parsePasskeys(list({ user: "alice" }))[0].identity).toEqual({ user: "alice" });
        expect(() => parsePasskeys(list({}))).toThrow("keys[0].identity: must name a user or an e-mail address");
        expect(() => parsePasskeys(list({ user: "a b" }))).toThrow(
            "keys[0].identity: user must be a code host user name",
        );
        expect(() => parsePasskeys(list({ emails: ["nope"] }))).toThrow("emails must be e-mail addresses");
        expect(() => parsePasskeys(list({ user: "a", signingKeys: ["-----BEGIN PGP"] }))).toThrow(
            "signingKeys must be SSH public keys",
        );
        expect(() => parsePasskeys(list({ user: "a", name: "A" }))).toThrow('unknown field "name"');
    });

    it("accepts selfApproval allow or forbid, and nothing else", () => {
        expect(normalizeConfig({ ...CONFIG, selfApproval: "forbid" }).selfApproval).toBe("forbid");
        expect(normalizeConfig({ ...CONFIG, selfApproval: "allow" }).selfApproval).toBe("allow");
        expect(normalizeConfig(CONFIG).selfApproval).toBeUndefined();
        expect(() => normalizeConfig({ ...CONFIG, selfApproval: "maybe" })).toThrow(
            'selfApproval must be "allow" or "forbid"',
        );
    });

    const GATE = fileURLToPath(new URL("../trusted/gate.mjs", import.meta.url));
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
    const run = (r) =>
        spawnSync(process.execPath, [GATE, "--captures", captures(), "--base", "master", "--head", "pr", "--pr", "7"], {
            cwd: r.repo,
            encoding: "utf8",
            env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_REPOSITORY_ID: "" },
        });

    it("passes the author's own key with the policy off, and refuses it once the base forbids it", () => {
        const off = repoWith(undefined, { repositoryId: REPO_ID, approvalFormat: "change" });
        commitAs(off, { "src.txt": "code" }, { as: people.alice });
        finishAs(off, people.alice);
        expect(run(off).status).toBe(0);

        const on = repoWith();
        commitAs(on, { "src.txt": "code" }, { as: people.alice });
        const mine = finishAs(on, people.alice);
        const out = run(on);
        expect(out.stdout).toContain(`::error::self-approval -- ${refused(mine, "alice")}`);
        expect(out.status).toBe(1);
    });

    it("takes the setting from the base only: a change cannot switch it off", () => {
        const r = repoWith();
        commitAs(r, { "src.txt": "code" }, { as: people.alice });
        const config = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
        commitAs(r, { [CONFIG_FILE]: { ...config, selfApproval: "allow" } }, { as: people.alice });
        finishAs(r, people.alice);
        expect(run(r).stdout).toContain("::error::self-approval -- ");
    });

    it("refuses a tree statement in tree mode, whose signer it cannot check", () => {
        const r = repoWith(undefined, { repositoryId: REPO_ID, approvalFormat: "tree", selfApproval: "forbid" });
        commitAs(r, { [CARD_FILE]: "new image" }, { as: people.alice });
        const tree = treeAt("HEAD", BASELINES, r.repo);
        const statement = {
            version: 1,
            commit: git(r.repo, "rev-parse", "HEAD"),
            tree,
            baselines: BASELINES,
            pr: 7,
            approvedAt: "2026-10-19T12:00:00.000Z",
        };
        commitAs(r, { [`${APPROVALS}/${tree}.json`]: sign(statement, people.rita.passkey) }, { as: people.rita });
        const out = run(r);
        expect(out.stdout).toContain("::error::self-approval -- a version 1 tree statement approves these baselines");
        expect(out.status).toBe(1);
    });
});
