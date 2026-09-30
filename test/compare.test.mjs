import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { classify, compareImages, isLfsPointer, readBaseline, sha256 } from "../trusted/lib/compare.mjs";

/**
 * Encodes a width x height PNG filled with `fill` ([r, g, b]), then applies `edits`.
 * @param {number} width in pixels
 * @param {number} height in pixels
 * @param {number[]} fill the background colour
 * @param {(set: (x: number, y: number, rgb: number[]) => void) => void} [edits] paints pixels
 * @returns {Buffer} the encoded PNG
 */
function png(width, height, fill, edits) {
    const img = new PNG({ width, height });
    const set = (x, y, [r, g, b]) => img.data.set([r, g, b, 255], (y * width + x) * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            set(x, y, fill);
        }
    }
    edits?.(set);
    return PNG.sync.write(img);
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const OPTS = { threshold: 0.063, includeAA: false };

describe("compareImages", () => {
    it("reports equal bytes as unchanged without decoding them", () => {
        // A valid header over zeroed image data: decoding it would throw, so passing means the
        // hash alone decided (and the size came from the header).
        const bytes = png(8, 8, WHITE).fill(0, 33);
        expect(() => PNG.sync.read(bytes)).toThrow();
        const r = compareImages(bytes, Buffer.from(bytes), OPTS);
        expect(r).toMatchObject({ status: "unchanged", changedPixels: 0, bbox: null, size: [8, 8] });
        expect(r.baseline).toBe(sha256(bytes));
        expect(r.capture).toBe(r.baseline);
    });

    it("counts one pixel changed above the threshold and boxes it", () => {
        const base = png(8, 8, WHITE);
        const cap = png(8, 8, WHITE, (set) => set(3, 5, BLACK));
        expect(compareImages(base, cap, OPTS)).toMatchObject({
            status: "changed",
            changedPixels: 1,
            bbox: [3, 5, 1, 1],
            size: [8, 8],
            baselineSize: [8, 8],
        });
    });

    it("treats a change under the threshold as unchanged", () => {
        const base = png(8, 8, WHITE);
        const cap = png(8, 8, WHITE, (set) => set(3, 5, [250, 250, 250]));
        const r = compareImages(base, cap, OPTS);
        expect(r).toMatchObject({ status: "unchanged", changedPixels: 0, bbox: null });
        expect(r.capture).not.toBe(r.baseline);
    });

    it("pads different sizes to the larger one, top-left, and counts the padding", () => {
        const base = png(4, 4, WHITE);
        const cap = png(4, 6, WHITE);
        expect(compareImages(base, cap, OPTS)).toMatchObject({
            status: "changed",
            changedPixels: 8,
            bbox: [0, 4, 4, 2],
            size: [4, 6],
            baselineSize: [4, 4],
        });
        // Wider baseline, taller capture: everything outside the 3 x 3 overlap is padding.
        const r = compareImages(png(5, 3, WHITE), png(3, 5, WHITE), OPTS);
        expect(r).toMatchObject({ changedPixels: 25 - 9, bbox: [0, 0, 5, 5] });
    });

    it("ignores an anti-aliased edge pixel unless includeAA is set", () => {
        // A vertical black/white edge; the capture greys one pixel on it, as anti-aliasing does.
        const edge = (set) => {
            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 4; x++) {
                    set(x, y, BLACK);
                }
            }
        };
        const base = png(8, 8, WHITE, edge);
        const cap = png(8, 8, WHITE, (set) => {
            edge(set);
            set(4, 4, [128, 128, 128]);
        });
        expect(compareImages(base, cap, OPTS)).toMatchObject({ status: "unchanged", changedPixels: 0 });
        expect(compareImages(base, cap, { ...OPTS, includeAA: true })).toMatchObject({
            status: "changed",
            changedPixels: 1,
            bbox: [4, 4, 1, 1],
        });
    });
});

describe("classify", () => {
    const base = png(8, 8, WHITE);
    const a = png(8, 8, WHITE, (set) => set(1, 1, BLACK));
    const b = png(8, 8, WHITE, (set) => set(6, 6, BLACK));

    it("capture equal to the baseline is unchanged", () => {
        expect(classify({ baseline: base, first: Buffer.from(base), ...OPTS })).toMatchObject({
            status: "unchanged",
            flaky: false,
        });
    });

    it("two agreeing captures that differ are changed, or new without a baseline", () => {
        expect(classify({ baseline: base, first: a, second: Buffer.from(a), ...OPTS })).toMatchObject({
            status: "changed",
            flaky: false,
            changedPixels: 1,
            bbox: [1, 1, 1, 1],
            capture: sha256(a),
        });
        expect(classify({ baseline: null, first: a, second: Buffer.from(a), ...OPTS })).toMatchObject({
            status: "new",
            baseline: null,
            capture: sha256(a),
            size: [8, 8],
            baselineSize: null,
        });
    });

    it("a first capture that differs and a second that matches is unchanged and flaky", () => {
        expect(classify({ baseline: base, first: a, second: Buffer.from(base), ...OPTS })).toMatchObject({
            status: "unchanged",
            flaky: true,
            capture: sha256(base),
        });
    });

    it("two captures that differ from the baseline and from each other are unstable", () => {
        expect(classify({ baseline: base, first: a, second: b, ...OPTS })).toMatchObject({
            status: "unstable",
            flaky: false,
        });
        expect(classify({ baseline: null, first: a, second: b, ...OPTS })).toMatchObject({ status: "unstable" });
    });

    it("a baseline with no story is removed", () => {
        expect(classify({ baseline: base, first: null, ...OPTS })).toMatchObject({
            status: "removed",
            baseline: sha256(base),
            capture: null,
            baselineSize: null,
        });
    });

    it("a single capture that differs is changed (a local run captures once)", () => {
        expect(classify({ baseline: base, first: a, ...OPTS })).toMatchObject({ status: "changed" });
    });

    it("no baseline and the same as master's capture is unseeded; different from it is new", () => {
        expect(classify({ baseline: null, first: a, reference: Buffer.from(a), ...OPTS })).toMatchObject({
            status: "unseeded",
            baseline: null,
            capture: sha256(a),
            size: [8, 8],
        });
        expect(classify({ baseline: null, first: a, reference: b, ...OPTS })).toMatchObject({ status: "new" });
        // A reference never applies where a baseline exists: the baseline decides.
        expect(classify({ baseline: base, first: a, reference: a, ...OPTS })).toMatchObject({ status: "changed" });
    });

    it("a renamed story that looks as its old id's baseline is moved; one that differs is changed", () => {
        const moved = { baseline: base, moved: true, ...OPTS };
        expect(classify({ ...moved, first: Buffer.from(base) })).toMatchObject({ status: "moved", flaky: false });
        expect(classify({ ...moved, first: a, second: Buffer.from(base) })).toMatchObject({
            status: "moved",
            flaky: true,
            capture: sha256(base),
        });
        expect(classify({ ...moved, first: a, second: Buffer.from(a) })).toMatchObject({
            status: "changed",
            changedPixels: 1,
        });
        expect(classify({ ...moved, first: a, second: b })).toMatchObject({ status: "unstable" });
    });
});

describe("Git LFS pointers", () => {
    const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 687\n`;

    it("tells a pointer file from a PNG", () => {
        expect(isLfsPointer(Buffer.from(POINTER))).toBe(true);
        expect(isLfsPointer(png(8, 8, WHITE))).toBe(false);
        expect(isLfsPointer(Buffer.alloc(0))).toBe(false);
    });

    it("refuses a baseline that is a pointer, reads a PNG, and returns null for none", async () => {
        const dir = mkdtempSync(join(tmpdir(), "vr-lfs-"));
        writeFileSync(join(dir, "pointer.png"), POINTER);
        writeFileSync(join(dir, "real.png"), png(8, 8, WHITE));
        await expect(readBaseline(join(dir, "pointer.png"))).rejects.toThrow(
            /pointer.png: baseline is an LFS pointer; run git lfs pull/,
        );
        expect(await readBaseline(join(dir, "real.png"))).toEqual(png(8, 8, WHITE));
        expect(await readBaseline(join(dir, "missing.png"))).toBeNull();
    });
});
