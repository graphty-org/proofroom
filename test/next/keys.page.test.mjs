/*
 * The new page's keys, pressed for real in Chromium and in WebKit (half of the owner's reviews run
 * in iPad Safari with a keyboard): in every state of this stage, no two visible controls show the
 * same key, and a key acts only as a visible key box says; AZERTY digits reach the pane keys; Esc
 * in a field never changes the level; Esc closes a menu before Back; Enter after a box closes does
 * what the printed [Enter] says; and with letter keys off their hints go and the keys do nothing
 * while Enter and Esc still work.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { COVERS } from "./covers.mjs";
import { BROWSERS, TOKEN, fiftyChanges, message, openNext, visibleKeys, webkitRuns } from "./page-kit.mjs";

const pressed = new Set();
const runWebkit = await webkitRuns();

// What a key press is called by Playwright, and how the page prints it.
const KEYS = [
    ["Shift+Digit1", "Shift+1"],
    ["Shift+Digit2", "Shift+2"],
    ["Shift+Digit3", "Shift+3"],
    ["Shift+KeyN", "Shift+N"],
    ["Enter", "Enter"],
    ["Escape", "Esc"],
    ["Slash", "/"],
    ["Shift+Slash", "?"],
    ["KeyA", "A"],
    ["KeyU", "U"],
    ["KeyX", "X"],
    ["KeyS", "S"],
    ["Digit1", "1"],
];

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
        // The key presses the page logged, after a click on the Review tab has been logged too:
        // the page sends its events in order, so every press before the click has arrived.
        const settled = async (page, from) => {
            const marks = t.actions.filter((a) => a.a === "screen-review").length;
            await page.locator('#tabs [data-act="screen-review"]').click();
            await expect.poll(() => t.actions.filter((a) => a.a === "screen-review").length).toBe(marks + 1);
            return t.actions.slice(from).filter((a) => a.via === "key");
        };

        // Each state of this stage, reached from a fresh page by real input.
        const STATES = {
            "the changes, no change open": async () => open({}),
            "a small change open (one level)": async () => {
                const page = await open({});
                await page.locator('.chg[data-chg="3484"]').click();
                await page.locator(".iline").waitFor({ state: "attached" });
                return page;
            },
            "a large change, list level": async () => {
                const page = await open({ viewport: { width: 1280, height: 800 } });
                await page.locator('.chg[data-chg="3486"]').click();
                await page.locator('.iline [data-act="openrow"]').waitFor();
                return page;
            },
            "a large change, viewing": async () => {
                const page = await open({ viewport: { width: 1280, height: 800 } });
                await page.locator('.chg[data-chg="3486"]').click();
                await page.locator('.iline [data-act="openrow"]').click();
                await expect.poll(() => page.locator(".iline").innerText()).toContain("Back to list");
                return page;
            },
            "back at the changes with a change open": async () => {
                const page = await open({});
                await page.locator('.chg[data-chg="3486"]').click();
                await page.locator(".iline").waitFor({ state: "attached" });
                await page.keyboard.press("Escape");
                await expect.poll(() => message(page)).toBe("Back to the changes.");
                return page;
            },
            "a menu open": async () => {
                const page = await open({});
                await page.getByRole("button", { name: /^Sort:/ }).click();
                await page.getByRole("menu").waitFor();
                return page;
            },
            "Find holding text": async () => {
                const page = await open({});
                await page.locator("#chg-find").click();
                await page.keyboard.type("34");
                return page;
            },
        };

        describe.each(Object.keys(STATES))("with %s", (state) => {
            it("shows each key on one visible control at most", async () => {
                const page = await STATES[state]();
                const shown = await visibleKeys(page);
                const keys = shown.map((k) => k.key);
                expect(
                    keys.filter((k, i) => keys.indexOf(k) !== i),
                    JSON.stringify(shown),
                ).toEqual([]);
            });

            it.each(KEYS)("acts on %s only as a visible key box says", async (press, printed) => {
                const page = await STATES[state]();
                const before = await visibleKeys(page);
                // A control shown unavailable (Undo [U] with nothing to undo) keeps its key box,
                // and its key only says why.
                const shown = await visibleKeys(page, { unavailable: true });
                const from = t.actions.length;
                await page.keyboard.press(press);
                const acted = await settled(page, from);
                for (const a of acted) {
                    expect(shown, `${press} ran ${a.a}`).toContainEqual({ act: a.a, key: printed });
                }
                // A key a visible box shows acts (unless a menu or a field holds the keys).
                const owner = before.find((k) => k.key === printed);
                if (owner && !["a menu open", "Find holding text"].includes(state)) {
                    expect(
                        acted.map((a) => a.a),
                        `${press} should run ${owner.act}`,
                    ).toContain(owner.act);
                }
            });
        });

        it("moves the panes and the levels by key: Shift+1, Shift+2, Enter, Esc", async () => {
            const page = await open({ viewport: { width: 1280, height: 800 } });
            const rails = () =>
                page.evaluate(() =>
                    ["changes", "snaps"].map((id) => globalThis.document.getElementById(id).classList.contains("rail")),
                );
            await page.locator("#chg-list").focus();
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("ArrowUp");
            // 3484 is first in Needs you; walk to 3486 (300 snapshots, two levels at 1280).
            for (let i = 0; i < 7; i++) {
                await page.keyboard.press("ArrowDown");
            }
            await expect.poll(() => page.locator(".chg.cur").getAttribute("data-chg")).toBe("3486");
            await page.keyboard.press("Enter");
            await expect.poll(() => message(page)).toBe("Opened #3486 Storybook 9 upgrade: 300 undecided.");
            expect(await rails()).toEqual([true, false]);
            await page.keyboard.press("Enter");
            await expect.poll(rails).toEqual([true, true]);
            expect(await page.locator('.iline [data-act="back"]').innerText()).toBe("Back to listEsc");
            await page.keyboard.press("Shift+Digit2");
            await expect.poll(rails).toEqual([true, false]);
            await page.keyboard.press("Shift+Digit1");
            await expect.poll(rails).toEqual([false, true]);
            expect(await message(page)).toBe("Changes shown. Snapshots moved to its rail so the viewer keeps 800 px.");
            await page.keyboard.press("Shift+Digit1");
            await expect.poll(rails).toEqual([true, true]);
            expect(await message(page)).toBe("Changes hidden: its rail or Shift+1 brings it back.");
            await page.keyboard.press("Escape");
            await expect.poll(() => message(page)).toBe("Back to the list.");
            await page.keyboard.press("Escape");
            await expect.poll(() => message(page)).toBe("Back to the changes.");
            // At 1280 the viewer keeps its snapshot, so Snapshots stays a rail beside Changes.
            expect(await rails()).toEqual([false, true]);
        });

        it("never changes the level with Esc in a field, and closes a menu before going back", async () => {
            const page = await open({});
            await page.locator('.chg[data-chg="3486"]').click();
            await page.locator(".iline").waitFor({ state: "attached" });
            await page.keyboard.press("Shift+Digit1");
            await expect.poll(() => page.locator("#chg-find").isVisible()).toBe(true);
            await page.keyboard.press("Slash");
            await page.keyboard.type("zz");
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.id)).toBe("chg-list");
            expect(await page.locator('.iline [data-act="back"]').innerText()).toBe("Back to changesEsc");
            // A menu takes Esc first, and Back shows no key box while it is open.
            await page.getByRole("button", { name: /^Sort:/ }).click();
            await page.getByRole("menu").waitFor();
            expect(await page.locator('.iline [data-act="back"] kbd').isVisible()).toBe(false);
            await page.keyboard.press("Escape");
            await expect.poll(() => page.getByRole("menu").count()).toBe(0);
            expect(await page.locator(".iline").count()).toBe(1);
            await page.keyboard.press("Escape");
            await expect.poll(() => message(page)).toBe("Back to the changes.");
        });

        it("closes a menu with Esc after Tab took focus out of it, then goes back", async () => {
            const page = await open({});
            await page.locator('.chg[data-chg="3486"]').click();
            await page.locator(".iline").waitFor({ state: "attached" });
            expect(await page.locator('.iline [data-act="back"]').getAttribute("title")).toBe("Back to changes [Esc]");
            await page.keyboard.press("Shift+Digit1");
            await expect.poll(() => page.locator("#chg-find").isVisible()).toBe(true);
            await page.getByRole("button", { name: /^Sort:/ }).click();
            await page.getByRole("menu").waitFor();
            await page.keyboard.press("Tab");
            await expect
                .poll(() => page.evaluate(() => globalThis.document.activeElement?.closest(".menu") === null))
                .toBe(true);
            await page.keyboard.press("Escape");
            await expect.poll(() => page.getByRole("menu").count()).toBe(0);
            expect(await page.locator(".iline").count()).toBe(1);
            await page.keyboard.press("Escape");
            await expect.poll(() => message(page)).toBe("Back to the changes.");
        });

        it("does what the printed [Enter] says after a box closes", async () => {
            const page = await open({});
            await page.locator('.chg[data-chg="3484"] [data-act="rowmenu"]').click();
            await page.getByRole("menuitem", { name: "Copy link" }).waitFor();
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("Enter");
            await page.locator("dialog[open]").waitFor();
            await page.keyboard.press("Escape");
            await expect.poll(() => page.locator("dialog[open]").count()).toBe(0);
            await expect.poll(() => visibleKeys(page)).toContainEqual({ act: "openchg", key: "Enter" });
            await page.keyboard.press("Enter");
            await expect.poll(() => message(page)).toBe("Opened #3484 Legend overlay: 3 undecided.");
        });

        it("hides letter key hints and ignores those keys while letter keys are off", async () => {
            const page = await open({ storage: { "proofroom:letter-keys": "off" } });
            await expect.poll(() => visibleKeys(page)).toEqual([{ act: "openchg", key: "Enter" }]);
            expect(await page.locator("#chg-find").getAttribute("placeholder")).toBe(
                "Find a change: number, title, branch, author",
            );
            const from = t.actions.length;
            await page.locator("#chg-list").focus();
            await page.keyboard.press("Shift+Digit1");
            await page.keyboard.press("Shift+KeyN");
            await page.keyboard.press("Slash");
            expect(await settled(page, from)).toEqual([]);
            // Enter and Esc still act.
            await page.locator("#chg-list").focus();
            await page.keyboard.press("Enter");
            await expect.poll(() => message(page)).toBe("Opened #3484 Legend overlay: 3 undecided.");
            // The viewer's boxes keep only their arrow and Space halves.
            expect(await visibleKeys(page)).toEqual([
                { act: "view-flash", key: "hold Space" },
                { act: "back", key: "Esc" },
                { act: "prev", key: "Left" },
                { act: "next", key: "Right" },
            ]);
            await page.keyboard.press("Escape");
            await expect.poll(() => message(page)).toBe("Back to the changes.");
        });

        it.skipIf(name !== "chromium")("reads AZERTY's digit row by key position", async () => {
            const page = await open({});
            await page.locator('.chg[data-chg="3484"]').click();
            await page.locator(".iline").waitFor({ state: "attached" });
            const cdp = await page.context().newCDPSession(page);
            // AZERTY: Shift+Digit1 types "1", Digit1 alone types "&".
            const key = async (k, code, vk, shift) => {
                for (const type of ["keyDown", "keyUp"]) {
                    await cdp.send("Input.dispatchKeyEvent", {
                        type,
                        key: k,
                        code,
                        windowsVirtualKeyCode: vk,
                        modifiers: shift ? 8 : 0,
                        ...(type === "keyDown" && k.length === 1 && { text: k }),
                    });
                }
            };
            const from = t.actions.length;
            await key("&", "Digit1", 49, false);
            await key("1", "Digit1", 49, true);
            await expect.poll(() => message(page)).toBe("Changes shown.");
            await key("2", "Digit2", 50, true);
            await expect.poll(() => message(page)).toMatch(/^Snapshots shown\./);
            // Digit1 alone ("&") is the 1 key: zoom 1x. With Shift ("1") it is the Changes pane.
            expect((await settled(page, from)).map((a) => a.a)).toEqual(["zoom-1", "pane1", "pane2"]);
        });

        // WebKit has no DevTools protocol to type AZERTY's characters, so Shift stays held while the
        // digit row's keys go down: the pane keys must follow event.code, not the character typed.
        it.skipIf(name !== "webkit")("reads the digit row by key position while Shift is held", async () => {
            const page = await open({});
            await page.locator('.chg[data-chg="3484"]').click();
            await page.locator(".iline").waitFor({ state: "attached" });
            const from = t.actions.length;
            await page.keyboard.down("Shift");
            await page.keyboard.press("Digit1");
            await expect.poll(() => message(page)).toBe("Changes shown.");
            await page.keyboard.press("Digit2");
            await expect.poll(() => message(page)).toMatch(/^Snapshots shown\./);
            await page.keyboard.up("Shift");
            expect((await settled(page, from)).map((a) => a.a)).toEqual(["pane1", "pane2"]);
        });

        it("opens with the token in the address, as a link serve printed", async () => {
            const page = await open({ hash: `token=${TOKEN}&change=3484` });
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
}

// Last, after every test above: each action listed for this file was pressed by one of them.
it("pressed every action covers.mjs lists for this file", () => {
    expect([...COVERS["keys.page.test.mjs"]].filter((id) => !pressed.has(id))).toEqual([]);
});
