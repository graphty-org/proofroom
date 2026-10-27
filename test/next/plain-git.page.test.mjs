/*
 * The new page on a plain git repository (design 12.4), in Chromium with real keys and clicks, over
 * the real server and its own adapters: the words about changes are the plain git code host's, the
 * buttons it cannot back are hidden and Settings, Adapters says why, and a branch captured from the
 * page is reviewed and finished, its reject written to visual-review-rejects/<branch>.md on it.
 */

import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { captureRepo } from "../capture-repo.mjs";
import { startApp } from "../faults.mjs";
import { git } from "../helpers.mjs";
import { countingServer } from "../stand-in-storybook.mjs";
import { TOKEN, message } from "./page-kit.mjs";

let browser;
let counter;
let t = null;

beforeAll(async () => {
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    vi.stubEnv("GITHUB_ACTIONS", "");
    browser = await chromium.launch();
    counter = await countingServer();
});
afterEach(async () => {
    await t?.close();
    t = null;
});
afterAll(async () => {
    vi.unstubAllEnvs();
    counter?.close();
    await browser?.close();
});

describe("the page on a plain git repository", () => {
    it("captures a branch, hides what plain git cannot do, says why in Settings, and finishes the reject into a file", async () => {
        const r = captureRepo(counter.url, { codeHost: "plain-git" });
        const s = await startApp(r, {
            config: r.config,
            previews: join(r.repo, "tmp/visual-review/local"),
            token: TOKEN,
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.setDefaultTimeout(0);
        await page.route("**/api/usage-setting", (route) => route.fulfill({ json: { on: false } }));
        t = {
            close: async () => {
                await context.close();
                await s.close();
            },
        };
        await page.goto(`${s.origin}/next/#token=${TOKEN}`);

        // No CI: the empty Review screen offers only a capture on this machine.
        await expect.poll(() => page.locator("#snap-list").innerText()).toContain("No captures yet.");
        expect(await page.locator("#snap-list").innerText()).toContain("Capture the working tree on this machine now.");
        expect(await page.locator("#snap-list").innerText()).not.toContain("Captures made by");

        // New capture: a branch from the remote (none here), and CI unavailable.
        await page.locator("#snap-list").getByRole("button", { name: "New capture..." }).click();
        const sheet = page.locator("#ncf");
        await sheet.waitFor();
        const remote = sheet.locator("label", { hasText: "A branch from the remote" });
        expect(await remote.getAttribute("title")).toBe("No branch is only on the remote");
        expect(await remote.locator("input").isDisabled()).toBe(true);
        expect(await sheet.innerText()).toContain("CI: unavailable, your capture store cannot start CI jobs");
        expect(await page.locator("#nc-br").inputValue()).toBe("feat/x");
        await page.keyboard.press("Enter");

        // The branch's row: named by the branch, its title and author its last commit's.
        const row = page.locator('.chg[data-chg="branch-feat%2Fx"]');
        // Ready once its one project is: the capture has ended and been read.
        await expect.poll(() => row.innerText()).toContain("1 of 1 projects ready");
        const rowText = await row.innerText();
        expect(rowText).toContain("branch");
        expect(rowText).toContain("feature");
        expect(rowText).toContain("Owner");
        // Its menu has no Open on the code host.
        await page.locator('.chg[data-chg="branch-feat%2Fx"] [data-act="rowmenu"]').click();
        const menu = page.getByRole("menu");
        await menu.waitFor();
        const items = await menu.getByRole("menuitem").allInnerTexts();
        expect(items.some((i) => i.startsWith("About this change"))).toBe(true);
        expect(items.some((i) => i.startsWith("Open on"))).toBe(false);
        await page.keyboard.press("Escape");
        await expect.poll(() => menu.count()).toBe(0);
        await row.click();
        await expect.poll(() => message(page)).toBe("Opened feat/x feature: 3 undecided.");

        // Settings, Adapters: what plain git lacks and what that hides.
        await page.getByRole("button", { name: "Settings" }).click();
        const adapters = page.locator("#set-adapters");
        await adapters.waitFor();
        const said = await adapters.innerText();
        expect(said).toContain(
            "Read only, from visual-review.config.json. A missing function hides the buttons that need it.",
        );
        expect(said).toContain("Code host\tPlain git");
        expect(said).toContain(
            "comment: Cannot post comments: rejects are written to visual-review-rejects/<branch>.md",
        );
        expect(said).toContain("setStatus: Cannot set commit statuses: Finish sets none");
        expect(said).toContain("fileIssue: Cannot file issues: rejects on the default branch go to the same file");
        expect(said).toContain(
            'openChange: "Open on the code host" hidden; a seed says "Pushed branch seed/x: open a merge on your host"',
        );
        expect(said).toContain("Capture store\tLocal folder");
        expect(said).toContain(
            'request: No CI: every capture runs on this machine, and "CI" in New capture is unavailable',
        );
        expect(said).toContain("Renderer\tPlaywright Chromium\tnothing missing");
        await page.keyboard.press("Escape");
        await expect.poll(() => page.locator("dialog[open]").count()).toBe(0);

        // Reject the second snapshot with a reason (the first failed to render: it can only be excluded).
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("KeyR");
        await page.locator("#popbox").waitFor();
        await page.keyboard.type("Text is clipped");
        await page.keyboard.press("Enter");
        await expect.poll(() => message(page)).toBe("Rejected #2.");

        // Finish: the reject goes to a file on the branch, and no status is set.
        const finish = page.locator('#top [data-act="finish"]');
        await expect.poll(() => finish.innerText()).toContain("Finish feat/x (1)");
        await finish.click();
        const box = page.locator("dialog.finish[open]");
        await box.waitFor();
        const summary = await box.innerText();
        expect(summary).toContain("Will commit: only the rejects, to visual-review-rejects/feat-x.md.");
        expect(summary).toContain("Will write 1 reject to visual-review-rejects/feat-x.md on the branch.");
        expect(summary).not.toContain("Will post");
        expect(summary).not.toContain("Will set");
        await page.keyboard.press("Enter");
        await expect
            .poll(() => message(page))
            .toContain("The rejects are in visual-review-rejects/feat-x.md on the branch.");
        expect(git(r.repo, "rev-parse", "feat/x~1")).toBe(r.head);
        expect(git(r.repo, "show", "feat/x:visual-review-rejects/feat-x.md")).toContain('"Text is clipped"');
    });
});
