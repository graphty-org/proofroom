/*
 * A capture holding the fields compare and run add (areas, pictures, attempts, renderer) passes and
 * fails the gate exactly as one without them, with this package's gate and with the old package's
 * (test/fixtures/old-gate/), which graphty-monorepo's CI runs on captures this package writes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as oldConfig from "./fixtures/old-gate/trusted/lib/config.mjs";
import * as oldGate from "./fixtures/old-gate/trusted/gate.mjs";
import * as gate from "../trusted/gate.mjs";
import * as config from "../trusted/lib/config.mjs";
import { FIXTURE } from "./helpers.mjs";

const FIXTURE_RESULTS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

// A valid results.json whose items have these statuses, with or without the new fields.
const results = (statuses, withNew) => ({
    ...FIXTURE_RESULTS,
    complete: true,
    expected: statuses.length,
    ...(withNew && { renderer: { name: "chromium", version: "143.0.7499.4" } }),
    items: statuses.map((status, i) => ({
        ...FIXTURE_RESULTS.items[0],
        id: `story--s${i}`,
        mode: null,
        file: `story--s${i}.png`,
        status,
        flaky: false,
        baseline: status === "new" || status === "unseeded" ? null : HASH,
        capture: status === "removed" ? null : HASH,
        ...(status === "moved" && { from: `old--s${i}` }),
        ...(withNew && {
            areas: [[1, 2, 30, 40]],
            pictures: { plain: `story--s${i}.plain.webp` },
            attempts: [{ status: "changed", capture: OTHER, changedPixels: 5, reason: null, console: [] }],
        }),
    })),
});

const CASES = [
    ["unchanged", "excluded"],
    ["changed", "unchanged"],
    ["moved", "removed", "new", "unseeded"],
    ["failed"],
];

describe.each([
    ["this package's gate", gate, config],
    ["the old package's gate", oldGate, oldConfig],
])("%s", (_name, g, c) => {
    const cfg = c.normalizeConfig({ defaultBranch: "master", projects: { "compact-mantine": { storybook: "a" } } });
    const seeded = new Set(["compact-mantine"]);
    const problems = (r) =>
        g.gateProblems({ config: cfg, seeded, captures: { "compact-mantine": { attempt: 1, results: r } } });

    it.each(CASES)("judges %s the same with the new fields as without", (...statuses) => {
        const before = problems(results(statuses, false));
        expect(problems(results(statuses, true))).toEqual(before);
        expect(before.length === 0).toBe(statuses.every((s) => s === "unchanged" || s === "excluded"));
    });
});

describe("this package's gate", () => {
    it("reads an item without flaky", () => {
        const cfg = config.normalizeConfig({
            defaultBranch: "master",
            projects: { "compact-mantine": { storybook: "a" } },
        });
        const r = results(["unchanged"], true);
        delete r.items[0].flaky;
        const captures = { "compact-mantine": { attempt: 1, results: r } };
        expect(gate.gateProblems({ config: cfg, seeded: new Set(["compact-mantine"]), captures })).toEqual([]);
    });
});
