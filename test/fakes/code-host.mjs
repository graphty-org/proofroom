/*
 * An in-memory code host with the GitHub adapter's functions: its changes are plain objects, and
 * every call and every write is recorded, so a test asserts what the server or Finish asked and
 * posted without a gh runner.
 */

import { GITHUB_VOCABULARY } from "../../trusted/lib/adapters/github.mjs";

/**
 * The fake code host.
 * @param {object} [state] what it holds
 * @param {object[]} [state.changes] the open changes, as listChanges returns them
 * @param {string | null} [state.login] whoAmI's answer
 * @param {string | null} [state.repositoryId] repositoryId's answer
 * @param {object[]} [state.posted] receives every write
 * @param {boolean} [state.listOpened] listChanges and change also answer for the changes it opened,
 *     as a real code host does
 * @param {(branch: string) => string} [state.headOf] a branch's tip on the remote: an opened change's
 *     head follows it while the change is open and stays where it was when it was closed, as
 *     GitHub's refs/pull/N/head does; reopening one whose branch is gone throws
 * @returns {import("../../trusted/lib/adapters/index.mjs").CodeHost & { calls: string[], posted: object[],
 *     opened: { number: number, html_url: string, branch: string, state: string, body: string }[] }}
 *     the adapter, with every call by name, every write, and the changes it opened
 */
export function fakeCodeHost({
    changes = [],
    login = "owner",
    repositoryId = "fake:1",
    posted = [],
    listOpened = false,
    headOf = null,
} = {}) {
    const tip = (branch) => {
        try {
            return headOf?.(branch);
        } catch {
            return undefined;
        }
    };
    const calls = [];
    const opened = [];
    const call =
        (name, fn) =>
        async (...args) => {
            calls.push(name);
            return fn(...args);
        };
    return {
        name: "fake",
        vocabulary: GITHUB_VOCABULARY,
        calls,
        posted,
        opened,
        listChanges: call("listChanges", (config = {}) =>
            [
                ...structuredClone(changes),
                ...(listOpened ? opened : [])
                    .filter((o) => o.state === "open")
                    .map((o) => ({ number: o.number, url: o.html_url, branch: o.branch, fork: false })),
            ].filter((c) => !(config.ignoreBranches ?? []).some((prefix) => c.branch?.startsWith(prefix))),
        ),
        describe: call("describe", (number) => {
            const c = changes.find((x) => x.number === number);
            return {
                title: c?.title ?? "",
                body: "",
                author: c?.author ?? null,
                owner: login,
                createdAt: null,
                comments: [],
            };
        }),
        comment: call("comment", (number, body) => void posted.push({ kind: "comment", number, body })),
        setStatus: call("setStatus", (sha, status) => void posted.push({ kind: "status", sha, ...status })),
        fileIssue: call("fileIssue", (issue) => {
            posted.push({ kind: "issue", ...issue });
            return `https://fake/issues/${posted.length}`;
        }),
        openChange: call("openChange", ({ title, head, base, body }) => {
            const number = 900 + opened.length;
            const html_url = `https://fake/changes/${number}`;
            opened.push({ number, html_url, branch: head, base, state: "open", body });
            posted.push({ kind: "change", title, head, base, body });
            return html_url;
        }),
        openChangeOf: call("openChangeOf", (branch) => {
            const o = opened.find((x) => x.branch === branch && x.state === "open");
            return o ? { number: o.number, html_url: o.html_url } : null;
        }),
        closedChanges: call("closedChanges", (prefix) =>
            opened
                .filter((x) => x.state === "closed" && x.merged !== true && x.branch.startsWith(prefix))
                .map((x) => ({ number: x.number, url: x.html_url, branch: x.branch })),
        ),
        change: call("change", (number) => {
            const o = listOpened ? opened.find((x) => x.number === number) : undefined;
            if (o) {
                const repo = { id: 1 };
                const sha = o.state === "open" ? tip(o.branch) : o.head;
                return {
                    number,
                    html_url: o.html_url,
                    state: o.state,
                    merged: o.merged === true,
                    head: { ref: o.branch, sha, repo },
                    base: { repo },
                };
            }
            const c = changes.find((x) => x.number === number);
            return c ? { number, state: "open", head: { ref: c.branch, sha: c.headSha } } : { number, state: "closed" };
        }),
        updateChange: call("updateChange", (number, { body }) => {
            posted.push({ kind: "update", number, body });
            const o = opened.find((x) => x.number === number);
            if (o) {
                o.body = body;
            }
        }),
        closeChange: call("closeChange", (number) => {
            posted.push({ kind: "close", number });
            const o = opened.find((x) => x.number === number);
            if (o) {
                if (o.state === "open") {
                    o.head = tip(o.branch);
                }
                o.state = "closed";
            }
        }),
        reopenChange: call("reopenChange", (number) => {
            posted.push({ kind: "reopen", number });
            const o = opened.find((x) => x.number === number);
            if (o) {
                if (headOf && tip(o.branch) === undefined) {
                    throw new Error("the head branch is gone");
                }
                if (o.merged) {
                    throw new Error("a merged pull request cannot be reopened");
                }
                // As GitHub: one open pull request per head and base (a missing base matches any).
                const same = (x) =>
                    x !== o &&
                    x.branch === o.branch &&
                    (x.base === undefined || o.base === undefined || x.base === o.base);
                if (opened.some((x) => x.state === "open" && same(x)) || changes.some(same)) {
                    throw new Error("a pull request already exists for this head and base");
                }
                o.state = "open";
            }
        }),
        whoAmI: call("whoAmI", () => login),
        repositoryId: call("repositoryId", () => repositoryId),
    };
}
