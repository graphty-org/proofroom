/*
 * The changes pane's model (design section 3): each row state's mark and words from the server's
 * target summaries, the seven sections, Sort, Find, Next change, and the address the page reads
 * and writes, including today's page's links.
 */

import { describe, expect, it } from "vitest";

import { formatAddress, parseAddress, snapParts } from "../../trusted/page/next/address.js";
import { SECTIONS, changeOf, matchesFind, nextNeeding, sectionsOf, sharesOf } from "../../trusted/page/next/changes.js";
import { fiftyChanges, project, target } from "./fixtures.mjs";

const AT = { defaultBranch: "master", now: Date.UTC(2026, 9, 26, 12, 0, 0) };
const rowOf = (t, at = {}) => changeOf(t, { ...AT, ...at });

describe("row states", () => {
    const rows = new Map(fiftyChanges().map((t) => [t.id, rowOf(t)]));
    // [change, section, mark, words]
    const STATES = [
        ["3484", "needs", "open", "3 undecided"],
        ["3482", "needs", "half", "31 of 60 decided"],
        ["3480", "decided", "full", "9 decided, not finished"],
        ["3478", "busy", "down", "Downloading: 2 of 3 projects (68 MB)"],
        ["3477", "busy", "spin", "Capturing on CI, 2 of 3 projects"],
        ["3476", "notready", "failed", "Capture failed: graphty, 3 stories"],
        ["3475", "notready", "failed", "Incomplete: 2 of 3 projects"],
        ["3474", "nothing", "accept", "Finished, signed"],
        ["3473", "nothing", null, "No differences"],
        ["3472", "drafts", "open", "5 undecided"],
        ["local", "look", "eye", "Look only: 22 to view"],
    ];
    it.each(STATES)("%s: %s, %s, %s", (id, section, mark, words) => {
        const r = rows.get(id);
        expect(r.section).toBe(section);
        expect(r.mark?.[0] ?? null).toBe(mark);
        expect(r.count).toBe(words);
    });

    it("tags each kind of change, and names a seed by the default branch", () => {
        expect(rows.get("3486").kind).toBe("PR");
        expect(rows.get("local").kind).toBe("preview");
        expect(rows.get("master").kind).toBe("seed");
        expect(rows.get("master").branch).toBe("master at 6dfc21d");
        expect(rows.get("local").source).toBe("this machine");
        expect(rows.get("3486").source).toBe("CI");
    });

    it("gives every badge: behind, pending push, CI pending, stale, shares", () => {
        const text = (id) => rows.get(id).badges.map((b) => b.text);
        expect(text("3485")).toEqual(["behind master"]);
        expect(text("3481")).toEqual(["pending push"]);
        expect(text("3471")).toEqual(["CI pending"]);
        expect(text("3483")).toEqual(["Changed on master: 3 newer baselines"]);
        const shares = sharesOf([{ ids: ["3486", "3471"], prs: [3486, 3471], shared: Array(14).fill("x") }]);
        expect(rowOf(fiftyChanges()[0], { shares }).badges.map((b) => b.text)).toEqual([
            "shares 14 baselines with #3471",
        ]);
    });

    it("offers Dismiss on a finished row until it is dismissed", () => {
        const t = fiftyChanges().find((x) => x.id === "3474");
        expect(rowOf(t).dismissable).toBe(true);
        expect(rowOf(t, { dismissed: new Set([rowOf(t).dismissKey]) }).dismissable).toBe(false);
    });

    it("says how long ago the capture was ready, from minutes to days", () => {
        const ago = (ms) => rowOf(target(1, { readyAt: new Date(AT.now - ms).toISOString() })).age;
        expect(ago(4 * 60000)).toBe("4 min ago");
        expect(ago(6 * 3600000)).toBe("6 h ago");
        expect(ago(3 * 86400000)).toBe("3 d ago");
        expect(rowOf(target(1, { readyAt: null })).age).toBe(null);
        // Not a time: no age, not a guess (Date.parse reads "attempt 1" as a year).
        expect(rowOf(target(1, { readyAt: "attempt 1" })).age).toBe(null);
    });
});

describe("sections", () => {
    const rows = fiftyChanges().map((t) => rowOf(t));

    it("come in the design's order, every row in exactly one", () => {
        expect(SECTIONS.map((s) => s[1])).toEqual([
            "Needs you",
            "Decided, not finished",
            "Capturing or downloading",
            "Not ready",
            "Look only",
            "Nothing to decide",
            "Drafts",
        ]);
        const s = sectionsOf(rows, "needs");
        expect([...s.values()].reduce((n, l) => n + l.length, 0)).toBe(50);
        // Nothing to decide and Drafts start collapsed; the rest open.
        expect(SECTIONS.filter((x) => !x[2]).map((x) => x[0])).toEqual(["nothing", "drafts"]);
    });

    it("put the fewest snapshots first in Needs you, then the longest waiting", () => {
        const a = rowOf(target(1, { readyAt: "2026-10-26T10:00:00Z", projects: [project("p", { reviewable: 5 })] }));
        const b = rowOf(target(2, { readyAt: "2026-10-26T09:00:00Z", projects: [project("p", { reviewable: 5 })] }));
        const c = rowOf(target(3, { projects: [project("p", { reviewable: 2 })] }));
        expect(
            sectionsOf([a, b, c], "needs")
                .get("needs")
                .map((r) => r.id),
        ).toEqual(["3", "2", "1"]);
    });

    it("sort by Newest, Most undecided and Author", () => {
        const a = rowOf(
            target(1, { author: "b", readyAt: "2026-10-26T10:00:00Z", projects: [project("p", { reviewable: 5 })] }),
        );
        const b = rowOf(
            target(2, { author: "a", readyAt: "2026-10-26T11:00:00Z", projects: [project("p", { reviewable: 9 })] }),
        );
        const order = (sort) =>
            sectionsOf([a, b], sort)
                .get("needs")
                .map((r) => r.id);
        expect(order("newest")).toEqual(["2", "1"]);
        expect(order("most")).toEqual(["2", "1"]);
        expect(order("author")).toEqual(["2", "1"]);
        expect(order("needs")).toEqual(["1", "2"]);
    });

    it("Find matches number, title, branch and author", () => {
        const r = rowOf(target(3486, { title: "Storybook 9 upgrade", branch: "feat/sb9", author: "apowers" }));
        for (const q of ["3486", "#3486", "storybook", "SB9", "apow"]) {
            expect(matchesFind(r, q), q).toBe(true);
        }
        expect(matchesFind(r, "zzzz")).toBe(false);
        expect(
            sectionsOf(rows, "needs", "storybook")
                .get("needs")
                .map((x) => x.id),
        ).toEqual(["3486"]);
    });
});

describe("Next change", () => {
    const rows = fiftyChanges().map((t) => rowOf(t));
    const needs = sectionsOf(rows, "needs")
        .get("needs")
        .map((r) => r.id);

    it("goes to the next change that needs you, in the order shown, skipping look-only previews", () => {
        expect(nextNeeding(rows, "needs", null).id).toBe(needs[0]);
        expect(nextNeeding(rows, "needs", needs[0]).id).toBe(needs[1]);
        // From the last, round to the first; from one not in Needs you, the first.
        expect(nextNeeding(rows, "needs", needs.at(-1)).id).toBe(needs[0]);
        expect(nextNeeding(rows, "needs", "local").id).toBe(needs[0]);
        expect(needs).not.toContain("local");
    });

    it("finds none when nothing else needs you", () => {
        const one = [rowOf(target(1))];
        expect(nextNeeding(one, "needs", "1")).toBe(null);
        expect(nextNeeding([], "needs", null)).toBe(null);
    });
});

describe("the address", () => {
    it("writes and reads the change and the snapshot by its file", () => {
        const hash = formatAddress({ token: "tok", change: "3486", snap: "graphty-element/a--b.png" });
        expect(hash).toBe("#token=tok&change=3486&snap=graphty-element%2Fa--b.png");
        const back = parseAddress(hash);
        expect([back.token, back.change, back.snap, back.old]).toEqual([
            "tok",
            "3486",
            "graphty-element/a--b.png",
            false,
        ]);
        expect(snapParts(back.snap)).toEqual({ project: "graphty-element", file: "a--b.png" });
        expect(formatAddress({})).toBe("#");
    });

    it("converts today's page's links from pull request comments", () => {
        const old = parseAddress(
            "#token=tok&target=3486&project=graphty-element&filter=changed&q=menu&item=menu--open.png&view=spotlight&zoom=2&box=on&baseline=off&blink=off",
        );
        expect(old).toMatchObject({
            old: true,
            token: "tok",
            change: "3486",
            project: "graphty-element",
            snap: "graphty-element/menu--open.png",
            show: "changed",
            find: "menu",
            view: "spotlight",
            zoom: "2",
            outline: "on",
            base: "off",
        });
        // A link to a target alone opens the change.
        expect(parseAddress("#token=tok&target=master")).toMatchObject({ old: true, change: "master", snap: null });
    });
});
