/*
 * The Same change grouping's Look alike groups: the server groups every reviewable snapshot, and an
 * image approved before stays in its own group until a decision since takes it out.
 */

import { describe, expect, it } from "vitest";

import { BEFORE, groupsOf } from "../../trusted/page/groups.js";

const snap = (n, over = {}) => ({
    n,
    key: `app/look--${n}.png`,
    file: `look--${n}.png`,
    project: "app",
    component: "look",
    status: "changed",
    baseline: `b${n}`,
    capture: `c${n}`,
    look: "app:0",
    decision: null,
    before: false,
    ...over,
});
const clusters = new Map([["app:0", { name: "Look alike: color", representative: "look--1.png" }]]);
const keysOf = (rows) =>
    groupsOf(rows, { grouping: "same", clusters, pairs: new Map() }).map((g) => [g.key, g.rows.map((s) => s.n)]);

describe("Look alike and Approved before", () => {
    it("keeps an image approved before in its own group, and puts it with its look-alikes once rejected", () => {
        const approved = snap(1, { decision: { decision: "accept", approvedBefore: { pr: 77 } }, before: true });
        expect(keysOf([approved, snap(2), snap(3)])).toEqual([
            [BEFORE, [1]],
            ["l:app:0", [2, 3]],
        ]);
        // Reloaded after the reject: no longer approved before, so it joins its look-alikes.
        const rejected = snap(1, { decision: { decision: "reject", reason: "no" } });
        expect(keysOf([rejected, snap(2), snap(3)])).toEqual([["l:app:0", [1, 2, 3]]]);
    });

    it("puts the one image left of a two-image cluster with the rest, not in a Look alike group", () => {
        const approved = snap(1, { decision: { decision: "accept", approvedBefore: { pr: 77 } }, before: true });
        const other = snap(4, { look: null });
        expect(keysOf([approved, snap(2), other])).toEqual([
            [BEFORE, [1]],
            ["z:rest", [2, 4]],
        ]);
    });
});
