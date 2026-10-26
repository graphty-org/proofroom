// Types for story-test.mjs (proofroom/vitest), for TypeScript Vitest configs.

import type { BrowserCommand } from "vitest/node";

/** What one Storybook project's storybook Vitest project needs to shoot its stories. */
export interface VisualStoryTest {
    viewport: { width: number; height: number };
    providerOptions: { launchOptions: object; contextOptions: object };
    commands: Record<string, BrowserCommand<[payload?: Record<string, unknown>]>>;
    reporter: object;
}

/** Production semantics for a story-test Vitest project, spread into its config. */
export const PRODUCTION: { mode: "production"; define: Record<string, string>; appType: "mpa" };

export function visualStoryTest(options: {
    project: string;
    out: string;
    root?: string;
    /** When a story test fails: "differences" (default) when a snapshot did not pass, "errors" only when it could not be shot. */
    fail?: "differences" | "errors";
    /** Shoot a snapshot that did not pass again inside the same story test, up to this many times (default 0). */
    retries?: number;
}): VisualStoryTest;
