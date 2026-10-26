/**
 * The environment every test that runs git -- directly, or through a script or a CLI under test --
 * must give it. Without it git reads the developer's own ~/.gitconfig: with commit.gpgsign=true
 * there, a test's throwaway `git commit` asks gpg-agent for a passphrase on the owner's terminal
 * in the middle of a test run.
 *
 * The global config is a temporary file holding an identity, not /dev/null, so a commit works
 * without one. Signing stays at git's default, off, because nothing sets it; a test that turns
 * signing on in its own repository (the accept and serve tests do) still can, which a
 * command-line override would prevent. The system config is skipped. Only the
 * variables a git hook exports are dropped (GIT_DIR and friends point git at the real repository
 * even from a temporary directory); every other GIT_* variable, such as a GIT_CONFIG_COUNT
 * override the caller's environment sets, is kept.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// No automatic maintenance or gc: after every fetch and push they spawn more git processes, which
// only cost a short-lived test repository time.
const CONFIG = "[user]\n\tname = t\n\temail = t@t\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n";

// What git exports to a hook, and what would aim a test's git at the repository the hook runs in.
const HOOK_VARS = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

let globalConfig;

/**
 * The environment to hand a git process (or a script that runs git) that a test starts.
 * @param [env] the environment to start from
 * @returns a copy of `env` with no hook variables and git's config isolated
 */
export function isolatedGitEnv(env = process.env) {
    if (!globalConfig) {
        // One made by a parent process (vitest's main process, before its workers start) is used
        // as it is: a worker that made its own per test file left one directory behind per file.
        const inherited = process.env.GIT_CONFIG_GLOBAL;
        if (inherited && basename(dirname(inherited)).startsWith("test-git-") && existsSync(inherited)) {
            globalConfig = inherited;
        } else {
            const dir = mkdtempSync(join(tmpdir(), "test-git-"));
            globalConfig = join(dir, "gitconfig");
            writeFileSync(globalConfig, CONFIG);
            process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
        }
    }
    const kept = Object.entries(env).filter(([k]) => !HOOK_VARS.includes(k));
    return { ...Object.fromEntries(kept), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
}

/** Isolates git for this whole process: every child process started afterwards inherits it. */
export function isolateGit() {
    for (const k of HOOK_VARS) delete process.env[k];
    Object.assign(process.env, isolatedGitEnv());
}
