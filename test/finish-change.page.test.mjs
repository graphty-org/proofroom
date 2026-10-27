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

it("asks for the passkey once, says it signs the decisions and the baselines, and pushes one signed statement", async () => {
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
    const asked = [];
    // The page asks in its own dialog: every question is answered yes, as the reader would.
    await page.exposeFunction("asked", (message) => {
        asked.push(message);
        return true;
    });
    await page.addInitScript(() => {
        const { document, MutationObserver, navigator } = globalThis;
        new MutationObserver(() => {
            for (const d of document.querySelectorAll("dialog.ask[open]:not([data-seen])")) {
                d.dataset.seen = "";
                globalThis.asked(d.querySelector(".ask-text").innerText).then(() => d.querySelector("#ask-yes").click());
            }
        }).observe(document, { childList: true, subtree: true, attributes: true });
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
    await page.goto(`${origin}/#token=${TOKEN}`);
    await page.getByRole("button", { name: "Register passkey" }).click();
    await page.getByText(/^Passkey registered/).first().waitFor();
    for (const file of ["button--primary.dark.png", "badge--default.light.png"]) {
        const res = await fetch(`${origin}/api/decide`, {
            method: "POST",
            headers: { "x-review-token": TOKEN, origin, "content-type": "application/json" },
            body: JSON.stringify({ id: "123", project: "compact-mantine", file, decision: "accept", reason: null }),
        });
        expect(res.status).toBe(200);
    }

    await page.getByRole("button", { name: /^Finish #123/ }).click();
    await page.locator(".finish-outcome h2", { hasText: /^Finished #123/ }).waitFor();

    expect(asked.join("\n")).toContain(
        "Your passkey signs your decisions and the baselines this Finish leaves on the branch, in one prompt (Face ID or a security key).",
    );
    expect(await page.evaluate(() => globalThis.gets)).toBe(1);
    const files = git(r.remote, "show", "--name-only", "--format=", "feature").split("\n");
    expect(files.some((f) => f.includes("/reviews/"))).toBe(false);
    const [file, ...more] = files.filter((f) => f.startsWith(`${APPROVALS}/`));
    expect(more).toEqual([]);
    const st = JSON.parse(git(r.remote, "show", `feature:${file}`));
    expect(file).toBe(statementPath(APPROVALS, st));
    expect(st.entries.map((e) => e.path)).toEqual([
        "compact-mantine/badge--default.light.png",
        "compact-mantine/button--primary.dark.png",
    ]);
    const keys = JSON.parse(readFileSync(join(tmp, "state/passkeys-pending.json"), "utf8")).keys;
    expect(verifyApproval(st, keys, { origin })).toBeNull();
});
