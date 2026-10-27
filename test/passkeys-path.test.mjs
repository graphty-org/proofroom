/*
 * The passkey list has one place, `visual-review/passkeys.json`, and no setting moves it: the gate
 * and the review server read keys from that path only, a key file anywhere else (or a config that
 * names another path) is never read, and no module of the package names another path.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { approvalKeys } from "../trusted/gate.mjs";
import { PASSKEYS_FILE } from "../trusted/lib/approval.mjs";
import { CONFIG_FILE, normalizeConfig } from "../trusted/lib/config.mjs";
import { startApp } from "./faults.mjs";
import { onePrFakes } from "./fakes/adapters.mjs";
import { git, isolateGit, makeRepo, tempDir } from "./helpers.mjs";
import { makeKey, passkeysJson } from "./passkey-vectors.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = makeKey();
// Places a key file could be put by mistake, or by a config that names it.
const ELSEWHERE = ["passkeys.json", "keys/passkeys.json", "visual-baselines/passkeys.json"];

/**
 * Commits files on the repository's current branch.
 * @param {string} repo the repository
 * @param {Record<string, string>} files contents by path
 */
function commit(repo, files) {
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), text);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "files");
}

/**
 * The repository's config with a `passkeys` key naming another path.
 * @param {string} repo the repository
 * @returns {string} the config, as JSON
 */
const configNaming = (repo) =>
    JSON.stringify({ ...JSON.parse(readFileSync(join(repo, CONFIG_FILE), "utf8")), passkeys: "keys/passkeys.json" });

describe("the passkey list's path", () => {
    it("is visual-review/passkeys.json, and a config cannot name another", () => {
        expect(PASSKEYS_FILE).toBe("visual-review/passkeys.json");
        const config = normalizeConfig({
            defaultBranch: "main",
            projects: { web: { storybook: "web" } },
            passkeys: "keys/passkeys.json",
        });
        expect(Object.values(config)).not.toContain("keys/passkeys.json");
    });

    it("is the only place the gate reads keys from", () => {
        isolateGit();
        const r = makeRepo();
        commit(r.repo, {
            ...Object.fromEntries(ELSEWHERE.map((p) => [p, passkeysJson(KEY)])),
            [CONFIG_FILE]: configNaming(r.repo),
        });
        expect(approvalKeys("HEAD", "HEAD", r.repo)).toEqual({ keys: null, problems: [] });
        commit(r.repo, { [PASSKEYS_FILE]: passkeysJson(KEY) });
        expect(approvalKeys("HEAD", "HEAD", r.repo)).toEqual({ keys: [KEY.entry], problems: [] });
    });

    it("is the only place the review server reads the default branch's keys from", async () => {
        isolateGit();
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        const r = makeRepo();
        const s = await startApp(r, { ...onePrFakes()(r), token: "p".repeat(43) });
        try {
            const push = (files) => {
                const clone = tempDir("vr-keys-");
                git(clone, "clone", "-q", "-b", "master", r.remote, ".");
                commit(clone, files);
                git(clone, "push", "-q", "origin", "master");
            };
            push({
                ...Object.fromEntries(ELSEWHERE.map((p) => [p, passkeysJson(KEY)])),
                [CONFIG_FILE]: configNaming(r.repo),
            });
            await s.api("GET", "/api/prs");
            expect((await s.api("GET", "/api/passkeys")).body).toMatchObject({ keys: [], required: false });
            push({ [PASSKEYS_FILE]: passkeysJson(KEY) });
            await s.api("GET", "/api/prs");
            expect((await s.api("GET", "/api/passkeys")).body.keys.map((k) => k.id)).toEqual([KEY.entry.id]);
        } finally {
            await s.close();
            out.mockRestore();
        }
    });

    it("is named by no module of the package but the one that defines it", () => {
        const files = (dir) =>
            readdirSync(join(ROOT, dir), { recursive: true })
                .map(String)
                .filter((f) => /\.(m?js)$/.test(f) && !f.startsWith("vendor"))
                .map((f) => join(dir, f));
        // A path to a passkeys file in code (not in a comment or a sentence shown to a reader).
        const named = [];
        for (const file of [...files("trusted"), ...files("capture")]) {
            const code = readFileSync(join(ROOT, file), "utf8")
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/^\s*\/\/.*$/gm, "");
            for (const m of code.matchAll(/["'`]([\w./-]*passkeys\.json)["'`]/g)) {
                named.push(`${file}: ${m[1]}`);
            }
        }
        expect(named).toEqual(["trusted/lib/approval.mjs: visual-review/passkeys.json"]);
    });
});
