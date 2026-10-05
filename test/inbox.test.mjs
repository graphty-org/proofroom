import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inboxOf, message, notifyOnce, notifyStep } from "../trusted/lib/inbox.mjs";

const project = (name, extra = {}) => ({ project: name, problem: null, downloading: false, undecided: 0, ...extra });
const target = (pr, projects, extra = {}) => ({
    id: String(pr),
    pr,
    title: `PR ${pr}`,
    url: `https://gh/pull/${pr}`,
    headSha: `${pr}`.repeat(4),
    unpublished: 0,
    projects,
    ...extra,
});

describe("inboxOf", () => {
    const targets = [
        target(1, [project("a", { undecided: 5 }), project("b")]),
        target(2, [project("a", { undecided: 2, preview: true }), project("b", { preview: true })]),
        target(3, [project("a", { undecided: 1 }), project("b", { downloading: true })]),
        target(4, [project("a", { problem: "capture failed", logUrl: "https://gh/job/a" }), project("b")]),
        target(5, [project("a", { problem: "download failed: boom; reload the page to retry" }), project("b")]),
        target(6, [project("a", { problem: "waiting for CI on 1234567890" }), project("b")]),
        target(7, [project("a"), project("b", { problem: "no capture" })]),
        target(8, [project("a"), project("b")], { unpublished: 3 }),
        target(null, [project("a", { undecided: 9 })], { id: "master" }),
        target(9, [project("a", { undecided: 9 })], { local: true }),
    ];

    it("lists complete pull requests with images to decide first, fewest first, then partial ones", () => {
        const inbox = inboxOf(targets, { now: 1000 });
        expect(inbox.ready.map((r) => [r.pr, r.undecided, r.complete])).toEqual([
            [8, 0, true],
            [2, 2, true],
            [1, 5, true],
            [3, 1, false],
        ]);
        expect(inbox.ready.find((r) => r.pr === 2).source).toBe("local preview");
        expect(inbox.ready.find((r) => r.pr === 1).source).toBe("CI");
        expect(inbox.ready.find((r) => r.pr === 3)).toMatchObject({ loaded: 1, total: 2, since: 1000 });
    });

    it("sets failed captures apart with their reason, and counts the rest", () => {
        const inbox = inboxOf(targets, { now: 1000 });
        expect(inbox.notReady).toEqual([
            expect.objectContaining({
                pr: 4,
                project: "a",
                reason: "capture failed",
                retry: false,
                logUrl: "https://gh/job/a",
            }),
            expect.objectContaining({ pr: 5, reason: "download failed: boom", retry: true }),
        ]);
        expect(inbox).toMatchObject({ capturing: 1, done: 1 });
    });

    it("keeps when a pull request became ready, and orders equal counts by it", () => {
        const two = [target(1, [project("a", { undecided: 1 })]), target(2, [project("a", { undecided: 1 })])];
        const since = new Map([["2@2222", 5]]);
        expect(inboxOf(two, { now: 50, since }).ready.map((r) => [r.pr, r.since])).toEqual([
            [2, 5],
            [1, 50],
        ]);
    });
});

describe("the notifier", () => {
    const ready = (pr, undecided = 1, extra = {}) => ({
        pr,
        title: `PR ${pr}`,
        headSha: `h${pr}`,
        undecided,
        complete: true,
        ...extra,
    });
    const MIN = 60000;

    it("announces the first at once, holds the next ones for the gap, then sends them together", () => {
        let s = { notified: [], lastAt: 0 };
        let step = notifyStep(s, { ready: [ready(1)] }, 100 * MIN, 10 * MIN);
        expect(step.fresh.map((r) => r.pr)).toEqual([1]);
        s = step.state;
        step = notifyStep(s, { ready: [ready(1), ready(2)] }, 103 * MIN, 10 * MIN);
        expect(step.fresh).toEqual([]);
        step = notifyStep(step.state, { ready: [ready(1), ready(2), ready(3)] }, 106 * MIN, 10 * MIN);
        expect(step.fresh).toEqual([]);
        step = notifyStep(step.state, { ready: [ready(1), ready(2), ready(3)] }, 110 * MIN, 10 * MIN);
        expect(step.fresh.map((r) => r.pr)).toEqual([2, 3]);
        // Nothing new: nothing sent, however long it waits.
        expect(notifyStep(step.state, { ready: [ready(1), ready(2), ready(3)] }, 200 * MIN, 10 * MIN).fresh).toEqual(
            [],
        );
    });

    it("never announces a partial capture or one only waiting for Finish, and again only after it left or was pushed", () => {
        const s0 = { notified: [], lastAt: 0 };
        const quiet = { ready: [ready(1, 2, { complete: false }), ready(2, 0)] };
        expect(notifyStep(s0, quiet, MIN, 0).fresh).toEqual([]);
        const once = notifyStep(s0, { ready: [ready(1)] }, MIN, 0).state;
        expect(notifyStep(once, { ready: [ready(1)] }, 2 * MIN, 0).fresh).toEqual([]);
        // Pushed again: a new head is a new announcement.
        expect(notifyStep(once, { ready: [ready(1, 1, { headSha: "new" })] }, 2 * MIN, 0).fresh).toHaveLength(1);
        // Left the list (decided, failed, capturing), then back.
        const left = notifyStep(once, { ready: [] }, 2 * MIN, 0).state;
        expect(notifyStep(left, { ready: [ready(1)] }, 3 * MIN, 0).fresh).toHaveLength(1);
    });

    it("writes one line per pull request and the inbox's address", () => {
        expect(message([ready(812, 2, { title: "Fix label padding" }), ready(9, 1)], "https://host:9000/")).toEqual({
            title: "Visual review: 2 ready",
            message: "#812 Fix label padding: 2 images\n#9 PR 9: 1 image\nhttps://host:9000/",
        });
    });

    it("runs the command without a shell, keeps what it sent, and ignores a stale inbox", async () => {
        const dir = mkdtempSync(join(tmpdir(), "vr-notify-"));
        const out = join(dir, "sent.json");
        const command = [
            process.execPath,
            "-e",
            "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
            out,
            "{title}",
            "{message}",
            "{url}",
        ];
        const inbox = { at: 1000, origin: "https://host:9000", ready: [ready(7, 3, { title: "a; rm -rf $HOME" })] };
        writeFileSync(join(dir, "inbox.json"), JSON.stringify(inbox));
        expect(await notifyOnce({ stateDir: dir, command, gap: 0, now: 11 * MIN, stale: 10 * MIN })).toEqual([]);
        const sent = await notifyOnce({ stateDir: dir, command, gap: 0, now: 2000 });
        expect(sent.map((r) => r.pr)).toEqual([7]);
        expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
            "Visual review: 1 ready",
            "#7 a; rm -rf $HOME: 3 images\nhttps://host:9000/",
            "https://host:9000/",
        ]);
        expect(JSON.parse(readFileSync(join(dir, "notify.json"), "utf8"))).toEqual({
            notified: ["7@h7"],
            lastAt: 2000,
        });
        expect(await notifyOnce({ stateDir: dir, command, gap: 0, now: 3000 })).toEqual([]);
    });

    it("tries again next time when the command fails", async () => {
        const dir = mkdtempSync(join(tmpdir(), "vr-notify-"));
        writeFileSync(join(dir, "inbox.json"), JSON.stringify({ at: 0, origin: "o", ready: [ready(1)] }));
        await expect(
            notifyOnce({ stateDir: dir, command: [process.execPath, "-e", "process.exit(1)"], now: 1, gap: 0 }),
        ).rejects.toThrow();
        expect(await notifyOnce({ stateDir: dir, command: [process.execPath, "-e", ""], now: 2, gap: 0 })).toHaveLength(
            1,
        );
    });
});
