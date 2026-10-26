/*
 * What the changes list answer (GET /api/prs) gives the new page beyond today's: the repository's
 * name for the top bar, and when CI last touched each pull request's capture run, for the row's
 * "4 min ago".
 */

import { afterEach, describe, expect, it } from "vitest";

import { startApp } from "./faults.mjs";
import { fakeGh, job, makeRepo, onePr } from "./helpers.mjs";

let s = null;
afterEach(async () => {
    await s?.close();
    s = null;
});

describe("the changes list answer", () => {
    it("names the repository and when each pull request's run was last updated", async () => {
        const r = makeRepo();
        s = await startApp(r, { gh: onePr()(r) });
        const { status, body } = await s.api("GET", "/api/prs");
        expect(status).toBe(200);
        // Named after origin (remote.git), not the checkout's folder.
        expect(body.repository).toBe("remote");
        // The fake gh's run says "attempt 1" where GitHub gives an ISO time; it is passed on as given.
        expect(body.targets.map((t) => [t.id, t.readyAt])).toEqual([["123", "attempt 1"]]);
    });

    it("gives no time for a pull request CI never ran on", async () => {
        const r = makeRepo();
        s = await startApp(r, {
            gh: fakeGh({
                prs: [{ number: 7, head: r.head, branch: "waiting" }],
                jobs: { 1000: [job("compact-mantine")] },
            }),
        });
        const { body } = await s.api("GET", "/api/prs");
        expect(body.targets.map((t) => [t.id, t.readyAt])).toEqual([["7", null]]);
    });
});
