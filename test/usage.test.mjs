/*
 * Usage events: the config setting, what the server keeps of a page's batch and that it keeps
 * nothing when the setting is off, and the `usage` command's summary of a recorded log.
 */

import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeConfig } from "../trusted/lib/config.mjs";
import { createApp, usageLines } from "../trusted/lib/serve.mjs";
import { formatUsage, readUsage, summarize } from "../trusted/lib/usage.mjs";
import { CONFIG, isolateGit, makeRepo, tempDir } from "./helpers.mjs";

const TOKEN = "t".repeat(43);
const PROJECTS = { projects: { web: { storybook: "storybook-static" } } };

describe("usage: the config setting", () => {
    it("is off unless set, and takes only true or false", () => {
        expect(normalizeConfig(PROJECTS).usage).toBe(false);
        expect(normalizeConfig({ ...PROJECTS, usage: true }).usage).toBe(true);
        expect(() => normalizeConfig({ ...PROJECTS, usage: "yes" })).toThrow(/usage must be true or false/);
    });
});

describe("usage: what the server keeps", () => {
    const e = (extra = {}) => ({ type: "press", at: 1, s: "a", c: "Accept", ...extra });

    it("keeps small events as lines and drops one holding the token", () => {
        expect(usageLines([e(), e({ m: `x ${TOKEN} y` })], TOKEN)).toBe(`${JSON.stringify(e())}\n`);
    });

    it("refuses a batch that is not small usage events", () => {
        for (const bad of [
            null,
            {},
            Array.from({ length: 101 }, () => e()),
            [e({ type: "Bad type" })],
            [e({ at: "now" })],
            [e({ s: 1 })],
            [e({ m: "x".repeat(2000) })],
            [[1]],
        ]) {
            expect(usageLines(bad, TOKEN)).toBeNull();
        }
    });

    let server;
    afterEach(() => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve())));

    async function serve(usage) {
        isolateGit();
        const r = makeRepo();
        const tmp = join(r.repo, "tmp/visual-review");
        server = createServer();
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        server.on(
            "request",
            createApp({ repo: r.repo, tmp, config: { ...CONFIG, usage }, token: TOKEN, origin, gh: async () => "[]" }),
        );
        const call = (method, body) =>
            fetch(`${origin}/api/usage`, {
                method,
                headers: { "x-review-token": TOKEN, origin, "content-type": "application/json" },
                body: body && JSON.stringify(body),
            });
        return { call, file: join(tmp, "state/usage-events.jsonl") };
    }

    it("on: says so, and appends each batch", async () => {
        const { call, file } = await serve(true);
        expect(await (await call("GET")).json()).toEqual({ on: true });
        expect((await call("POST", { events: [e()] })).status).toBe(200);
        expect((await call("POST", { events: [e({ c: "Reject" })] })).status).toBe(200);
        expect(readUsage(file).map((x) => x.c)).toEqual(["Accept", "Reject"]);
        expect((await call("POST", { events: [e({ type: "" })] })).status).toBe(400);
    });

    it("off: says so, and writes nothing", async () => {
        const { call, file } = await serve(false);
        expect(await (await call("GET")).json()).toEqual({ on: false });
        expect((await call("POST", { events: [e()] })).status).toBe(404);
        expect(existsSync(file)).toBe(false);
    });
});

describe("usage: the summary", () => {
    // Two sessions: a mouse one deciding three items (one after a long look, one reached by going
    // back), and a touch one that meets an error and finishes.
    const M = "mouse-session";
    const T = "touch-session";
    const LOG = [
        { type: "load", at: 0, s: M, w: 1400, h: 900, dpr: 2, coarse: false, touch: 0 },
        { type: "controls", at: 1, s: M, c: ["Accept", "Reject", "Exclude", "Review"] },
        { type: "press", at: 2, s: M, c: "Review" },
        { type: "project", at: 3, s: M, id: 7, project: "web", items: 3, stale: 0 },
        { type: "item", at: 10, s: M, project: "web", file: "a.png", i: 0, n: 3, back: false },
        { type: "drawn", at: 20, s: M, file: "a.png", ms: 400 },
        { type: "press", at: 2000, s: M, c: "key-A" },
        {
            type: "decide",
            at: 2000,
            s: M,
            project: "web",
            file: "a.png",
            d: "accept",
            was: null,
            ms: 2000,
            view: "side",
        },
        { type: "item", at: 2001, s: M, project: "web", file: "b.png", i: 1, n: 3, back: false },
        { type: "set", at: 2500, s: M, key: "view", from: "side", to: "flash" },
        { type: "press", at: 22000, s: M, c: "Accept" },
        {
            type: "decide",
            at: 22000,
            s: M,
            project: "web",
            file: "b.png",
            d: "accept",
            was: null,
            ms: 20000,
            view: "flash",
        },
        { type: "item", at: 22001, s: M, project: "web", file: "a.png", i: 0, n: 3, back: true },
        {
            type: "undo",
            at: 23000,
            s: M,
            project: "web",
            file: "a.png",
            d: null,
            was: "accept",
            ms: 999,
            view: "flash",
        },
        { type: "idle", at: 143000, s: M, ms: 120000 },
        {
            type: "decide",
            at: 143000,
            s: M,
            project: "web",
            file: "a.png",
            d: "reject",
            was: null,
            ms: 4000,
            view: "flash",
            reasonLength: 9,
        },
        { type: "load", at: 200000, s: T, w: 1024, h: 1366, dpr: 2, coarse: true, touch: 5 },
        { type: "pointer", at: 200001, s: T, p: "touch" },
        { type: "project", at: 200002, s: T, id: 8, project: "app", items: 5, stale: 2 },
        { type: "decide", at: 200100, s: T, project: "app", d: "accept", n: 5, bulk: "all" },
        { type: "error", at: 200200, s: T, m: "Not saved: offline." },
        { type: "finish-start", at: 200300, s: T, id: 8 },
        { type: "finish-end", at: 260300, s: T, id: 8, kind: "finish", ok: true, ms: 60000 },
    ];

    it("sums up sessions, timing, controls, going back, hesitation, errors, stale captures and Finish", () => {
        const dir = tempDir("vr-usage-");
        const file = join(dir, "usage-events.jsonl");
        writeFileSync(file, `${LOG.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`);
        const s = summarize(readUsage(file));
        expect(s.sessions).toMatchObject({ n: 2, touch: 1, mouse: 1 });
        expect(s.sessions.list.map((x) => [x.pointer, x.items, x.decisions, x.viewport])).toEqual([
            ["mouse", 3, 3, "1400x900@2"],
            ["touch", 0, 5, "1024x1366@2"],
        ]);
        expect(s.items).toMatchObject({ shown: 3, distinct: 2, backtracked: 1 });
        expect(s.decisions).toMatchObject({
            n: 8,
            single: 3,
            bulk: 5,
            byDecision: { accept: 2, reject: 1 },
            undos: 1,
            hesitations: 1,
            timePerItem: { n: 3, median: 4000, p90: 20000 },
            byView: { side: { n: 1, median: 2000, p90: 2000 }, flash: { n: 2, median: 20000, p90: 20000 } },
        });
        // 8 decisions in 23 s of the mouse session (its 2-minute idle gap left out) and 60.3 s of the touch one.
        expect(s.decisions.perMinute).toBe(5.8);
        expect(s.views.switchesPerItem).toBeCloseTo(1 / 3);
        expect(s.controls.pressed).toEqual([
            { name: "Accept", n: 1 },
            { name: "Review", n: 1 },
        ]);
        expect(s.controls.keys).toEqual([{ name: "key-A", n: 1 }]);
        expect(s.controls.neverUsed).toEqual(["Exclude", "Reject"]);
        expect(s.errors).toMatchObject({ n: 1, perSession: 0.5 });
        expect(s.stale).toEqual({ projectsOpened: 2, stale: 1, rate: 0.5 });
        expect(s.finish).toMatchObject({ started: 1, completed: 1, failed: 0, duration: { median: 60000 } });
        expect(s.idle).toEqual({ gaps: 1, minutes: 2 });
        const text = formatUsage(s);
        for (const line of [
            "Sessions: 2 (1 touch, 1 mouse)",
            "backtracking 33%",
            "time per item: median 4.0 s, p90 20.0 s (3)",
            "Controls shown but never used: Exclude, Reject",
            "Stale captures: 1 of 2 projects opened (50%)",
            "Finish: 1 started, 1 completed, 0 failed",
        ]) {
            expect(text).toContain(line);
        }
        // --since leaves out what came before.
        expect(summarize(readUsage(file, 200000)).sessions.n).toBe(1);
    });

    it("says so when nothing was recorded", () => {
        const s = summarize(readUsage(join(tempDir("vr-usage-"), "none.jsonl")));
        expect(formatUsage(s)).toBe("No usage events recorded.");
    });
});
