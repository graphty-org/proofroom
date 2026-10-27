/*
 * The review page without a session token, in Chromium: a home-screen web app keeps its own
 * storage, so the page asks for the token (or the URL serve printed) and keeps it, and asks again
 * when the server refuses it. The token is never shown on the page. The page hands the token to
 * the server once for a session cookie, named per server so two servers on one host keep their
 * pages signed in, ended by a new token, and refused to a page of another origin.
 */

import { createServer } from "node:http";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../trusted/lib/serve.mjs";
import { onePrFakes } from "./fakes/adapters.mjs";
import { CONFIG, isolateGit, makeRepo } from "./helpers.mjs";

const TOKEN = "k".repeat(43);

const LABEL = "Session token";

let browser;
let server;
let origin;
let context;
let page;
// Every request the server answered: path, status, and whether it carried a session cookie.
let answered;
// More servers a test started, closed after it.
let more = [];

beforeAll(async () => {
    isolateGit();
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterAll(() => browser?.close());

/**
 * A review server of the fixture on a random port of 127.0.0.1.
 * @param {object} [options] passed to createApp
 * @returns {Promise<{ server: import("node:http").Server, origin: string, swap: (o: object) => void }>}
 *     the server, its origin, and `swap(options)` to answer with another app from now on
 */
async function review(options = {}) {
    const r = makeRepo();
    const s = createServer();
    await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${s.address().port}`;
    const make = (o) =>
        createApp({
            repo: r.repo,
            tmp: join(r.repo, "tmp/visual-review"),
            config: CONFIG,
            token: TOKEN,
            origin: at,
            startCommand: "serve",
            ...onePrFakes()(r),
            ...o,
        });
    let app = make(options);
    s.on("request", (req, res) => {
        res.on("finish", () =>
            answered.push({
                path: req.url,
                status: res.statusCode,
                cookie: /vr_session_/.test(req.headers.cookie ?? ""),
            }),
        );
        app(req, res);
    });
    return { server: s, origin: at, swap: (o) => (app = make(o)) };
}

beforeEach(async () => {
    answered = [];
    ({ server, origin } = await review());
    // A new context each test: its own storage, as a home-screen web app has.
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    page = await context.newPage();
    // No limit of Playwright's 30 s on its waits: the test's ends them.
    page.setDefaultTimeout(0);
});
afterEach(async () => {
    await context?.close();
    await Promise.all(more.splice(0).map((s) => new Promise((resolve) => s.close(() => resolve()))));
    // Until every request has been answered: a list refresh still running would write its state
    // into the repository after the test file removed it (tempDir).
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const field = () => page.getByLabel(LABEL);
const stored = () => page.evaluate(() => globalThis.localStorage.getItem("visual-review:token"));
// The list holds the change (attached: a change the page opens at once folds the list to its rail).
const loaded = (p = page) => p.locator("#chg-list .chg").first().waitFor({ state: "attached" });

async function paste(text) {
    await field().fill(text);
    await page.locator('#token-box [data-act="usetoken"]').click();
}

describe("review page: the session token", () => {
    it("asks for the token when it has none, in a labelled password field", async () => {
        await page.goto(`${origin}/`);
        await field().waitFor();
        expect(await field().getAttribute("type")).toBe("password");
        await page.getByText("Open the link the server printed, or paste its token").waitFor();
    });

    it("loads once the token is pasted, and keeps it for the next visit", async () => {
        await page.goto(`${origin}/`);
        await paste(TOKEN);
        await loaded();
        expect(await stored()).toBe(TOKEN);
        await page.goto(`${origin}/`);
        await loaded();
    });

    it("takes the token out of the full URL serve printed", async () => {
        await page.goto(`${origin}/`);
        await paste(`  ${origin}/#token=${TOKEN}  `);
        await loaded();
        expect(await stored()).toBe(TOKEN);
    });

    it("says a wrong token was refused, asks again, and never shows the token", async () => {
        const wrong = "w".repeat(43);
        await page.goto(`${origin}/`);
        await paste(wrong);
        await expect.poll(() => page.locator("#token-box .error").textContent()).toMatch(/did not accept/);
        await field().waitFor();
        expect(await field().inputValue()).toBe("");
        expect(await stored()).toBeNull();
        expect(await page.locator("body").innerText()).not.toContain(wrong);
        // A wrong token in the address is refused the same way, and leaves the address.
        await page.goto("about:blank");
        await page.goto(`${origin}/#token=${wrong}`);
        await expect.poll(() => page.locator("#token-box .error").textContent()).toMatch(/did not accept/);
        expect(page.url()).not.toContain(wrong);
        await paste(TOKEN);
        await loaded();
    });
});

describe("review page: the session cookie", () => {
    // What the page's own script gets for a request, as a status (0 when the browser refused it).
    const status = (p, url, init = {}) =>
        p.evaluate(
            ([u, i]) =>
                globalThis.fetch(u, i).then(
                    (res) => res.status,
                    () => 0,
                ),
            [url, init],
        );

    it("gets 401 without the cookie, and signs in once from the address with an HttpOnly, SameSite=Strict cookie", async () => {
        await page.goto(`${origin}/`);
        await field().waitFor();
        expect(await status(page, "/api/prs?cached=1")).toBe(401);
        await page.goto("about:blank");
        await page.goto(`${origin}/#token=${TOKEN}`);
        await loaded();
        expect(answered.filter((a) => a.path === "/api/session")).toEqual([
            { path: "/api/session", status: 200, cookie: false },
        ]);
        const [cookie] = await page.context().cookies(origin);
        expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", secure: false, path: "/" });
        expect(cookie.name).toMatch(/^vr_session_[0-9a-f]{16}$/);
        // The page's script cannot read it, and every request after the sign-in carried it.
        expect(await page.evaluate(() => globalThis.document.cookie)).toBe("");
        const after = answered.slice(answered.findIndex((a) => a.path === "/api/session") + 1);
        expect(after.length).toBeGreaterThan(0);
        expect(after.filter((a) => !a.cookie)).toEqual([]);
        expect(await status(page, "/api/prs?cached=1")).toBe(200);
    });

    it("refuses a page of another origin on this host, with the cookie, to read or write", async () => {
        await page.goto(`${origin}/#token=${TOKEN}`);
        await loaded();
        // The review tab leaves, so only the other page's requests reach the server.
        await page.goto("about:blank");
        const foreign = createServer((_, res) => res.end("<!doctype html><title>other</title>"));
        more.push(foreign);
        await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
        const other = await context.newPage();
        await other.goto(`http://127.0.0.1:${foreign.address().port}/`);
        answered = [];
        const body = JSON.stringify({
            id: "123",
            project: "compact-mantine",
            file: "card--legacy.png",
            decision: "accept",
        });
        // A form-like write needs no preflight, so it reaches the server, cookie and all.
        await status(other, `${origin}/api/decide`, { method: "POST", mode: "no-cors", credentials: "include", body });
        await status(other, `${origin}/api/prs?cached=1`, { credentials: "include" });
        // A plain <img> of this server's image, on the other page.
        await other.evaluate(
            (u) =>
                new Promise((resolve) => {
                    const img = new globalThis.Image();
                    img.onload = img.onerror = resolve;
                    img.src = u;
                }),
            `${origin}/api/blob/${"0".repeat(64)}`,
        );
        expect(answered.map(({ path, status: code, cookie }) => [path.split("?")[0], code, cookie])).toEqual([
            ["/api/decide", 403, true],
            ["/api/prs", 403, true],
            [`/api/blob/${"0".repeat(64)}`, 403, true],
        ]);
        await other.close();
        // Nothing was decided.
        const res = await fetch(`${origin}/api/pr/123/compact-mantine`, { headers: { "x-review-token": TOKEN } });
        expect((await res.json()).decisions["card--legacy.png"]).toBeUndefined();
    });

    it("ends the cookie when the token changes, and asks for the new one", async () => {
        const fixed = await review({ serverId: "fixed" });
        more.push(fixed.server);
        await page.goto(`${fixed.origin}/#token=${TOKEN}`);
        await loaded();
        // The page leaves first: it is still opening the change, and a request of its own refused
        // by the new token would forget the token before the visit below could present it.
        const at = page.url();
        await page.goto("about:blank");
        // The same server id with a new token: the cookie of the old token no longer counts.
        const NEW = "n".repeat(43);
        fixed.swap({ token: NEW, serverId: "fixed" });
        const [cookie] = await context.cookies(fixed.origin);
        const res = await fetch(`${fixed.origin}/api/prs?cached=1`, {
            headers: { cookie: `${cookie.name}=${cookie.value}` },
        });
        expect(res.status).toBe(401);
        await page.goto(at);
        await expect.poll(() => page.locator("#token-box .error").textContent()).toMatch(/did not accept/);
        await paste(NEW);
        await loaded();
    });

    it("keeps two servers on two ports of one host signed in, in one browser", async () => {
        const second = await review({ token: "z".repeat(43) });
        more.push(second.server);
        await page.goto(`${origin}/#token=${TOKEN}`);
        await loaded();
        const other = await context.newPage();
        await other.goto(`${second.origin}/#token=${"z".repeat(43)}`);
        await loaded(other);
        expect((await page.context().cookies()).map((c) => c.name)).toHaveLength(2);
        // Back on the first, by its own cookie only: it is still signed in, and so is the second.
        answered = [];
        await page.reload();
        await loaded();
        await other.reload();
        await loaded(other);
        expect(answered.filter((a) => a.status === 401)).toEqual([]);
        expect(await status(page, "/api/prs?cached=1")).toBe(200);
        expect(await status(other, "/api/prs?cached=1")).toBe(200);
        await other.close();
    });
});
