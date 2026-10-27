/*
 * The server over the adapter fakes, with no gh runner at all: the changes list, the poll's
 * count of code host and capture store calls, a change's description, and a Finish whose
 * comment and commit status go to the code host.
 */

import { afterEach, describe, expect, it } from "vitest";

import { endedJob, startApp } from "./faults.mjs";
import { fakeCaptureStore } from "./fakes/capture-store.mjs";
import { fakeCodeHost } from "./fakes/code-host.mjs";
import { copyFixture, makeRepo, tempDir } from "./helpers.mjs";

const PROJECTS = ["compact-mantine", "graphty-element"];
const RUN = 1000;

let s = null;
afterEach(async () => {
    await s?.close();
    s = null;
});

/**
 * The fakes for `count` open changes of the repository's head, each with the same finished CI run
 * that captured both fixture projects.
 * @param {{ head: string }} r the repository
 * @param {number} [count] how many changes
 * @returns {{ codeHost: ReturnType<typeof fakeCodeHost>, captureStore: ReturnType<typeof fakeCaptureStore> }} the fakes
 */
function fakes(r, count = 1) {
    const at = { commit: r.head, headSha: r.head };
    const sets = Object.fromEntries(PROJECTS.map((p) => [p, copyFixture(p, tempDir(`vr-set-${p}-`), at).dir]));
    const changes = Array.from({ length: count }, (_, i) => ({
        number: 123 + i,
        title: `PR ${123 + i}`,
        url: `https://fake/changes/${123 + i}`,
        headSha: r.head,
        branch: "feature",
        draft: false,
        author: "octocat",
        run: { id: RUN, status: "completed", conclusion: "success", updatedAt: "2026-10-25T10:30:00Z" },
        visual: null,
    }));
    return {
        codeHost: fakeCodeHost({ changes }),
        captureStore: fakeCaptureStore({
            runs: [
                {
                    id: RUN,
                    attempt: 1,
                    status: "completed",
                    conclusion: "success",
                    url: "https://fake/runs/1000",
                    headSha: r.head,
                    updatedAt: "2026-10-25T10:30:00Z",
                },
            ],
            jobs: {
                [RUN]: Object.fromEntries(
                    PROJECTS.map((p) => [p, { conclusion: "success", url: `https://fake/job/${p}` }]),
                ),
            },
            sets: { [RUN]: sets },
        }),
    };
}

const count = (calls, name) => calls.filter((c) => c === name).length;

describe("the server over the adapters", () => {
    it("lists the code host's changes with the capture store's captures", async () => {
        const r = makeRepo();
        const f = fakes(r);
        s = await startApp(r, f);
        const { body } = await s.api("GET", "/api/prs");
        const [t] = body.targets;
        expect(t).toMatchObject({ id: "123", runId: RUN, author: "octocat" });
        const cm = t.projects.find((p) => p.project === "compact-mantine");
        expect(cm).toMatchObject({ problem: null, logUrl: "https://fake/job/compact-mantine" });
    });

    it("asks the code host once per poll at 50 changes, and the capture store again only for a run that changed", async () => {
        const r = makeRepo();
        const f = fakes(r, 50);
        s = await startApp(r, f);
        expect((await s.api("GET", "/api/prs")).body.targets).toHaveLength(50);
        expect(count(f.codeHost.calls, "listChanges")).toBe(1);
        const runs = count(f.captureStore.calls, "run");
        expect(runs).toBeGreaterThan(0);
        await s.api("GET", "/api/prs?refresh=1");
        expect(count(f.codeHost.calls, "listChanges")).toBe(2);
        // The run is as the last poll listed it, so it is not asked again.
        expect(count(f.captureStore.calls, "run")).toBe(runs);
        expect(f.codeHost.calls.filter((c) => c !== "listChanges")).toEqual([]);
    });

    it("describes a change through the code host, as the reviewer it names", async () => {
        const r = makeRepo();
        const f = fakes(r);
        s = await startApp(r, f);
        await s.api("GET", "/api/prs");
        const { status, body } = await s.api("GET", "/api/pr-context/123");
        expect(status).toBe(200);
        expect(body).toMatchObject({ title: "PR 123", owner: "owner", comments: [] });
        expect(f.codeHost.calls).toEqual(expect.arrayContaining(["whoAmI", "describe"]));
    });

    it("finishes through the code host: one comment with the reject and one commit status", async () => {
        const r = makeRepo();
        const f = fakes(r);
        s = await startApp(r, f);
        await s.api("GET", "/api/prs");
        const decide = (file, decision, reason = null) =>
            s.api("POST", "/api/decide", { id: "123", project: "compact-mantine", file, decision, reason });
        expect((await decide("badge--default.light.png", "accept")).status).toBe(200);
        expect((await decide("slider--sizes.png", "reject", "thumb moved")).status).toBe(200);
        expect((await s.api("POST", "/api/finish", { id: "123" })).status).toBe(202);
        const job = await endedJob(s);
        expect(job.error).toBeNull();
        const { commit } = job.result;
        expect(f.codeHost.posted.map((p) => p.kind)).toEqual(["comment", "status"]);
        expect(f.codeHost.posted[0]).toMatchObject({ number: 123 });
        expect(f.codeHost.posted[0].body).toContain("thumb moved");
        expect(f.codeHost.posted[1]).toMatchObject({ sha: commit, state: "failure" });
    });
});
