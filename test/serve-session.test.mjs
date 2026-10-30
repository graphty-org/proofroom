/**
 * Content-addressed images and pictures, and the session cookie: an image is served by its hash
 * and a picture by both images' hashes, the settings and its kind, both immutable, found through
 * a Map filled as each capture loads (never a directory read); the page's token, posted once,
 * becomes an HttpOnly, SameSite=Strict cookie named per server, which every route accepts beside
 * the `x-review-token` header, and any request naming another origin is refused.
 */

import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../trusted/lib/compare.mjs";
import { createApp, serverIdOf } from "../trusted/lib/serve.mjs";
import { fakeAdapters, onePrFakes } from "./fakes/adapters.mjs";
import { copyFixture, FIXTURE, FIXTURE_CONFIG, job, makeRepo, onePr } from "./helpers.mjs";

// Every directory read, by any code in this process.
const dirReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
    const fs = /** @type {typeof import("node:fs")} */ (await importOriginal());
    const counted =
        (f) =>
        (...args) => {
            dirReads.count++;
            return f(...args);
        };
    const own = {
        readdirSync: counted(fs.readdirSync),
        readdir: counted(fs.readdir),
        opendirSync: counted(fs.opendirSync),
        opendir: counted(fs.opendir),
    };
    return { ...fs, ...own, default: { ...fs, ...own } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
    const fs = /** @type {typeof import("node:fs/promises")} */ (await importOriginal());
    const counted =
        (f) =>
        (...args) => {
            dirReads.count++;
            return f(...args);
        };
    const own = { readdir: counted(fs.readdir), opendir: counted(fs.opendir) };
    return { ...fs, ...own, default: { ...fs, ...own } };
});

const TOKEN = "s".repeat(43);
const ITEMS = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8")).items;
const item = (file) => ITEMS.find((i) => i.file === file);
const BUTTON = item("button--primary.dark.png");
const picName = (i, kind) =>
    `${i.baseline ?? "none"}-${i.capture ?? "none"}-${i.threshold}-${i.includeAA ? 1 : 0}-${kind}`;
const IMMUTABLE = "private, max-age=31536000, immutable";

const servers = [];
afterEach(async () => {
    for (const { server, app } of servers.splice(0)) {
        await new Promise((resolve) => server.close(() => resolve()));
        await app.idle();
    }
});

/**
 * Starts the app on a random port of 127.0.0.1, over the fixture as pull request #123.
 * @param {object} [options] passed to createApp, but `ghOf` and `fakes`
 * @param {(r: object) => Function} [options.ghOf] makes the gh runner for the repository
 * @param {(r: object) => object} [options.fakes] makes the code host and capture store instead
 * @returns {Promise<object>} `get(path, headers)`, `post(path, body, headers)`, the origin, the
 *     app and its tmp directory
 */
async function start({ ghOf, fakes = onePrFakes(), ...options } = {}) {
    const r = makeRepo();
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = options.origin ?? `http://127.0.0.1:${server.address().port}`;
    const at = `http://127.0.0.1:${server.address().port}`;
    const tmp = join(r.repo, "tmp/visual-review");
    const app = createApp({
        repo: r.repo,
        tmp,
        config: FIXTURE_CONFIG,
        token: TOKEN,
        origin,
        ...(ghOf ? { gh: ghOf(r) } : fakes(r)),
        ...options,
    });
    server.on("request", app);
    servers.push({ server, app });
    const get = (path, headers = {}) => fetch(`${at}${path}`, { headers });
    const post = (path, body, headers = {}) =>
        fetch(`${at}${path}`, {
            method: "POST",
            headers: { origin, "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
        });
    // The capture loads, as the page's list does.
    const token = { "x-review-token": options.token ?? TOKEN };
    expect((await get("/api/prs", token)).status).toBe(200);
    expect((await get("/api/pr/123/compact-mantine", token)).status).toBe(200);
    return { get, post, origin, app, tmp };
}

/**
 * The cookie POST /api/session sets, as a request's `cookie` header carries it.
 * @param {Response} res its answer
 * @returns {string} `name=value`
 */
const cookieOf = (res) => res.headers.get("set-cookie").split(";")[0];

describe("serve: images and pictures by their content", () => {
    it("serves an image by its hash, immutable, and JSON never cached", async () => {
        const s = await start();
        const res = await s.get(`/api/blob/${BUTTON.capture}`, { "x-review-token": TOKEN });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
        expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(BUTTON.capture);
        // A baseline, from the capture's baselines folder; and an image of an item with one side.
        expect((await s.get(`/api/blob/${BUTTON.baseline}`, { "x-review-token": TOKEN })).status).toBe(200);
        const removed = item("card--legacy.png");
        expect((await s.get(`/api/blob/${removed.baseline}`, { "x-review-token": TOKEN })).status).toBe(200);
        const json = await s.get("/api/pr/123/compact-mantine", { "x-review-token": TOKEN });
        expect(json.headers.get("cache-control")).toBe("no-store");
        // A hash no capture names, and its answer is not kept either.
        const none = await s.get(`/api/blob/${"0".repeat(64)}`, { "x-review-token": TOKEN });
        expect(none.status).toBe(404);
        expect(none.headers.get("cache-control")).toBe("no-store");
    });

    it("refuses an image whose bytes do not match its hash, and never as immutable", async () => {
        const s = await start();
        writeFileSync(join(s.tmp, "1000-1/compact-mantine", BUTTON.file), "tampered");
        const res = await s.get(`/api/blob/${BUTTON.capture}`, { "x-review-token": TOKEN });
        expect(res.status).toBe(409);
        expect(res.headers.get("cache-control")).toBe("no-store");
        // Damaged: results.json is dropped, so the next reload downloads the capture again.
        expect(existsSync(join(s.tmp, "1000-1/compact-mantine/results.json"))).toBe(false);
    });

    it("answers a missing image 404 and never drops results.json for it", async () => {
        const s = await start();
        const dir = join(s.tmp, "1000-1/compact-mantine");
        rmSync(join(dir, BUTTON.file));
        const res = await s.get(`/api/blob/${BUTTON.capture}`, { "x-review-token": TOKEN });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe(`${BUTTON.file}: not in the downloaded capture`);
        expect(existsSync(join(dir, "results.json"))).toBe(true);
    });

    it("shows an unchanged item's baseline from git, which the capture does not keep", async () => {
        // Within tolerance, not byte for byte: the capture's own hash names the baseline too.
        const fixture = JSON.parse(readFileSync(join(FIXTURE, "compact-mantine/results.json"), "utf8"));
        const close = { ...item("input--default.png"), capture: "c".repeat(64) };
        const items = fixture.items.map((i) => (i.file === close.file ? close : i));
        const s = await start({
            fakes: (r) =>
                onePrFakes({
                    results: {
                        "visual-compact-mantine-1": { commit: r.head, headSha: r.head, items },
                        "visual-graphty-element-1": { commit: r.head, headSha: r.head },
                    },
                })(r),
        });
        const dir = join(s.tmp, "1000-1/compact-mantine");
        expect(existsSync(join(dir, close.file))).toBe(false);
        expect(existsSync(join(dir, "baselines", close.file))).toBe(false);
        for (const hash of [close.baseline, close.capture]) {
            const res = await s.get(`/api/blob/${hash}`, { "x-review-token": TOKEN });
            expect(res.status).toBe(200);
            expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(close.baseline);
        }
        const pic = await s.get(`/api/pic/${picName(close, "plain")}`, { "x-review-token": TOKEN });
        expect(pic.status).toBe(200);
        expect(existsSync(join(dir, "results.json"))).toBe(true);
    });

    it("answers 404, not damaged, when an unchanged item's baseline is not in the repository", async () => {
        // Captured at a commit this repository does not have; graphty-element, whose capture
        // holds the same image, is left out.
        const unchanged = item("input--default.png");
        const at = { commit: "3".repeat(40), headSha: "3".repeat(40) };
        const s = await start({
            fakes: onePrFakes({
                jobs: { 1000: [job("compact-mantine")] },
                artifacts: { 1000: ["visual-compact-mantine-1"] },
                results: { "visual-compact-mantine-1": at },
            }),
        });
        const res = await s.get(`/api/blob/${unchanged.baseline}`, { "x-review-token": TOKEN });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe(
            `${unchanged.file}: the capture does not keep it and its committed baseline is not in this repository`,
        );
        expect(existsSync(join(s.tmp, "1000-1/compact-mantine/results.json"))).toBe(true);
    });

    it("serves every kind of a changed pair's picture by its name, immutable", async () => {
        const s = await start();
        for (const kind of ["plain", "spot", "row-plain", "row-spot", "auto"]) {
            const res = await s.get(`/api/pic/${picName(BUTTON, kind)}`, { "x-review-token": TOKEN });
            expect([kind, res.status, res.headers.get("cache-control")]).toEqual([kind, 200, IMMUTABLE]);
            expect(res.headers.get("content-type")).toBe("image/png");
        }
        // An item with one image has only its plain picture.
        const added = item("badge--default.light.png");
        expect((await s.get(`/api/pic/${picName(added, "plain")}`, { "x-review-token": TOKEN })).status).toBe(200);
        expect((await s.get(`/api/pic/${picName(added, "spot")}`, { "x-review-token": TOKEN })).status).toBe(404);
        // Other settings than the item's, an unknown kind, or a malformed name: no such picture.
        for (const name of [
            picName({ ...BUTTON, threshold: 0.5 }, "spot"),
            picName(BUTTON, "huge"),
            `${BUTTON.capture}-spot`,
            "..-..-0-0-plain",
        ]) {
            const res = await s.get(`/api/pic/${encodeURIComponent(name)}`, { "x-review-token": TOKEN });
            expect([name, res.status, res.headers.get("cache-control")]).toEqual([name, 404, "no-store"]);
        }
    });

    it("finds an image's file without reading a directory", async () => {
        const s = await start();
        await s.app.idle();
        // The spy sees the server's directory reads: loading the capture made some.
        expect(dirReads.count).toBeGreaterThan(0);
        dirReads.count = 0;
        expect((await s.get(`/api/blob/${BUTTON.capture}`, { "x-review-token": TOKEN })).status).toBe(200);
        expect((await s.get(`/api/blob/${BUTTON.baseline}`, { "x-review-token": TOKEN })).status).toBe(200);
        expect(dirReads.count).toBe(0);
    });

    it("keeps serving an image two pull requests share after either closes and its download is pruned", async () => {
        const other = "4".repeat(40);
        const pushed = "5".repeat(40);
        // Whichever loaded last, closing each in turn closes the one the image was found under once.
        for (const closed of [123, 124]) {
            const prs = [];
            const runs = {};
            const ghOf = (r) => {
                prs.push(
                    { number: 123, head: r.head, branch: "feature" },
                    { number: 124, head: other, branch: "other" },
                );
                Object.assign(runs, { [r.head]: { id: 1000, head: r.head }, [other]: { id: 1001, head: other } });
                const fake = onePr({
                    prs,
                    runs,
                    jobs: { 1000: [job("compact-mantine")], 1001: [job("compact-mantine")] },
                    artifacts: { 1000: ["visual-compact-mantine-1"], 1001: ["visual-compact-mantine-1"] },
                    results: { "visual-compact-mantine-1": { commit: r.head, headSha: r.head } },
                })(r);
                // A run GitHub cannot answer for: its pull request keeps the capture it showed.
                return async (args, input) => {
                    if (args[1]?.endsWith("actions/runs/1002")) {
                        throw new Error("HTTP 502");
                    }
                    return fake(args, input);
                };
            };
            const s = await start({ ghOf });
            const token = { "x-review-token": TOKEN };
            expect((await s.get("/api/pr/124/compact-mantine", token)).status).toBe(200);
            expect((await s.get(`/api/blob/${BUTTON.capture}`, token)).status).toBe(200);
            // One closes; the other is pushed to, and its new run cannot be read yet, so it keeps
            // its capture without loading it again. The refresh prunes the closed one's download.
            const kept = prs.find((p) => p.number !== closed);
            prs.splice(prs.indexOf(prs.find((p) => p.number === closed)), 1);
            kept.head = pushed;
            runs[pushed] = { id: 1002, head: pushed };
            expect((await s.get("/api/prs", token)).status).toBe(200);
            const gone = closed === 123 ? "1000-1" : "1001-1";
            expect([closed, existsSync(join(s.tmp, gone))]).toEqual([closed, false]);
            const blob = await s.get(`/api/blob/${BUTTON.capture}`, token);
            expect([closed, blob.status]).toEqual([closed, 200]);
            const pic = await s.get(`/api/pic/${picName(BUTTON, "auto")}`, token);
            expect([closed, pic.status]).toEqual([closed, 200]);
        }
    });

    it("drops only the damaged copy's capture and serves the image from another change's good copy", async () => {
        // Two pull requests whose captures hold the same image.
        const other = "4".repeat(40);
        const s = await start({
            ghOf: (r) =>
                onePr({
                    prs: [
                        { number: 123, head: r.head, branch: "feature" },
                        { number: 124, head: other, branch: "other" },
                    ],
                    runs: { [r.head]: { id: 1000, head: r.head }, [other]: { id: 1001, head: other } },
                    jobs: { 1000: [job("compact-mantine")], 1001: [job("compact-mantine")] },
                    artifacts: { 1000: ["visual-compact-mantine-1"], 1001: ["visual-compact-mantine-1"] },
                    results: { "visual-compact-mantine-1": { commit: r.head, headSha: r.head } },
                })(r),
        });
        const token = { "x-review-token": TOKEN };
        expect((await s.get("/api/pr/124/compact-mantine", token)).status).toBe(200);
        await s.app.idle();
        const fileIn = (d) => join(s.tmp, d, "compact-mantine", BUTTON.file);
        const resultsIn = (d) => join(s.tmp, d, "compact-mantine/results.json");
        // The copy the server reads first is the one whose missing file it answers 404 for.
        const good = readFileSync(fileIn("1000-1"));
        rmSync(fileIn("1000-1"));
        const first = (await s.get(`/api/blob/${BUTTON.capture}`, token)).status === 404 ? "1000-1" : "1001-1";
        writeFileSync(fileIn("1000-1"), good);
        const second = first === "1000-1" ? "1001-1" : "1000-1";
        writeFileSync(fileIn(first), "tampered");
        const res = await s.get(`/api/blob/${BUTTON.capture}`, token);
        expect(res.status).toBe(200);
        expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(BUTTON.capture);
        // Only the damaged copy's capture is dropped, to download again on the next reload.
        expect(existsSync(resultsIn(first))).toBe(false);
        expect(existsSync(resultsIn(second))).toBe(true);
    });

    it("forgets the images a local preview named once it is captured again in the same directory", async () => {
        const r = makeRepo();
        const previews = join(r.dir, "previews");
        const dest = join(previews, "123", "compact-mantine");
        copyFixture("compact-mantine", dest, {
            commit: "3".repeat(40),
            headSha: r.head,
            pr: 123,
            runId: null,
            runAttempt: null,
            local: {
                describe: "abc1234-dirty",
                diff: "0".repeat(64),
                preview: { merge: "3".repeat(40), host: "devbox", tool: "test" },
            },
        });
        const status = join(previews, "123", "status.json");
        writeFileSync(status, JSON.stringify({ state: "done" }));
        const s = await start({
            fakes: () => fakeAdapters({ prs: [{ number: 123, head: r.head, branch: "feature" }] }),
            previews,
        });
        const token = { "x-review-token": TOKEN };
        expect((await s.get(`/api/blob/${BUTTON.capture}`, token)).status).toBe(200);
        // visual-preview.sh captures the pull request again: the button's image is another one.
        const img = new PNG({ width: 10, height: 10 });
        img.data.fill(77);
        const bytes = PNG.sync.write(img);
        writeFileSync(join(dest, BUTTON.file), bytes);
        const saved = JSON.parse(readFileSync(join(dest, "results.json"), "utf8"));
        saved.items.find((i) => i.file === BUTTON.file).capture = sha256(bytes);
        writeFileSync(join(dest, "results.json"), JSON.stringify(saved));
        // Before the server reads it again, the old image is gone, not damaged.
        expect((await s.get(`/api/blob/${BUTTON.capture}`, token)).status).toBe(404);
        expect(existsSync(join(dest, "results.json"))).toBe(true);
        const later = new Date(Date.now() + 100000);
        utimesSync(status, later, later);
        expect((await s.get("/api/prs", token)).status).toBe(200);
        const pr = await (await s.get("/api/pr/123/compact-mantine", token)).json();
        expect(pr.items.find((i) => i.file === BUTTON.file).capture).toBe(sha256(bytes));
        // Once it has, neither the old image nor its picture is found; the new image is.
        expect((await s.get(`/api/blob/${BUTTON.capture}`, token)).status).toBe(404);
        expect((await s.get(`/api/pic/${picName(BUTTON, "auto")}`, token)).status).toBe(404);
        expect((await s.get(`/api/blob/${sha256(bytes)}`, token)).status).toBe(200);
        expect(existsSync(join(dest, "results.json"))).toBe(true);
    });
});

describe("serve: the session cookie", () => {
    it("sets an HttpOnly, SameSite=Strict cookie named per server for the right token only", async () => {
        const s = await start({ serverId: "a1b2" });
        expect((await s.post("/api/session", { token: "x".repeat(43) })).status).toBe(401);
        expect((await s.post("/api/session", {})).status).toBe(401);
        expect((await s.post("/api/session", { token: TOKEN }, { origin: "http://127.0.0.1:1" })).status).toBe(403);
        const res = await s.post("/api/session", { token: TOKEN });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ had: false });
        const cookie = res.headers.get("set-cookie");
        expect(cookie).toMatch(/^vr_session_a1b2=[\w-]+; Path=\/; Max-Age=604800; HttpOnly; SameSite=Strict$/);
        // The cookie is not the token.
        expect(cookie).not.toContain(TOKEN);
        // Sent again with it: the page already had a good one.
        const again = await s.post("/api/session", { token: TOKEN }, { cookie: cookieOf(res) });
        expect(await again.json()).toEqual({ had: true });
    });

    it("marks the cookie Secure when the page is served over HTTPS", async () => {
        const s = await start({ origin: "https://review.example:9443" });
        const res = await s.post("/api/session", { token: TOKEN });
        expect(res.headers.get("set-cookie")).toMatch(/; Secure$/);
    });

    it("accepts the cookie or the header on every route, and neither without one", async () => {
        const s = await start();
        const cookie = cookieOf(await s.post("/api/session", { token: TOKEN }));
        for (const path of [
            "/api/prs?cached=1",
            `/api/blob/${BUTTON.capture}`,
            `/api/pic/${picName(BUTTON, "plain")}`,
        ]) {
            expect([path, (await s.get(path)).status]).toEqual([path, 401]);
            expect([path, (await s.get(path, { cookie })).status]).toEqual([path, 200]);
            expect([path, (await s.get(path, { "x-review-token": TOKEN })).status]).toEqual([path, 200]);
            expect([path, (await s.get(path, { cookie: "vr_session_other=abc" })).status]).toEqual([path, 401]);
        }
        const decision = { id: "123", project: "compact-mantine", file: BUTTON.file, decision: "accept" };
        expect((await s.post("/api/decide", decision, { cookie })).status).toBe(200);
    });

    it("refuses whatever names another origin or another site, the cookie or the header with it", async () => {
        const s = await start();
        const cookie = cookieOf(await s.post("/api/session", { token: TOKEN }));
        const other = { origin: "http://127.0.0.1:1" };
        const decision = { id: "123", project: "compact-mantine", file: BUTTON.file, decision: "accept" };
        expect((await s.post("/api/decide", decision, { cookie, ...other })).status).toBe(403);
        for (const path of ["/api/prs?cached=1", `/api/blob/${BUTTON.capture}`]) {
            expect((await s.get(path, { cookie, ...other })).status).toBe(403);
            expect((await s.get(path, { "x-review-token": TOKEN, ...other })).status).toBe(403);
            // A plain <img> on another port of this host names no origin, but says it is another site's.
            expect((await s.get(path, { cookie, "sec-fetch-site": "same-site" })).status).toBe(403);
            expect((await s.get(path, { cookie, "sec-fetch-site": "same-origin" })).status).toBe(200);
            expect((await s.get(path, { cookie, origin: s.origin })).status).toBe(200);
        }
    });

    it("keeps the server id in the work directory, so a restart keeps the cookie's name", async () => {
        const s = await start();
        const state = join(s.tmp, "state");
        expect(readFileSync(join(state, "server-id"), "utf8")).toBe(s.app.serverId);
        // A restart on the same work directory reads it back: the same name, and with the same
        // token the same value, so an open page stays signed in.
        expect(serverIdOf(state)).toBe(s.app.serverId);
        // A damaged file is replaced, not used.
        writeFileSync(join(state, "server-id"), "not an id");
        const fresh = serverIdOf(state);
        expect(fresh).toMatch(/^[0-9a-f]{16}$/);
        expect(serverIdOf(state)).toBe(fresh);
    });

    it("ends the cookie with the token, and keeps another server's cookie apart", async () => {
        const s = await start({ serverId: "same" });
        const cookie = cookieOf(await s.post("/api/session", { token: TOKEN }));
        // The same server id with a new token: the old cookie's value no longer matches.
        const rotated = await start({ serverId: "same", token: "n".repeat(43) });
        expect((await rotated.get("/api/prs?cached=1", { cookie })).status).toBe(401);
        // Another server: its own cookie name, so this one's is not its.
        const other = await start();
        expect(other.app.serverId).toMatch(/^[0-9a-f]{16}$/);
        expect(other.app.serverId).not.toBe(s.app.serverId);
        expect((await other.get("/api/prs?cached=1", { cookie })).status).toBe(401);
    });
});
