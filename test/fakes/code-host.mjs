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
 * @returns {import("../../trusted/lib/adapters/index.mjs").CodeHost & { calls: string[], posted: object[],
 *     opened: { number: number, html_url: string, branch: string, state: string, body: string }[] }}
 *     the adapter, with every call by name, every write, and the changes it opened
 */
export function fakeCodeHost({ changes = [], login = "owner", repositoryId = "fake:1" } = {}) {
    const calls = [];
    const posted = [];
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
        listChanges: call("listChanges", () => structuredClone(changes)),
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
            opened.push({ number, html_url, branch: head, state: "open", body });
            posted.push({ kind: "change", title, head, base, body });
            return html_url;
        }),
        openChangeOf: call("openChangeOf", (branch) => {
            const o = opened.find((x) => x.branch === branch && x.state === "open");
            return o ? { number: o.number, html_url: o.html_url } : null;
        }),
        change: call("change", (number) => {
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
                o.state = "closed";
            }
        }),
        whoAmI: call("whoAmI", () => login),
        repositoryId: call("repositoryId", () => repositoryId),
    };
}
