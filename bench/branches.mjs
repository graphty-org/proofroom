// Measures plain git's list of changes (adapters/plain-git.mjs listChanges): one `git
// for-each-ref` over a repository with 200 branches, against its budget of 50 ms. Not published,
// not run in CI.
//
// Usage: node bench/branches.mjs [branches=200]

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { plainGitCodeHost } from "../trusted/lib/adapters/plain-git.mjs";

const n = Number(process.argv[2] ?? 200);
const repo = mkdtempSync(join(tmpdir(), "proofroom-bench-branches-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("-c", "user.name=Bench", "-c", "user.email=bench@example.com", "commit", "-q", "-m", "init");
    const tip = git("rev-parse", "HEAD");
    const refs = Array.from({ length: n }, (_, i) => `create refs/heads/feat/${i} ${tip}\n`).join("");
    execFileSync("git", ["update-ref", "--stdin"], { cwd: repo, input: refs });
    const host = plainGitCodeHost(repo, { defaultBranch: "main" });
    const config = { ignoreBranches: [] };
    await host.listChanges(config);
    const times = [];
    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const listed = await host.listChanges(config);
        times.push(performance.now() - start);
        if (listed.length !== n) {
            throw new Error(`listed ${listed.length} branches, not ${n}`);
        }
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1];
    console.log(
        `${n} branches, one git for-each-ref: median ${median.toFixed(1)} ms, worst ${times.at(-1).toFixed(1)} ms (budget 50 ms)`,
    );
} finally {
    rmSync(repo, { recursive: true, force: true });
}
