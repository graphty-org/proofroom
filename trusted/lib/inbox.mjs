/**
 * The pending-approvals inbox and the quiet notifier.
 *
 * `inboxOf` sorts the review server's pull requests into what is waiting for the owner ("ready":
 * images to decide, or decisions not yet finished), what cannot be reviewed ("notReady": a capture
 * that failed, or a capture with a story that failed, with its reason) and two counts (capturing, nothing to decide). The server answers
 * it on GET /api/inbox and keeps it in `<workDir>/state/inbox.json`.
 *
 * `coupledGroups` finds the pull requests that change the same baseline files: they conflict when
 * the first of them merges, so the inbox shows them as one group, in the order to merge them, with
 * how many images the group holds once the ones shared by the same image are counted once, and,
 * when they all touch one package and none is breaking, a suggestion to fold them into the first.
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
 * @param {{ now: number, since?: Map<string, number>, coupling?: Map<string, { paths: string[],
 *     images: string[], packages: string[] | null }> }} at the time, when each ready entry (by
 *     readyKey) entered the ready list before, and what each pull request changes (coupledGroups)
 * @returns {{ ready: object[], notReady: object[], capturing: number, done: number,
 *     groups: ReturnType<typeof coupledGroups> }} the inbox; `ready` complete ones first, then
 *     fewest undecided images, then longest waiting; `groups` those with a member listed
 */
export function inboxOf(targets, { now, since = new Map(), coupling = new Map() }) {
    const inbox = { ready: [], notReady: [], capturing: 0, done: 0, groups: [] };
    for (const t of targets) {
        if (t.pr === null || t.local) {
            continue;
        }
        const failed = t.projects.find(
            (p) => !p.downloading && p.problem && p.problem !== NONE && !CAPTURING.test(p.problem),
        );
        const loaded = t.projects.filter((p) => !p.downloading && (!p.problem || p.problem === NONE));
        const undecided = loaded.reduce((n, p) => n + p.undecided, 0);
        // A story whose capture failed: never sent for review until it is fixed, whatever else waits.
        const failedStory = loaded.find((p) => p.failed?.length > 0);
        const about = { id: t.id, pr: t.pr, title: t.title, url: t.url, headSha: t.headSha };
        if (failed) {
            inbox.notReady.push({
                ...about,
                project: failed.project,
                reason: failed.problem.replace(RETRY, ""),
                retry: RETRY.test(failed.problem),
                logUrl: failed.logUrl ?? null,
            });
        } else if (failedStory) {
            const [first, ...more] = failedStory.failed;
            const story = first.mode ? `${first.id} (${first.mode})` : first.id;
            inbox.notReady.push({
                ...about,
                project: failedStory.project,
                story: first.id,
                reason:
                    `capture failed: ${story}: ${first.reason ?? "no reason given"}` +
                    (more.length > 0 ? ` (and ${more.length} more)` : ""),
                retry: false,
                logUrl: failedStory.logUrl ?? null,
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
    const listed = new Set([...inbox.ready, ...inbox.notReady].map((r) => r.id));
    // Only groups with a member waiting for the owner: the rest have nothing to review together.
    inbox.groups = coupledGroups(
        targets.filter((t) => coupling.has(t.id)).map((t) => ({ ...t, ...coupling.get(t.id) })),
    ).filter((g) => g.ids.some((id) => listed.has(id)));
    return inbox;
}

// A conventional-commit title marked breaking: `feat!: ...`, `fix(scope)!: ...`.
const BREAKING = /^\w+(\([^)]*\))?!:/;

/**
 * The groups of pull requests that change at least one baseline file in common (directly, or
 * through another member), each in the order to merge them.
 * ponytail: merge order is oldest pull request first; Mergify's queue order is not known here.
 * @param {{ id: string, pr: number, title: string, paths: string[], images: string[],
 *     packages: string[] | null }[]} entries per pull request: the baseline files it changes
 *     (`<project>/<file>`), its undecided images (`<project>/<file> <image hash> <baseline hash>`),
 *     and the top-level directories of its other changed files (null: unknown)
 * @returns {{ ids: string[], prs: number[], shared: string[], images: number, distinct: number,
 *     fold: { into: number, from: number[] } | null }[]} the groups of two or more, lowest first
 *     pull request first; `shared` the files more than one member changes, `images` the members'
 *     undecided images, `distinct` those once an image shared with the same hashes counts once
 */
export function coupledGroups(entries) {
    const leader = new Map(entries.map((e) => [e.id, e.id]));
    const find = (id) => (leader.get(id) === id ? id : find(leader.get(id)));
    const byPath = new Map();
    for (const e of entries) {
        for (const path of e.paths) {
            const first = byPath.get(path);
            if (first === undefined) {
                byPath.set(path, e.id);
            } else {
                leader.set(find(e.id), find(first));
            }
        }
    }
    const members = new Map();
    for (const e of entries) {
        members.set(find(e.id), [...(members.get(find(e.id)) ?? []), e]);
    }
    const groups = [];
    for (const list of members.values()) {
        if (list.length < 2) {
            continue;
        }
        list.sort((a, b) => a.pr - b.pr);
        const count = new Map();
        for (const path of list.flatMap((e) => e.paths)) {
            count.set(path, (count.get(path) ?? 0) + 1);
        }
        const packages = new Set(list.flatMap((e) => e.packages ?? [null]));
        const foldable = packages.size === 1 && !packages.has(null) && !list.some((e) => BREAKING.test(e.title));
        groups.push({
            ids: list.map((e) => e.id),
            prs: list.map((e) => e.pr),
            shared: [...count]
                .filter(([, n]) => n > 1)
                .map(([p]) => p)
                .sort(),
            images: list.reduce((n, e) => n + e.images.length, 0),
            distinct: new Set(list.flatMap((e) => e.images)).size,
            fold: foldable ? { into: list[0].pr, from: list.slice(1).map((e) => e.pr) } : null,
        });
    }
    return groups.sort((a, b) => a.prs[0] - b.prs[0]);
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
