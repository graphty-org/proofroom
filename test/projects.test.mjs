import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PROJECTS = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
const CI = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

// The `visual` job's matrix: "- project: <name>" followed by "artifact: <name>".
function visualMatrix() {
    const job = CI.slice(CI.indexOf("\n    visual:\n"));
    const include = job.slice(job.indexOf("include:"), job.indexOf("steps:"));
    return Object.fromEntries([...include.matchAll(/- project: (\S+)\s+artifact: (\S+)/g)].map((m) => [m[1], m[2]]));
}

// The `build` job alone, so a matching download step in a later job cannot stand in for its upload.
function buildJob() {
    const start = CI.indexOf("\n    build:\n");
    return CI.slice(start, CI.indexOf("\n    test:\n", start));
}

describe("projects.json", () => {
    it("lists exactly the projects the CI visual job captures, with the same Storybook artifact", () => {
        const fromRegistry = Object.fromEntries(Object.entries(PROJECTS).map(([name, p]) => [name, p.artifact]));
        expect(visualMatrix()).toEqual(fromRegistry);
    });

    it("names each project after its package directory, where CI downloads the Storybook", () => {
        for (const [name, p] of Object.entries(PROJECTS)) {
            expect(p.dir).toBe(name);
        }
    });

    it("points each project at a Storybook the build job uploads from that directory", () => {
        for (const p of Object.values(PROJECTS)) {
            expect(buildJob()).toMatch(
                new RegExp(
                    `uses: actions/upload-artifact@v4\\s+with:\\s+name: ${p.artifact}\\s+path: ${p.dir}/storybook-static/`,
                ),
            );
        }
    });

    // layout's 3D stories draw into a WebGL canvas, so its captures keep the viewport rather than
    // cropping to the content, which could resize the canvas and clear it. Its 17 stories captured
    // identically twice in a row without waiting for a stable frame. It is not seeded from master
    // until its two-run stability is measured with the pinned fonts (design.md, "Measurements
    // before each project's seed"); its 3D stories run a timed one-second tween.
    it("captures layout as a canvas project and does not seed it from master yet", () => {
        expect(PROJECTS.layout).toEqual({
            dir: "layout",
            artifact: "build-storybook-layout",
            workers: 4,
            stableFrame: false,
            canvas: true,
            seedFromMaster: false,
        });
    });

    // layout's stories import @graphty/layout, which resolves to layout/dist.
    it("builds layout before its Storybook, which imports the built package", () => {
        const layout = JSON.parse(readFileSync(new URL("../../layout/project.json", import.meta.url), "utf8"));
        expect(layout.targets["build-storybook"]?.dependsOn).toContain("build");
    });
});
