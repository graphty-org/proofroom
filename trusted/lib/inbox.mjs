/**
 * The pending-approvals inbox and the quiet notifier.
 *
 * `inboxOf` sorts the review server's pull requests into what is waiting for the owner ("ready":
 * images to decide, or decisions not yet finished), what cannot be reviewed ("notReady": a capture
 * that failed, with its reason) and two counts (capturing, nothing to decide). The server answers
 * it on GET /api/inbox and keeps it in `<workDir>/state/inbox.json`.
 *
 * `notify` (the `visual-review notify` command) reads that file and sends one message when pull
 * requests become ready: the first at once, any more within `gap` held and sent together when the
 * gap ends, nothing when nothing is new. A pull request is announced once per head while it stays
 * ready; it can be announced again only after it left the ready list or was pushed again. It never
 * talks to GitHub and never reads a credential: the command it runs does the sending.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

// A project still being captured or downloaded, rather than one whose capture failed.
const CAPTURING = /^(waiting for CI|CI still running)/;
// A project the run did not capture at all (a pull request that does not affect it): nothing to decide.
const NONE = "no capture";
const RETRY = /[;:] reload (the page )?(to retry|in a moment|when it finishes)$/;

/**
 * The key one announcement is made for: a pull request at one captured head.
 * @param {{ pr: number, headSha: string | null }} r a ready entry
 * @returns {string} the key
 */
export const readyKey = (r) => `${r.pr}@${r.headSha ?? ""}`;

/**
 * Where a ready pull request's images come from.
 * @param {number} previews how many of its loaded projects are local previews
 * @param {number} loaded how many projects are loaded
 * @returns {string} "CI", "local preview" or both
 */
function sourceOf(previews, loaded) {
    if (previews === 0) {
        return "CI";
    }
    return previews === loaded ? "local preview" : "local preview and CI";
}

/**
 * Sorts the pull requests the server lists into the inbox.
 * @param {object[]} targets the server's target summaries (GET /api/prs)
 * @param {{ now: number, since?: Map<string, number> }} at the time, and when each ready entry
 *     (by readyKey) entered the ready list before
 * @returns {{ ready: object[], notReady: object[], capturing: number, done: number }} the inbox;
 *     `ready` complete ones first, then fewest undecided images, then longest waiting
 */
export function inboxOf(targets, { now, since = new Map() }) {
    const inbox = { ready: [], notReady: [], capturing: 0, done: 0 };
    for (const t of targets) {
        if (t.pr === null || t.local) {
            continue;
        }
        const failed = t.projects.find(
            (p) => !p.downloading && p.problem && p.problem !== NONE && !CAPTURING.test(p.problem),
        );
        const loaded = t.projects.filter((p) => !p.downloading && (!p.problem || p.problem === NONE));
        const undecided = loaded.reduce((n, p) => n + p.undecided, 0);
        const about = { id: t.id, pr: t.pr, title: t.title, url: t.url, headSha: t.headSha };
        if (failed) {
            inbox.notReady.push({
                ...about,
                project: failed.project,
                reason: failed.problem.replace(RETRY, ""),
                retry: RETRY.test(failed.problem),
                logUrl: failed.logUrl ?? null,
            });
        } else if (undecided > 0 || t.unpublished > 0) {
            const previews = loaded.filter((p) => p.preview).length;
            const key = readyKey({ pr: t.pr, headSha: t.headSha });
            inbox.ready.push({
                ...about,
                undecided,
                unpublished: t.unpublished,
                loaded: loaded.length,
                total: t.projects.length,
                complete: loaded.length === t.projects.length,
                source: sourceOf(previews, loaded.length),
                since: since.get(key) ?? now,
            });
        } else if (loaded.length < t.projects.length) {
            inbox.capturing++;
        } else {
            inbox.done++;
        }
    }
    inbox.ready.sort((a, b) => b.complete - a.complete || a.undecided - b.undecided || a.since - b.since);
    return inbox;
}

/**
 * One step of the notifier: which ready pull requests to announce now, and the state after.
 * @param {{ notified: string[], lastAt: number }} state what was announced, and when last
 * @param {{ ready: object[] }} inbox the server's inbox
 * @param {number} now the time
 * @param {number} gap the least time between two messages
 * @returns {{ state: { notified: string[], lastAt: number }, fresh: object[] }} the state to keep,
 *     and the entries to announce (none: send nothing)
 */
export function notifyStep(state, inbox, now, gap) {
    const ready = inbox.ready.filter((r) => r.complete && r.undecided > 0);
    const keys = new Set(ready.map(readyKey));
    // A pull request that left the list may be announced again when it comes back.
    const notified = state.notified.filter((k) => keys.has(k));
    const fresh = ready.filter((r) => !notified.includes(readyKey(r)));
    if (fresh.length === 0 || now - state.lastAt < gap) {
        return { state: { ...state, notified }, fresh: [] };
    }
    return { state: { notified: [...notified, ...fresh.map(readyKey)], lastAt: now }, fresh };
}

/**
 * The message announcing ready pull requests: a title, one line each, and the inbox's address.
 * @param {object[]} fresh the entries, fewest images first
 * @param {string} url the inbox's address, without the session token
 * @returns {{ title: string, message: string }} the message
 */
export function message(fresh, url) {
    const lines = fresh.map((r) => `#${r.pr} ${r.title}: ${r.undecided} image${r.undecided === 1 ? "" : "s"}`);
    return { title: `Visual review: ${fresh.length} ready`, message: [...lines, url].join("\n") };
}

/**
 * Writes a JSON file through a sibling renamed into place.
 * @param {string} file the file
 * @param {unknown} value what to write
 */
export function writeJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${file}.tmp`, file);
}

const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
};

/**
 * Reads the server's inbox file and announces what became ready, by running `command` (an argv
 * whose `{title}`, `{message}` and `{url}` are replaced; no shell). An inbox older than `stale`
 * (the server stopped) changes nothing.
 * @param {{ stateDir: string, command: string[], now?: number, gap?: number, stale?: number }} o where
 *     the server keeps its state, the command, the time, the least time between two messages, and
 *     the age past which the inbox is ignored
 * @returns {Promise<object[]>} the entries announced
 */
export async function notifyOnce({ stateDir, command, now = Date.now(), gap = 10 * 60000, stale = 10 * 60000 }) {
    const inbox = readJson(join(stateDir, "inbox.json"));
    if (!inbox || !Array.isArray(inbox.ready) || now - inbox.at > stale) {
        return [];
    }
    const file = join(stateDir, "notify.json");
    const before = readJson(file) ?? { notified: [], lastAt: 0 };
    const { state, fresh } = notifyStep(before, inbox, now, gap);
    if (fresh.length > 0) {
        const url = `${inbox.origin}/`;
        const m = { ...message(fresh, url), url };
        const [program, ...args] = command.map((a) => a.replaceAll(/\{(title|message|url)\}/g, (_, k) => m[k]));
        // Kept as sent only once the command succeeded, so a failed send is tried again next time.
        await promisify(execFile)(program, args, { timeout: 60000 });
    }
    if (JSON.stringify(state) !== JSON.stringify(before)) {
        writeJson(file, state);
    }
    return fresh;
}
