/*
 * The new page's changes pane in Chromium, driven by real keys and clicks (design section 3): with
 * 0, 1 and 50 changes, the sections in order with their counts, Sort, Find, Next change, the row
 * menu, Dismiss, the summary while no change is open, the empty state, the top bar, the message
 * line's Messages, the token box, and the address, including a link today's page wrote.
 */

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startApp } from "../faults.mjs";
import { makeRepo, onePr } from "../helpers.mjs";
import { COVERS } from "./covers.mjs";
import { TOKEN, fiftyChanges, listAnswer, message, openNext, project, target } from "./page-kit.mjs";

let browser;
let t = null;
const pressed = new Set();

beforeAll(async () => {
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterEach(async () => {
    for (const a of t?.actions ?? []) {
        pressed.add(a.a);
    }
    await t?.close();
    t = null;
});
afterAll(async () => {
    await browser?.close();
});

const open = async (options) => {
    t = await openNext(browser, options);
    return t.page;
};
const sections = (page) => page.locator(".sec").evaluateAll((ns) => ns.map((n) => n.textContent.trim()));
const rowIds = (page) => page.locator(".chg").evaluateAll((ns) => ns.map((n) => n.dataset.chg));
const currentRow = (page) => page.locator(".chg.cur").getAttribute("data-chg");

describe("with no changes", () => {
    it("says so, and Next change and Sort are unavailable with that reason", async () => {
        const page = await open({ targets: [] });
        await expect.poll(() => page.locator("#chg-list").innerText()).toBe("No changes yet");
        const next = page.getByRole("button", { name: "Next change" });
        await expect.poll(() => next.getAttribute("aria-disabled")).toBe("true");
        expect(await next.getAttribute("title")).toBe("No changes yet");
        const sort = page.getByRole("button", { name: /^Sort:/ });
        expect(await sort.getAttribute("title")).toBe("No changes yet");
        // The Snapshots pane says how captures appear; New capture... is absent until it can work.
        expect(await page.locator("#snap-list").innerText()).toContain("No captures yet.");
        expect(await page.locator("#snap-list").innerText()).toContain("Captures made by CI appear here on their own");
        expect(await page.getByText("New capture...").count()).toBe(0);
        // Pressing either, by pointer or by key, says why.
        // A reader can press a control marked unavailable; Playwright's click would wait for it to
        // become available, so these clicks skip that wait.
        await next.click({ force: true });
        await expect.poll(() => message(page)).toBe("Next change: No changes yet.");
        await sort.click({ force: true });
        await expect.poll(() => message(page)).toBe("Sort: Needs me first: No changes yet.");
        await page.locator("#chg-list").focus();
        await page.keyboard.press("Shift+KeyN");
        await expect.poll(() => t.actions.filter((a) => a.a === "nextchange" && a.via === "key").length).toBe(1);
        expect(await message(page)).toBe("Next change: No changes yet.");
    });
});

describe("with one change", () => {
    it("opens it by itself, Changes on its rail still counting it", async () => {
        const page = await open({ targets: [target(3486, { title: "Storybook 9 upgrade" })] });
        await expect.poll(() => message(page)).toBe("Opened #3486 Storybook 9 upgrade: 3 undecided.");
        expect(await page.locator("#changes").getAttribute("class")).toContain("rail");
        expect(await page.locator("#rail-c .count").innerText()).toBe("1");
        // A small change: Snapshots on its rail too, the first undecided snapshot in the viewer.
        expect(await page.locator("#snaps").getAttribute("class")).toContain("rail");
        expect(await page.locator(".iline").innerText()).toContain("#1");
        expect(await page.locator("#rail-s .count").innerText()).toBe("3");
    });
});

describe("with 50 changes", () => {
    it("lists the sections in order with their counts, from one list request and no image", async () => {
        const page = await open({ targets: fiftyChanges() });
        await expect
            .poll(() => sections(page))
            .toEqual([
                "Needs you8",
                "Decided, not finished2",
                "Capturing or downloading2",
                "Not ready2",
                "Look only1",
                "Nothing to decide34",
                "Drafts1",
            ]);
        expect(await page.locator("#chg-count").innerText()).toBe("50 changes");
        // Nothing to decide and Drafts start collapsed.
        expect(await page.locator('.sec[data-sec="nothing"]').getAttribute("aria-expanded")).toBe("false");
        expect(await page.locator('.sec[data-sec="drafts"]').getAttribute("aria-expanded")).toBe("false");
        expect(t.requests.filter((r) => r.startsWith("/api/prs"))).toHaveLength(1);
        expect(t.requests.filter((r) => /\.(png|webp)|\/api\/(pic|blob|img|thumb)/.test(r))).toEqual([]);
        // Every row state's words, as a reader sees them.
        const text = await page.locator("#chg-list").innerText();
        for (const words of [
            "3 undecided",
            "31 of 60 decided",
            "9 decided, not finished",
            "Downloading: 2 of 3 projects (68 MB)",
            "Capturing on CI, 2 of 3 projects",
            "Capture failed: graphty, 3 stories",
            "Incomplete: 2 of 3 projects",
            "Look only: 22 to view",
            "behind master",
            "pending push",
            "CI pending",
            "Changed on master: 3 newer baselines",
        ]) {
            expect(text, words).toContain(words);
        }
        // Kind tags: a pull request, a preview and a seed.
        const tags = await page.locator(".chg .tag").allInnerTexts();
        expect(new Set(tags)).toEqual(new Set(["PR", "preview", "seed"]));
    });

    it("opens and closes a section by its header", async () => {
        const page = await open({ targets: fiftyChanges() });
        const nothing = page.locator('.sec[data-sec="nothing"]');
        await nothing.click();
        await expect.poll(() => nothing.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator(".chg").count()).toBe(15 + 34);
        await nothing.click();
        await expect.poll(() => page.locator(".chg").count()).toBe(15);
    });

    it("sorts by each order of the Sort menu", async () => {
        const page = await open({ targets: fiftyChanges() });
        await expect.poll(() => rowIds(page).then((ids) => ids[0])).toBe("3484");
        const sortBy = async (label) => {
            await page.getByRole("button", { name: /^Sort:/ }).click();
            await page.getByRole("menuitemradio", { name: label }).click();
            await expect.poll(() => page.getByRole("button", { name: /^Sort:/ }).innerText()).toBe(`Sort: ${label}`);
        };
        await sortBy("Most undecided");
        expect((await rowIds(page)).slice(0, 3)).toEqual(["3486", "3482", "3471"]);
        await sortBy("Author");
        expect((await rowIds(page))[0]).toBe("3486"); // apowers
        await sortBy("Newest");
        await sortBy("Needs me first");
        expect((await rowIds(page))[0]).toBe("3484");
        // The menu closed with focus back on the list, not on Sort.
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("chg-list");
    });

    it("finds a change by number, title, branch and author; Esc clears, then leaves", async () => {
        const page = await open({ targets: fiftyChanges() });
        await page.locator(".chg").first().waitFor();
        await page.locator("#chg-list").focus();
        await page.keyboard.press("/");
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("chg-find");
        for (const [q, id] of [
            ["3485", "3485"],
            ["#3485", "3485"],
            ["Legend overlay", "3484"],
            ["fix/legend", "3484"],
            ["mlin", "3484"],
        ]) {
            await page.locator("#chg-find").fill("");
            await page.keyboard.type(q);
            await expect.poll(() => rowIds(page), q).toEqual([id]);
            expect(await page.locator("#chg-count").innerText()).toBe("1 of 50 match");
        }
        await page.keyboard.press("Escape");
        await expect.poll(() => page.locator("#chg-find").inputValue()).toBe("");
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("chg-find");
        await page.keyboard.press("Escape");
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("chg-list");
        // Neither Esc opened or left anything.
        expect(await page.locator(".iline").count()).toBe(0);
    });

    it("moves the current row with Up and Down and opens it with Enter or its Open button", async () => {
        const page = await open({ targets: fiftyChanges() });
        await expect.poll(() => currentRow(page)).toBe("3484");
        await page.locator("#chg-list").focus();
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => currentRow(page)).toBe("3481");
        // Open [Enter] is printed on the current row only.
        expect(await page.locator('.chg [data-act="openchg"]').count()).toBe(1);
        expect(await page.locator('.chg.cur [data-act="openchg"]').innerText()).toBe("OpenEnter");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Opened #3481 Change 3481: 7 undecided.");
        await page.keyboard.press("Escape");
        await expect.poll(() => message(page)).toBe("Back to the changes.");
        await page.locator('.chg.cur [data-act="openchg"]').click();
        await expect.poll(() => message(page)).toBe("Opened #3481 Change 3481: 7 undecided.");
    });

    it("opens a change by a click on its row, and the next that needs you with Next change", async () => {
        const page = await open({ targets: fiftyChanges() });
        // Needs you, fewest snapshots first: 3484 (3), 3481 (7), 3485 (12), the seed (12), 3483 (18),
        // 3471 (26), 3482 (60), 3486 (300).
        await page.locator('.chg[data-chg="3485"]').click();
        await expect.poll(() => message(page)).toBe("Opened #3485 Change 3485: 12 undecided.");
        // With Changes on its rail, the Snapshots header carries Next change [Shift+N].
        expect(await page.locator('#snaps-head [data-act="nextchange"]').innerText()).toBe("Next changeShift+N");
        await page.keyboard.press("Shift+KeyN");
        await expect.poll(() => message(page)).toBe("Opened seed master: 12 undecided.");
        await page.keyboard.press("Escape");
        await expect.poll(() => message(page)).toBe("Back to the changes.");
        // Back at the changes, the Changes header carries it.
        expect(await page.locator('#snaps-head [data-act="nextchange"]').count()).toBe(0);
        await page.locator('#changes [data-act="nextchange"]').click();
        await expect.poll(() => message(page)).toBe("Opened #3483 Change 3483: 18 undecided.");
        // Walking every change that needs you, by key from the changes, never reaches the
        // look-only preview, and comes round to the start.
        const seen = new Set();
        for (let i = 0; i < 9; i++) {
            await page.keyboard.press("Escape");
            await expect.poll(() => page.locator('#changes [data-act="nextchange"]').isVisible()).toBe(true);
            await page.keyboard.press("Shift+KeyN");
            await expect.poll(() => t.actions.filter((a) => a.a === "nextchange").length).toBe(i + 3);
            await expect.poll(() => message(page)).toMatch(/^Opened /);
            seen.add(await page.evaluate(() => new URLSearchParams(globalThis.location.hash.slice(1)).get("change")));
        }
        expect(seen.has("local")).toBe(false);
        expect(seen.size).toBe(8);
    });

    it("shows the current change's summary in the Snapshots pane while none is open, with Open", async () => {
        const page = await open({ targets: fiftyChanges() });
        await expect.poll(() => page.locator("#snap-list .summary .title").innerText()).toBe("#3484 Legend overlay");
        const text = await page.locator("#snap-list").innerText();
        expect(text).toContain("by mlin, from CI, 1 of 1 projects ready, 4 min ago");
        expect(text).toContain("3 undecided of 3");
        expect(text).toContain("3 changed");
        await page.locator("#snap-list").getByRole("button", { name: "Open" }).click();
        await expect.poll(() => message(page)).toBe("Opened #3484 Legend overlay: 3 undecided.");
    });

    it("says nothing needs you when nothing does, with the sections below", async () => {
        const page = await open({
            targets: [
                target(1, { projects: [project("p", { reviewable: 0 })] }),
                target(2, { projects: [project("p", { problem: "CI still running; reload when it finishes" })] }),
            ],
        });
        await expect
            .poll(() => page.locator("#chg-list p").first().innerText())
            .toBe("Nothing needs you. 1 capturing, 1 with nothing to decide.");
        expect(await sections(page)).toEqual(["Capturing or downloading1", "Nothing to decide1"]);
    });
});

describe("the row menu", () => {
    it("opens by click: About this change, Open on GitHub, Copy link", async () => {
        const page = await open({ targets: fiftyChanges() });
        const menuOf = (id) => page.locator(`.chg[data-chg="${id}"] [data-act="rowmenu"]`);
        await menuOf("3484").click();
        expect(await page.getByRole("menuitem").allInnerTexts()).toEqual([
            "Open on GitHub",
            "About this change",
            "Copy link",
        ]);
        await page.getByRole("menuitem", { name: "About this change" }).click();
        const box = page.locator("dialog[open]");
        await expect.poll(() => box.innerText()).toContain("What this change does.");
        expect(await box.locator("h3").innerText()).toBe("#3484 Legend overlay");
        await box.getByRole("button", { name: "Close" }).click();
        await expect.poll(() => box.count()).toBe(0);
        // Closing returns focus to the list, never to the button that opened it.
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("chg-list");

        await menuOf("3484").click();
        const [popup] = await Promise.all([
            page.waitForEvent("popup"),
            page.getByRole("menuitem", { name: "Open on GitHub" }).click(),
        ]);
        await popup.waitForLoadState();
        expect(popup.url()).toBe("https://gh/pull/3484");
        await popup.close();

        await menuOf("3484").click();
        await page.getByRole("menuitem", { name: "Copy link" }).click();
        await expect.poll(() => message(page)).toBe("Link copied: #3484.");
        const link = await page.evaluate(() => navigator.clipboard.readText());
        expect(link).toBe(`${t.origin}/next/#token=${TOKEN}&change=3484`);
        // A preview has no page on the code host: its menu leaves Open on GitHub out.
        await menuOf("local").click();
        expect(await page.getByRole("menuitem").allInnerTexts()).toEqual(["About this change", "Copy link"]);
    });

    it("opens by key, and Esc closes it before anything else", async () => {
        const page = await open({ targets: fiftyChanges() });
        const button = page.locator('.chg[data-chg="3484"] [data-act="rowmenu"]');
        await button.focus();
        await page.keyboard.press("Enter");
        await page.getByRole("menu").waitFor();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.locator("dialog[open]").waitFor();
        await page.keyboard.press("Escape");
        await expect.poll(() => page.locator("dialog[open]").count()).toBe(0);
        await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("chg-list");
        await button.focus();
        await page.keyboard.press("Enter");
        await page.getByRole("menu").waitFor();
        await page.keyboard.press("Escape");
        await expect.poll(() => page.getByRole("menu").count()).toBe(0);
        expect(await page.locator(".iline").count()).toBe(0);
    });
});

describe("row actions", () => {
    it("Dismiss takes the finished mark's button off a finished row, and it stays off", async () => {
        const page = await open({ targets: fiftyChanges() });
        await page.locator('.sec[data-sec="nothing"]').click();
        const row = page.locator('.chg[data-chg="3474"]');
        expect(await row.innerText()).toContain("Finished, signed");
        await row.getByRole("button", { name: "Dismiss" }).click();
        await expect.poll(() => row.getByRole("button", { name: "Dismiss" }).count()).toBe(0);
        await page.reload();
        await page.locator('.sec[data-sec="nothing"]').click();
        await page.locator('.chg[data-chg="3474"]').waitFor();
        expect(await page.locator('.chg[data-chg="3474"] [data-act="dismiss"]').count()).toBe(0);
    });

    it("Job log opens a failed capture's log", async () => {
        const page = await open({ targets: fiftyChanges() });
        const [popup] = await Promise.all([
            page.waitForEvent("popup"),
            page.locator('.chg[data-chg="3477"]').getByRole("button", { name: "Job log" }).click(),
        ]);
        await popup.waitForLoadState();
        expect(popup.url()).toBe("https://gh/job/graphty-element");
        await popup.close();
    });
});

describe("the top bar and the message line", () => {
    it("names the repository, refreshes on a click of the status, and keeps the last messages", async () => {
        const page = await open({ targets: fiftyChanges() });
        await expect.poll(() => page.locator("#repo").innerText()).toBe("graphty-monorepo");
        await page.getByRole("button", { name: "Review" }).click();
        await page.locator("#srvstatus").click();
        await expect.poll(() => message(page)).toBe("Refreshed.");
        expect(t.requests).toContain("/api/prs?refresh=1");
        await page.getByRole("button", { name: "Messages" }).click();
        const box = page.locator("dialog[open]");
        expect(await box.innerText()).toContain("Refreshed.");
        expect(await box.innerText()).toContain("Choose a change on the left");
        await page.keyboard.press("Escape");
        await expect.poll(() => box.count()).toBe(0);
    });

    it("says when the code host did not answer", async () => {
        const page = await open({ list: listAnswer(fiftyChanges(), { error: "gh: HTTP 502" }) });
        await expect.poll(() => page.locator("#srvstatus").innerText()).toBe("GitHub not answering");
    });
});

describe("the token box", () => {
    it("asks for the token, by Enter and by its Open button, and opens the page", async () => {
        const page = await open({ targets: fiftyChanges(), hash: "" });
        await page.getByText("Open the link the server printed, or paste its token").waitFor();
        await page.locator("#token-field").fill("");
        await page.getByRole("button", { name: "Open" }).click();
        await expect
            .poll(() => page.locator("#token-box .error").innerText())
            .toBe("Paste the token or the URL first.");
        await page.locator("#token-field").fill(`http://127.0.0.1:1/#token=${TOKEN}`);
        await page.keyboard.press("Enter");
        await page.locator(".chg").first().waitFor();
        expect(t.actions.filter((a) => a.a === "usetoken").map((a) => a.via)).toEqual(["pointer", "key"]);
    });
});

describe("addresses", () => {
    it("opens the change and snapshot of a link today's page wrote, and writes it in the new form", async () => {
        const page = await open({
            targets: fiftyChanges(),
            hash: `token=${TOKEN}&target=3484&project=graphty-element&filter=undecided&item=component-0--story-1.dark.png&view=side&zoom=fit`,
        });
        await expect
            .poll(() =>
                page
                    .locator(".iline")
                    .innerText()
                    .catch(() => ""),
            )
            .toContain("#2");
        expect(await page.evaluate(() => globalThis.location.hash)).toBe(
            `#token=${TOKEN}&change=3484&snap=graphty-element%2Fcomponent-0--story-1.dark.png`,
        );
    });

    it("says why when a link's change is gone, showing every change", async () => {
        const page = await open({ targets: fiftyChanges(), hash: `token=${TOKEN}&target=9999` });
        await expect.poll(() => message(page)).toBe("9999 is no longer listed: showing every change.");
        expect(await page.locator(".iline").count()).toBe(0);
    });

    it("moves between states with the browser's Back and Forward", async () => {
        const page = await open({ targets: fiftyChanges() });
        await page.locator('.chg[data-chg="3485"]').click();
        await expect.poll(() => page.evaluate(() => globalThis.location.hash)).toContain("change=3485");
        await page.goBack();
        await expect.poll(() => page.locator(".iline").count()).toBe(0);
        await page.goForward();
        await expect
            .poll(() =>
                page
                    .locator(".iline")
                    .innerText()
                    .catch(() => ""),
            )
            .toContain("#1");
    });
});

describe("on the real server", () => {
    it("lists the server's pull request and opens it into its snapshots", async () => {
        const r = makeRepo();
        const s = await startApp(r, { gh: onePr()(r), token: TOKEN });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        try {
            page.setDefaultTimeout(0);
            await page.goto(`${s.origin}/next/#token=${TOKEN}`);
            // One change: it opens by itself, its first undecided snapshot on the item line.
            await expect.poll(() => message(page)).toMatch(/^Opened #123 PR 123: \d+ undecided\.$/);
            expect(await page.locator(".iline").innerText()).toContain("#1");
            expect(await page.locator("#repo").innerText()).toBe(r.repo.split("/").pop());
            await page.keyboard.press("Escape");
            await expect.poll(() => page.locator(".chg.cur").innerText()).toContain("#123 PR 123");
            expect(await page.locator(".chg.cur").innerText()).toMatch(
                /feature\s+octocat\s+CI\s+2 of 2 projects ready\n/,
            );
        } finally {
            await page.close();
            await s.close();
        }
    });
});

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["changes.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
