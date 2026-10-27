/*
 * The disk budget on the new page, by real input in Chromium and in WebKit: Settings shows the
 * budget and what the work directory holds; a change whose images were evicted keeps its counts and
 * says what opening it downloads, and a click on it asks the server to download them again, its row
 * then showing the download and, once they are in, opening as any other; a change whose images the
 * code host deleted is in Not ready and says to capture again.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BROWSERS, listAnswer, message, openNext, project, rowsAnswer, target, webkitRuns } from "./page-kit.mjs";

const runWebkit = await webkitRuns();

const evicted = (over = {}) =>
    target(10, {
        evicted: { bytes: 68e6, deleted: false },
        projects: [project("graphty-element", { reviewable: 3 })],
        ...over,
    });
const deleted = target(11, {
    evicted: { bytes: 5e6, deleted: true },
    projects: [project("graphty-element", { reviewable: 2 })],
});
const DISK = { budget: 10e9, used: 3.2e9 };

// The section header a row is listed under.
const sectionOf = (page, id) =>
    page.locator(`.chg[data-chg="${id}"]`).evaluate((n) => {
        let s = n.previousElementSibling;
        while (s && !s.classList.contains("sec")) {
            s = s.previousElementSibling;
        }
        return s?.dataset.sec ?? null;
    });

for (const [name, type] of Object.entries(BROWSERS)) {
    describe.skipIf(name === "webkit" && !runWebkit)(`in ${name}`, () => {
        let browser;
        let t = null;
        beforeAll(async () => {
            process.env.FC_FONTATIONS = "1";
            browser = await type.launch();
        });
        afterAll(() => browser?.close());
        afterEach(async () => {
            await t?.close();
            t = null;
        });

        it("shows the budget and what is in use in Settings", async () => {
            t = await openNext(browser, { list: listAnswer([target(1)], { disk: DISK }) });
            const page = t.page;
            await page.locator(".chg").first().waitFor();
            await page.getByRole("button", { name: "Settings" }).click();
            const row = page.locator("dialog[open] #set-disk");
            await expect
                .poll(() => row.innerText())
                .toMatch(/^Disk budget\s*10 GB, least recently opened removed first\. 3\.2 GB in use\.$/);
        });

        it("downloads an evicted change again when it is clicked, then opens it", async () => {
            // The server's answer to the page's ask: it starts the download, and lists the change as downloading.
            let asked = 0;
            const downloading = target(10, {
                downloading: true,
                download: { done: 0, total: 1, bytesDone: 0, bytes: 68e6, startedAt: 0 },
                projects: [project("graphty-element", { reviewable: 3, downloading: true })],
            });
            t = await openNext(browser, {
                list: listAnswer([evicted(), deleted]),
                rows: (id, p) => {
                    if (id === "10" && asked++ === 0) {
                        t.setList(listAnswer([downloading, deleted]));
                        return { downloading: true };
                    }
                    return rowsAnswer(p, 3);
                },
            });
            const page = t.page;
            const row = page.locator('.chg[data-chg="10"]');
            await row.waitFor();
            const l2 = () => row.locator(".l2").innerText();
            await expect.poll(l2).toContain("3 undecided");
            expect(await l2()).toContain("Images not on disk: opening downloads 68 MB");
            expect(await sectionOf(page, "10")).toBe("needs");
            // Deleted by the code host: not ready, and what to do.
            // WebKit's innerText ends the mark's line with a newline.
            expect((await page.locator('.chg[data-chg="11"] .cnt').innerText()).trim()).toBe(
                "Images deleted by the code host: capture again",
            );
            expect(await sectionOf(page, "11")).toBe("notready");

            await row.locator(".t").click();
            await expect.poll(() => message(page)).toBe("Downloading the images of #10 again (68 MB).");
            expect(t.requests.filter((r) => r.startsWith("/api/pr/10/"))).toEqual([
                "/api/pr/10/graphty-element?rows=1",
            ]);
            await expect.poll(l2).toContain("Downloading: 0 of 1 projects");
            expect(await sectionOf(page, "10")).toBe("busy");

            // Its images are in: the next list shows it as before, and a click opens it.
            t.setList(listAnswer([target(10, { projects: [project("graphty-element", { reviewable: 3 })] }), deleted]));
            await page.locator('[data-act="refresh"]').click();
            await expect.poll(l2).not.toContain("Downloading");
            expect(await l2()).not.toContain("Images not on disk");
            await row.locator(".t").click();
            await expect.poll(() => message(page)).toMatch(/^Opened #10 Change 10: 3 undecided\.$/);
            expect(asked).toBe(2);
        });
    });
}
