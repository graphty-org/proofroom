/*
 * The Keys sheet's map names only actions the page has. A row whose actions are still to come is
 * hidden until they exist; PENDING lists those rows, and the stage that adds the actions empties it.
 */

import { describe, expect, it } from "vitest";

import { ACTIONS } from "../../trusted/page/actions.js";
import { MAP } from "../../trusted/page/key-map.js";

// The rows whose actions are still to come: none since the decision keys arrived.
const PENDING = [];

describe("the Keys sheet's map", () => {
    it("names an existing action in every row but the pending ones", () => {
        const missing = MAP.filter(([, , acts]) => acts.length > 0 && !acts.some((id) => Object.hasOwn(ACTIONS, id)));
        expect(missing.map(([keys]) => keys)).toEqual(PENDING);
    });

    it("names no action that does not exist in a row it shows", () => {
        const half = MAP.filter(
            ([, , acts]) =>
                acts.some((id) => Object.hasOwn(ACTIONS, id)) && !acts.every((id) => Object.hasOwn(ACTIONS, id)),
        );
        expect(half).toEqual([]);
    });
});
