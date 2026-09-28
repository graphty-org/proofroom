import { describe, expect, it } from "vitest";

import { MAX_ITEMS, validateResults } from "../trusted/lib/results.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function item(overrides = {}) {
    return {
        id: "button--primary",
        mode: "dark",
        file: "button--primary.dark.png",
        status: "changed",
        flaky: false,
        baseline: HASH_A,
        capture: HASH_B,
        size: [1200, 900],
        baselineSize: [1200, 900],
        changedPixels: 412,
        bbox: [10, 20, 90, 44],
        threshold: 0.063,
        includeAA: false,
        reason: null,
        console: [],
        ...overrides,
    };
}

function results(overrides = {}) {
    return {
        version: 1,
        project: "compact-mantine",
        commit: "0123456789abcdef0123456789abcdef01234567",
        headSha: null,
        pr: 123,
        runId: 987654,
        runAttempt: 1,
        local: null,
        seeded: true,
        complete: true,
        expected: 4,
        capturedAt: "2026-09-27T12:00:00Z",
        clock: { start: "2026-01-01T12:00:00Z", running: true },
        environment: { chromium: "143.0", renderer: "SwiftShader", gpu: false, tool: "abc123" },
        items: [
            item(),
            item({ id: "button--new", mode: null, file: "button--new.png", status: "new", baseline: null }),
            item({ id: "button--gone", mode: null, file: "button--gone.png", status: "removed", capture: null }),
            item({ id: "chart--spin", mode: null, file: "chart--spin.png", status: "unstable" }),
        ],
        ...overrides,
    };
}

describe("validateResults", () => {
    it("accepts a valid example", () => {
        expect(validateResults(results())).toEqual([]);
    });

    it("accepts a local run with its describe string and diff hash", () => {
        expect(validateResults(results({ local: { describe: "f449e107-dirty", diff: HASH_A } }))).toEqual([]);
    });

    it("accepts an unseeded item, which has a capture and no baseline", () => {
        const unseeded = { id: "b--u", mode: null, file: "b--u.png", status: "unseeded", baseline: null };
        expect(validateResults(results({ items: [item(unseeded)] }))).toEqual([]);
        expect(validateResults(results({ items: [item({ ...unseeded, baseline: HASH_A })] }))).toEqual([
            "items[0].baseline must be null for a unseeded item",
        ]);
    });

    it("rejects an unknown status", () => {
        expect(validateResults(results({ items: [item({ status: "approved" })] })).join("\n")).toMatch(/status/);
    });

    it("rejects a changed item without a baseline or capture hash", () => {
        expect(validateResults(results({ items: [item({ baseline: null })] })).join("\n")).toMatch(/baseline/);
        expect(validateResults(results({ items: [item({ capture: undefined })] })).join("\n")).toMatch(/capture/);
    });

    it("rejects a file containing / or ..", () => {
        for (const file of ["../button--primary.dark.png", "a/button--primary.dark.png", "button--primary..png"]) {
            expect(validateResults(results({ items: [item({ file })] })).join("\n")).toMatch(/file/);
        }
    });

    it("rejects a file that does not match the id and mode", () => {
        expect(validateResults(results({ items: [item({ file: "other--story.dark.png" })] })).join("\n")).toMatch(
            /file/,
        );
    });

    it(`rejects more than ${MAX_ITEMS} items`, () => {
        const items = Array.from({ length: MAX_ITEMS + 1 }, (_, i) =>
            item({
                id: `s--${i}`,
                mode: null,
                file: `s--${i}.png`,
                status: "unchanged",
                baseline: HASH_A,
                capture: HASH_A,
            }),
        );
        expect(validateResults(results({ items })).join("\n")).toMatch(/items/);
    });

    it("rejects a duplicate story and mode", () => {
        expect(validateResults(results({ items: [item(), item()] })).join("\n")).toMatch(/duplicate/);
    });

    it("rejects a non-object and a wrong version", () => {
        expect(validateResults(null)).not.toEqual([]);
        expect(validateResults(results({ version: 2 }))).not.toEqual([]);
    });
});
