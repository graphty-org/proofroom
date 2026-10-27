/*
 * What the new page's tests share: a real review server (the page's files and its session), the
 * list of changes and each change's rows answered from plain data the way the server shapes them,
 * the browsers to run in, and the actions the page logged as pressed.
 */

import { PNG } from "pngjs";
import { chromium, webkit } from "playwright";

import { startApp } from "../faults.mjs";
import { fakeAdapters } from "../fakes/adapters.mjs";
import { makeRepo } from "../helpers.mjs";
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
 *     pictures?: (name: string) => boolean, decide?: (body: object) => object,
 *     acceptAll?: (body: object) => object, update?: (body: object) => object,
 *     finishStatus?: () => object | null, host?: string }} [options]
 *     the changes, the list answer in their place, each project's rows (by default as many as the
 *     project's reviewable), the window, the address after #, local storage to start with,
 *     whether the test controls the page's clock, the server's page at /, the path to open, and
 *     how many of the first asks for the list answer HTTP 500, which pictures to answer (the rest
 *     fail with HTTP 500), the answer to each POST /api/decide (by default `{ ok: true }`) and
 *     POST /api/accept-all (by default every file listed done), POST /api/update's answer, the
 *     job GET /api/finish-status reports, and the host name the page is opened at (localhost for
 *     a passkey)
 * @returns {Promise<{ page: import("playwright").Page, context: import("playwright").BrowserContext,
 *     close: () => Promise<void>, actions: object[], requests: string[],
 *     posts: { path: string, body: any }[], origin: string, setList: (answer: object) => void,
 *     stopServer: () => Promise<void>, startServer: () => Promise<void> }>} the tab, how to
 *     close it, the actions it logged (`{ a, via }`), every path it asked for, every decision
 *     request with its body, how to change the list's next answer, and how to stop the server
 *     (every request the test answers for it then fails as one to a stopped server does) and
 *     start it again on the same port
 */
export async function openNext(browser, options = {}) {
    const s = await startApp(makeRepo(), {
        ...fakeAdapters(),
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
    // The decision routes: each request kept, in order, and answered as the server does (or by
    // the test's own answer, which may be a promise or { status, json } for a refusal).
    const posts = [];
    const answerWith = async (route, given, fallback) => {
        const body = route.request().postDataJSON();
        posts.push({ path: new URL(route.request().url()).pathname, body });
        const a = await (given ? given(body) : fallback(body));
        return a?.status ? route.fulfill({ status: a.status, json: a.json }) : route.fulfill({ json: a });
    };
    await page.route("**/api/decide", (route) => answerWith(route, options.decide, () => ({ ok: true })));
    await page.route("**/api/accept-all", (route) =>
        answerWith(route, options.acceptAll, (b) =>
            b.decision === null
                ? { undone: b.files.length, files: b.files, unpublished: 0 }
                : { accepted: b.files.length, files: b.files, unpublished: 0 },
        ),
    );
    await page.route("**/api/update", (route) =>
        answerWith(route, options.update, () => ({ status: 404, json: { error: "no update here" } })),
    );
    await page.route("**/api/finish-status", (route) =>
        route.fulfill({ json: { job: options.finishStatus ? options.finishStatus() : null } }),
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
        posts,
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
 * action its item runs, while letter keys are on. With `unavailable`, also the boxes of controls
 * shown unavailable, whose key only says why.
 * @param {import("playwright").Page} page the tab
 * @param {{ unavailable?: boolean }} [options] whether to list unavailable controls' boxes too
 * @returns {Promise<{ act: string, key: string }[]>} the boxes
 */
export const visibleKeys = (page, { unavailable = false } = {}) =>
    page.evaluate(
        (all) =>
            [...globalThis.document.querySelectorAll("[data-act]")]
                .filter((n) => n.getClientRects().length > 0 && (all || n.getAttribute("aria-disabled") !== "true"))
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
        unavailable,
    );

// ---------------------------------------------------------------- the Baselines screen

const BL_W = 640;
const BL_H = 400;
// A baseline image: a blue panel, moved right by `shift` px, with red areas when `marked`.
function baselinePicture(shift, marked) {
    const png = new PNG({ width: BL_W, height: BL_H });
    png.data.fill(255);
    const rect = (x0, y0, w, h, [r, g, b]) => {
        for (let y = y0; y < y0 + h; y++) {
            for (let x = x0; x < x0 + w; x++) {
                const i = (y * BL_W + x) * 4;
                [png.data[i], png.data[i + 1], png.data[i + 2]] = [r, g, b];
            }
        }
    };
    rect(80 + shift, 80, 240, 160, [80, 90, 200]);
    if (marked) {
        rect(400, 260, 90, 60, [220, 30, 30]);
    }
    return PNG.sync.write(png);
}
const hashOf = (c) => c.repeat(64);
/** The hashes of the fixture's baselines: the three versions of button--primary.dark and the rest. */
export const BL_HASH = {
    current: hashOf("c"),
    previous: hashOf("b"),
    first: hashOf("a"),
    other: hashOf("d"),
    fresh: hashOf("e"),
};
const BL_IMAGES = {
    [BL_HASH.current]: baselinePicture(0, true),
    [BL_HASH.previous]: baselinePicture(0, false),
    [BL_HASH.first]: baselinePicture(30, false),
};
/** The baseline with three versions in its history. */
export const BL_THREE = "visual-baselines/compact-mantine/button--primary.dark.png";

/**
 * Answers the Baselines screen's routes from plain data, as the server shapes them: the default
 * branch's baselines (every one downloaded), change 3486's (two of them Git LFS pointers not
 * downloaded), one baseline with three versions (its first not downloaded: its change statement,
 * a tree statement and no approval), the images by hash and the downloads, which make exactly the
 * paths asked for downloaded.
 * @param {import("playwright").Page} page the tab
 * @returns {Promise<{ downloads: object[], asked: string[] }>} each download's body, and each
 *     list and history request
 */
export async function routeBaselines(page) {
    const local = new Set();
    const downloads = [];
    const asked = [];
    const item = (project, file, hash, more = {}) => ({
        project,
        file,
        hash,
        bytes: 2_400_000,
        local: true,
        change: null,
        at: null,
        ...more,
    });
    const master = [
        item("compact-mantine", "button--primary.dark.png", BL_HASH.current, {
            change: "pr:71",
            at: "2026-10-15T08:00:00Z",
        }),
        item("compact-mantine", "button--secondary.light.png", BL_HASH.other, {
            change: "pr:60",
            at: "2026-09-01T10:00:00Z",
        }),
        item("compact-mantine", "chip--default.light.png", BL_HASH.other),
        item("compact-mantine", "card--legacy.png", BL_HASH.other),
        item("graphty-element", "graph--basic.png", BL_HASH.other, { change: "pr:12", at: "2026-08-02T10:00:00Z" }),
        item("graphty-element", "graph--large.dark.png", BL_HASH.other),
    ];
    const change = [
        ...master,
        item("graphty-element", "graph--fresh.png", BL_HASH.fresh, { local: false, bytes: 3_000_000 }),
        item("graphty-element", "graph--wide.png", BL_HASH.fresh, { local: false, bytes: 4_000_000 }),
    ];
    const path = (i) => `visual-baselines/${i.project}/${i.file}`;
    const at = (path) => (url) => url.pathname === path;
    await page.route(at("/api/baselines"), (route) => {
        const ref = new URL(route.request().url()).searchParams.get("ref");
        asked.push(`list ${ref ?? ""}`);
        const items = (ref === "3486" ? change : master).map((i) => ({ ...i, local: i.local || local.has(path(i)) }));
        return route.fulfill({ json: { ref, sha: "f".repeat(40), baselines: "visual-baselines", items } });
    });
    const signed = (kind, file, change) => ({
        kind,
        file,
        change,
        verified: true,
        signed: true,
        signer: "MacBook Touch ID",
    });
    await page.route(at("/api/baselines/history"), (route) => {
        const p = new URL(route.request().url()).searchParams.get("path");
        asked.push(`history ${p}`);
        const one = [...change].find((i) => path(i) === p);
        const versions =
            p === BL_THREE
                ? [
                      {
                          commit: "3".repeat(40),
                          date: "2026-10-15T08:00:00Z",
                          author: "apowers",
                          hash: BL_HASH.current,
                          bytes: 1000,
                          local: true,
                          approval: signed("statement", "visual-review-approvals/pr-71/x.json", "pr:71"),
                      },
                      {
                          commit: "2".repeat(40),
                          date: "2026-09-18T08:00:00Z",
                          author: "mlin",
                          hash: BL_HASH.previous,
                          bytes: 1000,
                          local: true,
                          approval: signed("tree", "visual-review-approvals/tree.json", "pr:60"),
                      },
                      {
                          commit: "1".repeat(40),
                          date: "2026-08-02T08:00:00Z",
                          author: "kchen",
                          hash: BL_HASH.first,
                          bytes: 1000,
                          local: local.has(`${p}@${"1".repeat(40)}`),
                          approval: null,
                      },
                  ]
                : [
                      {
                          commit: "4".repeat(40),
                          date: "2026-09-01T10:00:00Z",
                          author: "apowers",
                          hash: one.hash,
                          bytes: one.bytes,
                          local: one.local || local.has(p),
                          approval: null,
                      },
                  ];
        return route.fulfill({ json: { path: p, ref: null, versions } });
    });
    await page.route("**/api/baselines/image/*", (route) => {
        const hash = new URL(route.request().url()).pathname.split("/").pop();
        return route.fulfill({
            status: 200,
            contentType: "image/png",
            body: BL_IMAGES[hash] ?? baselinePicture(10, false),
        });
    });
    await page.route("**/api/baselines/pic/*", (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: PICTURE }),
    );
    await page.route("**/api/baselines-download", (route) => {
        const body = route.request().postDataJSON();
        downloads.push(body);
        for (const p of body.paths) {
            local.add(body.commit ? `${p}@${body.commit}` : p);
        }
        return route.fulfill({ json: { fetched: body.paths.length } });
    });
    return { downloads, asked };
}
