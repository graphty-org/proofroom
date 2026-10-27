/*
 * The snapshot list's groupings (design 4.4): Component, Same change, Project, Status and None, and
 * the Approved before group at the top of every grouping. An identical change is a fact (the same
 * baseline and new image hashes); a look-alike group is the server's guess (filters.mjs clusters()),
 * so the two are labeled differently. Pure functions over the list's snapshots.
 */

import { ORDER, STATUS } from "./marks.js";

/** The Group menu's choices, in its order. */
export const GROUPINGS = {
    component: "Component",
    same: "Same change",
    project: "Project",
    status: "Status",
    none: "None",
};

/** The Approved before group's key. */
export const BEFORE = "!before";

/** A group over this many rows that holds undecided rows opens collapsed (all but the first). */
export const BIG = 50;

/**
 * The component of a story id ("legend--default" is in "legend").
 * @param {string} id the story id
 * @returns {string} its component
 */
export const componentOf = (id) => String(id).split("--")[0];

/**
 * The story's own name within its component.
 * @param {string} id the story id
 * @returns {string} the name
 */
export const storyOf = (id) => {
    const at = String(id).indexOf("--");
    return at < 0 ? String(id) : String(id).slice(at + 2);
};

/**
 * The key of a changed snapshot's pair of images, or null for one that is not a change of one image
 * into another.
 * @param {{ status: string, baseline?: string | null, capture?: string | null }} s the snapshot
 * @returns {string | null} the pair
 */
export const pairOf = (s) =>
    s.status === "changed" && s.baseline && s.capture && s.baseline !== s.capture ? `${s.baseline}:${s.capture}` : null;

/**
 * How many snapshots share each pair of images.
 * @param {object[]} snaps every snapshot of the change
 * @returns {Map<string, number>} the count by pair
 */
export function pairCounts(snaps) {
    const out = new Map();
    for (const s of snaps) {
        const p = pairOf(s);
        if (p) {
            out.set(p, (out.get(p) ?? 0) + 1);
        }
    }
    return out;
}

const KINDS = { pixels: "changes", speck: "specks", size: "size changes" };
const EXTENT = { small: "small ", medium: "", large: "large ", any: "" };

/**
 * A look-alike group's name, from the server's cluster ("pixels top-left small", 30 to 40 px).
 * @param {{ signature: string, pixels: [number, number] }} c the cluster
 * @returns {string} "Look alike: small changes, top left, 30 to 40 px"
 */
export function lookAlikeName(c) {
    const [kind, region, extent] = String(c.signature).split(" ");
    const where = region && region !== "whole" ? `, ${region.replace("-", " ")}` : "";
    const [lo, hi] = c.pixels ?? [0, 0];
    const px =
        lo === hi
            ? `${lo.toLocaleString("en-US")} px`
            : `${lo.toLocaleString("en-US")} to ${hi.toLocaleString("en-US")} px`;
    return `Look alike: ${EXTENT[extent] ?? ""}${KINDS[kind] ?? kind}${where}, ${px}`;
}

const rank = (s) => {
    const i = ORDER.indexOf(s.status);
    return i < 0 ? ORDER.length : i;
};
const byNumber = (a, b) => a.n - b.n;

/**
 * Whether a row is left for the reviewer: undecided, and of a status Accept is allowed for (a
 * failed or unstable row only takes Exclude).
 * @param {{ status: string, decision?: object | null }} s the snapshot
 * @returns {boolean} it is
 */
export const undecided = (s) => !s.decision && STATUS[s.status]?.accept !== false;

/**
 * The groups the list draws, in order: Approved before first, then by name (by the status order
 * for Status; identical changes, look-alikes, then the rest for Same change). In each group the
 * rows follow the status order, then the snapshot number; None is one group in number order.
 * @param {object[]} rows the snapshots shown (Show and Find applied)
 * @param {{ grouping: string, all: object[], clusters: Map<string, { name: string, files: Set<string>,
 *     representative: string }>, pairs: Map<string, number> }} at the grouping, every snapshot of the
 *     change, the look-alike clusters by id, and the pair counts
 * @returns {{ key: string, label: string, kind: string, rows: object[] }[]} the groups
 */
export function groupsOf(rows, { grouping, clusters, pairs }) {
    if (grouping === "none") {
        return [{ key: "all", label: "", kind: "none", rows: [...rows].sort(byNumber) }];
    }
    const groups = new Map();
    const add = (key, label, kind, s) => {
        if (!groups.has(key)) {
            groups.set(key, { key, label, kind, rows: [] });
        }
        groups.get(key).rows.push(s);
    };
    for (const s of rows) {
        // The group a row arrived in: a decision taken since never moves it.
        if (s.beforeGroup ?? s.before) {
            add(BEFORE, "Approved before", "before", s);
            continue;
        }
        if (grouping === "component") {
            const name = `${s.project} > ${s.component}`;
            add(`c:${name}`, name, "component", s);
        } else if (grouping === "project") {
            add(`p:${s.project}`, s.project, "project", s);
        } else if (grouping === "status") {
            add(`s:${s.status}`, s.status, "status", s);
        } else {
            const pair = pairOf(s);
            const look = s.look && clusters.get(s.look);
            if (pair && (pairs.get(pair) ?? 0) > 1) {
                add(`i:${pair}`, "Identical change", "identical", s);
            } else if (look) {
                add(`l:${s.look}`, look.name, "look", s);
            } else {
                add("z:rest", "Different from the rest", "rest", s);
            }
        }
    }
    // A look-alike cluster counts images approved before, which wait in their own group: one
    // image left is not a look-alike group.
    for (const g of [...groups.values()]) {
        if (g.kind === "look" && g.rows.length < 2) {
            groups.delete(g.key);
            for (const s of g.rows) {
                add("z:rest", "Different from the rest", "rest", s);
            }
        }
    }
    const kindOrder = { before: 0, identical: 1, look: 2, rest: 3 };
    const out = [...groups.values()];
    out.sort((a, b) => {
        if (a.kind === "before" || b.kind === "before") {
            return a.kind === "before" ? -1 : 1;
        }
        if (grouping === "status") {
            return ORDER.indexOf(a.label) - ORDER.indexOf(b.label);
        }
        if (grouping === "same") {
            return kindOrder[a.kind] - kindOrder[b.kind] || b.rows.length - a.rows.length || (a.key < b.key ? -1 : 1);
        }
        return a.label.localeCompare(b.label);
    });
    for (const g of out) {
        // In each group, the status order, then the snapshot number.
        g.rows.sort((x, y) => rank(x) - rank(y) || byNumber(x, y));
        if (g.kind === "look") {
            // The representative (most changed pixels) first.
            const rep = clusters.get(g.rows[0].look)?.representative;
            const at = g.rows.findIndex((s) => s.file === rep);
            if (at > 0) {
                g.rows.unshift(...g.rows.splice(at, 1));
            }
        }
    }
    return out;
}

/**
 * The status split of a group holding more than one status: [status, count] in the status order,
 * or null.
 * @param {{ rows: object[] }} g the group
 * @returns {[string, number][] | null} the split
 */
export function splitOf(g) {
    const n = new Map();
    for (const s of g.rows) {
        n.set(s.status, (n.get(s.status) ?? 0) + 1);
    }
    const out = ORDER.filter((st) => n.has(st)).map((st) => /** @type {[string, number]} */ ([st, n.get(st)]));
    return out.length > 1 ? out : null;
}

/**
 * The split's words: "12 changed, 7 new".
 * @param {[string, number][]} split the split
 * @returns {string} the words
 */
export const splitWords = (split) =>
    split.map(([st, n]) => `${n.toLocaleString("en-US")} ${STATUS[st].word}`).join(", ");

/**
 * The groups that open collapsed: every group over 50 rows that holds undecided rows, except the
 * first such; and Approved before, unless Show is All or Accepted.
 * @param {{ key: string, rows: object[] }[]} groups the groups
 * @param {string} show the Show choice
 * @returns {Set<string>} their keys
 */
export function collapsedAtStart(groups, show) {
    const out = new Set();
    let first = true;
    for (const g of groups) {
        if (g.key === BEFORE) {
            if (show !== "all" && show !== "accept") {
                out.add(g.key);
            }
            continue;
        }
        if (!first && g.rows.length > BIG && g.rows.some(undecided)) {
            out.add(g.key);
        }
        first = false;
    }
    return out;
}
