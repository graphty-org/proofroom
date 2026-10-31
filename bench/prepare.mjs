// Measures a Finish's preparation (accept.mjs prepareApproval: the accept commit the owner's passkey
// signs) on a repository shaped like graphty-monorepo's nightly candidate: 30,000 other files,
// 2,500 baselines stored in Git LFS, and a pull request's capture of 1,749 changed images, every
// one accepted. Not published, not run in CI.
//
// Usage: node bench/prepare.mjs [images=1749] [files=30000] [baselines=2500]

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { prepareApproval } from "../trusted/lib/accept.mjs";
import { CONFIG_FILE, normalizeConfig } from "../trusted/lib/config.mjs";

const [images, files, baselines] = [1749, 30000, 2500].map((d, i) => Number(process.argv[2 + i] ?? d));
const ROOT = fileURLToPath(new URL("../test/fixtures/repo/", import.meta.url));
const configText = readFileSync(join(ROOT, CONFIG_FILE), "utf8");
const config = normalizeConfig(JSON.parse(configText));
const attributes = readFileSync(join(ROOT, "gitattributes"), "utf8");

// No global or system git config: only what the repository sets.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const dir = mkdtempSync(join(tmpdir(), "proofroom-bench-prepare-"));
const repo = join(dir, "repo");
const remote = join(dir, "remote.git");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const put = (path, data) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, data);
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
const pointer = (oid, size) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

try {
    git(dir, "init", "-q", "--bare", "-b", "master", remote);
    git(dir, "init", "-q", "-b", "master", repo);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "config", "user.name", "Bench");
    git(repo, "config", "user.email", "bench@example.com");
    git(repo, "config", "core.hooksPath", "/dev/null");
    git(repo, "lfs", "install", "--local", "--skip-repo");
    put(join(repo, ".gitattributes"), attributes);
    put(join(repo, CONFIG_FILE), `${JSON.stringify({ ...JSON.parse(configText), approvalFormat: "tree" }, null, 4)}\n`);
    for (let i = 0; i < files; i++) {
        put(join(repo, `src/pkg${i % 40}/dir${i % 300}/file${i}.ts`), `export const v${i} = ${i};\n`);
    }
    const project = "graphty-element";
    const captured = join(dir, "capture", project);
    const items = [];
    for (let i = 0; i < baselines; i++) {
        const file = `story-${i}--default.png`;
        const old = randomBytes(64);
        put(join(repo, config.baselines, project, file), pointer(sha(old), 100000));
        if (i < images) {
            const bytes = randomBytes(100000);
            put(join(captured, file), bytes);
            items.push({
                id: `story-${i}--default`,
                mode: null,
                file,
                status: "changed",
                baseline: sha(old),
                capture: sha(bytes),
            });
        }
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "master");
    git(repo, "checkout", "-q", "-b", "feature");
    put(join(repo, "src.txt"), "feature\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "push", "-q", "origin", "feature");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "master");
    const results = {
        version: 1,
        project,
        commit: head,
        headSha: head,
        pr: 123,
        runId: 1000,
        runAttempt: 1,
        local: null,
        environment: { chromium: "bench" },
        items,
    };
    const decisions = items.map((i) => ({ project, file: i.file, decision: "accept", reason: null }));
    const t0 = performance.now();
    const out = await prepareApproval({
        repo,
        target: { pr: 123, branch: "feature" },
        projects: { [project]: { dir: captured, results } },
        decisions,
        now: new Date(),
        config,
    });
    const ms = performance.now() - t0;
    console.log(
        `prepareApproval: ${images} accepted images, ${files} other files, ${baselines} baselines: ` +
            `${(ms / 1000).toFixed(2)} s (commit ${out.commit.slice(0, 10)})`,
    );
} finally {
    rmSync(dir, { recursive: true, force: true });
}
