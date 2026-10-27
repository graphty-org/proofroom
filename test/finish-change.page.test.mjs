/*
 * Finish in change mode on the review page in Chromium, pressed as a reader presses it: the sheet
 * names the passkey that signs, the passkey is asked once, and the branch gains one signed change
 * statement and no review record.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { verifyApproval } from "../trusted/lib/approval.mjs";
import { statementPath } from "../trusted/lib/change-approval.mjs";
import { CONFIG_FILE } from "../trusted/lib/config.mjs";
import { createApp } from "../trusted/lib/serve.mjs";
import { onePrFakes } from "./fakes/adapters.mjs";
import { FIXTURE_CONFIG, git, interceptedPage, isolateGit, makeRepo } from "./helpers.mjs";

const TOKEN = "f".repeat(43);
const APPROVALS = "visual-review-approvals";

let browser;
let server;
let app;
let page;
beforeAll(async () => {
    isolateGit();
    // Headless Chromium can crash at start while reading system fonts without this.
    process.env.FC_FONTATIONS = "1";
    browser = await chromium.launch();
});
afterAll(() => browser?.close());
afterEach(async () => {
    await page?.close();
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.idle();
});

it("asks for the passkey once, names it on the sheet, and pushes one signed statement", async () => {
    // A repository in change mode with no key yet: the reader registers one on the page.
    const r = makeRepo();
    const own = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
    writeFileSync(
        join(r.repo, CONFIG_FILE),
        JSON.stringify({ ...own, approvalFormat: "change", repositoryId: "id-1" }),
    );
    git(r.repo, "commit", "-q", "-am", "change statements");
    git(r.repo, "push", "-q", "origin", "master");

    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    // A host name: WebAuthn never takes an IP address as a passkey's site.
    const origin = `http://localhost:${server.address().port}`;
    const tmp = join(r.repo, "tmp/visual-review");
    app = createApp({ repo: r.repo, tmp, config: FIXTURE_CONFIG, token: TOKEN, origin, ...onePrFakes()(r) });
    server.on("request", app);
    page = await interceptedPage(browser, { viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
        const { navigator } = globalThis;
        globalThis.gets = 0;
        const real = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = (o) => {
            globalThis.gets++;
            return real(o);
        };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
    const message = () => page.locator("#msg-t").innerText();
    const current = () => page.locator("#snap-list .srow.cur").getAttribute("data-snap");
    const ready = () =>
        expect
            .poll(async () => {
                const key = await current();
                return key !== null && (await page.locator("#stage").getAttribute("data-ready")) === key;
            })
            .toBe(true);
    await page.goto(`${origin}/#token=${TOKEN}&change=123&snap=compact-mantine/button--primary.dark.png`);

    // Two images accepted with the A key, from the first one on; the rest stay undecided.
    for (const file of ["button--primary.dark.png", "slider--sizes.png"]) {
        await expect.poll(current).toBe(`compact-mantine/${file}`);
        await ready();
        await page.keyboard.press("KeyA");
        await expect.poll(message).toMatch(/^Accepted #\d+\.$/);
    }

    // Finish: the sheet offers to register a passkey, Settings registers it, and the sheet signs.
    await page.locator('#top [data-act="finish"]').click();
    const sheet = page.locator("dialog.finish[open]");
    await sheet.getByRole("button", { name: "Register passkey..." }).click();
    const settings = page.locator("dialog.settings[open]");
    await settings.getByRole("button", { name: "Register passkey..." }).click();
    await settings.getByRole("button", { name: "Create the passkey" }).click();
    await expect.poll(message).toMatch(/^Passkey registered \(/);
    await settings.getByRole("button", { name: "Close" }).click();
    await sheet.waitFor();
    expect(await sheet.innerText()).toMatch(/Signs with: Passkey '(Linux|Mac|Windows) passkey, \d{4}-\d\d-\d\d'/);
    await page.keyboard.press("Enter");
    await expect.poll(message).toMatch(/^Finished #123 at \d\d:\d\d, signed\./);

    expect(await page.evaluate(() => globalThis.gets)).toBe(1);
    const files = git(r.remote, "show", "--name-only", "--format=", "feature").split("\n");
    expect(files.some((f) => f.includes("/reviews/"))).toBe(false);
    const [file, ...more] = files.filter((f) => f.startsWith(`${APPROVALS}/`));
    expect(more).toEqual([]);
    const st = JSON.parse(git(r.remote, "show", `feature:${file}`));
    expect(file).toBe(statementPath(APPROVALS, st));
    expect(st.entries.map((e) => [e.path, e.decision])).toEqual([
        ["compact-mantine/button--primary.dark.png", "accept"],
        ["compact-mantine/slider--sizes.png", "accept"],
    ]);
    const keys = JSON.parse(readFileSync(join(tmp, "state/passkeys-pending.json"), "utf8")).keys;
    expect(verifyApproval(st, keys, { origin })).toBeNull();
});
