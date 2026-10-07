/**
 * The review page's safe filters: ways to spend less of the owner's time on screenshot changes
 * without hiding one.
 *
 * - **Approved before.** A capture byte-identical to an image the owner already approved for the
 *   same story and mode (a review record on the default branch or on an open pull request's
 *   branch) is accepted again, with the record that approved it named in the new record. The gate
 *   checks that record before the item counts (gate.mjs earlierApprovalProblem), so nothing here
 *   is taken on trust.
 * - **Known capture noise.** A story whose capture changed on two pull requests that touch none of
 *   its package's files, or that flips between the same two images, is flaky. It is labeled, never
 *   accepted: the owner still decides, but can decide the group at once.
 * - **Grouped review.** Changed items with the same signature (where the change is, how large,
 *   what kind) form a cluster the owner can decide as one; the rest are outliers, shown first.
 */

import { earlierApprovalProblem } from "../gate.mjs";

/**
 * The images the owner approved, by baseline path and image hash, from review records.
 * @param {{ commit: string, path: string, record: any, main: boolean }[]} records review records,
 *     each with the commit it was read at, its path there, and whether that is the default branch
 * @param {object[] | null} keys the default branch's passkeys (null when none): a record must then
 *     carry a valid approval of its own, as the gate requires
 * @returns {Map<string, { pr: number | null, commit: string, record: string, reviewedAt: string }>}
 *     by `<path> <hash>`; a default branch record wins over a pull request's, then the newest
 */
export function approvalIndex(records, keys) {
    const index = new Map();
    for (const { commit, path, record, main } of records) {
        const items = Array.isArray(record?.items) ? record.items : [];
        const direct = items.filter(
            (i) => typeof i?.path === "string" && typeof i.to === "string" && i.approvedBefore === undefined,
        );
        // One check per record: its pull request and its own approval hold for every item.
        if (
            direct.length === 0 ||
            earlierApprovalProblem(record, { path: direct[0].path, to: direct[0].to, pr: record.pr ?? null }, keys)
        ) {
            continue;
        }
        const at = String(record.reviewedAt ?? "");
        for (const i of direct) {
            const key = `${i.path} ${i.to}`;
            const was = index.get(key);
            if (!was || (main && !was.main) || (main === was.main && at > was.reviewedAt)) {
                index.set(key, { pr: record.pr ?? null, commit, record: path, reviewedAt: at, main });
            }
        }
    }
    return new Map(
        [...index].map(([k, v]) => [k, { pr: v.pr, commit: v.commit, record: v.record, reviewedAt: v.reviewedAt }]),
    );
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
    const extent = kind === "speck" ? "any" : share < 0.01 ? "small" : share < 0.2 ? "medium" : "large";
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
        if (s !== null) {
            bySignature.set(s, [...(bySignature.get(s) ?? []), item]);
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
