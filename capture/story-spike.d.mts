// Types for story-spike.mjs, for the TypeScript Vitest configs that import it (spike, issue #3389).

import type { BrowserCommand } from "vitest/node";

/** What one Storybook project's storybook Vitest project needs for the spike. */
export interface StorySpike {
    viewport: { width: number; height: number };
    providerOptions: { launchOptions: object; contextOptions: object };
    commands: Record<string, BrowserCommand<[payload?: Record<string, unknown>]>>;
}

export function storySpike(options: {
    root: string;
    project: string;
    out: string;
    mode: string;
    fontconfig: string;
}): StorySpike;
