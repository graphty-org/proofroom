/*
 * Captures on this machine from the new page (design 9.1, 9.2), in Chromium with real keys and
 * clicks: New capture... from the top bar, from the empty Review screen and from a row's Capture
 * again..., the sheet's defaults (Start is one Enter), what it says about a dirty working tree and a
 * story prefix, the second step for another person's pull request, the Capturing row in the
 * changes pane at once, the four sections of the Captures screen, Cancel, and Review results
 * [Enter]. One test captures a stand-in Storybook for real, through the server's own routes.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { captureRepo } from "../capture-repo.mjs";
import { fakeAdapters } from "../fakes/adapters.mjs";
import { startApp } from "../faults.mjs";
import { countingServer } from "../stand-in-storybook.mjs";
import { COVERS } from "./covers.mjs";
import { NOW } from "./fixtures.mjs";
import { TOKEN, listAnswer, message, openNext, target } from "./page-kit.mjs";

let browser;
let counter;
let t = null;
const pressed = new Set();

beforeAll(async () => {
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    vi.stubEnv("GITHUB_ACTIONS", "");
    browser = await chromium.launch();
    counter = await countingServer();
});
afterEach(async () => {
    for (const a of t?.actions ?? []) {
        pressed.add(a.a);
    }
    await t?.close();
    t = null;
});
afterAll(async () => {
    vi.unstubAllEnvs();
    counter?.close();
    await browser?.close();
});

const CI = { available: false, label: "CI (GitHub Actions)", why: "your capture store cannot start CI jobs" };

/**
 * A capture as GET /api/captures lists it.
 * @param {number} id its id
 * @param {object} [over] fields to change
 * @returns {object} it
 */
const capture = (id, over = {}) => ({
    id,
    what: { kind: "tree", label: "working tree", title: null, branch: "fix/legend-sizing", number: null, author: null },
    head: "a".repeat(40),
    where: "this machine",
    state: "running",
    cancelling: false,
    step: "capturing graphty-element",
    error: null,
    look: null,
    target: `capture-${id}`,
    projects: ["graphty-element"],
    stories: null,
    baselines: { kind: "target", label: "master" },
    done: 120,
    total: 230,
    failures: 0,
    createdAt: NOW - 5 * 60000,
    startedAt: NOW - 4 * 60000,
    endedAt: null,
    ...over,
});

const captureList = (all = []) => ({
    running: all.filter((c) => c.state === "running"),
    queued: all.filter((c) => c.state === "queued"),
    finished: all.filter((c) => !["running", "queued"].includes(c.state)),
    ci: CI,
    changeHere: true,
    hostName: "GitHub",
    projects: ["graphty-element", "graphty"],
    now: NOW,
});

/**
 * The new page over scripted captures: GET /api/captures answers `list()`, with ?sources=1 the
 * sheet's sources too, GET /api/captures/<id> the capture with its progress and log, and every
 * POST is kept and answered by `post(path, body)`.
 * @param {object} options openNext's options, and the captures
 * @param {object[]} [options.captures] the captures listed
 * @param {object} [options.sources] what the sheet offers
 * @param {(path: string, body: any) => object | [number, object]} [options.post] the answer to a POST,
 *     or its status and answer
 * @returns {Promise<any>} openNext's tab, with `capturePosts` and `setCaptures(list)`
 */
async function openScripted({ captures = [], sources, post, ...options }) {
    let list = captures;
    const capturePosts = [];
    const opened = await openNext(browser, {
        ...options,
        list: listAnswer(options.targets ?? [], { captures: captureList(list) }),
    });
    await opened.page.route("**/api/captures**", (route) => {
        const req = route.request();
        const u = new URL(req.url());
        if (req.method() === "POST") {
            const body = req.postDataJSON();
            capturePosts.push({ path: u.pathname, body });
            // post answers the body, or [status, body] for a refusal.
            const answer = post ? post(u.pathname, body) : { id: 99, target: "capture-99" };
            const [status, json] = Array.isArray(answer) ? answer : [202, answer];
            return route.fulfill({ status, json });
        }
        const id = u.pathname.split("/")[3];
        if (id) {
            const c = list.find((x) => String(x.id) === id);
            return route.fulfill({
                json: {
                    ...c,
                    progress: [
                        {
                            project: "graphty-element",
                            done: c.done,
                            total: c.total,
                            current: "layouts--force-3d.dark.png",
                            failures: 1,
                            failed: [{ file: "graphty--data-panel.png", reason: "Timed out waiting for the story" }],
                        },
                    ],
                    log: { from: 0, lines: ["[graphty-element] new layouts--force-3d.dark.png"] },
                },
            });
        }
        return route.fulfill({
            json: {
                ...captureList(list),
                ...(u.searchParams.get("sources") === "1" && {
                    sources: sources ?? {
                        branch: "fix/legend-sizing",
                        changed: 0,
                        branches: ["fix/legend-sizing", "master"],
                    },
                }),
            },
        });
    });
    t = opened;
    return {
        ...opened,
        capturePosts,
        setCaptures: (next) => {
            list = next;
        },
    };
}

const sheet = (page) => page.locator("dialog[open]");
const checked = (page, name) => page.locator(`dialog[open] input[name=${name}]:checked`).getAttribute("value");

describe("New capture...", () => {
    it("opens from the top bar; a clean tree defaults to its branch, and Start is one Enter", async () => {
        const s = await openScripted({ targets: [target(3486), target(3490)] });
        const { page } = s;
        await page.getByRole("button", { name: "New capture..." }).first().click();
        await expect.poll(() => sheet(page).locator("h3").innerText()).toBe("New capture");
        // The working tree has no change: its branch is what is captured, the current one first.
        expect(await checked(page, "what")).toBe("br");
        expect(await page.locator("#nc-br").inputValue()).toBe("fix/legend-sizing");
        expect(await sheet(page).innerText()).toContain(
            "The working tree on this machine (fix/legend-sizing, 0 files changed)",
        );
        expect(await checked(page, "vs")).toBe("target");
        expect(await sheet(page).innerText()).toContain("The change's target branch (master)");
        // Every project; CI shown unavailable, with why.
        expect(await page.locator("dialog[open] input[name=project]:checked").count()).toBe(2);
        const ci = sheet(page).locator("label", { hasText: "CI (GitHub Actions)" });
        expect(await ci.innerText()).toBe("CI (GitHub Actions): unavailable, your capture store cannot start CI jobs");
        expect(await ci.locator("input").isDisabled()).toBe(true);
        expect(await page.locator("#nc-ok").innerText()).toContain("Start capture");
        await page.keyboard.press("Enter");
        await expect.poll(() => s.capturePosts.length).toBe(1);
        expect(s.capturePosts[0]).toEqual({
            path: "/api/captures",
            body: {
                what: { kind: "branch", branch: "fix/legend-sizing" },
                baselines: "target",
                projects: ["graphty-element", "graphty"],
                stories: "",
                where: "here",
                confirmed: false,
            },
        });
        await expect
            .poll(() => message(page))
            .toBe(
                "Capture of branch fix/legend-sizing started on this machine. Its row is in Changes, under Capturing.",
            );
        expect(await sheet(page).count()).toBe(0);
    });

    it("says before Start that a dirty working tree is look only, and that a story prefix is", async () => {
        const { page } = await openScripted({
            targets: [target(3486)],
            sources: { branch: "fix/legend-sizing", changed: 4, branches: ["fix/legend-sizing", "master"] },
        });
        await page.getByRole("button", { name: "New capture..." }).first().click();
        await expect.poll(() => checked(page, "what")).toBe("wt");
        const text = () => sheet(page).innerText();
        expect(await text()).toContain("The working tree on this machine (fix/legend-sizing, 4 files changed)");
        expect(await text()).toContain(
            "Uncommitted changes are captured to look at only; commit them to review and finish.",
        );
        expect(await text()).toContain("The capture uses the files as they are when it starts.");
        expect(await page.locator("#nc-warn").isVisible()).toBe(false);
        await page.locator("#nc-prefix").click();
        await page.keyboard.type("button--");
        await expect.poll(() => page.locator("#nc-warn").isVisible()).toBe(true);
        expect(await page.locator("#nc-warn").innerText()).toBe(
            "A partial capture reports every story it skipped as removed, so it is look only: it can be viewed but not finished.",
        );
        // A local branch says nothing of uncommitted changes.
        await page.locator("dialog[open] input[value=br]").click();
        await expect.poll(() => page.locator("#nc-dirty").isVisible()).toBe(false);
        // Cancel [Esc] closes it, nothing started.
        expect(
            await sheet(page)
                .getByRole("button", { name: /^Cancel/ })
                .innerText(),
        ).toContain("Esc");
        await sheet(page)
            .getByRole("button", { name: /^Cancel/ })
            .click();
        await expect.poll(() => sheet(page).count()).toBe(0);
        await page.getByRole("button", { name: "New capture..." }).first().click();
        await expect.poll(() => sheet(page).count()).toBe(1);
        await page.keyboard.press("Escape");
        await expect.poll(() => sheet(page).count()).toBe(0);
    });

    it("from a pull request row's Capture again..., asks once more, naming its author; Cancel keeps the sheet", async () => {
        const s = await openScripted({
            targets: [
                target(3486, { head: "b".repeat(40), title: "Storybook 9 upgrade" }),
                target(3490, { head: "c".repeat(40) }),
            ],
            post: () => ({ id: 7, target: "3486" }),
        });
        const { page } = s;
        await page.locator('.chg[data-chg="3486"]').getByRole("button", { name: "..." }).click();
        await page.locator(".menu").getByText("Capture again...").click();
        await expect.poll(() => checked(page, "what")).toBe("pr");
        expect(await page.locator("#nc-pr").inputValue()).toBe("3486");
        expect(await page.locator("#nc-pr option:checked").innerText()).toBe("#3486 Storybook 9 upgrade (octocat)");
        await page.keyboard.press("Enter");
        await expect.poll(() => sheet(page).locator("h3").innerText()).toBe("Capture on this computer?");
        expect(await sheet(page).innerText()).toContain(
            "This builds and runs the code of #3486 by octocat on this computer.",
        );
        expect(await sheet(page).getByRole("button", { name: /^Cancel/ }).innerText()).toContain("Esc");
        expect(s.capturePosts).toEqual([]);
        // Cancel [Esc]: the sheet as it was.
        await page.keyboard.press("Escape");
        await expect.poll(() => sheet(page).locator("h3").innerText()).toBe("New capture");
        expect(await checked(page, "what")).toBe("pr");
        await page.keyboard.press("Enter");
        await expect.poll(() => sheet(page).locator("h3").innerText()).toBe("Capture on this computer?");
        await page.keyboard.press("Enter");
        await expect.poll(() => s.capturePosts.length).toBe(1);
        expect(s.capturePosts[0].body).toMatchObject({
            what: { kind: "change", number: 3486, head: "b".repeat(40) },
            where: "here",
            confirmed: true,
        });
        // Cancel by Esc and Capture here by Enter, each as the box printed it.
        await expect
            .poll(() => s.actions.filter((a) => ["capback", "capconfirm"].includes(a.a)).map((a) => a.a))
            .toEqual(["capback", "capconfirm"]);
    });

    it("a local branch the server says is someone else's change asks once more, naming its author", async () => {
        const s = await openScripted({
            targets: [target(3486)],
            post: (_, body) =>
                body.confirmed
                    ? { id: 7, target: "3486" }
                    : [
                          428,
                          {
                              error: "capturing #3486 here builds and runs its code: confirm it first",
                              change: { pr: 3486, author: "mallory" },
                          },
                      ],
        });
        const { page } = s;
        await page.getByRole("button", { name: "New capture..." }).first().click();
        await expect.poll(() => sheet(page).locator("h3").innerText()).toBe("New capture");
        await page.keyboard.press("Enter");
        await expect.poll(() => sheet(page).locator("h3").innerText()).toBe("Capture on this computer?");
        expect(await sheet(page).innerText()).toContain(
            "This builds and runs the code of #3486 by mallory on this computer.",
        );
        await page.keyboard.press("Enter");
        await expect.poll(() => s.capturePosts.length).toBe(2);
        expect(s.capturePosts.map((p) => p.body.confirmed)).toEqual([false, true]);
        expect(s.capturePosts[1].body.what).toEqual({ kind: "branch", branch: "fix/legend-sizing" });
    });
});

describe("following a capture", () => {
    it("asks once a second while one runs, one small request, and not for the whole list", async () => {
        const { page, requests } = await openScripted({ targets: [target(3486)], captures: [capture(1)], clock: true });
        await expect.poll(() => page.locator('.chg[data-chg="capture-1"]').count()).toBe(1);
        let answered = 0;
        page.on("requestfinished", (req) => {
            answered += new URL(req.url()).pathname === "/api/captures" ? 1 : 0;
        });
        const asked = () => requests.filter((r) => r.startsWith("/api/captures")).length;
        // The page's clock stands still; each second is run by the test.
        await page.clock.pauseAt(Date.now() + 5000);
        await expect.poll(() => asked() > 0 && answered === asked()).toBe(true);
        const before = requests.length;
        // Every request since, but the usage events this test records the presses by.
        const since = () => requests.slice(before).filter((r) => !r.startsWith("/api/usage"));
        for (let second = 1; second <= 3; second++) {
            await page.clock.runFor(1000);
            await expect.poll(() => (answered === asked() ? since().length : -1)).toBe(second);
        }
        // Only the running capture is named: the finished ones are not sent again.
        expect(since()).toEqual(["/api/captures?watch=1", "/api/captures?watch=1", "/api/captures?watch=1"]);
    });
});

describe("the Captures screen", () => {
    it("lists Running, Queued, Finished today and Earlier; the detail follows the capture; Cancel stops it", async () => {
        const yesterday = NOW - 26 * 3600000;
        const s = await openScripted({
            targets: [target(3486)],
            captures: [
                capture(1),
                capture(2, {
                    state: "queued",
                    what: { kind: "branch", label: "branch feat/minimap", branch: "feat/minimap" },
                    done: 0,
                    total: 0,
                    startedAt: null,
                }),
                capture(3, { state: "done", done: 230, total: 230, endedAt: NOW - 60000, target: "branch-x" }),
                capture(4, {
                    state: "done",
                    done: 230,
                    total: 230,
                    createdAt: yesterday,
                    startedAt: yesterday,
                    endedAt: yesterday + 60000,
                }),
            ],
        });
        const { page } = s;
        // The running capture is a row of Changes, under Capturing, with its Cancel.
        await expect
            .poll(() => page.locator('.chg[data-chg="capture-1"]').innerText())
            .toContain("On this machine, 120 of 230 stories");
        expect(await page.locator('.chg[data-chg="capture-2"]').innerText()).toContain(
            "On this machine, queued: local captures run one at a time",
        );
        await page.getByRole("button", { name: "Captures", exact: true }).click();
        await expect
            .poll(() => page.locator("#cap-rows .sec").evaluateAll((ns) => ns.map((n) => n.textContent.trim())))
            .toEqual(["Running1", "Queued1", "Finished today1", "Earlier1"]);
        // A queued capture has no count yet; one that ended before today says the day.
        expect(await page.locator('.caprow[data-cap="2"] .small').innerText()).toBe("queued");
        expect(await page.locator('.caprow[data-cap="4"] .small').innerText()).toMatch(
            /^230 of 230 stories, (yesterday|[A-Z][a-z]{2} \d{1,2}) \d\d:\d\d, 1 min$/,
        );
        expect(await page.locator(".caprow.cur").innerText()).toContain("120 of 230 stories, 4 min");
        await expect
            .poll(() => page.locator("#cap-detail").innerText())
            .toContain("Now: graphty-element / layouts--force-3d.dark.png");
        const detail = await page.locator("#cap-detail").innerText();
        expect(detail).toContain(
            "This machine, running for 4 min. Against the baselines of master. Projects: graphty-element, every story.",
        );
        expect(detail).toContain("Failures so far (1)");
        expect(detail).toContain("graphty-element/graphty--data-panel.png: Timed out waiting for the story");
        expect(await page.locator("#caplog").innerText()).toBe("[graphty-element] new layouts--force-3d.dark.png");
        // Down: the next capture, the queued one.
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => page.locator(".caprow.cur").getAttribute("data-cap")).toBe("2");
        await page.locator('.caprow[data-cap="1"]').click();
        await page.locator("#cap-detail").getByRole("button", { name: "Cancel" }).click();
        await expect.poll(() => s.capturePosts.map((p) => p.path)).toEqual(["/api/captures/1/cancel"]);
        await expect.poll(() => message(page)).toBe("Capture of working tree cancelled.");
        // A finished capture: Review results [Enter].
        await page.locator('.caprow[data-cap="3"]').click();
        await expect
            .poll(() =>
                page
                    .locator("#cap-detail")
                    .getByRole("button", { name: /^Review results/ })
                    .innerText(),
            )
            .toContain("Enter");
    });

    it("New capture... from the empty Review screen captures for real, its row Capturing at once; Review results [Enter] opens it", async () => {
        // The capture waits for the test's go: its row is seen Capturing before it can end.
        const r = captureRepo(counter.url, {
            captureCommand: 'while [ ! -e "$PROOFROOM_GO" ]; do sleep 0.05; done; exec',
        });
        const go = join(r.repo, "..", `go-${Date.now()}`);
        vi.stubEnv("PROOFROOM_GO", go);
        const s = await startApp(r, {
            config: r.config,
            previews: join(r.repo, "tmp/visual-review/local"),
            token: TOKEN,
            ...fakeAdapters(),
        });
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.setDefaultTimeout(0);
        const actions = [];
        await page.route("**/api/usage-setting", (route) => route.fulfill({ json: { on: true } }));
        await page.route("**/api/usage", (route) => {
            for (const e of route.request().postDataJSON().events) {
                if (e.type === "action") {
                    actions.push({ a: e.a, via: e.via });
                }
            }
            return route.fulfill({ json: { kept: 0 } });
        });
        t = {
            actions,
            close: async () => {
                await context.close();
                await s.close();
            },
        };
        await page.goto(`${s.origin}/next/#token=${TOKEN}`);
        await expect.poll(() => page.locator("#snap-list").innerText()).toContain("No captures yet.");
        expect(await page.locator("#snap-list").innerText()).toContain(
            "Captures made by CI appear here on their own once a pull request runs its visual job. Or capture the working tree on this machine now.",
        );
        await page.locator("#snap-list").getByRole("button", { name: "New capture..." }).click();
        await expect.poll(() => checked(page, "what")).toBe("br");
        expect(await page.locator("#nc-br").inputValue()).toBe("feat/x");
        await page.keyboard.press("Enter");
        // At once, before the capture can end: its row, under Capturing.
        await expect
            .poll(() => page.locator(".sec").evaluateAll((ns) => ns.map((n) => n.textContent.trim())))
            .toEqual(["Capturing or downloading1"]);
        expect(await page.locator(".chg").innerText()).toContain("On this machine, 0 of 0 stories");
        writeFileSync(go, "");
        await page.getByRole("button", { name: "Captures", exact: true }).click();
        const review = page.locator("#cap-detail").getByRole("button", { name: /^Review results/ });
        await expect.poll(() => review.count()).toBe(1);
        expect(await page.locator("#cap-detail").innerText()).toContain("Failures so far (1)");
        expect(await page.locator("#caplog").innerText()).toContain(
            "[demo] failed demo--broken.png: story render errored",
        );
        await page.locator("#cap-rows").focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Opened branch Capture of branch feat/x: 3 undecided.");
        expect(await page.locator("#scr-captures").isVisible()).toBe(false);
        expect(await page.locator(".chg.cur").getAttribute("data-chg")).toBe("branch-feat%2Fx");
        expect(await page.locator(".chg.cur").innerText()).toContain("this machine");
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["captures.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
