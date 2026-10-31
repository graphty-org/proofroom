/**
 * The adapters between the tool and the systems outside it, picked by name from
 * visual-review.config.json (`codeHost`, `captureStore`, `stories`, `renderer`), each defaulting
 * to today's: GitHub, GitHub Actions artifacts, Storybook and Playwright Chromium. The story
 * source and the renderer are capture's (capture/storybook.mjs, capture/chromium.mjs). The
 * interfaces are internal: nothing here is published for other implementations yet.
 */

import { ADAPTERS } from "../config.mjs";
import { githubActionsStore } from "./github-actions.mjs";
import { githubCodeHost } from "./github.mjs";
import { localFolderStore } from "./local-folder.mjs";
import { noCiStore, plainGitCodeHost } from "./plain-git.mjs";

/**
 * @typedef {object} CodeHost the code host: changes (pull requests), comments, statuses, issues
 * @property {string} name the adapter's config name
 * @property {{ hostName: string, changeNoun: string, changeTag: string, numberPrefix: string, ciName: string | null }} vocabulary
 *     the page's words for this host's changes (`ciName` null: the host has no CI)
 * @property {(config: { workflow: string, ignoreBranches?: string[] }) => Promise<object[]>} listChanges
 *     every open change, with each project's capture job when the host has it: one call per poll
 * @property {(change: any, reviewer: string | null) => Promise<object>} [describe] title, description, comments
 *     of a change, by its number (by its branch on a host whose changes have none)
 * @property {(number: number, body: string) => Promise<void>} [comment] posts the rejects
 * @property {(sha: string, status: { state: "success" | "failure" | "pending", description: string }) => Promise<void>} [setStatus]
 *     sets the commit status
 * @property {(issue: { title: string, body: string, labels: string[] }) => Promise<string>} [fileIssue]
 *     opens an issue, returning its URL
 * @property {(change: { title: string, head: string, base: string, body: string }) => Promise<string>} [openChange]
 *     opens a change, returning its URL
 * @property {(branch: string) => Promise<{ number: number, html_url: string } | null>} [openChangeOf]
 *     the open change of a branch
 * @property {(prefix: string) => Promise<{ number: number, html_url: string, branch: string }[]>} [openChangesOf] the
 *     open changes whose branch starts with `prefix`
 * @property {(number: number) => Promise<any>} [change] one change: its state, head ref and sha
 * @property {(number: number, change: { body: string }) => Promise<void>} [updateChange] rewrites its description
 * @property {(number: number) => Promise<void>} [closeChange] closes it
 * @property {() => Promise<string | null>} [whoAmI] the reviewer's login
 * @property {() => Promise<string | null>} [repositoryId] the id change statements name the repository by
 */

/**
 * @typedef {object} CaptureStore where CI's capture sets are
 * @property {string} name the adapter's config name
 * @property {(id: number) => Promise<object>} run one CI run
 * @property {(sha: string, config: { workflow: string }) => Promise<object | null>} newestRun the
 *     newest CI run of a commit
 * @property {(run: object, projects: string[]) => Promise<Record<string, any>>} jobs each project's capture job
 * @property {(run: object) => Promise<{ project: string, attempt: number, bytes: number, expired: boolean,
 *     expiresAt: string | null, ref: string }[]>} list the run's capture sets
 * @property {(run: object, projects: string[], dir: string, others?: string[], landed?: (project: string, got: any) => void,
 *     planned?: (sizes: Record<string, number>) => void, again?: boolean) => Promise<Record<string, any>>} fetch downloads each
 *     project's newest set into `dir`; `again` fetches a set the disk budget evicted again
 * @property {(run: object, project: string) => Promise<string | null>} [expiresAt] when the host deletes a set
 * @property {(project: string, dir: string, config: { workflow: string, defaultBranch: string }) =>
 *     Promise<string | null>} newestDefault the default branch's newest complete set of a project
 * @property {(runId: number, name: string, dir: string) => Promise<void>} [artifact] downloads one capture set by
 *     its artifact's name into `dir` (serve's `rolling` renders)
 * @property {(wanted: (dir: string) => boolean) => void} hurry fetches these first
 * @property {(change: { pr: number, branch: string, head: string }, what: { projects: string[], stories: string[] },
 *     config: { workflow: string }) => Promise<object>} [request] asks CI for a capture of a change (of
 *     this repository, never a fork's) at that head, returning the request `status` and `cancel` take
 * @property {(request: any, projects: string[]) => Promise<{ state: string, run: { id: number, url: string } | null,
 *     jobs: object[] }>} [status] a requested capture's state, its run, and each project's job, with
 *     the stories that failed in a job that ended
 * @property {(request: any) => Promise<boolean>} [cancel] stops a requested capture
 */

/**
 * @typedef {ReturnType<typeof localFolderStore>} LocalStore capture sets in a folder on this machine:
 *     the local previews of a change and `serve --results`. It is not a CaptureStore and the config
 *     cannot name it: it has no CI runs or jobs, and its sets are read where they are, never fetched.
 *     The server reads it beside the capture store the config names.
 */

/**
 * The code host the config names.
 * @param {{ codeHost?: string, defaultBranch: string, repositoryId?: string }} config the settings
 * @param {{ gh: (args: string[], input?: string) => Promise<string>, repo?: string }} with what it
 *     runs on: gh for GitHub, the repository for plain git
 * @returns {CodeHost} the adapter
 */
export function codeHostFor(config, { gh, repo = "." }) {
    const name = config.codeHost ?? ADAPTERS.codeHost[0];
    if (name === "github") {
        return githubCodeHost(gh);
    }
    if (name === "plain-git") {
        return plainGitCodeHost(repo, config);
    }
    throw new Error(`no code host "${name}"`);
}

/**
 * The capture store the config names; without one, GitHub Actions, or under plain git the local
 * folder (no CI).
 * @param {{ captureStore?: string, codeHost?: string }} config the settings
 * @param {{ gh: (args: string[], input?: string) => Promise<string>, keep?: string | null, warn?: (message: string) => void }} with what it runs on,
 *     and where a finished run's answers are kept (github-actions.mjs)
 * @returns {CaptureStore} the adapter
 */
export function captureStoreFor(config, { gh, keep = null, warn }) {
    const name = config.captureStore ?? (config.codeHost === "plain-git" ? "local-folder" : ADAPTERS.captureStore[0]);
    if (name === "github-actions") {
        return githubActionsStore(gh, { keep, warn });
    }
    if (name === "local-folder") {
        return noCiStore();
    }
    throw new Error(`no capture store "${name}"`);
}

/** Each adapter role's optional functions: the ones a missing button can be blamed on (Settings, Adapters). */
const OPTIONAL = {
    codeHost: ["describe", "comment", "setStatus", "fileIssue", "openChange", "whoAmI"],
    captureStore: ["request", "status", "cancel", "expiresAt"],
};

/**
 * What the page says about the adapters in use (Settings, Adapters): each one's name and the
 * optional functions it lacks, and the code host's words for its changes.
 * @param {CodeHost} host the code host
 * @param {CaptureStore} store the capture store
 * @param {{ stories?: string, renderer?: string }} config the settings
 * @returns {{ codeHost: { name: string, vocabulary: object, lacks: string[] }, captureStore: { name: string, lacks: string[] },
 *     stories: { name: string, lacks: string[] }, renderer: { name: string, lacks: string[] } }} it
 */
export function adapterFacts(host, store, config) {
    const lacks = (obj, role) => OPTIONAL[role].filter((fn) => typeof obj[fn] !== "function");
    return {
        codeHost: { name: host.name, vocabulary: host.vocabulary, lacks: lacks(host, "codeHost") },
        captureStore: { name: store.name, lacks: lacks(store, "captureStore") },
        stories: { name: config.stories ?? ADAPTERS.stories[0], lacks: [] },
        renderer: { name: config.renderer ?? ADAPTERS.renderer[0], lacks: [] },
    };
}

export { localFolderStore };
