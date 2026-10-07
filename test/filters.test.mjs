import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { approvalIndex, clusters, isNoise, knownNoise, observations, signature } from "../trusted/lib/filters.mjs";
import { FIXTURE } from "./helpers.mjs";
import { approve, makeKey } from "./passkey-vectors.mjs";

// Every changed item of a real CI run, as [file, status, size, baselineSize, changedPixels, bbox].
const real = (name) =>
    JSON.parse(readFileSync(join(FIXTURE, "..", "clusters", `${name}.json`), "utf8")).items.map(
        ([file, status, size, baselineSize, changedPixels, bbox]) => ({
            file,
            status,
            size,
            baselineSize,
            changedPixels,
            bbox,
        }),
    );

const changed = (file, changedPixels, bbox, extra = {}) => ({
    file,
    status: "changed",
    size: [2400, 1800],
    baselineSize: [2400, 1800],
    changedPixels,
    bbox,
    ...extra,
});

describe("grouped review", () => {
    it("turns #1356's 388 changes, all in the eruda button's box at the top right, into one cluster", () => {
        const items = real("pr1356-graphty");
        expect(items).toHaveLength(388);
        const { clusters: found, outliers } = clusters(items);
        expect(outliers).toEqual([]);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ signature: "pixels top-right small", pixels: [826, 5566] });
        expect(found[0].files).toHaveLength(388);
        // The representative is the member with the most changed pixels: the worst case.
        const rep = items.find((i) => i.file === found[0].representative);
        expect(rep.changedPixels).toBe(5566);
    });

    it("turns #1370 into a handful of clusters per project, with the few that fit none listed apart", () => {
        const element = clusters(real("pr1370-graphty-element"));
        expect(element.clusters.map((c) => [c.signature, c.files.length])).toEqual([
            ["speck middle-center any", 64],
            ["pixels middle-center medium", 39],
            ["pixels middle-center large", 20],
            ["pixels top-center medium", 12],
            ["speck top-center any", 12],
            ["pixels middle-center small", 3],
            ["speck top-right any", 2],
        ]);
        expect(element.outliers).toHaveLength(4);
        const app = clusters(real("pr1370-graphty"));
        expect(app.clusters.map((c) => c.files.length)).toEqual([90, 62, 2]);
        expect(app.outliers).toEqual([]);
    });

    it("never clusters what is not a pixel change of the same story, and splits a band at a tenfold jump", () => {
        expect(signature({ ...changed("a.png", 10, [0, 0, 5, 5]), status: "new" })).toBeNull();
        expect(signature(changed("a.png", 10, [0, 0, 5, 5], { from: "old" }))).toBeNull();
        expect(signature(changed("a.png", 900, [0, 0, 5, 5], { size: [2400, 2000] }))).toBe("size whole any");
        expect(signature(changed("a.png", 900, [2300, 1700, 40, 40]))).toBe("pixels bottom-right small");
        const items = [
            changed("a.png", 100, [0, 0, 40, 40]),
            changed("b.png", 300, [0, 0, 40, 40]),
            changed("c.png", 5000, [0, 0, 40, 40]),
            changed("d.png", 9000, [0, 0, 40, 40]),
            changed("e.png", 1e6, [0, 0, 40, 40]),
            { file: "f.png", status: "new" },
        ];
        const { clusters: found, outliers } = clusters(items);
        expect(found.map((c) => c.files)).toEqual([
            ["a.png", "b.png"],
            ["c.png", "d.png"],
        ]);
        expect(outliers).toEqual(["e.png", "f.png"]);
    });
});

describe("known capture noise", () => {
    const target = (pr, changedFiles, items, local = null) => ({
        pr,
        runId: pr * 10,
        changedFiles,
        projects: [{ project: "web", results: { local, items } }],
    });
    const packageOf = () => "packages/web";
    const item = (capture, baseline = "b") => ({ file: "x.png", status: "changed", capture, baseline });

    it("needs two pull requests that touch none of the story's package", () => {
        const one = observations(target(1, ["docs/a.md"], [item("c")]), packageOf);
        expect(one).toEqual([{ key: "web/x.png", pr: 1, run: 10, baseline: "b", capture: "c", untouched: true }]);
        expect(knownNoise(one).size).toBe(0);
        // A pull request that changes the package explains its own change: it is no proof.
        const touched = observations(target(2, ["packages/web/src/x.ts"], [item("d")]), packageOf);
        expect(knownNoise([...one, ...touched]).size).toBe(0);
        const two = observations(target(3, ["README.md"], [item("e")]), packageOf);
        expect(knownNoise([...one, ...touched, ...two]).get("web/x.png")).toEqual({
            prs: [1, 3],
            why: "untouched",
            hashes: ["c", "e"],
        });
    });

    it("counts a capture that flips between the same two images", () => {
        const a = observations(target(1, ["packages/web/a.ts"], [item("y", "x")]), packageOf);
        const b = observations(target(2, ["packages/web/b.ts"], [item("x", "y")]), packageOf);
        const noise = knownNoise([...a, ...b]).get("web/x.png");
        expect(noise).toMatchObject({ prs: [1, 2], why: "flip-flop" });
        // Labeled on a pull request that touches the package only for that same flip.
        expect(isNoise(noise, { baseline: "x", capture: "y" }, false)).toBe(true);
        expect(isNoise(noise, { baseline: "x", capture: "z" }, false)).toBe(false);
        expect(isNoise(noise, { baseline: "x", capture: "z" }, true)).toBe(true);
        expect(isNoise(undefined, { baseline: "x", capture: "y" }, true)).toBe(false);
    });

    it("takes no evidence from a local preview, a seed or a target whose changed files are unknown", () => {
        expect(observations(target(1, [], [item("c")], { describe: "local" }), packageOf)).toEqual([]);
        expect(observations({ ...target(1, [], [item("c")]), pr: null }, packageOf)).toEqual([]);
        expect(observations(target(1, null, [item("c")]), packageOf)).toEqual([]);
    });
});

describe("approved before", () => {
    const KEY = makeKey();
    const PATH = "visual-baselines/web/x.png";
    const record = (pr, items, at = "2026-10-01T00:00:00.000Z") => ({
        version: 2,
        pr,
        subject: {},
        items,
        rejects: [],
        reviewedAt: at,
    });
    const signed = (r) => ({ ...r, approval: approve(r, KEY) });
    const item = (to, extra = {}) => ({ path: PATH, from: "a", to, reason: null, ...extra });

    // A record read at tip `ref` (every one of these at its own tip, unless given).
    const row = (n, rec, main, ref = n.repeat(40)) => ({
        ref,
        commit: n.repeat(40),
        path: `r/${n}.json`,
        record: rec,
        main,
    });
    const entry = (pr, n) => ({
        pr,
        commit: n.repeat(40),
        record: `r/${n}.json`,
        reviewedAt: "2026-10-01T00:00:00.000Z",
    });

    it("indexes the images of records the gate would accept, the default branch's first", () => {
        const index = approvalIndex(
            [
                row("1", signed(record(5, [item("h1")])), false),
                row("2", signed(record(6, [item("h1")])), true),
                // Unsigned once keys exist: never an approval.
                row("3", record(7, [item("h2")]), true),
                // An approval taken as approved before is not itself a source.
                row("4", signed(record(8, [item("h3", { approvedBefore: {} })])), true),
            ],
            [KEY.entry],
        );
        expect([...index]).toEqual([[`${PATH} h1`, entry(6, "2")]]);
    });

    it("before a passkey is registered, takes unsigned records only from the default branch", () => {
        const onMaster = [row("1", record(5, [item("h1")]), true)];
        expect([...approvalIndex(onMaster, null)]).toEqual([[`${PATH} h1`, entry(5, "1")]]);
        // A record anyone with push access could put on a pull request's branch counts for nothing.
        expect(approvalIndex([row("2", record(6, [item("h1")]), false)], null).size).toBe(0);
        expect(approvalIndex(onMaster, [KEY.entry]).size).toBe(0);
        // Signed, a pull request's record counts once passkeys are registered.
        expect(approvalIndex([row("2", signed(record(6, [item("h1")])), false)], [KEY.entry]).size).toBe(1);
    });

    it("drops an approval the owner later replaced or rejected for that path where it lives", () => {
        const tip = "9".repeat(40);
        const at = (n, rec) => row(n, signed(rec), false, tip);
        const first = at("1", record(5, [item("h1")]));
        expect(approvalIndex([first], [KEY.entry]).size).toBe(1);
        // A later record on the same branch accepting another image for the path replaces it.
        const replaced = approvalIndex([first, at("2", record(5, [item("h2")]))], [KEY.entry]);
        expect([...replaced.keys()]).toEqual([`${PATH} h2`]);
        // A later reject of the path leaves nothing approved there.
        const rejected = { ...record(5, []), rejects: [{ path: PATH, capture: "h1", reason: "no" }] };
        expect(approvalIndex([first, at("2", rejected)], [KEY.entry]).size).toBe(0);
        // A record elsewhere (another branch) does not replace it.
        expect(approvalIndex([first, row("3", signed(rejected), false)], [KEY.entry]).size).toBe(1);
    });
});
