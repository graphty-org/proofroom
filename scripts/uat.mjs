#!/usr/bin/env node
/*
 * User acceptance test of a running review page: walks a reviewer's journey in Chromium against
 * whatever the page lists, on its real screenshots.
 *
 *   npm run uat -- '<page URL with #token=...>' [--shots <dir>]
 *
 * Prints one PASS, FAIL or SKIP line per step (SKIP with the reason, when the page has nothing for
 * the step), records each failure and carries on, saves a screenshot per step to --shots (default
 * tmp/uat-shots), prints a summary and exits 1 when anything failed.
 *
 * It decides on snapshots only to undo the decision at once, and its last step checks that no
 * decision is left behind. It never presses Finish's final confirm, Exclude or Start capture,
 * never registers a passkey and never creates a virtual authenticator. Not published.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: { shots: { type: "string", default: "tmp/uat-shots" } },
});
const url = positionals[0];
if (!url || !url.includes("#token=")) {
    console.error("usage: npm run uat -- '<page URL with #token=...>' [--shots <dir>]");
    process.exit(2);
}
const SHOTS = resolve(opts.shots);
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// Every key the Keys sheet lists that acts through a control (trusted/page/key-map.js), as printed
// tokens, with a snapshot open and Snapshots shown. hold Space has no control; at the viewing level
// (both panes rails) Up and Down have no button, and Previous [Left / J] / Next [Right / K] do the same.
const SNAPSHOT_KEYS = [
    "Left",
    "J",
    "Right",
    "K",
    "Up",
    "Down",
    "Esc",
    "A",
    "R",
    "E",
    "U",
    "X",
    "V",
    "F",
    "H",
    "L",
    "S",
    "P",
    "Y",
    "B",
    "O",
    "N",
    "0",
    "1",
    "2",
    "4",
    "8",
    "Z",
    "Shift+1",
    "Shift+2",
    "Shift+3",
    "Shift+N",
    "/",
    "?",
    "Shift+A",
];
// Text a reviewer should never see unless the step expects it.
const BAD_TEXT = /could not be shown|could not be loaded|damaged|\berrors?\b|\bfailed\b/i;
// A change's row that has snapshots to decide: its count says so.
const READY_COUNT = /: [\d,]+ undecided$|: [\d,]+ of [\d,]+ decided$/;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
await context.grantPermissions(["clipboard-read", "clipboard-write"]);
const page = await context.newPage();
page.setDefaultTimeout(30_000);

// Per-step collectors.
let consoleErrors = [];
let pageErrors = [];
let badResponses = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${m.text()} @ ${m.location()?.url ?? ""}`));
page.on("pageerror", (e) => pageErrors.push(e.message));
// Each response >= 400, with the start of its body as evidence.
const bodies = new Map();
page.on("response", async (r) => {
    if (r.status() >= 400) {
        const line = `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`;
        badResponses.push(line);
        if (!bodies.has(line)) {
            bodies.set(line, (await r.text().catch(() => "")).slice(0, 300));
        }
    }
});

const results = [];
let n = 0;

class Skip extends Error {}
const skip = (why) => {
    throw new Skip(why);
};

// Runs one step: its own assertions, then the common ones (pictures, error text, console, HTTP),
// and a screenshot. Never throws.
async function step(name, fn, opt = {}) {
    n++;
    const id = String(n).padStart(2, "0");
    const fails = [];
    let skipped = null;
    consoleErrors = [];
    pageErrors = [];
    badResponses = [];
    const check = (ok, msg) => {
        if (!ok) {
            fails.push(msg);
        }
        return ok;
    };
    try {
        await fn({ check });
    } catch (err) {
        if (err instanceof Skip) {
            skipped = err.message;
        } else {
            fails.push(`step threw: ${err.message.split("\n").slice(0, 3).join(" | ")}`);
        }
    }
    try {
        for (const m of await brokenPictures()) {
            fails.push(`picture did not load: ${m}`);
        }
        for (const line of await badText()) {
            // A change whose CI capture failed says so in its row: data, not a page fault.
            if (!(opt.allowText && opt.allowText.test(line)) && !/^Capture failed: /.test(line)) {
                fails.push(`on screen: "${line}"`);
            }
        }
    } catch (err) {
        fails.push(`common checks threw: ${err.message.split("\n")[0]}`);
    }
    for (const e of consoleErrors) {
        fails.push(`console error: ${e}`);
    }
    for (const e of pageErrors) {
        fails.push(`uncaught page error: ${e}`);
    }
    for (const r of badResponses) {
        fails.push(`HTTP ${r} -> ${bodies.get(r) ?? ""}`);
    }
    const shot = join(SHOTS, `${id}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    const status = fails.length ? "FAIL" : skipped !== null ? "SKIP" : "PASS";
    results.push({ id, name, status, fails, skipped, shot });
    console.log(`${status.padEnd(5)} ${id} ${name}`);
    for (const f of fails) {
        console.log(`        - ${f}`);
    }
    if (skipped !== null) {
        console.log(`        - skipped: ${skipped}`);
    }
}

// Pictures in the window that a reviewer sees: every <img> must load (naturalWidth > 0) and every
// canvas have a size. Waits (bounded) for images still loading.
async function brokenPictures() {
    await page
        .waitForFunction(
            () =>
                [...document.querySelectorAll("img")]
                    .filter((i) => {
                        const r = i.getBoundingClientRect();
                        return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
                    })
                    .every((i) => i.complete),
            null,
            { timeout: 30_000 },
        )
        .catch(() => {});
    return page.evaluate(() => {
        const inView = (n) => {
            const r = n.getBoundingClientRect();
            const s = getComputedStyle(n);
            return (
                r.width > 0 &&
                r.height > 0 &&
                r.bottom > 0 &&
                r.right > 0 &&
                r.top < innerHeight &&
                r.left < innerWidth &&
                s.visibility !== "hidden" &&
                s.display !== "none"
            );
        };
        const out = [];
        for (const i of document.querySelectorAll("img")) {
            if (inView(i) && (!i.complete || i.naturalWidth === 0)) {
                out.push(`<img> ${i.complete ? "broken" : "still loading"} ${i.src.slice(0, 120)}`);
            }
        }
        for (const c of document.querySelectorAll("canvas")) {
            if (inView(c) && (c.width === 0 || c.height === 0)) {
                out.push(`<canvas> with no size in ${c.parentElement?.className ?? "?"}`);
            }
        }
        return out;
    });
}

// Lines of visible text that say something went wrong.
async function badText() {
    const text = await page.evaluate(() => {
        const parts = [document.body.innerText];
        const d = document.querySelector("dialog[open]");
        if (d) {
            parts.push(d.innerText);
        }
        return parts.join("\n");
    });
    const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => BAD_TEXT.test(l));
    return [...new Set(lines)].map((l) => l.slice(0, 200));
}

// The key tokens a reader sees printed on a visible control now: a control's visible key boxes,
// a Find box's [/] placeholder, and the keys a visible menu button names for its closed menu.
async function shownKeys() {
    return new Set(
        await page.evaluate(() => {
            const vis = (n) => n.getClientRects().length > 0;
            const out = [];
            for (const n of document.querySelectorAll("[data-key]")) {
                if (!vis(n)) {
                    continue;
                }
                if (n instanceof HTMLInputElement) {
                    if (n.placeholder.endsWith(`[${n.dataset.key}]`)) {
                        out.push(n.dataset.key);
                    }
                    continue;
                }
                if ([...n.querySelectorAll(":scope > kbd")].some((k) => vis(k))) {
                    out.push(...n.dataset.key.split(" / "));
                }
            }
            for (const n of document.querySelectorAll("[data-menukeys]")) {
                if (vis(n)) {
                    out.push(...Object.keys(JSON.parse(n.dataset.menukeys)));
                }
            }
            return out;
        }),
    );
}

// Presses a key after checking a visible button shows it (every key has a button).
async function press(key, check) {
    const shown = await shownKeys();
    check(shown.has(key), `key ${key} pressed but no visible button shows it`);
    await page.evaluate(() => {
        const a = document.activeElement;
        if (a && a.matches("input, textarea, select")) {
            a.blur();
        }
    });
    const pw =
        { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Esc: "Escape", "?": "Shift+Slash" }[
            key
        ] ?? key;
    await page.keyboard.press(pw.replace(/^Shift\+([a-z])$/i, (_, c) => `Shift+${c.toUpperCase()}`));
}

const act = (a, extra = "") => page.locator(`[data-act="${a}"]${extra}`).filter({ visible: true }).first();
const itemNumber = async () => (await page.locator("#viewer").innerText()).match(/#(\d+)/)?.[1] ?? null;
// "12 of 720 decided" in the snapshot pane's head.
const decided = async () => {
    const m = (await page.locator("#snaps-head").innerText()).match(/([\d,]+) of ([\d,]+) decided/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
};
const waitDecided = (want) =>
    page.waitForFunction(
        (w) => {
            const m = document.querySelector("#snaps-head")?.innerText.match(/([\d,]+) of ([\d,]+) decided/);
            return m && Number(m[1].replace(/,/g, "")) === w;
        },
        want,
        { timeout: 20_000 },
    );
const decisionPost = () =>
    page
        .waitForResponse(
            (r) => /\/api\/(decide|accept-all)$/.test(new URL(r.url()).pathname) && r.request().method() === "POST",
            { timeout: 20_000 },
        )
        .catch(() => null);
// Waits until the viewer has drawn the current snapshot: a picture, or an error pane.
const viewerSettled = () =>
    page.waitForFunction(
        () => {
            const v = document.querySelector("#viewer");
            return (
                v.querySelector(".error") !== null ||
                [...v.querySelectorAll("canvas, img")].some((c) => c.getClientRects().length > 0 && (c.width ?? 0) > 0)
            );
        },
        null,
        { timeout: 60_000 },
    );
const viewerError = async () => {
    const e = page.locator("#viewer .error").filter({ visible: true });
    return (await e.count()) ? (await e.first().innerText()).trim() : null;
};
const dialogOpen = () => page.evaluate(() => document.querySelector("dialog#dlg")?.open === true);
// Waits for the box to open and show `text` (its content can arrive after the box opens).
const waitDialog = (text) =>
    page
        .waitForFunction(
            (t) => {
                const d = document.querySelector("dialog#dlg");
                return d?.open && d.innerText.includes(t);
            },
            text,
            { timeout: 30_000 },
        )
        .then(
            () => true,
            () => false,
        );
// The page ignores a decision on an image shown less than a quarter second (a guard against
// deciding on a picture not seen): wait until the current one has been on screen 400 ms.
const seen = () =>
    page.waitForFunction(
        () => {
            const m = performance.getEntriesByName("viewer-drawn").at(-1);
            return m && performance.now() - m.startTime > 400;
        },
        null,
        { timeout: 30_000, polling: 100 },
    );
// Whether Changes and Snapshots are shown (not rails).
const panes = () =>
    page.evaluate(() => ["changes", "snaps"].map((i) => !document.getElementById(i).classList.contains("rail")));
const samePanes = (a, b) => a[0] === b[0] && a[1] === b[1];
const panesAre = (want) =>
    page
        .waitForFunction(
            (w) =>
                ["changes", "snaps"].every((i, k) => !document.getElementById(i).classList.contains("rail") === w[k]),
            want,
            { timeout: 10_000 },
        )
        .then(
            () => true,
            () => false,
        );
const message = () => page.locator("#msg-t").innerText();
const curSnapIsChanged = () =>
    page.evaluate(() => {
        const r = document.querySelector("#snap-list .srow.cur");
        return r
            ? r.innerText
                  .split("\n")
                  .map((l) => l.trim())
                  .includes("changed")
            : false;
    });

// Decides on the current snapshot then undoes it, checking the decided count both ways.
async function decideAndUndo(check, how) {
    const before = await decided();
    check(before !== null, "no 'N of M decided' in the snapshot pane");
    await seen();
    const post = decisionPost();
    await how.decide();
    const r = await post;
    if (!check(r !== null, `no decision request was sent; the message line says "${await message()}"`)) {
        return;
    }
    check(r.ok(), `decision POST answered ${r.status()}`);
    await waitDecided(before + how.count).catch(async () =>
        check(false, `decided count is ${await decided()}, expected ${before + how.count}`),
    );
    const undoPost = decisionPost();
    await how.undo();
    const u = await undoPost;
    if (!check(u !== null, `Undo sent no request; the message line says "${await message()}"`)) {
        return;
    }
    check(u.ok(), `undo POST answered ${u.status()}`);
    await waitDecided(before).catch(async () =>
        check(false, `after Undo decided count is ${await decided()}, expected ${before}`),
    );
}

/**
 * Up and Down move a list's current row, and its Previous [Up] / Next [Down] buttons move it
 * exactly the same: Down, Down, Up by key, back with Up, then the same by button, back with Up.
 * Skips when the list has fewer than three rows.
 * @param {(ok: boolean, msg: string) => boolean} check records a failure
 * @param {object} where the list
 * @param {string} where.list its element's selector
 * @param {string} where.row its rows' selector
 * @param {string} where.attr the attribute naming a row
 * @param {string} where.buttons the selector of the element holding its two buttons
 * @param {string} where.name its name in a failure
 */
async function rowWalk(check, where) {
    const { list, row, attr, buttons, name } = where;
    const count = await page.locator(`${list} ${row}`).count();
    if (count < 3) {
        skip(`${name} lists ${count} row(s); Down, Down, Up needs 3`);
    }
    const up = page.locator(`${buttons} [data-act="rowup"]`).filter({ visible: true }).first();
    const down = page.locator(`${buttons} [data-act="rowdown"]`).filter({ visible: true }).first();
    for (const [b, key, label] of [
        [up, "Up", "Previous"],
        [down, "Down", "Next"],
    ]) {
        if (!check((await b.count()) === 1, `${name}: no visible ${label} [${key}] button`)) {
            return;
        }
        check(
            (await b.innerText()).trim() === key,
            `${name}: the ${label} button shows "${await b.innerText()}", not its [${key}] box alone`,
        );
        check((await b.getAttribute("aria-label")) === label, `${name}: the ${key} button is not named ${label}`);
    }
    const cur = () =>
        page
            .locator(`${list} ${row}.cur`)
            .first()
            .getAttribute(attr)
            .catch(() => null);
    const moved = (from) =>
        page
            .waitForFunction(
                ([l, r, a, f]) => document.querySelector(`${l} ${r}.cur`)?.getAttribute(a) !== f,
                [list, row, attr, from],
                { timeout: 15_000 },
            )
            .then(
                () => true,
                () => false,
            );
    const start = await cur();
    check(start !== null, `${name}: no current row`);
    const byKey = [];
    await page.locator(list).first().focus();
    for (const k of ["ArrowDown", "ArrowDown", "ArrowUp"]) {
        const was = await cur();
        await page.keyboard.press(k);
        check(await moved(was), `${name}: ${k} did not move the current row from ${was}`);
        byKey.push(await cur());
    }
    await page.keyboard.press("ArrowUp");
    check(await moved(byKey.at(-1)), `${name}: the last ArrowUp did not move back`);
    check((await cur()) === start, `${name}: Down Down Up Up ended at ${await cur()}, not where it started (${start})`);
    const byButton = [];
    for (const b of [down, down, up]) {
        const was = await cur();
        await b.click();
        check(await moved(was), `${name}: a button press did not move the current row from ${was}`);
        byButton.push(await cur());
    }
    check(
        byButton.join() === byKey.join(),
        `${name}: the buttons went ${byButton.join(" > ")}, the keys ${byKey.join(" > ")}`,
    );
    const was = await cur();
    await up.click();
    await moved(was);
    check((await cur()) === start, `${name}: Previous did not take the row back to ${start}`);
}

// The word of a story key ("project/component--name.mode.png" -> "name") that the fewest keys
// listed hold, so Find on it narrows the list.
const rarestWord = (keys) => {
    const word = (k) =>
        k
            .split("/")
            .pop()
            .replace(/\.png$/, "")
            .split("--")
            .pop()
            .split(".")[0];
    const hits = (w) => keys.filter((k) => k.includes(w)).length;
    return (
        keys
            .map((k) => ({ k, w: word(k) }))
            .filter((x) => x.w.length >= 3)
            .sort((a, b) => hits(a.w) - hits(b.w))[0] ?? null
    );
};

// The change rows, by id: their aria-label ("<title>: <count>") and kind tag.
const changeRows = () =>
    page.evaluate(() =>
        [...document.querySelectorAll('#chg-list [data-act="pickchg"]')].map((r) => ({
            id: r.dataset.chg,
            label: r.getAttribute("aria-label") ?? "",
            title: r.getAttribute("title") ?? "",
            tag: r.querySelector(".tag")?.innerText.trim() ?? "",
        })),
    );
const changeRow = (id) => page.locator(`#chg-list [data-act="pickchg"][data-chg="${id}"]`);

// The two changes the journey opens: the candidate or seed run when one is listed, else the first
// change with snapshots to decide; and the first other change with snapshots to decide.
let primary = null;
let second = null;
let startLabels = new Map();
let snapOpen = false;

// ------------------------------------------------------------------ the journey

await step("load the changes list", async ({ check }) => {
    await page.goto(url);
    // The server lists the changes and reads CI runs on its first load.
    await page
        .locator('#chg-list [data-act="pickchg"]')
        .first()
        .waitFor({ timeout: 180_000 })
        .catch(() => check(false, "the changes list never showed a change in 3 minutes"));
    check(
        (await page.locator('[data-act="screen-review"]').getAttribute("aria-current")) === "page",
        "the Review tab is not marked current",
    );
    check(/\d+ changes?/.test(await page.locator("#chg-count").innerText()), "no change count in the Changes pane");
    const rows = await changeRows();
    const ready = rows.filter((r) => READY_COUNT.test(r.label));
    primary = ready.find((r) => /^(seed|candidate)$/i.test(r.tag)) ?? ready[0] ?? null;
    second = ready.find((r) => r !== primary && !/^(seed|candidate)$/i.test(r.tag)) ?? null;
    startLabels = new Map(rows.map((r) => [r.id, r.label]));
    console.log(`        first change: ${primary ? primary.title : "none with snapshots to decide"}`);
    console.log(`        second change: ${second ? second.title : "none"}`);
});

await step(
    "Changes: Previous [Up] and Next [Down] move the current change as the keys do",
    async ({ check }) => {
        await rowWalk(check, {
            list: "#chg-list",
            row: ".chg",
            attr: "data-chg",
            buttons: "#chg-rows",
            name: "Changes",
        });
    },
    { allowText: /^Choose a change on the left/ },
);

await step(
    "Keys sheet by button and by ?",
    async ({ check }) => {
        await act("keys").click();
        check(await waitDialog("Previous snapshot"), "the Keys button opened no sheet");
        const t = await page.locator("dialog#dlg").innerText();
        for (const w of ["Previous snapshot", "Accept", "Undo the last decision", "Fit"]) {
            check(t.includes(w), `the Keys sheet does not list "${w}"`);
        }
        await act("closebox").click();
        check(!(await dialogOpen()), "Close did not close the Keys sheet");
        await press("?", check);
        check(await waitDialog("Previous snapshot"), "? opened no sheet");
        await press("Esc", check);
        await page.waitForFunction(() => !document.querySelector("dialog#dlg").open);
    },
    { allowText: /^Choose a change on the left/ },
);

await step(
    "Settings sheet",
    async ({ check }) => {
        await act("settings").click();
        check(await waitDialog("Disk budget"), "Settings opened no sheet");
        const t = await page.locator("dialog#dlg").innerText();
        for (const w of ["Passkeys", "Theme", "Highlight color", "Disk budget"]) {
            check(t.includes(w), `Settings does not show "${w}"`);
        }
        check(
            await page
                .locator('dialog#dlg [data-act="register"]')
                .first()
                .waitFor({ timeout: 15_000 })
                .then(
                    () => true,
                    () => false,
                ),
            "no Register passkey... button (not pressed)",
        );
        await act("closebox").click();
        check(!(await dialogOpen()), "Close did not close Settings");
    },
    { allowText: /takes no capture requests|^Choose a change on the left/ },
);

await step(
    "New capture dialog: open and cancel",
    async ({ check }) => {
        await act("newcap", '[data-zone="top"]').click();
        check(await waitDialog("Where"), "New capture... opened no dialog");
        const t = await page.locator("dialog#dlg").innerText();
        for (const w of ["What", "Against which baselines", "Which projects", "Where"]) {
            check(t.includes(w), `New capture does not show "${w}"`);
        }
        check(
            await page.locator('dialog#dlg [data-act="capstart"]').isVisible(),
            "no Start capture button (not pressed)",
        );
        check(
            /Esc/.test(await page.locator('dialog#dlg [data-act="confirmcancel"]').innerText()),
            "Cancel does not show its Esc key",
        );
        await page.locator('dialog#dlg [data-act="confirmcancel"]').click();
        check(!(await dialogOpen()), "Cancel did not close New capture");
        await act("newcap", '[data-zone="top"]').click();
        check(await waitDialog("Where"), "New capture... opened no dialog the second time");
        await page.keyboard.press("Escape");
        check(!(await dialogOpen()), "Esc did not close New capture");
    },
    { allowText: /takes no capture requests|^Choose a change on the left/ },
);

let baselineCount = 0;
await step(
    "Baselines screen",
    async ({ check }) => {
        await act("screen-baselines").click();
        await page
            .locator("#scr-baselines")
            .waitFor({ state: "visible" })
            .catch(() => {});
        const has = await page
            .locator('#bl-list [data-act="blrow"]')
            .first()
            .waitFor({ timeout: 120_000 })
            .then(
                () => true,
                () => false,
            );
        baselineCount = await page.locator('#bl-list [data-act="blrow"]').count();
        if (!has) {
            skip("the Baselines screen lists no baseline");
        }
        check(
            /baselines?/.test(await page.locator("#bl-list-pane").innerText()),
            "the Baselines pane shows no baseline count",
        );
        await page.waitForFunction(
            () =>
                [...document.querySelectorAll("#bl-viewer canvas, #bl-viewer img")].some(
                    (c) => c.getClientRects().length > 0,
                ),
            null,
            { timeout: 60_000 },
        );
        check((await page.locator("#bl-viewer").innerText()).includes("History"), "no History for the baseline");
        if (baselineCount < 2) {
            skip("one baseline: Next, Right and Left have nowhere to go");
        }
        const num = async () => (await page.locator("#bl-viewer").innerText()).match(/#(\d+)/)?.[1];
        const changedFrom = (was) =>
            page.waitForFunction((w) => document.querySelector("#bl-viewer").innerText.match(/#(\d+)/)?.[1] !== w, was);
        const a = await num();
        await act("next").click();
        await changedFrom(a);
        const b = await num();
        check(Number(b) === Number(a) + 1, `Next went from #${a} to #${b}`);
        await press("Right", check);
        await changedFrom(b);
        await press("Left", check);
        await page.waitForFunction(
            (was) => document.querySelector("#bl-viewer").innerText.match(/#(\d+)/)?.[1] === was,
            b,
        );
    },
    { allowText: /^Choose a change on the left/ },
);

await step(
    "Baselines: Previous [Up] and Next [Down] move the current baseline as the keys do",
    async ({ check }) => {
        if (baselineCount === 0) {
            skip("the Baselines screen lists no baseline");
        }
        await rowWalk(check, {
            list: "#bl-list",
            row: ".blrow",
            attr: "data-bl",
            buttons: "#bl-ctrl",
            name: "Baselines",
        });
    },
    { allowText: /^Choose a change on the left/ },
);

await step(
    "Baselines find",
    async ({ check }) => {
        if (baselineCount < 2) {
            skip(`the Baselines screen lists ${baselineCount} baseline(s); Find needs 2 to narrow`);
        }
        const pick = rarestWord(
            await page.locator('#bl-list [data-act="blrow"]').evaluateAll((rs) => rs.map((r) => r.dataset.bl)),
        );
        if (!pick) {
            skip("no listed baseline has a name to find");
        }
        const { k: key, w: word } = pick;
        await press("/", check);
        check(
            await page.evaluate(() => document.activeElement?.id === "bl-find"),
            "/ did not focus the Baselines Find box",
        );
        await page.keyboard.type(word);
        await page
            .waitForFunction(
                ([k, all]) =>
                    document.querySelectorAll('#bl-list [data-act="blrow"]').length < all &&
                    document.querySelector(`#bl-list [data-bl="${k}"]`) !== null,
                [key, baselineCount],
                { timeout: 15_000 },
            )
            .catch(async () =>
                check(
                    false,
                    `Find "${word}" did not narrow the baselines to one holding ${key}: Find holds "${await page.locator("#bl-find").inputValue()}"`,
                ),
            );
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
    },
    { allowText: /^Choose a change on the left/ },
);

await step(
    "Captures screen",
    async ({ check }) => {
        await act("screen-captures").click();
        await page.locator("#scr-captures").waitFor({ state: "visible" });
        check((await page.locator("#cap-list").innerText()).includes("Captures"), "the Captures list has no title");
        check(
            await page.locator('#cap-list [data-act="newcap"]').isVisible(),
            "no New capture... in the Captures pane",
        );
        const keys = await shownKeys();
        check(keys.has("Up") && keys.has("Down"), "the Captures header shows no Previous [Up] / Next [Down] key boxes");
        for (const a of ["rowup", "rowdown"]) {
            check(
                (await page.locator(`#cap-rows-nav [data-act="${a}"]`).filter({ visible: true }).count()) === 1,
                `no visible ${a} button in the Captures header`,
            );
        }
    },
    { allowText: /^Choose a change on the left/ },
);

await step(
    "Captures: Previous [Up] and Next [Down] move the current capture as the keys do",
    async ({ check }) => {
        await rowWalk(check, {
            list: "#cap-rows",
            row: ".caprow",
            attr: "data-cap",
            buttons: "#cap-rows-nav",
            name: "Captures",
        });
    },
    { allowText: /^Choose a change on the left/ },
);

await step(
    "Find a change",
    async ({ check }) => {
        await act("screen-review").click();
        await page.locator("#chg-list").waitFor({ state: "visible" });
        const target = second ?? primary;
        const all = await page.locator('#chg-list [data-act="pickchg"]').count();
        if (!target || all < 2) {
            skip(
                target ? "only one change is listed: Find has nothing to narrow" : "no change has snapshots to decide",
            );
        }
        await press("/", check);
        check(
            await page.evaluate(() => document.activeElement?.id === "chg-find"),
            "/ did not focus Find in the Changes pane",
        );
        await page.keyboard.type(target.id);
        await page
            .waitForFunction(
                ([a, id]) =>
                    document.querySelectorAll('#chg-list [data-act="pickchg"]').length < a &&
                    document.querySelector(`#chg-list [data-chg="${id}"]`) !== null,
                [all, target.id],
                { timeout: 15_000 },
            )
            .catch(() => check(false, `Find "${target.id}" did not narrow the changes to one holding ${target.title}`));
        await page.keyboard.press("Escape");
        await page
            .waitForFunction((a) => document.querySelectorAll('#chg-list [data-act="pickchg"]').length === a, all, {
                timeout: 15_000,
            })
            .catch(() => check(false, "Esc did not clear Find"));
    },
    { allowText: /^Choose a change on the left/ },
);

// The steps from here to Finish need the first change open.
const needOpen = () => {
    if (!snapOpen) {
        skip(primary ? "the first change did not open" : "no change has snapshots to decide");
    }
};
// The steps that compare two pictures need a changed snapshot: picks one if the current is not.
async function onChanged() {
    if (await curSnapIsChanged()) {
        return;
    }
    const key = await page.evaluate(
        () =>
            [...document.querySelectorAll("#snap-list .srow")].find((r) =>
                r.innerText
                    .split("\n")
                    .map((l) => l.trim())
                    .includes("changed"),
            )?.dataset.snap ?? null,
    );
    if (!key) {
        skip("the open change lists no changed snapshot");
    }
    await page.locator(`#snap-list .srow[data-snap="${key}"]`).click();
    await viewerSettled();
}

await step("Open the first change (a candidate or seed run when listed) by its row", async ({ check }) => {
    if (!primary) {
        skip("no change has snapshots to decide");
    }
    console.log(`        opening ${primary.title}`);
    // A click on a change's row opens it (app.js pickChange); Open [Enter] is tested on the second change.
    await changeRow(primary.id).click();
    await page.locator('#snap-list [data-act="pickrow"]').first().waitFor({ timeout: 180_000 });
    await viewerSettled();
    snapOpen = true;
    check((await decided()) !== null, "no 'N of M decided' after opening");
    check((await itemNumber()) !== null, "the viewer names no snapshot number");
    const e = await viewerError();
    check(!e, `viewer error: ${e}`);
});

await step("Every key in the Keys sheet has a visible button (snapshot open)", async ({ check }) => {
    needOpen();
    const shown = await shownKeys();
    for (const k of SNAPSHOT_KEYS) {
        check(shown.has(k), `key ${k} acts here but no visible button shows it`);
    }
    const lit = await page.evaluate(() =>
        [...document.querySelectorAll("[data-key]")]
            .filter(
                (n) =>
                    n.getClientRects().length &&
                    n.tagName !== "INPUT" &&
                    n.querySelectorAll(":scope > kbd").length === 0,
            )
            .map((n) => `${n.dataset.act}[${n.dataset.key}]`),
    );
    check(lit.length === 0, `controls with a key but no key box: ${lit.join(", ")}`);
});

await step("Snapshots: Previous [Up] and Next [Down] move the current snapshot as the keys do", async ({ check }) => {
    needOpen();
    await rowWalk(check, {
        list: "#snap-list",
        row: ".srow",
        attr: "data-snap",
        buttons: "#snaps-head",
        name: "Snapshots",
    });
    await viewerSettled();
});

await step("Walk snapshots with Next and Previous buttons", async ({ check }) => {
    needOpen();
    const walked = [await itemNumber()];
    for (let i = 0; i < 3; i++) {
        await act("next").click();
        await page.waitForFunction(
            (was) => document.querySelector("#viewer").innerText.match(/#(\d+)/)?.[1] !== was,
            walked.at(-1),
        );
        await viewerSettled();
        walked.push(await itemNumber());
        const e = await viewerError();
        check(!e, `#${walked.at(-1)}: ${e}`);
    }
    check(new Set(walked).size === 4, `Next did not move to new snapshots: ${walked.join(", ")}`);
    await act("prev").click();
    await page.waitForFunction(
        (was) => document.querySelector("#viewer").innerText.match(/#(\d+)/)?.[1] === was,
        walked[2],
    );
    await viewerSettled();
    check((await itemNumber()) === walked[2], `Previous went to #${await itemNumber()}, expected #${walked[2]}`);
});

await step("Walk snapshots with Right / Left and K / J keys", async ({ check }) => {
    needOpen();
    const a = await itemNumber();
    for (const k of ["Right", "Right", "Left", "K", "J"]) {
        const was = await itemNumber();
        await press(k, check);
        await page
            .waitForFunction((w) => document.querySelector("#viewer").innerText.match(/#(\d+)/)?.[1] !== w, was)
            .catch(() => check(false, `${k} did not move from #${was}`));
        await viewerSettled();
        const e = await viewerError();
        check(!e, `#${await itemNumber()}: ${e}`);
    }
    const b = await itemNumber();
    check(Number(b) === Number(a) + 1, `after Right Right Left K J expected #${Number(a) + 1}, at #${b}`);
});

await step("Viewer modes by button", async ({ check }) => {
    needOpen();
    await onChanged();
    for (const m of ["view-side", "view-flash", "view-highlight", "view-spotlight"]) {
        const b = act(m);
        if ((await b.getAttribute("aria-disabled")) === "true") {
            check(false, `${m} is unavailable on a changed snapshot`);
            continue;
        }
        await b.click();
        await page
            .waitForFunction(
                (a) => document.querySelector(`[data-act="${a}"]`)?.getAttribute("aria-checked") === "true",
                m,
                { timeout: 10_000 },
            )
            .catch(() => check(false, `${m} not shown as on after clicking it`));
        await viewerSettled();
        const e = await viewerError();
        check(!e, `${m}: ${e}`);
    }
    // Blink, in Highlight.
    await act("view-highlight").click();
    const bl = act("blink");
    const before = await bl.getAttribute("aria-pressed");
    await bl.click();
    check((await bl.getAttribute("aria-pressed")) !== before, "Blink did not toggle in Highlight");
    await bl.click();
    // Baseline shown / hidden.
    await act("view-side").click();
    const p = act("baseline");
    const pb = await p.getAttribute("aria-pressed");
    await p.click();
    check((await p.getAttribute("aria-pressed")) !== pb, "Baseline did not toggle");
    await viewerSettled();
    await p.click();
    check((await p.getAttribute("aria-pressed")) === pb, "Baseline did not toggle back");
});

await step("Viewer modes by key (V F H L S P)", async ({ check }) => {
    needOpen();
    await onChanged();
    for (const [k, m] of [
        ["H", "view-highlight"],
        ["S", "view-spotlight"],
        ["V", "view-side"],
        ["F", "view-flash"],
        ["V", "view-side"],
    ]) {
        await press(k, check);
        await page
            .waitForFunction(
                (a) => document.querySelector(`[data-act="${a}"]`)?.getAttribute("aria-checked") === "true",
                m,
                { timeout: 10_000 },
            )
            .catch(() => check(false, `${k} did not switch to ${m}`));
        await viewerSettled();
        const e = await viewerError();
        check(!e, `${m}: ${e}`);
    }
    await press("H", check);
    const bl = act("blink");
    const before = await bl.getAttribute("aria-pressed");
    await press("L", check);
    check((await bl.getAttribute("aria-pressed")) !== before, "L did not toggle Blink");
    await press("L", check);
    await press("V", check);
    const p = act("baseline");
    const pb = await p.getAttribute("aria-pressed");
    await press("P", check);
    check((await p.getAttribute("aria-pressed")) !== pb, "P did not toggle Baseline");
    await press("P", check);
    check((await p.getAttribute("aria-pressed")) === pb, "P did not toggle Baseline back");
});

await step("Zoom buttons and keys (0 1 2 4 8 Z)", async ({ check }) => {
    needOpen();
    const on = (a) =>
        page
            .locator(`[data-act="${a}"]`)
            .first()
            .evaluate((x) => x.classList.contains("on"));
    for (const z of ["zoom-1", "zoom-2", "zoom-4", "zoom-8", "zoom-fit"]) {
        await act(z).click();
        check(await on(z), `${z} not shown as on after clicking it`);
        await viewerSettled();
    }
    for (const k of ["1", "2", "4", "8", "0"]) {
        await press(k, check);
        const z = k === "0" ? "zoom-fit" : `zoom-${k}`;
        await page
            .waitForFunction((a) => document.querySelector(`[data-act="${a}"]`)?.classList.contains("on"), z, {
                timeout: 5000,
            })
            .catch(() => check(false, `key ${k} did not select ${z}`));
    }
    await press("Z", check);
    const anyOn = await page.evaluate(() =>
        ["zoom-1", "zoom-2", "zoom-4", "zoom-8"].some((a) =>
            document.querySelector(`[data-act="${a}"]`)?.classList.contains("on"),
        ),
    );
    check(anyOn, "Z did not cycle away from Fit");
    await press("0", check);
    const e = await viewerError();
    check(!e, `viewer error: ${e}`);
});

await step("More menu, Outline, Next area", async ({ check }) => {
    needOpen();
    await onChanged();
    await act("more").click();
    const menu = page.locator(".menu");
    await menu.waitFor();
    const t = await menu.innerText();
    for (const w of ["Image only", "Layout", "Outline", "Open centered on the area"]) {
        check(t.includes(w), `More menu lacks "${w}"`);
    }
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await press("B", check);
    await page
        .waitForFunction(() => /Outline on/.test(document.querySelector("#msg-t").innerText), null, { timeout: 5000 })
        .catch(() => check(false, "B did not say Outline on"));
    await press("B", check);
    await page
        .waitForFunction(() => /Outline off/.test(document.querySelector("#msg-t").innerText), null, { timeout: 5000 })
        .catch(() => check(false, "second B did not say Outline off"));
    const n1 = (await page.locator("#viewer").innerText()).match(/(\d+) of (\d+)/);
    if (n1 && Number(n1[2]) > 1) {
        await act("nextarea").click();
        await page
            .waitForFunction(
                (w) => document.querySelector("#viewer").innerText.match(/(\d+) of (\d+)/)?.[1] !== w,
                n1[1],
                { timeout: 5000 },
            )
            .catch(() => check(false, "Next area did not move to the next area"));
    }
});

await step("Accept with the button, then Undo with the button", async ({ check }) => {
    needOpen();
    await decideAndUndo(check, { count: 1, decide: () => act("accept").click(), undo: () => act("undo").click() });
});

await step("Accept with A, then Undo with U", async ({ check }) => {
    needOpen();
    await decideAndUndo(check, { count: 1, decide: () => press("A", check), undo: () => press("U", check) });
});

await step("Reject with the button (reason), then Undo", async ({ check }) => {
    needOpen();
    await decideAndUndo(check, {
        count: 1,
        decide: async () => {
            await act("reject").click();
            await page.locator("#popbox #reason").waitFor();
            check(/Enter/.test(await page.locator("#popok").innerText()), "the reason box's OK shows no Enter key");
            await page.locator("#popbox #reason").fill("UAT: test reject, undone at once");
            await page.locator("#popok").click();
        },
        undo: () => act("undo").click(),
    });
});

await step("Reject with R (reason, Enter), then Undo with U", async ({ check }) => {
    needOpen();
    await decideAndUndo(check, {
        count: 1,
        decide: async () => {
            await press("R", check);
            await page.locator("#popbox #reason").waitFor();
            await page.keyboard.type("UAT: test reject by key, undone at once");
            await page.keyboard.press("Enter");
        },
        undo: () => press("U", check),
    });
});

await step("Reject box: Cancel and Esc decide nothing", async ({ check }) => {
    needOpen();
    const before = await decided();
    await seen();
    await act("reject").click();
    await page.locator("#popbox").waitFor();
    await page.locator('#popbox [data-act="reasoncancel"]').click();
    await page.locator("#popbox").waitFor({ state: "detached" });
    await seen();
    await press("R", check);
    await page.locator("#popbox").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#popbox").waitFor({ state: "detached" });
    check((await decided()) === before, "cancelling the reject box changed the decided count");
});

await step("Select two snapshots, bulk Accept, Undo", async ({ check }) => {
    needOpen();
    // The undecided row after the current one.
    const next = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#snap-list .srow")];
        const i = rows.findIndex((r) => r.classList.contains("cur"));
        return rows.slice(i + 1).find((r) => !r.classList.contains("decided"))?.dataset.snap ?? null;
    });
    if (!next) {
        skip("no undecided snapshot after the current one to select beside it");
    }
    await press("X", check);
    await page.locator('[data-act="accsel"]').filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    const box = page.locator(`#snap-list .srow[data-snap="${next}"] [data-act="rowcheck"]`);
    await box.scrollIntoViewIfNeeded();
    await box.click();
    const accsel = act("accsel");
    await page
        .waitForFunction(() => /Accept 2/.test(document.querySelector('[data-act="accsel"]')?.innerText ?? ""), null, {
            timeout: 10_000,
        })
        .catch(async () =>
            check(false, `selection bar says "${await accsel.innerText().catch(() => "nothing")}", not Accept 2`),
        );
    check(/Esc/.test(await act("clearsel").innerText()), "the selection's Clear shows no Esc key");
    await decideAndUndo(check, { count: 2, decide: () => accsel.click(), undo: () => press("U", check) });
    if (
        await act("clearsel")
            .isVisible()
            .catch(() => false)
    ) {
        await act("clearsel").click();
    }
    check(
        !(await page.locator('[data-act="accsel"]').filter({ visible: true }).count()),
        "the selection did not clear",
    );
});

await step("Group Accept (Shift+A), then Undo", async ({ check }) => {
    needOpen();
    if (!(await page.locator('[data-act="gaccept"]').filter({ visible: true }).count())) {
        skip("the current snapshot's group shows no Accept N");
    }
    const label = await act("gaccept").innerText();
    const m = label.match(/Accept\s+(\d+)/);
    check(m !== null, `the group header's Accept says "${label}"`);
    if (m) {
        await decideAndUndo(check, {
            count: Number(m[1]),
            decide: () => press("Shift+A", check),
            undo: () => press("U", check),
        });
    }
});

await step("A pane key pressed again restores the panes (Shift+1, Shift+2, rails and Hide)", async ({ check }) => {
    needOpen();
    const start = await panes();
    // Opening a change shows the viewer with Changes as a rail and Snapshots shown.
    check(
        samePanes(start, [false, true]),
        `panes are [Changes, Snapshots] = ${start} after opening, expected [false, true]`,
    );
    // Each pair: the first press, then the same key or the pane's own control again, which must
    // take back exactly what the first did.
    const twice = async (label, first, again, wantMoved) => {
        const before = await panes();
        await first();
        await page
            .waitForFunction(
                (b) =>
                    ["changes", "snaps"].some(
                        (i, k) => !document.getElementById(i).classList.contains("rail") !== b[k],
                    ),
                before,
                { timeout: 10_000 },
            )
            .catch(() => check(false, `${label}: the first press changed no pane`));
        const mid = await panes();
        const said = await message();
        const moved = / moved to its rail/.test(said);
        await again();
        check(
            await panesAre(before),
            `${label}: pressed again, the panes are ${await panes()}, not ${before} as before the first press`,
        );
        if (moved) {
            check(
                new RegExp(`${wantMoved} shown again\\.$`).test(await message()),
                `${label}: the second press said "${await message()}", not that ${wantMoved} is shown again`,
            );
        }
        return { mid, moved };
    };
    // Shift+1 shows Changes, which may move Snapshots to its rail; again brings Snapshots back.
    const s1 = await twice(
        "Shift+1 twice",
        () => press("Shift+1", check),
        () => press("Shift+1", check),
        "Snapshots",
    );
    check(s1.mid[0], "Shift+1 did not show Changes");
    // The Changes rail, then Changes' Hide button, do the same.
    await twice(
        "Changes rail, then Hide",
        () => page.locator("#rail-c").click(),
        () => page.locator('#hide-c [data-act="pane1"]').filter({ visible: true }).first().click(),
        "Snapshots",
    );
    // Shift+2: from Changes shown and Snapshots a rail, showing Snapshots may move Changes; again
    // brings Changes back.
    await press("Shift+2", check);
    check(await panesAre([false, false]), `Shift+2 did not hide Snapshots: panes ${await panes()}`);
    await press("Shift+1", check);
    check(await panesAre([true, false]), `Shift+1 did not show Changes: panes ${await panes()}`);
    await twice(
        "Shift+2 twice",
        () => press("Shift+2", check),
        () => press("Shift+2", check),
        "Changes",
    );
    // The Snapshots rail, then Snapshots' Hide button.
    await twice(
        "Snapshots rail, then Hide",
        () => page.locator("#rail-s").click(),
        () => page.locator('#snaps-head [data-act="pane2"]').filter({ visible: true }).first().click(),
        "Changes",
    );
    // Back to the panes as opened.
    await press("Shift+1", check);
    check(await panesAre([false, false]), `Shift+1 did not hide Changes: panes ${await panes()}`);
    await press("Shift+2", check);
    check(await panesAre(start), `Shift+2 did not bring back the panes as opened: ${await panes()}`);
    // Image only, and back.
    await press("Shift+3", check);
    check(await panesAre([false, false]), "Shift+3 (Image only) did not hide both panes");
    await viewerSettled();
    // The viewing level: both panes rails, Previous [Left / J] and Next [Right / K] move the snapshot.
    const keys = await shownKeys();
    check(
        ["Left", "J", "Right", "K"].every((k) => keys.has(k)),
        "with both panes rails, Previous [Left / J] / Next [Right / K] are not shown",
    );
    await press("Shift+3", check);
    check(await panesAre(start), `Shift+3 again did not bring the panes back: ${await panes()}`);
});

await step("Both panes shown: only the pair Up and Down move shows its key boxes", async ({ check }) => {
    needOpen();
    const start = await panes();
    await page.setViewportSize({ width: 2400, height: 1000 });
    try {
        await press("Shift+1", check);
        if (!(await panesAre([true, true]))) {
            skip(`even 2400 px wide, Shift+1 shows panes ${await panes()}, not both`);
        }
        const boxes = (sel) =>
            page
                .locator(`${sel} [data-act^="row"][data-rows] > kbd`)
                .evaluateAll((ks) => ks.filter((k) => k.getClientRects().length > 0).length);
        await page.locator("#snap-list").focus();
        await page
            .waitForFunction(() => document.body.dataset.rows === "snaps", null, { timeout: 5000 })
            .catch(() => {});
        check(
            (await boxes("#snaps-head")) === 2,
            `in Snapshots, its pair shows ${await boxes("#snaps-head")} key boxes, not 2`,
        );
        check(
            (await boxes("#chg-rows")) === 0,
            `in Snapshots, the Changes pair shows ${await boxes("#chg-rows")} key boxes, not 0`,
        );
        check(
            (await page.locator('#chg-rows [data-act="rowup"]').innerText()).trim() === "Previous",
            "the Changes pair without boxes does not show its word Previous",
        );
        const snap = await page.locator("#snap-list .srow.cur").getAttribute("data-snap");
        await page.keyboard.press("ArrowDown");
        await page
            .waitForFunction((s) => document.querySelector("#snap-list .srow.cur")?.dataset.snap !== s, snap, {
                timeout: 10_000,
            })
            .catch(() => check(false, "in Snapshots, Down did not move the current snapshot"));
        await page.keyboard.press("ArrowUp");
        await page
            .waitForFunction((s) => document.querySelector("#snap-list .srow.cur")?.dataset.snap === s, snap, {
                timeout: 10_000,
            })
            .catch(() => check(false, "in Snapshots, Up did not move back"));
        await viewerSettled();
        await page.locator("#chg-list").focus();
        await page
            .waitForFunction(() => document.body.dataset.rows === "changes", null, { timeout: 5000 })
            .catch(() => {});
        check(
            (await boxes("#chg-rows")) === 2,
            `in Changes, its pair shows ${await boxes("#chg-rows")} key boxes, not 2`,
        );
        check(
            (await boxes("#snaps-head")) === 0,
            `in Changes, the Snapshots pair shows ${await boxes("#snaps-head")} key boxes, not 0`,
        );
        check(
            (await page.locator('#snaps-head [data-act="rowup"]').innerText()).trim() === "Previous",
            "the Snapshots pair without boxes does not show its word Previous",
        );
    } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page
            .locator("#snap-list")
            .focus()
            .catch(() => {});
    }
    // Back to the panes as opened: Changes a rail, Snapshots shown.
    if ((await panes())[0]) {
        await press("Shift+1", check);
        await page
            .waitForFunction(() => document.getElementById("changes").classList.contains("rail"), null, {
                timeout: 10_000,
            })
            .catch(() => {});
    }
    if (!(await panes())[1]) {
        await press("Shift+2", check);
    }
    check(await panesAre(start), `the panes did not come back to ${start}: ${await panes()}`);
});

await step("Find a snapshot", async ({ check }) => {
    needOpen();
    const all = await page.locator('#snap-list [data-act="pickrow"]').count();
    if (all < 2) {
        skip(`the snapshot list shows ${all} row(s): Find has nothing to narrow`);
    }
    const pick = rarestWord(await page.locator("#snap-list .srow").evaluateAll((rs) => rs.map((r) => r.dataset.snap)));
    if (!pick) {
        skip("no listed snapshot has a name to find");
    }
    const { k: key, w: word } = pick;
    await page.locator("#snap-list").focus();
    await press("/", check);
    const id = await page.evaluate(() => document.activeElement?.id);
    check(id === "snap-find", `/ focused #${id}, not the Snapshots Find box`);
    await page.keyboard.type(word);
    await page
        .waitForFunction(
            ([k, a]) =>
                document.querySelectorAll('#snap-list [data-act="pickrow"]').length < a &&
                document.querySelector(`#snap-list .srow[data-snap="${k}"]`) !== null,
            [key, all],
            { timeout: 15_000 },
        )
        .catch(async () =>
            check(
                false,
                `Find "${word}" did not narrow the snapshots to one holding ${key}: list starts "${(await page.locator("#snap-list").innerText()).slice(0, 120)}"`,
            ),
        );
    await page.keyboard.press("Escape");
    await page
        .waitForFunction((a) => document.querySelectorAll('#snap-list [data-act="pickrow"]').length === a, all, {
            timeout: 15_000,
        })
        .catch(() => check(false, "Esc did not clear Find"));
});

// Opens up to three rows of the Approved before group, showing it first; skips without one.
async function approvedBefore(check) {
    const head = page.locator("#snap-list .ghead.before").first();
    if (!(await head.count())) {
        skip("the open change lists no Approved before group");
    }
    const grp = page.locator("#snap-list .grp").filter({ has: page.locator(".ghead.before") });
    const show = grp.locator('[data-act="gshowall"]').filter({ visible: true });
    if (await show.count()) {
        await show.first().click();
    }
    const rows = grp.locator('[data-act="pickrow"]');
    await rows
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => check(false, "showing Approved before showed no row"));
    const k = Math.min(3, await rows.count());
    for (let i = 0; i < k; i++) {
        await rows.nth(i).click();
        await viewerSettled();
        const e = await viewerError();
        check(!e, `viewer error on Approved before #${await itemNumber()}: ${e}`);
    }
}

await step("Open snapshots approved before", async ({ check }) => {
    needOpen();
    await approvedBefore(check);
});

await step("Finish sheet opens; its confirm is not pressed", async ({ check }) => {
    needOpen();
    await act("finish").click();
    await page.waitForFunction(
        () => document.querySelector("dialog#dlg")?.open || document.querySelector('[data-act="finishgo"]'),
        null,
        { timeout: 30_000 },
    );
    check(
        (await page.locator('[data-act="finishgo"]').filter({ visible: true }).count()) > 0,
        "the Finish sheet shows no Finish confirm button",
    );
    await page.keyboard.press("Escape");
    await page
        .waitForFunction(
            () =>
                !document.querySelector("dialog#dlg")?.open &&
                ![...document.querySelectorAll('[data-act="finishgo"]')].some((x) => x.getClientRects().length > 0),
            null,
            { timeout: 10_000 },
        )
        .catch(() => check(false, "Esc did not close the Finish sheet"));
});

let secondOpen = false;
await step(
    "Back to changes, open the second change with Enter",
    async ({ check }) => {
        if (snapOpen) {
            await press("Esc", check);
        }
        await page
            .locator('#chg-list [data-act="pickchg"]')
            .first()
            .waitFor({ state: "visible" })
            .catch(() => check(false, "Esc did not show the changes list"));
        if (!second) {
            skip("no second change with snapshots to decide");
        }
        console.log(`        opening ${second.title}`);
        await changeRow(second.id).click();
        await press("Enter", check);
        await page.waitForFunction(
            () =>
                document.querySelector("#snaps-head")?.innerText.includes("decided") &&
                document.querySelector('#snap-list [data-act="pickrow"]'),
            null,
            { timeout: 180_000 },
        );
        secondOpen = true;
        check(
            await page
                .waitForFunction(
                    (t) =>
                        document.querySelector("#msg-t").innerText.startsWith("Opened ") &&
                        document.querySelector("#msg-t").innerText.includes(t),
                    second.title,
                    { timeout: 15_000 },
                )
                .then(
                    () => true,
                    () => false,
                ),
            `the message line says "${await message()}", not that ${second.title} opened`,
        );
        await viewerSettled();
        const e = await viewerError();
        check(!e, `viewer error on #${await itemNumber()}: ${e}`);
    },
    { allowText: /^Choose a change on the left/ },
);

const needSecond = () => {
    if (!secondOpen) {
        skip(second ? "the second change did not open" : "no second change with snapshots to decide");
    }
};

await step("Second change: walk snapshots, all viewer modes", async ({ check }) => {
    needSecond();
    for (let i = 0; i < 4; i++) {
        await press("Right", check);
        await viewerSettled();
        const e = await viewerError();
        check(!e, `#${await itemNumber()}: ${e}`);
    }
    for (const k of ["H", "S", "F", "V"]) {
        if (
            (await act({ H: "view-highlight", S: "view-spotlight", F: "view-flash", V: "view-side" }[k]).getAttribute(
                "aria-disabled",
            )) === "true"
        ) {
            continue;
        }
        await press(k, check);
        await viewerSettled();
        const e = await viewerError();
        check(!e, `${k} on #${await itemNumber()}: ${e}`);
    }
});

await step("Second change: Accept with A and Reject with the button, both undone", async ({ check }) => {
    needSecond();
    await decideAndUndo(check, { count: 1, decide: () => press("A", check), undo: () => act("undo").click() });
    await decideAndUndo(check, {
        count: 1,
        decide: async () => {
            await act("reject").click();
            await page.locator("#popbox #reason").fill("UAT: test reject, undone at once");
            check(/Enter/.test(await page.locator("#popok").innerText()), "the reason box's OK shows no Enter key");
            await page.keyboard.press("Enter");
        },
        undo: () => press("U", check),
    });
});

await step("Second change: open snapshots approved before", async ({ check }) => {
    needSecond();
    await approvedBefore(check);
});

await step(
    "No decisions left behind",
    async ({ check }) => {
        if (snapOpen || secondOpen) {
            await press("Esc", check);
        }
        await page.locator('#chg-list [data-act="pickchg"]').first().waitFor({ state: "visible" });
        const now = new Map((await changeRows()).map((r) => [r.id, r.label]));
        const opened = [primary, second].filter(Boolean);
        if (!opened.length) {
            skip("no change was opened");
        }
        for (const r of opened) {
            check(
                now.get(r.id) === startLabels.get(r.id),
                `${r.title}: "${startLabels.get(r.id)}" at the start, "${now.get(r.id)}" now`,
            );
        }
    },
    { allowText: /^Choose a change on the left/ },
);

await browser.close();

// ------------------------------------------------------------------ summary
const count = (s) => results.filter((r) => r.status === s);
console.log("\n==== summary");
console.log(
    `${results.length} steps: ${count("PASS").length} passed, ${count("FAIL").length} failed, ${count("SKIP").length} skipped`,
);
for (const r of count("SKIP")) {
    console.log(`SKIP ${r.id} ${r.name}: ${r.skipped}`);
}
for (const r of count("FAIL")) {
    console.log(`FAIL ${r.id} ${r.name} (${r.shot})`);
}
process.exit(count("FAIL").length ? 1 : 0);
