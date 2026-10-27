// The review page reads a run's final capture (visual-final-<project>-<attempt>) when the run has
// one: the result of shooting its changed stories twice, which is what its promotion is gated on.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { downloadCaptures } from "../trusted/lib/github.mjs";
import { fakeGh } from "./helpers.mjs";

// fakeGh serves the fixture for a visual-<project>-<attempt> name; a final one is the same fixture,
// marked so the test can tell which artifact was downloaded
const withFinal = (artifacts) => {
    const inner = fakeGh({ artifacts: { 1000: artifacts } });
    const downloaded = [];
    const gh = (args, input) => {
        if (args[0] === "run" && args[1] === "download") {
            downloaded.push(args[4]);
            const plain = args.with(4, args[4].replace(/^visual-final-/, "visual-"));
            return inner(plain, input);
        }
        return inner(args, input);
    };
    return { gh, downloaded };
};

describe("downloadCaptures and a run's final capture", () => {
    it("takes the newest final capture over the first shot, and counts no 'final-' project", async () => {
        const { gh, downloaded } = withFinal([
            "visual-compact-mantine-1",
            "visual-final-compact-mantine-1",
            "visual-final-compact-mantine-2",
        ]);
        const others = [];
        const tmp = mkdtempSync(join(tmpdir(), "final-capture-"));
        const out = await downloadCaptures(gh, { id: 1000 }, ["compact-mantine"], tmp, others);
        expect(downloaded).toEqual(["visual-final-compact-mantine-2"]);
        expect(out["compact-mantine"].attempt).toBe(2);
        expect(out["compact-mantine"].dir).toBe(join(tmp, "1000-2-final", "compact-mantine"));
        expect(
            JSON.parse(readFileSync(join(out["compact-mantine"].dir, "results.json"), "utf8")).items.length,
        ).toBeGreaterThan(0);
        expect(others).toEqual([]);
    });

    it("takes the first shot when the run kept no final capture", async () => {
        const { gh, downloaded } = withFinal(["visual-compact-mantine-1"]);
        const tmp = mkdtempSync(join(tmpdir(), "final-capture-"));
        await downloadCaptures(gh, { id: 1000 }, ["compact-mantine"], tmp);
        expect(downloaded).toEqual(["visual-compact-mantine-1"]);
    });
});
