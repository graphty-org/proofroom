/*
 * Finish in change mode on the review page in Chromium, pressed as a reader presses it: the sheet
 * says what the one passkey prompt signs, the passkey is asked once, and the branch gains one
 * signed change statement and no review record.
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
import { FIXTURE_CONFIG, git, interceptedPage, isolateGit, makeRepo, onePr } from "./helpers.mjs";

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

it("asks for the passkey once, says it signs this Finish's decisions, and pushes one signed statement", async () => {
    // A repository in change mode with no key yet: the reader registers one on the page.
    const r = makeRepo();
    const own = JSON.parse(readFileSync(join(r.repo, CONFIG_FILE), "utf8"));
    writeFileSync(join(r.repo, CONFIG_FILE), JSON.stringify({ ...own, approvalFormat: "change", repositoryId: "id-1" }));
    git(r.repo, "commit", "-q", "-am", "change statements");
    git(r.repo, "push", "-q", "origin", "master");

    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    // A host name: WebAuthn never takes an IP address as a passkey's site.
    const origin = `http://localhost:${server.address().port}`;
    const tmp = join(r.repo, "tmp/visual-review");
    app = createApp({ repo: r.repo, tmp, config: FIXTURE_CONFIG, token: TOKEN, origin, gh: onePr()(r) });
    server.on("request", app);
    page = await interceptedPage(browser, { viewport: { width: 1000, height: 800 } });
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
    // The page asks in its own dialog: every question is answered yes with a click, as the reader
    // would, until `done` shows.
    const asked = [];
    const answerYesUntil = async (done) => {
        const ask = page.locator("dialog.ask[open]");
        for (;;) {
            await ask.or(done).first().waitFor();
            if (!(await ask.isVisible())) {
                return;
            }
            asked.push(await ask.locator(".ask-text").innerText());
            await ask.locator("#ask-yes").click();
            await ask.waitFor({ state: "detached" });
        }
    };
    await page.goto(`${origin}/#token=${TOKEN}`);
    await page.getByRole("button", { name: "Register passkey" }).click();
    await answerYesUntil(page.getByText(/^Passkey registered/).first());

    // Two images accepted with the A key, from the first one's tile on; the rest stay undecided.
    await page.getByRole("button", { name: "Review", exact: true }).first().click();
    await page.locator('.tile[data-file="button--primary.dark.png"]').click();
    const status = () => page.locator("#status").textContent();
    for (const n of [2, 3]) {
        await page.locator("#stage[data-ready]").waitFor();
        await page.keyboard.press("a");
        await expect.poll(status).toMatch(new RegExp(`^Accepted #${n}\\.`));
    }

    await page.getByRole("button", { name: /^Finish #123/ }).click();
    await answerYesUntil(page.locator(".finish-outcome h2", { hasText: /^Finished #123/ }));

    expect(asked.join("\n")).toContain(
        "Your passkey signs this Finish's 2 decisions, in one prompt (Face ID or a security key).",
    );
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
