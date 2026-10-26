import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseResultLines, passed, resultLine, validateResultLine } from "../trusted/lib/result-line.mjs";
import { MAX_ITEMS, validateResults } from "../trusted/lib/results.mjs";
import { FIXTURE } from "./helpers.mjs";

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

    it("accepts a moved item only with the id it moved from, and from on any item", () => {
        const moved = { status: "moved", baseline: HASH_A, capture: HASH_A, from: "old-button--primary" };
        expect(validateResults(results({ items: [item(moved)] }))).toEqual([]);
        expect(validateResults(results({ items: [item({ from: "old-button--primary" })] }))).toEqual([]);
        expect(validateResults(results({ items: [item({ ...moved, from: null })] }))).toEqual([
            "items[0].from is required for a moved item",
        ]);
        expect(validateResults(results({ items: [item({ from: "../x" })] }))).toEqual([
            "items[0].from must be a Storybook story id or null",
        ]);
    });

    it("accepts a scale of 1 or 2, or none (an older capture), and nothing else", () => {
        expect(validateResults(results({ scale: 2 }))).toEqual([]);
        expect(validateResults(results({ scale: 3 }))).toEqual(["scale must be 1 or 2"]);
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

describe("validateResults reads the fields compare and run add", () => {
    const areas = [
        [10, 20, 80, 24],
        [0, 0, 1, 1],
    ];
    const pictures = { plain: "button--primary.dark.plain.webp", spot: "button--primary.dark.spot.png" };
    const attempts = [{ status: "changed", capture: HASH_B, changedPixels: 3, reason: null, console: ["warn"] }];
    const renderer = { name: "chromium", version: "143.0.7499.4" };

    it("accepts areas, pictures, attempts and the renderer", () => {
        const items = [
            item({ areas, pictures, attempts }),
            item({ id: "b--c", mode: null, file: "b--c.png", areas: [] }),
        ];
        expect(validateResults(results({ renderer, items }))).toEqual([]);
    });

    it("accepts an item without flaky, and an old file as it is", () => {
        const noFlaky = item();
        delete noFlaky.flaky;
        expect(validateResults(results({ items: [noFlaky] }))).toEqual([]);
        const old = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        expect(validateResults(old)).toEqual([]);
        expect(validateResults(results())).toEqual([]);
    });

    it("rejects a bad area, picture, attempt or renderer", () => {
        const at = (overrides) => validateResults(results({ items: [item(overrides)] }));
        expect(at({ areas: [[0, 0, 0, 5]] })).toEqual([
            "items[0].areas must be at most 1000 boxes [x, y, width, height]",
        ]);
        expect(at({ areas: [[1, 2, 3]] })).toHaveLength(1);
        expect(at({ pictures: { plain: "../x.webp" } })).toEqual([
            "items[0].pictures must map at most 20 kinds to .png or .webp file names",
        ]);
        expect(at({ pictures: { plain: "a/b.webp" } })).toHaveLength(1);
        expect(at({ pictures: { Plain: "b.webp" } })).toHaveLength(1);
        expect(at({ pictures: ["b.webp"] })).toHaveLength(1);
        expect(at({ attempts: {} })).toEqual(["items[0].attempts must be an array of at most 20 earlier attempts"]);
        expect(at({ attempts: [{ ...attempts[0], status: "approved", capture: "x" }] })).toEqual([
            "items[0].attempts[0].status must be one of unchanged, moved, changed, new, unseeded, removed, unstable, failed, excluded",
            "items[0].attempts[0].capture must be a sha256 or null",
        ]);
        expect(at({ attempts: [null] })).toEqual(["items[0].attempts[0] must be an object"]);
        expect(at({ attempts: [{ ...attempts[0], status: "moved" }] })).toEqual([
            "items[0].attempts[0].from is required for a moved attempt",
        ]);
        expect(at({ flaky: "no" })).toEqual(["items[0].flaky must be a boolean"]);
        expect(validateResults(results({ renderer: { name: "chromium" } }))).toEqual([
            "renderer must be { name, version }",
        ]);
    });
});

describe("result lines", () => {
    const line = (overrides = {}, where = { project: "compact-mantine", attempt: 1 }) =>
        resultLine(item(overrides), where);

    it("is an item plus project, attempt and passed", () => {
        expect(line()).toEqual({ ...item(), project: "compact-mantine", attempt: 1, passed: false });
        expect(validateResultLine(line())).toEqual([]);
        expect(validateResultLine(line({ status: "unchanged", capture: HASH_A }))).toEqual([]);
    });

    it("passes an unchanged snapshot, does not fail an excluded one, and fails every other status", () => {
        const of = (status) => passed({ status });
        expect(["unchanged", "excluded"].map(of)).toEqual([true, true]);
        const failing = ["moved", "changed", "new", "unseeded", "removed", "unstable", "failed"];
        expect(failing.map(of)).toEqual(failing.map(() => false));
    });

    it("refuses a line with a bad item with the item's own messages", () => {
        const bad = { file: "../x.png", status: "approved", flaky: 1 };
        const asItem = validateResults(results({ items: [item(bad)] }));
        expect(asItem.length).toBeGreaterThan(0);
        expect(validateResultLine(line(bad))).toEqual(asItem.map((m) => m.replace(/^items\[0\]/, "line")));
    });

    it("refuses a bad project, attempt or passed", () => {
        expect(validateResultLine(null)).toEqual(["line must be an object"]);
        expect(validateResultLine({ ...line(), project: "Bad" })).toEqual(["line.project must be a lowercase name"]);
        expect(validateResultLine({ ...line(), attempt: 0 })).toEqual(["line.attempt must be a positive integer"]);
        expect(validateResultLine({ ...line(), passed: "no" })).toEqual(["line.passed must be a boolean"]);
        expect(validateResultLine({ ...line(), passed: true })).toEqual([
            "line.passed must be false for a changed item",
        ]);
    });

    it("reads a file of lines and names the first bad one", () => {
        const good = JSON.stringify(line());
        expect(parseResultLines(`${good}\n\n${good}\n`)).toHaveLength(2);
        expect(() => parseResultLines(`${good}\n{`)).toThrow("result line 2 is not JSON");
        expect(() => parseResultLines(`${good}\n${JSON.stringify({ ...line(), attempt: -1 })}`)).toThrow(
            "result line 2: line.attempt must be a positive integer",
        );
    });
});
