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

/**
 * @typedef {object} CodeHost the code host: changes (pull requests), comments, statuses, issues
 * @property {string} name the adapter's config name
 * @property {{ hostName: string, changeNoun: string, changeTag: string, numberPrefix: string, ciName: string }} vocabulary
 *     the page's words for this host's changes
 * @property {(config: { workflow: string, ignoreBranches?: string[] }) => Promise<object[]>} listChanges
 *     every open change, with each project's capture job when the host has it: one call per poll
 * @property {(number: number, reviewer: string | null) => Promise<object>} [describe] title, description, comments
 * @property {(number: number, body: string) => Promise<void>} [comment] posts the rejects
 * @property {(sha: string, status: { state: "success" | "failure" | "pending", description: string }) => Promise<void>} [setStatus]
 *     sets the commit status
 * @property {(issue: { title: string, body: string, labels: string[] }) => Promise<string>} [fileIssue]
 *     opens an issue, returning its URL
 * @property {(change: { title: string, head: string, base: string, body: string }) => Promise<string>} [openChange]
 *     opens a change, returning its URL
 * @property {(branch: string) => Promise<{ number: number, html_url: string } | null>} [openChangeOf]
 *     the open change of a branch
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
 * @property {(wanted: (dir: string) => boolean) => void} hurry fetches these first
 */

/**
 * @typedef {ReturnType<typeof localFolderStore>} LocalStore capture sets in a folder on this machine:
 *     the local previews of a change and `serve --results`. It is not a CaptureStore and the config
 *     cannot name it: it has no CI runs or jobs, and its sets are read where they are, never fetched.
 *     The server reads it beside the capture store the config names.
 */

/**
 * The code host the config names.
 * @param {{ codeHost?: string }} config the settings
 * @param {{ gh: (args: string[], input?: string) => Promise<string> }} with what it runs on
 * @returns {CodeHost} the adapter
 */
export function codeHostFor(config, { gh }) {
    const name = config.codeHost ?? ADAPTERS.codeHost[0];
    if (name === "github") {
        return githubCodeHost(gh);
    }
    throw new Error(`no code host "${name}"`);
}

/**
 * The capture store the config names.
 * @param {{ captureStore?: string }} config the settings
 * @param {{ gh: (args: string[], input?: string) => Promise<string>, keep?: string | null, warn?: (message: string) => void }} with what it runs on,
 *     and where a finished run's answers are kept (github-actions.mjs)
 * @returns {CaptureStore} the adapter
 */
export function captureStoreFor(config, { gh, keep = null, warn }) {
    const name = config.captureStore ?? ADAPTERS.captureStore[0];
    if (name === "github-actions") {
        return githubActionsStore(gh, { keep, warn });
    }
    throw new Error(`no capture store "${name}"`);
}

export { localFolderStore };
