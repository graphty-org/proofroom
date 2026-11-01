/*
 * The Same change grouping's Look alike groups: the server groups every reviewable snapshot, and an
 * image accepted earlier stays in its own group, last in the list, until a decision since takes it out.
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

describe("Look alike and Accepted earlier", () => {
    it("keeps an image accepted earlier in its own group, last, and puts it with its look-alikes once rejected", () => {
        const approved = snap(1, { decision: { decision: "accept", approvedBefore: { pr: 77 } }, before: true });
        expect(keysOf([approved, snap(2), snap(3)])).toEqual([
            ["l:app:0", [2, 3]],
            [BEFORE, [1]],
        ]);
        // Reloaded after the reject: no longer approved before, so it joins its look-alikes.
        const rejected = snap(1, { decision: { decision: "reject", reason: "no" } });
        expect(keysOf([rejected, snap(2), snap(3)])).toEqual([["l:app:0", [1, 2, 3]]]);
    });

    it("puts the one image left of a two-image cluster with the rest, not in a Look alike group", () => {
        const approved = snap(1, { decision: { decision: "accept", approvedBefore: { pr: 77 } }, before: true });
        const other = snap(4, { look: null });
        expect(keysOf([approved, snap(2), other])).toEqual([
            ["z:rest", [2, 4]],
            [BEFORE, [1]],
        ]);
    });

    it("names the group Accepted earlier and puts it after every other group in every grouping", () => {
        const approved = snap(9, { decision: { decision: "accept", approvedBefore: { pr: 77 } }, before: true });
        for (const grouping of ["component", "project", "status", "same"]) {
            const groups = groupsOf([approved, snap(2, { look: null }), snap(3, { component: "aaa", look: null })], {
                grouping,
                clusters,
                pairs: new Map(),
            });
            expect(groups.at(-1)).toMatchObject({ key: BEFORE, label: "Accepted earlier" });
            expect(groups.filter((g) => g.key === BEFORE)).toHaveLength(1);
        }
    });
});
