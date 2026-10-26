/**
 * The review page's safe filters: ways to spend less of the owner's time on screenshot changes
 * without hiding one.
 *
 * - **Approved before.** A capture byte-identical to an image the owner already approved for the
 *   same story and mode (a review record or a change statement on the default branch or on an
 *   open pull request's branch) is accepted again, with the record or statement that approved it
 *   named in the new record. A record counts only when it passes gate.mjs earlierApprovalProblem
 *   or the owner signed a baselines tree that holds it (accept.mjs treeSignedRecords), a statement
 *   only when its signature verifies (accept.mjs earlierApprovalsAt), and the owner's Finish
 *   sheet lists every such accept before the owner signs the baselines with it.
 * - **Known capture noise.** A story whose capture changed on two pull requests that touch none of
 *   its package's files, or that flips between the same two images, is flaky. It is labeled, never
 *   accepted: the owner still decides, but can decide the group at once.
 * - **Grouped review.** Changed items with the same signature (where the change is, how large,
 *   what kind) form a cluster the owner can decide as one; the rest are outliers, shown first.
 */

import { earlierApprovalProblem } from "../gate.mjs";
import { verifyRecord } from "./approval.mjs";
import { newestDecisions, statementId } from "./change-approval.mjs";

/**
 * The images the owner approved, by baseline path and image hash, from review records and change
 * statements.
 *
 * A record counts only where it cannot have been planted: before a passkey is registered, only on
 * the default branch (a pull request the owner finished and merged); once one is, anywhere, with
 * a valid approval of its own or inside a baselines tree the owner signed (`treeSigned`). A change
 * statement counts only once a passkey is registered, and only when it is verified (accept.mjs
 * earlierApprovalsAt). And an approval counts only while it is still the newest decision on that
 * path where it lives: a later record or statement that accepts another image for the path, or
 * rejects or excludes it, replaces it. Within one change, statements are ordered by their chain
 * (`previous`, change-approval.mjs newestDecisions); otherwise by time.
 * @param {{ ref: string, commit: string, path: string, record: any, main: boolean,
 *     treeSigned?: boolean }[]} records review records: the tip they were read at (`ref`), the
 *     commit to name for them, their path, whether `ref` is the default branch, and whether a
 *     baselines tree the owner signed with a passkey holds the record
 * @param {object[] | null} keys the default branch's passkeys (null when none)
 * @param {{ ref: string, commit: string, path: string, statement: any, verified: boolean,
 *     main: boolean }[]} [statements] change statements, read as the records are
 * @returns {Map<string, { pr: number | null, change?: string, commit: string, record: string,
 *     reviewedAt: string }>} by `<path> <hash>`; a default branch approval wins over a pull
 *     request's, then the newest. `record` is the record's or the statement's path; a statement's
 *     also names its `change` (`pr:7`, `branch:feat/x`), and its `pr` is null for one that is not a
 *     pull request's
 */
export function approvalIndex(records, keys, statements = []) {
    const index = new Map();
    const byRef = new Map();
    const atRef = (ref) => {
        if (!byRef.has(ref)) {
            byRef.set(ref, { records: [], statements: [] });
        }
        return byRef.get(ref);
    };
    records.forEach((r) => atRef(r.ref).records.push(r));
    statements.filter((s) => keys && s.verified).forEach((s) => atRef(s.ref).statements.push(s));
    const verdicts = new Map();
    const holds = (record, first) => {
        if (!verdicts.has(record)) {
            verdicts.set(record, earlierApprovalProblem(record, first, keys) === null);
        }
        return verdicts.get(record);
    };
    for (const { records: list, statements: signed } of byRef.values()) {
        // Record names start with their UTC time, so the name orders them as reviewedAt does.
        const sorted = [...list].sort((a, b) => (a.path < b.path ? -1 : 1));
        const newest = newestByPath(sorted);
        const decided = statementDecisions(signed);
        for (const r of sorted) {
            const direct = listOf(r.record, "items").filter(
                (i) =>
                    typeof i.to === "string" &&
                    i.approvedBefore === undefined &&
                    newest.get(i.path) === r &&
                    !(decided.get(i.path)?.time >= recordTime(r)),
            );
            // One check per record: its own approval holds for every item.
            if (direct.length > 0 && (keys || r.main) && (r.treeSigned === true || holds(r.record, direct[0]))) {
                const value = {
                    pr: r.record.pr ?? null,
                    commit: r.commit,
                    record: r.path,
                    reviewedAt: String(r.record.reviewedAt ?? ""),
                };
                direct.forEach((i) => keep(index, `${i.path} ${i.to}`, { main: r.main, time: recordTime(r), value }));
            }
        }
        for (const [path, d] of decided) {
            const r = newest.get(path);
            if (d.entry?.decision === "accept" && typeof d.entry.to === "string" && !(r && recordTime(r) > d.time)) {
                const { statement } = d.row;
                const pr = /^pr:(\d+)$/.exec(statement.change);
                const value = {
                    pr: pr ? Number(pr[1]) : null,
                    change: statement.change,
                    commit: d.row.commit,
                    record: d.row.path,
                    reviewedAt: statement.approvedAt,
                };
                keep(index, `${path} ${d.entry.to}`, { main: d.row.main, time: d.time, value });
            }
        }
    }
    return new Map([...index].map(([k, v]) => [k, v.value]));
}

const recordTime = (r) => Date.parse(String(r.record.reviewedAt ?? "")) || 0;
const statementTime = (s) => Date.parse(s.statement.approvedAt) || 0;

/**
 * The newest decision the statements of one tip make on each path: per change by its chain, then
 * the newest change. A change whose chain does not stand (a fork not closed, a missing previous),
 * and a path its newest statements decide differently, approve nothing there.
 * @param {{ path: string, statement: any }[]} rows the tip's verified statements
 * @returns {Map<string, { row: object, entry: object | null, time: number }>} by path, with the
 *     baselines directory as review records write it; `entry` null where nothing is approved
 */
function statementDecisions(rows) {
    const byChange = new Map();
    for (const s of rows) {
        byChange.set(s.statement.change, [...(byChange.get(s.statement.change) ?? []), s]);
    }
    const out = new Map();
    const take = (path, d) => {
        if (!(out.get(path)?.time > d.time)) {
            out.set(path, d);
        }
    };
    for (const chain of byChange.values()) {
        const rowOf = new Map(chain.flatMap((s) => s.statement.entries.map((e) => [e, s])));
        const latest = Math.max(...chain.map(statementTime));
        const r = newestDecisions(
            chain.map((s) => ({
                file: s.path,
                id: statementId(s.statement),
                previous: s.statement.previous,
                entries: s.statement.entries,
            })),
        );
        const decisions = "problem" in r ? new Map([...rowOf.keys()].map((e) => [e.path, null])) : r.decisions;
        const dir = `${chain[0].statement.baselines}/`;
        for (const [path, e] of decisions) {
            const row = rowOf.get(e);
            take(
                dir + path,
                row ? { row, entry: e, time: statementTime(row) } : { row: chain[0], entry: null, time: latest },
            );
        }
    }
    return out;
}

/**
 * Who wrote each image, for a baselines history: by baseline path and image hash, the newest change
 * statement or review record that wrote that image there (an accept, or an exclude that writes
 * `to`), with whether its signature verified. An unverified one is listed so the history can show
 * it as unverified; approvalIndex never counts it.
 * @param {{ path: string, record: any, treeSigned?: boolean }[]} records review records, as for
 *     approvalIndex
 * @param {{ path: string, statement: any, verified: boolean }[]} statements change statements, as
 *     for approvalIndex
 * @param {object[] | null} keys the default branch's passkeys (null when none: nothing verifies)
 * @returns {Map<string, { path: string, file: string, change: string | null, at: string,
 *     verified: boolean }>} by `<path> <hash>`: the baseline it was written to, the record's or
 *     statement's path, its change (`pr:7`; null for a record of the default branch), and when
 */
export function baselineWriters(records, statements, keys) {
    const out = new Map();
    const put = (hash, w) => {
        const key = `${w.path} ${hash}`;
        const was = out.get(key);
        if (!was || !(Date.parse(was.at) > Date.parse(w.at))) {
            out.set(key, w);
        }
    };
    for (const r of records) {
        const pr = r.record?.pr;
        const verified =
            r.treeSigned === true || (keys !== null && verifyRecord(r.record, keys, { pr: pr ?? null }) === null);
        for (const i of listOf(r.record, "items").filter((x) => typeof x.to === "string")) {
            const change = typeof pr === "number" ? `pr:${pr}` : null;
            put(i.to, { path: i.path, file: r.path, change, at: String(r.record.reviewedAt ?? ""), verified });
        }
    }
    for (const s of statements) {
        for (const e of s.statement.entries.filter((x) => (x.decision === "accept" || x.decision === "exclude") && typeof x.to === "string")) {
            put(e.to, {
                path: `${s.statement.baselines}/${e.path}`,
                file: s.path,
                change: s.statement.change,
                at: s.statement.approvedAt,
                verified: keys !== null && s.verified,
            });
        }
    }
    return out;
}

// The record items (or rejects) that name a path.
const listOf = (record, key) =>
    (Array.isArray(record?.[key]) ? record[key] : []).filter((i) => typeof i?.path === "string");

/**
 * The newest record of one tip that decides each path: accepts it, excludes it or rejects it.
 * @param {{ record: any }[]} sorted the tip's records, oldest first
 * @returns {Map<string, object>} the record row by path
 */
function newestByPath(sorted) {
    const newest = new Map();
    for (const r of sorted) {
        for (const i of [...listOf(r.record, "items"), ...listOf(r.record, "rejects")]) {
            newest.set(i.path, r);
        }
    }
    return newest;
}

// Indexes an approval for a key: the default branch's wins, then the newest.
function keep(index, key, a) {
    const was = index.get(key);
    if (!was || (a.main && !was.main) || (a.main === was.main && a.time > was.time)) {
        index.set(key, a);
    }
}

/**
 * What one target's capture says about capture noise: one observation per changed item.
 * @param {{ pr: number | null, runId: number | null, changedFiles?: string[] | null,
 *     projects: { project: string, results: object | null }[] }} t the target
 * @param {(project: string) => string} packageOf the directory of a project's package
 * @returns {{ key: string, pr: number, run: number, baseline: string, capture: string,
 *     untouched: boolean }[]} the observations; `untouched` when the pull request changes no file
 *     of the project's package
 */
export function observations(t, packageOf) {
    if (t.pr === null || !t.runId || !Array.isArray(t.changedFiles)) {
        return [];
    }
    const out = [];
    for (const p of t.projects) {
        const dir = `${packageOf(p.project)}/`;
        const untouched = !t.changedFiles.some((f) => f.startsWith(dir));
        // A local preview is not CI's capture: its bytes can differ for reasons of its own.
        for (const i of p.results?.local ? [] : (p.results?.items ?? [])) {
            if (i.status === "changed" && !i.from) {
                const key = `${p.project}/${i.file}`;
                out.push({ key, pr: t.pr, run: t.runId, baseline: i.baseline, capture: i.capture, untouched });
            }
        }
    }
    return out;
}

/**
 * The stories proven to be capture noise, from every observation kept.
 * @param {ReturnType<typeof observations>} evidence the observations, of every run seen
 * @returns {Map<string, { prs: number[], why: "untouched" | "flip-flop", hashes: string[] }>} by
 *     `<project>/<file>`: changed on two or more pull requests that touch none of its package, or
 *     captured as A over baseline B and as B over baseline A
 */
export function knownNoise(evidence) {
    const byKey = new Map();
    for (const o of evidence) {
        byKey.set(o.key, [...(byKey.get(o.key) ?? []), o]);
    }
    const out = new Map();
    for (const [key, seen] of byKey) {
        const untouched = [...new Set(seen.filter((o) => o.untouched).map((o) => o.pr))].sort((a, b) => a - b);
        const pairs = new Set(seen.map((o) => `${o.baseline} ${o.capture}`));
        const flips = seen.filter((o) => pairs.has(`${o.capture} ${o.baseline}`));
        if (untouched.length >= 2) {
            const hashes = [...new Set(seen.filter((o) => o.untouched).map((o) => o.capture))];
            out.set(key, { prs: untouched, why: "untouched", hashes });
        } else if (flips.length > 0) {
            const prs = [...new Set(flips.map((o) => o.pr))].sort((a, b) => a - b);
            out.set(key, { prs, why: "flip-flop", hashes: [flips[0].baseline, flips[0].capture] });
        }
    }
    return out;
}

/**
 * Whether one item of a target is known noise there: the story is known noise, and this change
 * cannot be the pull request's own doing (it touches none of the package's files), or it is the
 * same flip between two images seen before.
 * @param {{ prs: number[], why: string, hashes: string[] } | undefined} noise the story's entry
 * @param {{ baseline: string | null, capture: string | null }} item the item
 * @param {boolean} untouched whether this pull request changes no file of the package
 * @returns {boolean} whether to label it known noise
 */
export const isNoise = (noise, item, untouched) =>
    Boolean(noise) &&
    (untouched ||
        (noise.why === "flip-flop" && noise.hashes.includes(item.baseline) && noise.hashes.includes(item.capture)));

/** Fewer changed pixels than this is a speck: anti-aliasing or a sub-pixel shift. */
const SPECK = 50;
/** A cluster's pixel counts break where one is more than this many times the one before. */
const BAND_GAP = 10;

/**
 * The coarse kind of a changed item and where its change is.
 * @param {{ status: string, from?: string | null, size: number[] | null, baselineSize: number[] | null,
 *     changedPixels: number | null, bbox: number[] | null }} item the results.json item
 * @returns {string | null} `kind region extent`; null for an item that is never clustered
 */
export function signature(item) {
    if (item.status !== "changed" || item.from) {
        return null;
    }
    const [w, h] = item.size ?? item.baselineSize ?? [0, 0];
    if (String(item.size) !== String(item.baselineSize)) {
        return "size whole any";
    }
    const kind = (item.changedPixels ?? 0) < SPECK ? "speck" : "pixels";
    if (!item.bbox || w === 0 || h === 0) {
        return `${kind} whole any`;
    }
    const [x, y, bw, bh] = item.bbox;
    const third = (v, of) => Math.min(2, Math.floor((3 * v) / of));
    const region = `${["top", "middle", "bottom"][third(y + bh / 2, h)]}-${["left", "center", "right"][third(x + bw / 2, w)]}`;
    const share = (bw * bh) / (w * h);
    // A speck is a speck however far apart its few pixels lie.
    let extent = "large";
    if (kind === "speck") {
        extent = "any";
    } else if (share < 0.01) {
        extent = "small";
    } else if (share < 0.2) {
        extent = "medium";
    }
    return `${kind} ${region} ${extent}`;
}

/**
 * Groups changed items with the same signature and a similar number of changed pixels.
 * @param {object[]} items results.json items
 * @returns {{ clusters: { signature: string, files: string[], representative: string,
 *     pixels: [number, number] }[], outliers: string[] }} clusters of two or more, largest first,
 *     each with the member of most changed pixels as its representative; every other item
 *     (changed or not) is an outlier, in the order given
 */
export function clusters(items) {
    const bySignature = new Map();
    for (const item of items) {
        const s = signature(item);
        if (s === null) {
            continue;
        }
        const members = bySignature.get(s);
        if (members) {
            members.push(item);
        } else {
            bySignature.set(s, [item]);
        }
    }
    const found = [];
    for (const [s, members] of bySignature) {
        const sorted = [...members].sort((a, b) => (a.changedPixels ?? 0) - (b.changedPixels ?? 0));
        let band = [];
        for (const item of sorted) {
            const prev = band.at(-1)?.changedPixels ?? 0;
            if (band.length > 0 && (item.changedPixels ?? 0) > Math.max(prev, 1) * BAND_GAP) {
                found.push({ s, band });
                band = [];
            }
            band.push(item);
        }
        found.push({ s, band });
    }
    const out = found
        .filter(({ band }) => band.length >= 2)
        .map(({ s, band }) => ({
            signature: s,
            files: band.map((i) => i.file),
            representative: band.at(-1).file,
            pixels: /** @type {[number, number]} */ ([band[0].changedPixels ?? 0, band.at(-1).changedPixels ?? 0]),
        }))
        .sort((a, b) => b.files.length - a.files.length || (a.signature < b.signature ? -1 : 1));
    const clustered = new Set(out.flatMap((c) => c.files));
    return { clusters: out, outliers: items.filter((i) => !clustered.has(i.file)).map((i) => i.file) };
}

/**
 * A capture set's items by file name, so one item is found without a scan of the list.
 * @param {object[]} items results.json items
 * @returns {Map<string, object>} the item by `file`
 */
export const itemsByFile = (items) => new Map(items.map((i) => [i.file, i]));
