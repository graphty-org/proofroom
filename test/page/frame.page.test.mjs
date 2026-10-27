/*
 * The frame around the review on the new page, by real input in Chromium and in WebKit: the Keys
 * sheet [?] with its key map, letter keys switch and last 20 messages; Settings with letter keys,
 * the Highlight color (the drawn highlight changes) and the theme each way; a message that stays
 * through unrelated key presses and polls; the server stopped mid-review (every control that
 * writes unavailable, a press sends nothing and says why, Retry after a restart enables them
 * again); and the tab title's count following a change being finished. Registering a passkey runs
 * in Chromium alone: only its DevTools protocol has a virtual authenticator, used here against the
 * suite's own server only.
 */

import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ACTIONS, OFFLINE_WHY } from "../../trusted/page/actions.js";
import { COVERS } from "./covers.mjs";
import {
    BROWSERS,
    TOKEN,
    fiftyChanges,
    listAnswer,
    message,
    openNext,
    project,
    rowsAnswer,
    target,
    visibleKeys,
    webkitRuns,
} from "./page-kit.mjs";

const pressed = new Set();
const runWebkit = await webkitRuns();

// A 200 x 100 baseline, and a new image with one block changed.
function picture(changed) {
    const png = new PNG({ width: 200, height: 100 });
    png.data.fill(255);
    if (changed) {
        for (let y = 30; y < 60; y++) {
            for (let x = 50; x < 120; x++) {
                const i = (y * 200 + x) * 4;
                [png.data[i], png.data[i + 1], png.data[i + 2]] = [30, 30, 220];
            }
        }
    }
    return PNG.sync.write(png);
}
const BASELINE = picture(false);
const CAPTURE = picture(true);

const WRITES = Object.keys(ACTIONS).filter((id) => ACTIONS[id].writes);

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
            for (const a of t?.actions ?? []) {
                pressed.add(a.a);
            }
            await t?.close();
            t = null;
        });

        const open = async (options) => {
            t = await openNext(browser, { targets: fiftyChanges(), ...options });
            await t.page.locator(".chg").first().waitFor({ state: "attached" });
            return t.page;
        };
        // The key presses the page logged, once a click on the Review tab logged after them is in.
        const settled = async (page, from) => {
            const marks = t.actions.filter((a) => a.a === "screen-review").length;
            await page.locator('#tabs [data-act="screen-review"]').click();
            await expect.poll(() => t.actions.filter((a) => a.a === "screen-review").length).toBe(marks + 1);
            return t.actions.slice(from).filter((a) => a.via === "key");
        };
        const box = (page) => page.locator("dialog[open]");
        const closeBox = async (page) => {
            await page.keyboard.press("Escape");
            await expect.poll(() => box(page).count()).toBe(0);
        };

        describe("the Keys sheet", () => {
            it("measures the mockup's widths, Keys 762px and Settings 662px, at 1280x800", async () => {
                const page = await open({ viewport: { width: 1280, height: 800 } });
                const width = () => box(page).evaluate((d) => d.getBoundingClientRect().width);
                await page.getByRole("button", { name: "Keys" }).click();
                await expect.poll(width).toBe(762);
                await closeBox(page);
                await page.getByRole("button", { name: "Settings" }).click();
                await expect.poll(width).toBe(662);
                await closeBox(page);
            });

            it("opens by ? and by its button, lists the keys the page has, and the last 20 messages", async () => {
                const page = await open({});
                // 22 messages: a sort, then Changes hidden and shown 21 times.
                await page.getByRole("button", { name: /^Sort:/ }).click();
                await page.getByRole("menuitemradio", { name: "Newest" }).click();
                await page.locator("#chg-list").focus();
                for (let i = 0; i < 21; i++) {
                    await page.keyboard.press("Shift+Digit1");
                }
                await expect.poll(() => message(page)).toBe("Changes hidden: its rail or Shift+1 brings it back.");
                await page.keyboard.press("Shift+Slash");
                await expect.poll(() => box(page).locator("h3").innerText()).toBe("Keys");
                const text = await box(page).innerText();
                expect(text).toContain("Every key is also printed on its button.");
                for (const words of [
                    "Next change that needs you",
                    "Find in the focused pane",
                    "This sheet",
                    "Image only",
                    "Accept (or the selection)",
                    "Accept the current group",
                ]) {
                    expect(text).toContain(words);
                }
                await box(page).getByText("The last 20 messages").click();
                const items = await box(page).locator("li").allInnerTexts();
                expect(items).toHaveLength(20);
                expect(items[0]).toMatch(/^\d\d:\d\d Changes hidden: its rail or Shift\+1 brings it back\.$/);
                expect(items.join("\n")).not.toContain("Sorted: Newest.");
                await closeBox(page);
                await page.getByRole("button", { name: "Keys" }).click();
                await expect.poll(() => box(page).locator("h3").innerText()).toBe("Keys");
                await box(page).getByRole("button", { name: "Close" }).click();
                await expect.poll(() => box(page).count()).toBe(0);
            });

            it("keeps a message through unrelated key presses and polls, with no timer", async () => {
                const page = await open({ clock: true });
                await page.getByRole("button", { name: /^Sort:/ }).click();
                await page.getByRole("menuitemradio", { name: "Author" }).click();
                await expect.poll(() => message(page)).toBe("Sorted: Author.");
                await page.locator("#chg-list").focus();
                for (const k of ["ArrowDown", "ArrowDown", "ArrowUp", "Tab", "Shift+Tab"]) {
                    await page.keyboard.press(k);
                }
                await page.clock.runFor(60000);
                await expect.poll(() => t.requests.filter((r) => r === "/api/prs?cached=1").length).toBeGreaterThan(2);
                expect(await message(page)).toBe("Sorted: Author.");
                await page.getByRole("button", { name: "Messages" }).click();
                expect(await box(page).locator("li").first().innerText()).toMatch(/^\d\d:\d\d Sorted: Author\.$/);
                await closeBox(page);
            });
        });

        describe("letter keys", () => {
            it("off from the Keys sheet: hints gone, letter, digit and symbol keys dead, arrows and Enter act; on from Settings", async () => {
                const page = await open({});
                await page.keyboard.press("Shift+Slash");
                const sw = box(page).getByRole("checkbox", { name: /^Letter, digit and symbol keys on \(off:/ });
                expect(await sw.isChecked()).toBe(true);
                await sw.click();
                await expect
                    .poll(() => message(page))
                    .toBe("Letter, digit and symbol keys off: only arrows, Enter, Esc, Tab and Space act.");
                // The sheet's own letter boxes hide too; the arrows' stay.
                const sheetKey = (k) =>
                    box(page)
                        .locator(".keys kbd")
                        .filter({ hasText: new RegExp(`^${k}$`) });
                await expect.poll(() => sheetKey("J").isVisible()).toBe(false);
                expect(await sheetKey("Left").isVisible()).toBe(true);
                await closeBox(page);
                await expect.poll(() => visibleKeys(page)).toEqual([{ act: "openchg", key: "Enter" }]);
                const from = t.actions.length;
                await page.locator("#chg-list").focus();
                for (const k of ["Shift+KeyN", "Slash", "Shift+Slash", "Shift+Digit1"]) {
                    await page.keyboard.press(k);
                }
                expect(await settled(page, from)).toEqual([]);
                expect(await box(page).count()).toBe(0);
                // The arrows and Enter still act.
                await page.locator("#chg-list").focus();
                const was = await page.locator(".chg.cur").getAttribute("data-chg");
                await page.keyboard.press("ArrowDown");
                await expect.poll(() => page.locator(".chg.cur").getAttribute("data-chg")).not.toBe(was);
                await page.keyboard.press("ArrowUp");
                await page.keyboard.press("Enter");
                await expect.poll(() => message(page)).toMatch(/^Opened #\d+ /);
                // In the viewer the zoom digits and view letters do nothing either.
                const inViewer = t.actions.length;
                for (const k of ["Digit2", "KeyH", "KeyZ"]) {
                    await page.keyboard.press(k);
                }
                expect(await settled(page, inViewer)).toEqual([]);
                // On again, from Settings.
                await page.getByRole("button", { name: "Settings" }).click();
                const again = box(page).getByRole("checkbox", { name: "Letter, digit and symbol keys on" });
                expect(await again.isChecked()).toBe(false);
                await again.click();
                await expect.poll(() => message(page)).toBe("Letter, digit and symbol keys on.");
                await closeBox(page);
                await expect.poll(() => visibleKeys(page)).toContainEqual({ act: "keys", key: "?" });
                await page.keyboard.press("Shift+Slash");
                await expect.poll(() => box(page).locator("h3").innerText()).toBe("Keys");
            });
        });

        describe("Settings", () => {
            it("switches the Highlight color, and the drawn highlight follows", async () => {
                const page = await open({
                    targets: [target(9100, { projects: [project("graphty-element", { reviewable: 1 })] })],
                    rows: (id, n) => rowsAnswer(n, 1, () => "changed"),
                });
                await page.route("**/api/blob/**", (route) =>
                    route.fulfill({
                        contentType: "image/png",
                        body: route.request().url().split("/").pop().startsWith("b") ? CAPTURE : BASELINE,
                    }),
                );
                // The only change there is opens by itself.
                await page.locator("#stage").waitFor();
                await page.keyboard.press("KeyH");
                await expect.poll(() => page.locator("#stage canvas.diffmark").count()).toBe(2);
                // The color of the highlight's painted pixels, in every frame.
                const painted = () =>
                    page.evaluate(() =>
                        [...globalThis.document.querySelectorAll("#stage canvas.diffmark")].map((c) => {
                            const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
                            for (let i = 0; i < d.length; i += 4) {
                                if (d[i + 3] === 255) {
                                    return [d[i], d[i + 1], d[i + 2]].join(",");
                                }
                            }
                            return null;
                        }),
                    );
                await expect.poll(painted).toEqual(["255,0,0", "255,0,0"]);
                await page.getByRole("button", { name: "Settings" }).click();
                const red = box(page).getByRole("radio", { name: "red" });
                expect(await red.isChecked()).toBe(true);
                await box(page).getByText("magenta", { exact: true }).click();
                await expect.poll(() => message(page)).toBe("Highlight color: magenta.");
                await expect.poll(painted).toEqual(["255,0,255", "255,0,255"]);
                // The arrow keys choose within the group too.
                await page.keyboard.press("ArrowDown");
                await expect.poll(() => message(page)).toBe("Highlight color: cyan.");
                await expect.poll(painted).toEqual(["0,229,255", "0,229,255"]);
                await closeBox(page);
                // Kept in this browser: the next visit, which opens in Highlight again, paints cyan.
                await page.reload();
                await page.locator("#stage").waitFor();
                await expect.poll(painted).toEqual(["0,229,255", "0,229,255"]);
            });

            it("switches the theme to Light, Dark and Match the system", async () => {
                const page = await open({});
                const bg = () =>
                    page.evaluate(() => globalThis.getComputedStyle(globalThis.document.body).backgroundColor);
                await page.emulateMedia({ colorScheme: "light" });
                const light = await bg();
                await page.getByRole("button", { name: "Settings" }).click();
                expect(await box(page).getByRole("radio", { name: "Match the system" }).isChecked()).toBe(true);
                await box(page).getByText("Dark", { exact: true }).click();
                await expect.poll(() => message(page)).toBe("Theme: Dark.");
                await expect.poll(bg).not.toBe(light);
                const dark = await bg();
                await box(page).getByText("Light", { exact: true }).click();
                await expect.poll(bg).toBe(light);
                // Light stays light on a dark system.
                await page.emulateMedia({ colorScheme: "dark" });
                expect(await bg()).toBe(light);
                await box(page).getByText("Match the system", { exact: true }).click();
                await expect.poll(() => message(page)).toBe("Theme: Match the system.");
                await expect.poll(bg).toBe(dark);
                await page.emulateMedia({ colorScheme: "light" });
                await expect.poll(bg).toBe(light);
                // Kept in this browser.
                await box(page).getByText("Dark", { exact: true }).click();
                await closeBox(page);
                await page.reload();
                await page.locator(".chg").first().waitFor({ state: "attached" });
                await expect.poll(bg).toBe(dark);
            });

            it.skipIf(name !== "chromium")(
                "registers a passkey through the suite's own virtual authenticator, and lists it",
                async () => {
                    const page = await open({ host: "localhost" });
                    const cdp = await page.context().newCDPSession(page);
                    await cdp.send("WebAuthn.enable");
                    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
                        options: {
                            protocol: "ctap2",
                            transport: "internal",
                            hasResidentKey: true,
                            hasUserVerification: true,
                            isUserVerified: true,
                            automaticPresenceSimulation: true,
                        },
                    });
                    // Safari starts WebAuthn only from the press itself: the prompt must begin
                    // while Settings is open, inside Create the passkey's click.
                    await page.evaluate(() => {
                        const { document, navigator } = globalThis;
                        globalThis.whileOpen = [];
                        const real = navigator.credentials.create.bind(navigator.credentials);
                        navigator.credentials.create = (o) => {
                            globalThis.whileOpen.push(document.querySelector("dialog[open]") !== null);
                            return real(o);
                        };
                    });
                    await page.getByRole("button", { name: "Settings" }).click();
                    const row = box(page).locator("#set-passkeys");
                    await expect.poll(() => row.innerText()).toBe("Passkeys\nNone. Register passkey...");
                    await row.getByRole("button", { name: "Register passkey..." }).click();
                    await expect.poll(() => row.locator("b").innerText()).toBe("Register a passkey for localhost");
                    await row.getByRole("button", { name: "Cancel" }).click();
                    await expect.poll(() => message(page)).toBe("Passkey not created: nothing was changed.");
                    expect(await row.innerText()).toBe("Passkeys\nNone. Register passkey...");
                    await row.getByRole("button", { name: "Register passkey..." }).click();
                    await row.getByRole("button", { name: "Create the passkey" }).click();
                    await expect
                        .poll(() => message(page))
                        .toMatch(/^Passkey registered \((Linux|Mac|Windows) passkey, /);
                    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
                    expect(credentials).toHaveLength(1);
                    const id = Buffer.from(credentials[0].credentialId, "base64").toString("base64url");
                    expect(await message(page)).toContain(
                        `credential id ${id}. Opened https://fake/changes/900: check it names this id`,
                    );
                    await expect
                        .poll(() => row.innerText())
                        .toMatch(
                            /^Passkeys\n(Linux|Mac|Windows) passkey, registered \d{4}-\d\d-\d\d, waiting for its pull request to merge\nRegister passkey\.\.\.$/,
                        );
                    expect(await page.evaluate(() => globalThis.whileOpen)).toEqual([true]);
                },
            );
        });

        describe("offline", () => {
            const FILE = "component-0--story-0.light.png";
            const decided = (id, n) => ({
                ...rowsAnswer(n, 3, () => "changed"),
                decisions: { [FILE]: { decision: "accept", reason: null } },
            });

            it("when the server stops: nothing that writes is enabled, a press sends nothing and says why; Retry after a restart enables them", async () => {
                const page = await open({
                    targets: [
                        target(9300, { projects: [project("graphty-element", { reviewable: 3 })] }),
                        target(9301),
                    ],
                    rows: decided,
                    hash: `token=${TOKEN}&change=9300&show=all`,
                });
                // The change opens on its first undecided snapshot: Shift+2 brings the Snapshots
                // list, with the decided row's Undo, back beside it.
                await page.locator("#stage").waitFor();
                await page.keyboard.press("Shift+Digit2");
                // The decided row's own Undo, not the toolbar's.
                const undo = page.locator('#snap-list [data-act="rowundo"]');
                await undo.waitFor();
                expect(await undo.getAttribute("aria-disabled")).toBe(null);
                const writers = () =>
                    page.evaluate(
                        (ids) =>
                            [...globalThis.document.querySelectorAll("[data-act]")]
                                .filter((n) => ids.includes(n.dataset.act) && n.getClientRects().length > 0)
                                .map((n) => [n.dataset.act, n.getAttribute("aria-disabled"), n.title]),
                        WRITES,
                    );
                // WebKit ends the status's text with a line break after its icon.
                const status = async () => (await page.locator("#srvstatus").innerText()).trim();
                await t.stopServer();
                await page.locator("#srvstatus").click();
                await expect.poll(status).toMatch(/^Offline since \d\d:\d\d$/);
                expect(await page.locator("#srvstatus").getAttribute("title")).toMatch(
                    /^Offline: the server is unreachable\. Showing what was loaded at \d\d:\d\d\. Decisions cannot be saved\. Click to retry\.$/,
                );
                expect(await message(page)).toMatch(
                    /^Offline: the server is unreachable\. Showing what was loaded at \d\d:\d\d; decisions cannot be saved\.$/,
                );
                // Finish in the top bar and the decided row's Undo, both shown and neither enabled.
                expect(await writers()).toEqual([
                    ["finish", "true", OFFLINE_WHY],
                    ["rowundo", "true", OFFLINE_WHY],
                ]);
                // A press by key and by pointer: nothing sent, nothing queued, and the reason said.
                const decides = () => t.requests.filter((r) => r.startsWith("/api/decide")).length;
                const sent = decides();
                await undo.focus();
                await page.keyboard.press("Enter");
                await expect
                    .poll(() => message(page))
                    .toBe("Not saved: the server is unreachable. Nothing was queued.");
                await page.getByRole("button", { name: "Messages" }).click();
                await closeBox(page);
                // aria-disabled: Playwright would wait for it to be enabled, so the mouse presses it as is.
                await undo.click({ force: true });
                await expect
                    .poll(() => message(page))
                    .toBe("Not saved: the server is unreachable. Nothing was queued.");
                expect(decides()).toBe(sent);
                // Settings opens, and says it could not read the passkeys.
                await page.getByRole("button", { name: "Settings" }).click();
                await expect
                    .poll(() => box(page).locator("#set-passkeys").innerText())
                    .toBe("Passkeys\nNot read: the server is unreachable.");
                await closeBox(page);
                // Retry while it is still down.
                await page.locator("#msg-x").getByRole("button", { name: "Retry" }).click();
                await expect.poll(() => message(page)).toBe("Still unreachable.");
                expect(await status()).toMatch(/^Offline since \d\d:\d\d$/);
                // Started again: Retry reconnects, and the controls that write are enabled.
                await t.startServer();
                await page.locator("#msg-x").getByRole("button", { name: "Retry" }).click();
                await expect.poll(() => message(page)).toBe("Refreshed.");
                expect(await status()).toMatch(/^Updated \d+ s ago$/);
                expect(await writers()).toEqual([
                    ["finish", null, ""],
                    ["rowundo", null, "Undo this decision"],
                ]);
                await undo.click();
                await expect.poll(() => message(page)).toBe("Undone: #1.");
                expect(decides()).toBe(sent + 1);
                await page.getByRole("button", { name: "Messages" }).click();
                const said = await box(page).locator("li").allInnerTexts();
                expect(said.slice(0, 3).map((m) => m.slice(6))).toEqual([
                    "Undone: #1.",
                    "Refreshed.",
                    "Back online: decisions are saved again.",
                ]);
                expect(await box(page).locator("li.c-failed").count()).toBeGreaterThan(0);
                await closeBox(page);
            });

            it("with Settings open across a stop and a restart: Register passkey... follows, and Back online is said once", async () => {
                const page = await open({ clock: true });
                await page.getByRole("button", { name: "Settings" }).click();
                const register = box(page).getByRole("button", { name: "Register passkey..." });
                await register.waitFor();
                const state = async () => [
                    await register.getAttribute("aria-disabled"),
                    await register.getAttribute("title"),
                ];
                expect(await state()).toEqual([null, null]);
                await t.stopServer();
                await page.clock.runFor(15000);
                await expect.poll(state).toEqual(["true", OFFLINE_WHY]);
                await t.startServer();
                await page.clock.runFor(15000);
                await expect.poll(state).toEqual([null, null]);
                await closeBox(page);
                await page.getByRole("button", { name: "Messages" }).click();
                const said = await box(page).locator("li").allInnerTexts();
                expect(said.filter((m) => m.endsWith("Back online: decisions are saved again."))).toHaveLength(1);
                await closeBox(page);
            });
        });

        describe("the tab title", () => {
            it("counts the changes that need you, and follows one being finished", async () => {
                const needs = (over = {}) => [target(9401), target(9402, over)];
                const page = await open({ targets: needs() });
                await expect.poll(() => page.title()).toBe("(2) Visual review");
                t.setList(
                    listAnswer(
                        needs({
                            projects: [
                                project("graphty-element", { reviewable: 3, decided: 3, undecided: 0, finished: 3 }),
                            ],
                            unpublished: 0,
                        }),
                    ),
                );
                await page.locator("#srvstatus").click();
                await expect.poll(() => page.title()).toBe("(1) Visual review");
            });
        });
    });
}

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["frame.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
