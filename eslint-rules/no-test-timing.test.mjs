// Tests of the no-test-timing lint rule: a valid and an invalid case per pattern.
//
//   node --test eslint-rules/no-test-timing.test.mjs
import { describe, it } from "node:test";

import { RuleTester } from "eslint";

import rule from "./no-test-timing.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: "module" } });
const clock = { messageId: "clock" };
const sleep = { messageId: "sleep" };
const timeout = { messageId: "timeout" };
const frames = { messageId: "frames" };
const pageTimer = { messageId: "pageTimer" };
const FRAMES_HELPER = "async function frames(count) { for (let i = 0; i < count; i++) { await nextFrame(); } }";

tester.run("no-test-timing", rule, {
    valid: [
        // Wall-clock values that are not asserted on, and assertions on counted work.
        "const t0 = performance.now(); run(); console.log(performance.now() - t0);",
        "const deadline = Date.now() + 1000; while (Date.now() < deadline) { step(); }",
        "expect(visits).toBeLessThan(500);",
        "assert(count < 10);",
        "expect(record.createdAt).toBe(Date.now());",
        "const before = Date.now(); const e = emit(); assert.ok(e.timestamp >= before);",
        "const before = Date.now(); const r = retry(); expect(r.until).toBeGreaterThanOrEqual(before + 300);",
        "const dir = `run-${Date.now()}`; const w = new Writer(dir); expect(w.size).toBeGreaterThan(0);",
        "function f() { const t = Date.now(); } function g(t) { expect(t).toBeLessThan(5); }",
        // Waiting on a condition, and zero-delay yields.
        "await expect.poll(() => ready()).toBe(true);",
        "await vi.waitFor(() => assert(done));",
        "await new Promise((r) => setTimeout(r, 0));",
        "await new Promise((r) => setTimeout(r));",
        "await new Promise((r) => requestAnimationFrame(r));",
        "await new Promise((r) => emitter.once('done', r));",
        "await sleep(ms => ms);",
        "await wait('selector');",
        "setTimeout(() => fire(), 100);",
        "vi.advanceTimersByTime(1000);",
        "queue.run(async (ctx) => { ctx.progress(50); await new Promise((r) => setTimeout(r, 10)); });",
        "const op = vi.fn(async () => { await sleep(20); });",
        "await sleepUntil(1000);",
        // Tests and hooks without a timeout, and other options.
        "it('x', () => {});",
        "it('x', async () => {}, { retry: 2 });",
        "test.each([[1, 2]])('x %i', (a, b) => {});",
        "describe('x', () => {});",
        "beforeEach(() => {});",
        "it('x', runCase);",
        "vi.setConfig({ restoreMocks: true });",
        "window.setTimeout(() => {}, 10);",
        "expect(locator).toBeVisible({ timeout: 5000 });",
        "regex.test(input, 5);",
        // One animation frame is a yield; frames counted by the work they carry are counted work.
        "await nextFrame(); expect(count).toBe(1);",
        "await nextFrame(); click(); await nextFrame();",
        "while (updates() < target) { await nextFrame(); }",
        "for (let i = 0; i < 5; i++) { scene.render(); await nextFrame(); }",
        "for (let i = 0; i < steps.length; i++) { await nextFrame(); }",
        "for (let i = 0; i < 1; i++) { await nextFrame(); }",
        "await new Promise((r) => requestAnimationFrame(() => r()));",
        `${FRAMES_HELPER} await frames(1);`,
        `${FRAMES_HELPER} await frames(n);`,
        "async function frames(element) { await element.waitForStableFrame(); } await frames(el);",
        "async function frames(el, count = 3) { await new Promise((r) => { let d = 0; el.on('render', () => ++d >= count && r()); }); } await frames(el);",
        "const op = vi.fn(async () => { for (let i = 0; i < 5; i++) await nextFrame(); });",
        "const nextFrame = () => fetchFrame(); await nextFrame(); await nextFrame();",
        // Timers in the page that only yield, and timers in the test itself.
        "await page.evaluate(() => new Promise((r) => globalThis.setTimeout(r, 0)));",
        "await page.evaluate(() => { setTimeout(() => go()); });",
        "await page.addInitScript(() => { globalThis.ready = true; });",
        "await page.waitForFunction((n) => globalThis.pops >= n, 3);",
        "setTimeout(() => page.evaluate(() => go()), 100);",
        { code: "await nextFrame(); await nextFrame();", options: [{ frameWaits: false }] },
    ],
    invalid: [
        // 1. Asserting on wall-clock time.
        {
            code: "const t0 = performance.now(); run(); const elapsed = performance.now() - t0; expect(elapsed).toBeLessThan(500);",
            errors: [clock],
        },
        { code: "const t0 = Date.now(); run(); assert(Date.now() - t0 < 500);", errors: [clock] },
        { code: "const t = new Date().getTime(); run(); assert.ok(new Date().getTime() - t <= 10);", errors: [clock] },
        {
            code: "const s = process.hrtime.bigint(); expect(process.hrtime.bigint() - s).toBeGreaterThan(0n);",
            errors: [clock],
        },
        {
            code: "const a = time(() => Date.now()); let b; b = performance.now(); expect(b / 2 < 3).toBe(true);",
            errors: [clock],
        },
        {
            code: "const fast = performance.now(); const slow = performance.now(); assert.isBelow(fast / slow, 2);",
            errors: [clock],
        },
        // 2. Fixed sleeps.
        { code: "await page.waitForTimeout(500);", errors: [sleep] },
        { code: "it('x', async () => { await sleep(100); });", errors: [sleep] },
        { code: "beforeEach(async () => { await page.waitForTimeout(100); });", errors: [sleep] },
        { code: "async function settle() { await delay(500); }", errors: [sleep] },
        { code: "await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));", errors: [sleep] },
        { code: "await new Promise((resolve) => setTimeout(resolve, 100));", errors: [sleep] },
        { code: "await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });", errors: [sleep] },
        { code: "await new Promise((r) => window.setTimeout(r, 50));", errors: [sleep] },
        { code: "await setTimeout(100);", errors: [sleep] },
        { code: "await sleep(1_000);", errors: [sleep] },
        { code: "await helpers.delay(2 * 100);", errors: [sleep] },
        { code: "await nap(10);", options: [{ sleepNames: ["nap"] }], errors: [sleep] },
        // 3. Per-test timeouts.
        { code: "it('x', async () => {}, 60_000);", errors: [timeout] },
        { code: "it('x', { timeout: 1000 }, async () => {});", errors: [timeout] },
        { code: "it('x', async () => {}, { timeout: 1000 });", errors: [timeout] },
        { code: "it.skipIf(ci)('x', async () => {}, TIMEOUT);", errors: [timeout] },
        { code: "test.each([1])('x %i', (n) => {}, 5000);", errors: [timeout] },
        { code: "describe('x', () => {}, 30000);", errors: [timeout] },
        { code: "beforeAll(async () => {}, 30000);", errors: [timeout] },
        { code: "test.beforeEach(async () => {}, 30000);", errors: [timeout] },
        { code: "it('x', runCase, 5000);", errors: [timeout] },
        { code: "vi.setConfig({ testTimeout: 60000 });", errors: [timeout] },
        { code: "function f() { this.timeout(5000); }", errors: [timeout] },
        { code: "test.setTimeout(120000);", errors: [timeout] },
        // 4. Waits counted in animation frames (graphty-monorepo issues 2398, 2446, 2466).
        { code: "for (let i = 0; i < 3; i++) { await nextFrame(); }", errors: [frames] },
        { code: "for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));", errors: [frames] },
        { code: "const N = 10; for (let i = 1; i <= N; i++) { await nextFrame(); }", errors: [frames] },
        { code: `${FRAMES_HELPER} await frames(30); expect(updates).toBe(30);`, errors: [frames] },
        {
            code: "async function frames(frames = 3) { for (let i = 0; i < frames; i++) { await nextFrame(); } } await frames();",
            errors: [frames],
        },
        {
            code: "const skip = async (n) => { for (let f = 0; f < n; f++) { await new Promise((r) => window.requestAnimationFrame(r)); } }; it('x', async () => { await skip(6); });",
            errors: [frames],
        },
        { code: "await nextFrame(); await nextFrame();", errors: [frames] },
        {
            code: "function tick() { return new Promise((r) => requestAnimationFrame(() => r())); } await tick(); await tick();",
            errors: [frames],
        },
        { code: "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));", errors: [frames] },
        {
            code: "async function twoFrames() { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); } await twoFrames();",
            errors: [frames],
        },
        // 5. Timers in code handed to the page (graphty-monorepo issues 2422, 2447).
        {
            code: "await page.evaluate(() => new Promise((resolve) => { history.back(); setTimeout(() => history.back(), 50); setTimeout(() => { history.forward(); resolve(); }, 150); }));",
            errors: [pageTimer, pageTimer],
        },
        { code: "await page.addInitScript(() => { globalThis.setTimeout(fail, 1500); });", errors: [pageTimer] },
        {
            code: "function install() { setTimeout(() => answer(), RETRY_MS); } await page.addInitScript(install);",
            errors: [pageTimer],
        },
        { code: "await page.$eval('#x', (el) => setTimeout(() => el.click(), 10));", errors: [pageTimer] },
    ],
});
