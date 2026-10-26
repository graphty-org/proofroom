import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { sha256 } from "../trusted/lib/compare.mjs";
import { parity, readResults, samePixels } from "../trusted/lib/parity.mjs";

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

    it("agrees on two unchanged captures whose pixels are exactly the same baseline's", () => {
        const item = (capture, exact) => ({ id: "a--one", status: "unchanged", capture, exact });
        const withExact = (r, exact) => ({ ...r, items: r.items.map((i) => ({ ...i, exact })) });
        const first = results([item(hash("b"))]);
        const second = withExact(results([item(hash("2"))]), true);
        expect(parity(first, second).differences).toEqual([]);
        expect(parity(first, withExact(second, false)).differences[0].problem).toBe("different bytes");
        expect(parity(first, withExact(second, undefined)).differences[0].problem).toBe("different bytes");
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

/**
 * A 3-row PNG of a fixed gradient, encoded with the given settings.
 * @param {object} options pngjs encoder options (deflateLevel, filterType) and the width
 * @param {number} [options.width] the width, 4 unless given
 * @param {(data: Buffer) => void} [edit] changes the RGBA pixels before encoding
 * @returns {Buffer} the PNG bytes
 */
function png({ width = 4, ...options }, edit = () => {}) {
    const image = new PNG({ width, height: 3 });
    for (let i = 0; i < image.data.length; i++) {
        image.data[i] = (i * 37) % 256;
    }
    edit(image.data);
    return PNG.sync.write(image, options);
}

describe("samePixels", () => {
    const file = "a--one.png";
    /**
     * Lays out two capture directories the way capture.mjs and the story tests do: the first side
     * found the story unchanged (no image written), the second wrote its capture and the baseline.
     * @param {Buffer} baseline the first side's capture, which is the baseline
     * @param {Buffer} capture the second side's capture
     * @returns {Promise<object>} what samePixels says
     */
    const check = (baseline, capture) => {
        const old = tempDir("parity-old-");
        const now = tempDir("parity-new-");
        mkdirSync(join(now, "baselines"));
        writeFileSync(join(now, file), capture);
        writeFileSync(join(now, "baselines", file), baseline);
        const first = results([{ id: "a--one", status: "unchanged", capture: sha256(baseline) }]);
        const second = results([{ id: "a--one", status: "changed", capture: sha256(capture) }]);
        return samePixels(parity(first, second), [old, now]);
    };

    it("counts two encodings of the same pixels as the same", async () => {
        const a = png({ deflateLevel: 0, filterType: 0 });
        const b = png({ deflateLevel: 9, filterType: 4 });
        expect(sha256(a)).not.toBe(sha256(b));
        expect(await check(a, b)).toEqual({ compared: 1, same: 1, differences: [] });
    });

    it("reports one changed pixel, and a different size", async () => {
        const a = png({ deflateLevel: 0 });
        const changed = await check(
            a,
            png({ deflateLevel: 9 }, (data) => (data[5] ^= 1)),
        );
        expect(changed.same).toBe(0);
        expect(changed.differences[0]).toMatchObject({ file, problem: "different pixels", changedPixels: 1 });
        const wider = await check(a, png({ width: 5 }));
        expect(wider.differences[0]).toMatchObject({ file, problem: "different size" });
    });

    it("keeps different bytes when an image is not in either directory", async () => {
        const r = parity(
            results([{ id: "a--one", status: "unchanged", capture: hash("1") }]),
            results([{ id: "a--one", status: "changed", capture: hash("2") }]),
        );
        const dir = tempDir("parity-none-");
        expect((await samePixels(r, [dir, dir])).differences[0].problem).toBe("different bytes");
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
