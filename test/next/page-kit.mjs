/*
 * What the new page's tests share: a real review server (the page's files and its session), the
 * list of changes and each change's rows answered from plain data the way the server shapes them,
 * the browsers to run in, and the actions the page logged as pressed.
 */

import { chromium, webkit } from "playwright";

import { startApp } from "../faults.mjs";
import { fakeGh, makeRepo } from "../helpers.mjs";
import { listAnswer, rowsAnswer } from "./fixtures.mjs";

export { fiftyChanges, listAnswer, project, rowsAnswer, target } from "./fixtures.mjs";

export const TOKEN = "n".repeat(43);

/**
 * Whether Playwright's WebKit runs on this machine. On CI it must (the workflow installs it with
 * its system libraries); on a developer machine without those libraries the WebKit pass cannot
 * start, and says so.
 * @returns {Promise<boolean>} it runs
 */
export async function webkitRuns() {
    try {
        await (await webkit.launch()).close();
        return true;
    } catch (err) {
        if (process.env.CI) {
            throw err;
        }
        console.warn(`WebKit cannot start on this machine, so its pass is not run here: ${err.message.split("\n")[0]}`);
        return false;
    }
}

/** The browsers the key and decision tests run in. */
export const BROWSERS = { chromium, webkit };

/**
 * A review server whose list and rows the test gives, and a tab of the new page on it.
 * @param {import("playwright").Browser} browser the browser
 * @param {{ targets?: object[], list?: object, rows?: (id: string, project: string) => object,
 *     viewport?: { width: number, height: number }, hash?: string, storage?: Record<string, string> }} [options]
 *     the changes, the list answer in their place, each project's rows (by default as many as the
 *     project's reviewable), the window, the address after #, and local storage to start with
 * @returns {Promise<{ page: import("playwright").Page, context: import("playwright").BrowserContext,
 *     close: () => Promise<void>, actions: object[],
 *     requests: string[], origin: string, setList: (answer: object) => void }>} the tab, how to
 *     close it, the actions it logged (`{ a, via }`), every path it asked for, and how to change
 *     the list's next answer
 */
export async function openNext(browser, options = {}) {
    const s = await startApp(makeRepo(), { gh: fakeGh({}), token: TOKEN });
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 900 } });
    // Copy link writes to the clipboard: Chromium asks for the permission, WebKit has none to give.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const page = await context.newPage();
    page.setDefaultTimeout(0);
    const actions = [];
    const requests = [];
    let list = options.list ?? listAnswer(options.targets ?? []);
    page.on("request", (req) => requests.push(new URL(req.url()).pathname + new URL(req.url()).search));
    await context.route("https://gh/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<p>code host</p>" }),
    );
    await page.route("**/api/usage-setting", (route) => route.fulfill({ json: { on: true } }));
    await page.route("**/api/usage", (route) => {
        for (const e of route.request().postDataJSON().events) {
            if (e.type === "action") {
                actions.push({ a: e.a, via: e.via });
            }
        }
        return route.fulfill({ json: { kept: 0 } });
    });
    await page.route("**/api/prs*", (route) => route.fulfill({ json: list }));
    await page.route("**/api/pr/**", (route) => {
        const [, , , id, name] = new URL(route.request().url()).pathname.split("/").map(decodeURIComponent);
        const t = list.targets.find((x) => x.id === id);
        const p = t?.projects.find((x) => x.project === name);
        return route.fulfill({ json: options.rows ? options.rows(id, name) : rowsAnswer(name, p?.reviewable ?? 0) });
    });
    await page.route("**/api/pr-context/**", (route) =>
        route.fulfill({
            json: {
                title: "t",
                body: "What this change does.",
                author: "octocat",
                owner: null,
                createdAt: null,
                comments: [],
            },
        }),
    );
    if (options.storage) {
        await context.addInitScript((kept) => {
            for (const [k, v] of Object.entries(kept)) {
                globalThis.localStorage.setItem(k, v);
            }
        }, options.storage);
    }
    await page.goto(`${s.origin}/next/#${options.hash ?? `token=${TOKEN}`}`);
    return {
        page,
        context,
        actions,
        requests,
        origin: s.origin,
        setList: (answer) => {
            list = answer;
        },
        close: async () => {
            await context.close();
            await s.close();
        },
    };
}

/**
 * The message line's text.
 * @param {import("playwright").Page} page the tab
 * @returns {Promise<string>} the text
 */
export const message = (page) => page.locator("#msg-t").innerText();

/**
 * The key boxes a reader sees now, with the action of the control each is on: every visible,
 * enabled control's visible boxes, and a Find box's key where its placeholder prints it.
 * @param {import("playwright").Page} page the tab
 * @returns {Promise<{ act: string, key: string }[]>} the boxes
 */
export const visibleKeys = (page) =>
    page.evaluate(() =>
        [...globalThis.document.querySelectorAll("[data-act]")]
            .filter((n) => n.getClientRects().length > 0 && n.getAttribute("aria-disabled") !== "true")
            .flatMap((n) =>
                n instanceof globalThis.HTMLInputElement
                    ? n.placeholder.endsWith(`[${n.dataset.key}]`)
                        ? [{ act: n.dataset.act, key: n.dataset.key }]
                        : []
                    : [...n.querySelectorAll(":scope > kbd")]
                          .filter((k) => k.getClientRects().length > 0)
                          .map((k) => ({ act: n.dataset.act, key: k.textContent })),
            ),
    );
