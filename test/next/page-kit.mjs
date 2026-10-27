/*
 * What the new page's tests share: a real review server (the page's files and its session), the
 * list of changes and each change's rows answered from plain data the way the server shapes them,
 * the browsers to run in, and the actions the page logged as pressed.
 */

import { PNG } from "pngjs";
import { chromium, webkit } from "playwright";

import { startApp } from "../faults.mjs";
import { fakeGh, makeRepo } from "../helpers.mjs";
import { listAnswer, rowsAnswer } from "./fixtures.mjs";

export { fiftyChanges, listAnswer, project, richRows, row, rowsAnswer, target } from "./fixtures.mjs";

// The picture every /api/pic request is answered with: a small gray PNG.
const PICTURE = (() => {
    const png = new PNG({ width: 40, height: 16 });
    png.data.fill(160);
    return PNG.sync.write(png);
})();

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
 *     viewport?: { width: number, height: number }, hash?: string, storage?: Record<string, string>,
 *     clock?: boolean, ui?: "review" | "next", path?: string, failList?: number,
 *     pictures?: (name: string) => boolean, decide?: (body: object) => object, host?: string }} [options]
 *     the changes, the list answer in their place, each project's rows (by default as many as the
 *     project's reviewable), the window, the address after #, local storage to start with,
 *     whether the test controls the page's clock, the server's page at /, the path to open, and
 *     how many of the first asks for the list answer HTTP 500, which pictures to answer (the rest
 *     fail with HTTP 500), the answer to each POST /api/decide (by default `{ ok: true }`), and the
 *     host name the page is opened at (localhost for a passkey)
 * @returns {Promise<{ page: import("playwright").Page, context: import("playwright").BrowserContext,
 *     close: () => Promise<void>, actions: object[],
 *     requests: string[], origin: string, setList: (answer: object) => void,
 *     stopServer: () => Promise<void>, startServer: () => Promise<void> }>} the tab, how to
 *     close it, the actions it logged (`{ a, via }`), every path it asked for, how to change
 *     the list's next answer, and how to stop the server (every request the test answers for it
 *     then fails as one to a stopped server does) and start it again on the same port
 */
export async function openNext(browser, options = {}) {
    const s = await startApp(makeRepo(), {
        gh: fakeGh({}),
        token: TOKEN,
        ...(options.ui && { ui: options.ui }),
        ...(options.host && { host: options.host }),
    });
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 900 } });
    // Copy link writes to the clipboard: Chromium asks for the permission. WebKit has none to give,
    // and asked for one, it refuses every new tab.
    if (browser.browserType().name() === "chromium") {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }
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
    let failing = options.failList ?? 0;
    await page.route("**/api/prs*", (route) => {
        if (failing > 0) {
            failing--;
            return route.fulfill({ status: 500, json: { error: "the list failed" } });
        }
        return route.fulfill({ json: list });
    });
    await page.route("**/api/pr/**", (route) => {
        const u = new URL(route.request().url());
        const [, , , id, name] = u.pathname.split("/").map(decodeURIComponent);
        const t = list.targets.find((x) => x.id === id);
        const p = t?.projects.find((x) => x.project === name);
        return route.fulfill({
            json: options.rows ? options.rows(id, name, u.searchParams) : rowsAnswer(name, p?.reviewable ?? 0),
        });
    });
    await page.route("**/api/pic/**", (route) => {
        const name = new URL(route.request().url()).pathname.split("/").pop();
        return options.pictures && !options.pictures(name)
            ? route.fulfill({ status: 500, json: { error: "the picture failed" } })
            : route.fulfill({ status: 200, contentType: "image/png", body: PICTURE });
    });
    await page.route("**/api/decide", (route) =>
        route.fulfill({ json: options.decide ? options.decide(route.request().postDataJSON()) : { ok: true } }),
    );
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
    // Added last, so it is asked first: while the server is stopped, the answers the test gives
    // in its place are refused too. The usage events are the test's own record, never refused.
    let down = false;
    await page.route("**/api/**", (route) =>
        down && !new URL(route.request().url()).pathname.startsWith("/api/usage")
            ? route.abort("connectionrefused")
            : route.fallback(),
    );
    const port = new URL(s.origin).port;
    if (options.storage) {
        await context.addInitScript((kept) => {
            for (const [k, v] of Object.entries(kept)) {
                globalThis.localStorage.setItem(k, v);
            }
        }, options.storage);
    }
    if (options.clock) {
        // Time runs as usual, and a test can jump it ahead to the page's next timer.
        await page.clock.install();
        await page.clock.resume();
    }
    await page.goto(`${s.origin}${options.path ?? "/next/"}#${options.hash ?? `token=${TOKEN}`}`);
    return {
        page,
        context,
        actions,
        requests,
        origin: s.origin,
        setList: (answer) => {
            list = answer;
        },
        stopServer: async () => {
            down = true;
            s.server.closeAllConnections();
            await new Promise((resolve) => s.server.close(() => resolve()));
        },
        startServer: async () => {
            await new Promise((resolve) => s.server.listen(Number(port), "127.0.0.1", resolve));
            down = false;
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
 * enabled control's visible boxes, a Find box's key where its placeholder prints it, and the keys
 * a visible menu button's closed menu prints in its right column (`data-menukeys`), each with the
 * action its item runs, while letter keys are on.
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
                    : [
                          ...[...n.querySelectorAll(":scope > kbd")]
                              .filter((k) => k.getClientRects().length > 0)
                              // innerText: a box's letter half ("F / " of "F / hold Space") is
                              // hidden while letter keys are off.
                              .map((k) => ({ act: n.dataset.act, key: k.innerText })),
                          // A menu's keys are all letter, digit or symbol keys: none acts while
                          // letter keys are off.
                          ...(globalThis.document.body.classList.contains("nokeys")
                              ? []
                              : Object.entries(JSON.parse(n.dataset.menukeys ?? "{}")).map(([key, act]) => ({
                                    act,
                                    key,
                                }))),
                      ],
            ),
    );
