/*
 * An in-memory renderer with the Playwright Chromium adapter's functions: a "browser" is a plain
 * object, and a shot is a fixed PNG, or a failure for a URL the test names.
 */

import { PNG } from "pngjs";

/**
 * The fake renderer.
 * @param {{ failing?: string[] }} [options] the URLs whose shot fails
 * @returns {{ open: () => Promise<{ open: boolean }>, shoot: (browser: { open: boolean }, url: string) =>
 *     Promise<{ png: Buffer | null, reason: string | null, console: string[] }>, close: (browser: { open: boolean }) =>
 *     Promise<void>, shots: string[] }} the adapter, with every URL it shot
 */
export function fakeRenderer({ failing = [] } = {}) {
    const shots = [];
    const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    return {
        shots,
        open: async () => ({ open: true }),
        async shoot(browser, url) {
            if (!browser.open) {
                throw new Error("fake renderer: the browser is closed");
            }
            shots.push(url);
            return failing.includes(url)
                ? { png: null, reason: "story render errored", console: [] }
                : { png, reason: null, console: [] };
        },
        close: async (browser) => {
            browser.open = false;
        },
    };
}
