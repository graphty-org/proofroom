/*
 * Finish on the new page (design section 7), by real input: Finish in the top bar and its summary
 * sheet (what it commits, posts and sets, the commit status in the server's own words, what signs
 * it, the undecided left with Go to the first undecided, Esc keeping everything), Finish... on a
 * row of Decided, not finished without opening the change, Finish all with its cost and one
 * failure stopping only its change, Queued rows, Remove from the run and Stop, the step list on the
 * changes row, a reload during a Finish, the sheet refusing when decisions changed in another tab,
 * and Register passkey... opening Settings and coming back to the sheet. Two tests run on the
 * review server itself: a whole signed Finish with the suite's own virtual authenticator (against
 * the suite's own server only), and a seed's Finish on a default-branch run.
 *
 * The sheet's keys run in Chromium and in WebKit; the rest in Chromium.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import { startApp } from "../faults.mjs";
import { fakeGh, git, isolateGit, job, makeRepo, onePr } from "../helpers.mjs";
import { COVERS } from "./covers.mjs";
import {
    BROWSERS,
    TOKEN,
    finishPreview,
    message,
    openNext,
    project,
    rowsAnswer,
    target,
    webkitRuns,
} from "./page-kit.mjs";

const browsers = {};
let t = null;
const pressed = new Set();

beforeAll(async () => {
    process.env.FC_FONTATIONS = "1";
    browsers.chromium = await BROWSERS.chromium.launch();
    if (await webkitRuns()) {
        browsers.webkit = await BROWSERS.webkit.launch();
    }
});
afterEach(async () => {
    for (const a of t?.actions ?? []) {
        pressed.add(a.a);
    }
    await t?.close();
    t = null;
});
afterAll(async () => {
    await browsers.chromium?.close();
    await browsers.webkit?.close();
});

// An open change of four snapshots, two of them accepted; three changes every snapshot of which is
// decided (Decided, not finished); and one that needs review.
const OPEN = "9100";
const [A, B, C] = ["9101", "9102", "9103"];
const decided = (pr, n) =>
    target(pr, {
        unpublished: n,
        projects: [project("graphty-element", { reviewable: n, decided: n, undecided: 0 })],
    });
const TARGETS = () => [
    target(Number(OPEN), {
        title: "Four",
        unpublished: 2,
        projects: [project("graphty-element", { reviewable: 4, decided: 2, undecided: 2 })],
    }),
    decided(Number(A), 5),
    decided(Number(B), 3),
    decided(Number(C), 2),
    target(9104, { projects: [project("graphty-element", { reviewable: 6 })] }),
];
// Each project's rows; the open change's first two accepted.
const rows = (id, name) => {
    const r = rowsAnswer(name, id === OPEN ? 4 : 3, () => "changed");
    if (id === OPEN) {
        r.decisions = Object.fromEntries(r.items.slice(0, 2).map((i) => [i.file, { decision: "accept" }]));
    }
    return r;
};

// The server's Finish jobs, made of plain data: POST /api/finish starts one, and each status ask
// moves it one step on, so how far it is depends on how many times the page asked, never on time.
// A held change's job stops at "committing" until released; a failing one ends with its error,
// once: its next Finish succeeds.
const STEPS = ["checking", "writing 2 files", "committing", "uploading images to LFS (1 of 2 done)", "pushing"];
function jobs({ hold = [], fail = {} } = {}) {
    const held = new Set(hold);
    let j = null;
    let n = 0;
    return {
        finish: (b) => {
            j = { id: ++n, target: b.id, pr: Number(b.id), running: true, step: STEPS[0], error: null, warnings: [] };
            return { job: j };
        },
        finishStatus: () => {
            if (j?.running) {
                const at = STEPS.indexOf(j.step);
                if (held.has(j.target) && j.step === "committing") {
                    return j;
                }
                if (at + 1 < STEPS.length) {
                    j.step = STEPS[at + 1];
                } else {
                    Object.assign(j, { running: false, step: null });
                    if (fail[j.target]) {
                        j.error = fail[j.target];
                        delete fail[j.target];
                    } else {
                        j.result = { commit: `c0ffee${j.target}`, rejects: 0 };
                    }
                }
            }
            return j;
        },
        release: (id) => held.delete(id),
        // A job already running when the page loads, held at "committing".
        running: (id) => {
            held.add(id);
            j = { id: ++n, target: id, pr: Number(id), running: true, step: "committing", error: null, warnings: [] };
        },
    };
}

async function open(options = {}, browser = "chromium") {
    t = await openNext(browsers[browser], { targets: TARGETS(), rows, ...options });
    await t.page.locator(".chg").first().waitFor();
    return t.page;
}

const sheet = (page) => page.locator("dialog.finish[open]");
const rowOf = (page, id) => page.locator(`.chg[data-chg="${id}"]`);
// A row's count, or null while the row is not shown (its section closed): read as it is, never
// waited for, so a poll on it ends. WebKit ends the text with a line break after its icon.
const countOf = (page, id) =>
    page.evaluate(
        (sel) => globalThis.document.querySelector(sel)?.innerText.trim() ?? null,
        `.chg[data-chg="${id}"] .cnt`,
    );
// A finished change moves to Nothing to decide, which starts closed: its header opens it.
const openNothing = (page) => page.locator('.sec[data-sec="nothing"][aria-expanded="false"]').click();
const posts = (path) => t.posts.filter((p) => p.path === path);
// What a control shows, its key boxes as "[key]".
const shows = (loc) =>
    loc.evaluate((n) =>
        [...n.childNodes]
            .map((c) => (c.nodeName === "KBD" ? (c.hidden ? "" : ` [${c.textContent}]`) : c.textContent))
            .join("")
            .trim(),
    );
const focusedAct = (page) => page.evaluate(() => globalThis.document.activeElement?.dataset?.act ?? null);
// Every message the line shows from now on, in order.
const recordMessages = (page) =>
    page.evaluate(() => {
        const line = globalThis.document.getElementById("msg-t");
        globalThis.said = [];
        new globalThis.MutationObserver(() => globalThis.said.push(line.textContent.trim())).observe(line, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    });
const said = (page) => page.evaluate(() => globalThis.said);

// The open change, its list shown.
async function openChange(page, id) {
    await rowOf(page, id).click();
    await page.keyboard.press("Enter");
    await page.locator("#snap-list .srow.cur").waitFor({ state: "attached" });
}

describe("the summary sheet", () => {
    for (const name of ["chromium", "webkit"]) {
        it(`says what Finish will do; Esc keeps everything and Enter finishes (${name})`, async (ctx) => {
            if (!browsers[name]) {
                ctx.skip();
            }
            const page = await open({}, name);
            await openChange(page, OPEN);
            const finish = page.locator('#top [data-act="finish"]');
            expect(await shows(finish)).toBe(`Finish #${OPEN} (2)`);
            await finish.click();
            const s = sheet(page);
            await s.waitFor();
            expect(await s.locator("h3").innerText()).toBe(`Finish #${OPEN} Four`);
            expect(await s.locator(".warnbox").innerText()).toBe(
                "2 snapshots are still undecided; they will block the merge. Go to the first undecided",
            );
            const text = await s.innerText();
            expect(text).toContain(
                `Will commit: 2 accepted (0 not opened), 0 excluded, to branch feat/${OPEN}-change as Ada Owner.`,
            );
            // The commit status in the server's own words (commitStatus), never "approved" with
            // snapshots undecided.
            expect(text).toContain(
                'Will set: the commit status "Reviewed: 2 accepted, 0 rejected, 0 excluded, 2 left undecided" (pending).',
            );
            expect(text).not.toContain("Will post:");
            expect(text).toContain("Signs with: Not yet protected: no passkey registered. Register passkey...");
            expect(await shows(s.locator('[data-act="finishgo"]'))).toBe(`Finish #${OPEN} [Enter]`);
            expect(await shows(s.locator('[data-act="confirmcancel"]'))).toBe("Cancel [Esc]");
            expect(await focusedAct(page)).toBe("finishgo");

            // Esc closes it, nothing sent.
            await page.keyboard.press("Escape");
            await s.waitFor({ state: "detached" });
            expect(posts("/api/finish")).toEqual([]);

            // Enter on the sheet's own Finish: one start, with the digest the sheet showed.
            await finish.click();
            await s.waitFor();
            await page.keyboard.press("Enter");
            await expect
                .poll(() => message(page))
                .toMatch(new RegExp(`^Finished #${OPEN} at \\d\\d:\\d\\d\\. Its links are on its row\\.$`));
            expect(posts("/api/finish").map((p) => p.body)).toEqual([{ id: OPEN, digest: `digest-${OPEN}` }]);
            await page.keyboard.press("Escape");
            await expect.poll(() => countOf(page, OPEN)).toMatch(/^Finished \d\d:\d\d$/);
            expect(
                await rowOf(page, OPEN)
                    .locator("a")
                    .evaluate((a) => a.href),
            ).toBe(`https://gh/commit/c0ffee1234`);
        });
    }

    it("Go to the first undecided closes the sheet on the first undecided snapshot", async () => {
        const page = await open();
        await openChange(page, OPEN);
        // The current snapshot the last undecided one, then the sheet.
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => page.locator(".iline b.num").innerText()).toBe("#4");
        await page.locator('#top [data-act="finish"]').click();
        await sheet(page).getByRole("button", { name: "Go to the first undecided" }).click();
        await sheet(page).waitFor({ state: "detached" });
        await expect.poll(() => page.locator(".iline b.num").innerText()).toBe("#3");
        expect(posts("/api/finish")).toEqual([]);
    });

    it("lists the rejects it posts and sets the failure status a reject means", async () => {
        const notes = [{ decision: "reject", project: "graphty-element", file: "x.png", note: "Text is clipped" }];
        const page = await open({
            finishPreview: (id, tg) => finishPreview(tg, id === A ? { accepts: 4, rejects: 1, notes } : {}),
        });
        await rowOf(page, A).getByRole("button", { name: "Finish..." }).click();
        const s = sheet(page);
        await s.waitFor();
        const text = await s.innerText();
        expect(text).toContain(`Will post: 1 reject as one comment on #${A}.`);
        expect(text).toContain(
            'Will set: the commit status "Reviewed: 4 accepted, 1 rejected, 0 excluded, 0 left undecided" (failure).',
        );
        await s.locator("summary", { hasText: "The reasons" }).click();
        expect(await s.locator("details li").innerText()).toBe("graphty-element/x.png: Text is clipped");
        // Cancel by pointer: the sheet closes, nothing sent.
        await s.getByRole("button", { name: "Cancel" }).click();
        await s.waitFor({ state: "detached" });
        expect(posts("/api/finish")).toEqual([]);
    });

    it("refuses when decisions changed in another tab, and shows the new counts", async () => {
        let changed = false;
        let tries = 0;
        const page = await open({
            finishPreview: (id, tg) => finishPreview(tg, changed ? { accepts: 6, digest: "digest-new" } : {}),
            finish: (b) => {
                if (tries++ === 0) {
                    changed = true;
                    return {
                        status: 409,
                        json: { error: "Decisions changed since this sheet opened: check the summary again." },
                    };
                }
                return {
                    job: {
                        id: 1,
                        target: b.id,
                        running: false,
                        step: null,
                        error: null,
                        result: { commit: "c0ffee1234" },
                    },
                };
            },
        });
        await rowOf(page, A).getByRole("button", { name: "Finish..." }).click();
        await sheet(page).waitFor();
        expect(await sheet(page).innerText()).toContain("Will commit: 5 accepted");
        await page.keyboard.press("Enter");
        await expect
            .poll(() => sheet(page).locator("p.c-failed").first().innerText())
            .toBe("Decisions changed since this sheet opened: check the summary again.");
        expect(await sheet(page).innerText()).toContain("Will commit: 6 accepted");
        await page.keyboard.press("Enter");
        await openNothing(page);
        await expect.poll(() => countOf(page, A)).toMatch(/^Finished \d\d:\d\d$/);
        expect(posts("/api/finish").map((p) => p.body.digest)).toEqual([`digest-${A}`, "digest-new"]);
    });

    it("Register passkey... opens Settings, and closing Settings brings the sheet back", async () => {
        const page = await open();
        await rowOf(page, A).getByRole("button", { name: "Finish..." }).click();
        await sheet(page).getByRole("button", { name: "Register passkey..." }).click();
        const settings = page.locator("dialog.settings[open]");
        await settings.waitFor();
        expect(await settings.locator("h3").innerText()).toBe("Settings");
        await page.keyboard.press("Escape");
        await sheet(page).waitFor();
        expect(await sheet(page).locator("h3").innerText()).toBe(`Finish #${A} Change ${A}`);
    });
});

describe("Finish... and Finish all", () => {
    it("finishes a decided change from its row without opening it", async () => {
        const page = await open();
        const btn = rowOf(page, A).getByRole("button", { name: "Finish..." });
        expect(await btn.getAttribute("title")).toBe("Opens the summary sheet for this change without opening it");
        await btn.click();
        await sheet(page).waitFor();
        expect(await sheet(page).locator(".warnbox").count()).toBe(0);
        await page.keyboard.press("Enter");
        await openNothing(page);
        await expect.poll(() => countOf(page, A)).toMatch(/^Finished \d\d:\d\d$/);
        // The change was never opened: none of its rows were asked for.
        expect(t.requests.filter((r) => r.startsWith(`/api/pr/${A}/`))).toEqual([]);
        expect(await page.locator('#top [data-act="finish"]').count()).toBe(0);
    });

    it("runs Finish all one change at a time: Queued rows, the step list, one failure stopping only its change", async () => {
        const j = jobs({ hold: [A], fail: { [B]: "pushing: the push was rejected: the branch moved" } });
        const page = await open({ finish: j.finish, finishStatus: j.finishStatus });
        const all = page.locator('.sechead [data-act="finishall"]');
        expect(await shows(all)).toBe("Finish all 3...");
        await all.click();
        const s = sheet(page);
        await s.waitFor();
        expect(await s.locator("h3").innerText()).toBe("Finish all 3 decided changes");
        expect(await s.locator(".finlist > div").allInnerTexts()).toEqual([
            `#${A} Change ${A}\ncommit 5 accepted, 0 excluded; set "Reviewed: 5 accepted, 0 rejected, 0 excluded, 0 left undecided"`,
            `#${B} Change ${B}\ncommit 3 accepted, 0 excluded; set "Reviewed: 3 accepted, 0 rejected, 0 excluded, 0 left undecided"`,
            `#${C} Change ${C}\ncommit 2 accepted, 0 excluded; set "Reviewed: 2 accepted, 0 rejected, 0 excluded, 0 left undecided"`,
        ]);
        expect(await s.locator(".warnbox").innerText()).toBe(
            "Stay on this page: about 1 minute, 0 passkey confirmations, one as each change's turn comes. 3 need no passkey (no passkey registered) and run back to back.",
        );
        expect(await shows(s.locator('[data-act="finishgo"]'))).toBe("Finish all 3 [Enter]");
        await page.keyboard.press("Enter");

        // A runs, held at its commit step; B and C wait their turn.
        await expect.poll(() => rowOf(page, A).locator(".steps").innerText()).toBe("Step 3 of 6: commit");
        expect(await countOf(page, A)).toBe("Finishing");
        expect(await countOf(page, B)).toBe("Queued: Finish all, 1st");
        expect(await countOf(page, C)).toBe("Queued: Finish all, 2nd");
        expect(await rowOf(page, B).getByRole("button", { name: "Remove from the run" }).count()).toBe(1);
        expect(await page.locator('.sechead [data-act="stopfinish"]').innerText()).toBe("Stop");
        j.release(A);

        await openNothing(page);
        await expect.poll(() => countOf(page, C)).toMatch(/^Finished \d\d:\d\d$/);
        expect(await countOf(page, A)).toMatch(/^Finished \d\d:\d\d$/);
        expect(await countOf(page, B)).toBe("Finish failed");
        expect(await rowOf(page, B).locator(".cnt").getAttribute("title")).toBe(
            "pushing: the push was rejected: the branch moved",
        );
        // One preparation and one start per change, in order.
        expect(posts("/api/finish").map((p) => p.body.id)).toEqual([A, B, C]);
        expect(posts("/api/finish-prepare").map((p) => p.body.id)).toEqual([A, B, C]);

        // Retry on the failed row: its sheet again, and it finishes.
        await rowOf(page, B).getByRole("button", { name: "Retry" }).click();
        await sheet(page).waitFor();
        await page.keyboard.press("Enter");
        await expect.poll(() => countOf(page, B)).toMatch(/^Finished \d\d:\d\d$/);
    });

    it("Remove from the run and Stop: the rest return to Decided, not finished", async () => {
        const j = jobs({ hold: [A] });
        const page = await open({ finish: j.finish, finishStatus: j.finishStatus });
        await recordMessages(page);
        await page.locator('.sechead [data-act="finishall"]').click();
        await sheet(page).waitFor();
        await page.keyboard.press("Enter");
        await expect.poll(() => countOf(page, C)).toBe("Queued: Finish all, 2nd");
        await rowOf(page, C).getByRole("button", { name: "Remove from the run" }).click();
        await expect.poll(() => countOf(page, C)).toBe("2 decided, not finished");
        expect(await countOf(page, B)).toBe("Queued: Finish all, 1st");
        await page.locator('.sechead [data-act="stopfinish"]').click();
        expect(await message(page)).toBe("Stopping after the change that is finishing now.");
        j.release(A);
        await expect.poll(() => message(page)).toBe("Finish all stopped. 1 change returned to Decided, not finished.");
        await openNothing(page);
        expect(await countOf(page, A)).toMatch(/^Finished \d\d:\d\d$/);
        expect(await countOf(page, B)).toBe("3 decided, not finished");
        expect(posts("/api/finish").map((p) => p.body.id)).toEqual([A]);
        expect(await said(page)).toContain(`#${C} taken out of the run.`);
    });

    it("shows a Finish running on the server after a reload, and its end", async () => {
        const j = jobs();
        j.running(A);
        const page = await open({ finish: j.finish, finishStatus: j.finishStatus });
        await expect.poll(() => rowOf(page, A).locator(".steps").innerText()).toBe("Step 3 of 8: commit");
        await page.reload();
        await expect.poll(() => rowOf(page, A).locator(".steps").innerText()).toBe("Step 3 of 8: commit");
        expect(await countOf(page, A)).toBe("Finishing");
        j.release(A);
        await openNothing(page);
        await expect.poll(() => countOf(page, A)).toMatch(/^Finished \d\d:\d\d$/);
        expect(posts("/api/finish")).toEqual([]);
    });

    it("says what a run of 29 costs before it starts: about 6 minutes", async () => {
        // A passkey is registered for this host: each change asks for one touch.
        const passkey = {
            rpId: "127.0.0.1",
            required: true,
            keys: [{ id: "k1", label: "MacBook Touch ID", rpId: "127.0.0.1", pending: false }],
            problem: null,
            waiting: null,
        };
        const targets = Array.from({ length: 29 }, (_, i) => ({ ...decided(9200 + i, 2), passkey }));
        const page = await open({ targets });
        await page.locator('.sechead [data-act="finishall"]').click();
        await sheet(page).waitFor();
        expect(await sheet(page).locator(".finlist > div").count()).toBe(29);
        expect(await sheet(page).locator(".warnbox b").innerText()).toBe(
            "Stay on this page: about 6 minutes, 29 passkey confirmations, one as each change's turn comes.",
        );
        expect(await sheet(page).innerText()).toContain("Signs with: Passkey 'MacBook Touch ID'.");
    });
});

it("presses every Finish action", () => {
    expect([...COVERS["finish.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});

describe("on the review server", () => {
    // The captures downloaded first: a change still downloading opens with nothing to review.
    const downloaded = (s, id) =>
        expect
            .poll(async () => {
                const tg = (await s.api("GET", "/api/prs")).body.targets?.find((x) => x.id === id);
                return Boolean(tg && !tg.downloading && tg.projects.every((p) => !p.downloading));
            })
            .toBe(true);
    const quiet = () => {
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        onTestFinished(() => out.mockRestore());
    };

    it("finishes a change signed with a passkey registered from the sheet", async () => {
        quiet();
        isolateGit();
        const r = makeRepo();
        // localhost: WebAuthn never takes an IP address as a passkey's site.
        const s = await startApp(r, { gh: onePr()(r), token: TOKEN, host: "localhost" });
        const context = await browsers.chromium.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.setDefaultTimeout(0);
        try {
            await downloaded(s, "123");
            // The suite's own virtual authenticator, on the suite's own server.
            const cdp = await context.newCDPSession(page);
            await cdp.send("WebAuthn.enable");
            await cdp.send("WebAuthn.addVirtualAuthenticator", {
                options: {
                    protocol: "ctap2",
                    transport: "internal",
                    hasResidentKey: true,
                    hasUserVerification: true,
                    isUserVerified: true,
                    automaticPresenceSimulation: true,
                },
            });
            await page.addInitScript(() => {
                const { navigator } = globalThis;
                globalThis.gets = 0;
                const real = navigator.credentials.get.bind(navigator.credentials);
                navigator.credentials.get = (o) => {
                    globalThis.gets++;
                    return real(o);
                };
            });
            // Two snapshots accepted; the rest stay undecided, so the passkey signs the decisions.
            for (const file of ["button--primary.dark.png", "slider--sizes.png"]) {
                const res = await s.api("POST", "/api/decide", {
                    id: "123",
                    project: "compact-mantine",
                    file,
                    decision: "accept",
                });
                expect(res.status).toBe(200);
            }
            await page.goto(`${s.origin}/next/#token=${TOKEN}&change=123`);
            await page.locator("#snap-list .srow.cur").waitFor({ state: "attached" });
            const finish = page.locator('#top [data-act="finish"]');
            await expect.poll(() => shows(finish)).toBe("Finish #123 (2)");
            await finish.click();
            await sheet(page).getByRole("button", { name: "Register passkey..." }).click();
            const settings = page.locator("dialog.settings[open]");
            await settings.getByRole("button", { name: "Register passkey..." }).click();
            await settings.getByRole("button", { name: "Create the passkey" }).click();
            await expect.poll(() => message(page)).toMatch(/^Passkey registered \(/);
            await settings.getByRole("button", { name: "Close" }).click();

            // The sheet again, now signed with the passkey just registered.
            const sh = sheet(page);
            await sh.waitFor();
            expect(await sh.innerText()).toMatch(/Signs with: Passkey '(Linux|Mac|Windows) passkey, \d{4}-\d\d-\d\d'/);
            expect(await shows(sh.locator('[data-act="finishgo"]'))).toBe("Sign and finish #123 [Enter]");
            const before = git(r.remote, "rev-parse", "feature");
            await page.keyboard.press("Enter");
            await expect.poll(() => message(page)).toMatch(/^Finished #123 at \d\d:\d\d, signed\./);
            expect(await page.evaluate(() => globalThis.gets)).toBe(1);
            // One accept commit on the branch, holding the review record with the passkey's approval.
            expect(git(r.remote, "rev-parse", "feature^")).toBe(before);
            const record = git(r.remote, "show", "--name-only", "--format=", "feature")
                .split("\n")
                .find((f) => f.includes("reviews/"));
            expect(JSON.parse(git(r.remote, "show", `feature:${record}`)).approval).toBeDefined();
        } finally {
            await context.close();
            await s.close();
        }
    });

    it("finishes a seed: pushes its branch and opens its pull request", async () => {
        quiet();
        isolateGit();
        const r = makeRepo();
        const posted = [];
        const gh = fakeGh({
            runsById: { 2000: { id: 2000, head: r.master, attempt: 1 } },
            runs: { [r.master]: { id: 2999, head: r.master } },
            jobs: { 2000: [job("compact-mantine"), job("graphty-element")] },
            artifacts: { 2000: ["visual-compact-mantine-1", "visual-graphty-element-1"] },
            results: {
                "visual-compact-mantine-1": { commit: r.master, headSha: null, pr: null, runId: 2000 },
                "visual-graphty-element-1": { commit: r.master, headSha: null, pr: null, runId: 2000 },
            },
            posted,
        });
        const s = await startApp(r, { gh, token: TOKEN, masterRun: 2000 });
        const context = await browsers.chromium.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.setDefaultTimeout(0);
        try {
            await downloaded(s, "master");
            const res = await s.api("POST", "/api/decide", {
                id: "master",
                project: "compact-mantine",
                file: "badge--default.light.png",
                decision: "accept",
            });
            expect(res.status).toBe(200);
            await page.goto(`${s.origin}/next/#token=${TOKEN}&change=master`);
            await page.locator("#snap-list .srow.cur").waitFor({ state: "attached" });
            const finish = page.locator('#top [data-act="finish"]');
            await expect.poll(() => shows(finish)).toBe("Finish seed (1)");
            await finish.click();
            const sh = sheet(page);
            await sh.waitFor();
            expect(await sh.locator("h3").innerText()).toBe("Finish Seed from master");
            expect(await sh.innerText()).toMatch(
                /Will commit: 1 accepted \(0 not opened\), 0 excluded, to branch visual\/seed-\d{4}-\d\d-\d\d as .+, and open its pull request\./,
            );
            await page.keyboard.press("Enter");
            await expect.poll(() => message(page)).toMatch(/^Finished seed at \d\d:\d\d\./);
            expect(posted.filter((p) => p.path === "repos/{owner}/{repo}/pulls")).toHaveLength(1);
            const day = new Date().toISOString().slice(0, 10);
            // The branch, from the captured commit, holds the accepted baseline (and its approval).
            expect(git(r.remote, "diff", "--name-only", r.master, `visual/seed-${day}`)).toContain(
                "compact-mantine/badge--default.light.png",
            );
        } finally {
            await context.close();
            await s.close();
        }
    });
});
