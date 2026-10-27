/**
 * The GitHub code host: pull requests, their descriptions and comments, commit statuses, issues
 * and the reviewer's login, through the `gh` CLI (github.mjs). Every gh call the review page and
 * Finish make about changes goes through this object; the capture store's are in
 * github-actions.mjs.
 */

import {
    commentOnPullRequest,
    createIssue,
    createPullRequest,
    openPullRequests,
    postStatus,
    pullRequestContext,
    repositoryNumber,
    reviewerLogin,
} from "../github.mjs";

/** The words the page uses for this host's changes. */
export const GITHUB_VOCABULARY = Object.freeze({
    hostName: "GitHub",
    changeNoun: "pull request",
    changeTag: "PR",
    numberPrefix: "#",
    ciName: "CI",
});

/**
 * The GitHub code host over a gh runner.
 * @param {(args: string[], input?: string) => Promise<string>} gh the gh runner
 * @returns {import("./index.mjs").CodeHost} the adapter
 */
export function githubCodeHost(gh) {
    return {
        name: "github",
        vocabulary: GITHUB_VOCABULARY,
        listChanges: (config) => openPullRequests(gh, config),
        describe: (number, reviewer) => pullRequestContext(gh, number, reviewer),
        comment: (number, body) => commentOnPullRequest(gh, number, body),
        setStatus: (sha, status) => postStatus(gh, sha, status),
        fileIssue: (issue) => createIssue(gh, issue),
        openChange: (change) => createPullRequest(gh, change),
        // The open pull request of a branch of this repository, or null; throws when GitHub cannot say.
        async openChangeOf(branch) {
            const list = JSON.parse(await gh(["api", `repos/{owner}/{repo}/pulls?state=open&head={owner}:${branch}`]));
            const open = list.find((p) => p.head?.ref === branch);
            return open ? { number: open.number, html_url: open.html_url } : null;
        },
        // Every closed, unmerged pull request of this repository whose branch starts with `prefix`,
        // whether or not the branch still exists (GitHub keeps refs/pull/N/head); throws when
        // GitHub cannot say.
        // Newest updated first, stopping at the first one not updated since `since` (when given).
        async closedChanges(prefix, { since = null } = {}) {
            const out = [];
            for (let page = 1; ; page++) {
                const list = JSON.parse(
                    await gh([
                        "api",
                        `repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
                    ]),
                );
                for (const p of list) {
                    if (since !== null && p.updated_at < since) {
                        return out;
                    }
                    const own = p.head?.repo?.id !== undefined && p.head?.repo?.id === p.base?.repo?.id;
                    if (!p.merged_at && own && p.head.ref.startsWith(prefix)) {
                        out.push({ number: p.number, url: p.html_url, branch: p.head.ref });
                    }
                }
                if (list.length < 100) {
                    return out;
                }
            }
        },
        // One pull request as REST answers it: state, head ref and sha.
        change: async (number) => JSON.parse(await gh(["api", `repos/{owner}/{repo}/pulls/${number}`])),
        async updateChange(number, { body }) {
            await gh(
                ["api", "-X", "PATCH", `repos/{owner}/{repo}/pulls/${number}`, "--input", "-"],
                JSON.stringify({ body }),
            );
        },
        async closeChange(number) {
            await gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/pulls/${number}`, "-f", "state=closed"]);
        },
        async reopenChange(number) {
            await gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/pulls/${number}`, "-f", "state=open"]);
        },
        whoAmI: () => reviewerLogin(gh),
        // What change statements name this repository by (gate.mjs repositoryOf); null when unknown.
        repositoryId: async () => {
            const id = await repositoryNumber(gh);
            return id === null ? null : `github:${id}`;
        },
    };
}
