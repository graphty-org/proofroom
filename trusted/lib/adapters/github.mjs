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
        // The newest pull request of a branch of this repository in any state, or null; throws when
        // GitHub cannot say.
        async changeOf(branch) {
            const list = JSON.parse(await gh(["api", `repos/{owner}/{repo}/pulls?state=all&head={owner}:${branch}`]));
            const p = list.find((x) => x.head?.ref === branch);
            return p ? { number: p.number, html_url: p.html_url, state: p.state, merged: Boolean(p.merged_at) } : null;
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
