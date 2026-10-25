import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parity, readResults } from "../trusted/lib/parity.mjs";

import { FIXTURE, tempDir } from "./helpers.mjs";

const BASE = JSON.parse(readFileSync(join(FIXTURE, "graphty-element/results.json"), "utf8"));
const hash = (c) => c.repeat(64);

/**
 * A valid results.json of graphty-element holding the given items.
 * @param {object[]} items partial items: id and status, plus capture when it has one
 * @returns {object} the results
 */
function results(items) {
    const [template] = BASE.items;
    return {
        ...BASE,
        expected: items.length,
        items: items.map(({ id, mode = null, status, capture = null }) => ({
            ...template,
            id,
            mode,
            file: mode ? `${id}.${mode}.png` : `${id}.png`,
            status,
            capture,
            baseline: status === "unchanged" || status === "changed" ? hash("b") : null,
            size: capture ? [320, 200] : null,
        })),
    };
}

describe("parity", () => {
    it("agrees on equal hashes, whatever each side compared them with", () => {
        const first = results([{ id: "a--one", status: "unchanged", capture: hash("1") }]);
        const second = results([{ id: "a--one", status: "new", capture: hash("1") }]);
        expect(parity(first, second)).toEqual({ compared: 1, same: 1, differences: [] });
    });

    it("lists different bytes, a story one side lacks and one it could not capture", () => {
        const first = results([
            { id: "a--one", status: "unchanged", capture: hash("1") },
            { id: "a--two", status: "changed", capture: hash("2") },
            { id: "a--three", status: "unchanged", capture: hash("3") },
            { id: "a--four", mode: "dark", status: "unchanged", capture: hash("4") },
        ]);
        const second = results([
            { id: "a--one", status: "unchanged", capture: hash("1") },
            { id: "a--two", status: "changed", capture: hash("9") },
            { id: "a--three", status: "failed" },
        ]);
        const r = parity(first, second);
        expect(r.compared).toBe(4);
        expect(r.same).toBe(1);
        expect(r.differences.map((d) => [d.file, d.problem])).toEqual([
            ["a--four.dark.png", "only in the first"],
            ["a--three.png", "not captured on both sides"],
            ["a--two.png", "different bytes"],
        ]);
        expect(r.differences[2].second).toEqual({ status: "changed", capture: hash("9"), size: [320, 200] });
        expect(r.differences[0].second).toBeUndefined();
    });

    it("agrees on a story both sides exclude, never on one both failed", () => {
        const both = (status) => results([{ id: "a--one", status }]);
        expect(parity(both("excluded"), both("excluded")).differences).toEqual([]);
        expect(parity(both("failed"), both("failed")).differences).toHaveLength(1);
    });

    it("refuses an invalid results.json", async () => {
        const dir = tempDir("parity-");
        writeFileSync(join(dir, "results.json"), JSON.stringify({ ...BASE, version: 2 }));
        await expect(readResults(dir)).rejects.toThrow(/version must be 1/);
    });
});

describe("visual-review parity", () => {
    const cli = new URL("../trusted/cli.mjs", import.meta.url).pathname;
    const run = (...args) => spawnSync(process.execPath, [cli, "parity", ...args], { encoding: "utf8" });

    it("exits 0 on parity and 1 on a difference, printing it and a summary", () => {
        const dir = tempDir("parity-cli-");
        const write = (name, r) => {
            writeFileSync(join(dir, name), JSON.stringify(r));
            return join(dir, name);
        };
        const old = write("old.json", results([{ id: "a--one", status: "unchanged", capture: hash("1") }]));
        const same = write("same.json", results([{ id: "a--one", status: "unchanged", capture: hash("1") }]));
        const other = write("other.json", results([{ id: "a--one", status: "changed", capture: hash("2") }]));

        const ok = run("--project", "graphty-element", old, same);
        expect(ok.status).toBe(0);
        expect(JSON.parse(ok.stdout.trim())).toEqual({
            summary: { project: "graphty-element", compared: 1, same: 1, different: 0 },
        });

        const bad = run("--project", "graphty-element", old, other);
        expect(bad.status).toBe(1);
        const lines = bad.stdout
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        expect(lines[0]).toMatchObject({ file: "a--one.png", problem: "different bytes" });
        expect(lines[1].summary.different).toBe(1);

        expect(run("--project", "graphty", old, same).status).toBe(2);
        expect(run("--project", "graphty-element", old).status).toBe(2);
    });
});
