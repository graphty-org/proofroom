/**
 * The plain git code host, for a repository with no GitHub: its branches, local and remote, are
 * the changes, each named by its branch; the author of a branch is its last committer. It has no
 * CI, so every capture is made on this machine, and nothing to post to: Finish writes the rejects
 * to `visual-review-rejects/<branch>.md` on the branch (accept.mjs), sets no commit status and opens
 * nothing. The functions it lacks are the CodeHost's optional ones the page hides buttons for.
 */

import { exec } from "../github.mjs";

/** The words the page uses for a plain git repository's changes: there is no number and no CI. */
export const PLAIN_GIT_VOCABULARY = Object.freeze({
    hostName: "git",
    changeNoun: "branch",
    changeTag: "branch",
    numberPrefix: "",
    ciName: null,
});

/** Where Finish writes a branch's rejects, from the repository's root. */
export const REJECTS_DIR = "visual-review-rejects";

/**
 * The file a branch's rejects are written to: the branch name with every run of other characters
 * than letters, digits, dot, underscore and dash made one dash.
 * @param {string} branch the branch
 * @returns {string} the path, from the repository's root
 */
export const rejectsFile = (branch) => `${REJECTS_DIR}/${branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-")}.md`;

// One line per ref: its kind and name, then its commit, committer, date and subject. The subject
// is last, so a tab in it cannot shift the fields before it.
const FORMAT = "%(refname)%09%(objectname)%09%(committername)%09%(committerdate:iso-strict)%09%(subject)";

/**
 * The plain git code host of a repository.
 * @param {string} repo the repository
 * @param {{ defaultBranch: string, repositoryId?: string }} config the settings
 * @param {{ git?: (args: string[]) => Promise<string> }} [with] the git runner (tests count its calls)
 * @returns {import("./index.mjs").CodeHost} the adapter
 */
export function plainGitCodeHost(repo, config, { git = (args) => exec("git", args, { cwd: repo }) } = {}) {
    return {
        name: "plain-git",
        vocabulary: PLAIN_GIT_VOCABULARY,
        // Every branch but the default one and the ignored ones, in one `git for-each-ref`: a local
        // branch, or a remote one this repository has no local branch of (`remote` names it).
        async listChanges({ ignoreBranches = [] }) {
            const out = await git(["for-each-ref", `--format=${FORMAT}`, "refs/heads/", "refs/remotes/"]);
            const local = new Map();
            const remote = new Map();
            for (const line of out.split("\n").filter(Boolean)) {
                const [ref, headSha, author, updatedAt, ...subject] = line.split("\t");
                const isLocal = ref.startsWith("refs/heads/");
                const name = ref.slice(isLocal ? "refs/heads/".length : "refs/remotes/".length);
                // A remote branch is <remote>/<branch>; <remote>/HEAD only points at one of them.
                const branch = isLocal ? name : name.slice(name.indexOf("/") + 1);
                if (
                    branch === "HEAD" ||
                    branch === config.defaultBranch ||
                    ignoreBranches.some((prefix) => branch.startsWith(prefix))
                ) {
                    continue;
                }
                const change = {
                    number: null,
                    id: `branch:${branch}`,
                    title: subject.join("\t"),
                    url: null,
                    headSha,
                    branch,
                    draft: false,
                    author: author || null,
                    updatedAt,
                    run: null,
                    visual: null,
                    remote: isLocal ? null : name,
                };
                if (isLocal) {
                    local.set(branch, change);
                } else if (!remote.has(branch)) {
                    remote.set(branch, change);
                }
            }
            return [...local.values(), ...[...remote.values()].filter((c) => !local.has(c.branch))];
        },
        // About this change: the branch's last commit message.
        async describe(branch) {
            const [title, ...body] = (await git(["log", "-1", "--format=%s%n%b", `refs/heads/${branch}`])).split("\n");
            return { title, body: body.join("\n").trim(), author: null, owner: null, createdAt: null, comments: [] };
        },
        whoAmI: async () => (await git(["config", "user.name"]).catch(() => "")) || null,
        repositoryId: async () => config.repositoryId ?? null,
    };
}

/**
 * The capture store of a repository with no CI: it holds no runs, so every capture set is one made
 * on this machine, which the server reads from its previews folder (local-folder.mjs).
 * @returns {import("./index.mjs").CaptureStore} the adapter
 */
export function noCiStore() {
    return {
        name: "local-folder",
        run: async (id) => {
            throw new Error(`there is no CI here, so no run ${id}`);
        },
        newestRun: async () => null,
        jobs: async () => ({}),
        list: async () => [],
        fetch: async () => ({}),
        newestDefault: async () => null,
        hurry: () => {},
    };
}
