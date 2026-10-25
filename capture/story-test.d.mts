// Types for story-test.mjs (@graphty/visual-review/vitest), for TypeScript Vitest configs.

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

export function visualStoryTest(options: { project: string; out: string; root?: string }): VisualStoryTest;
