// Types for capture.mjs (proofroom/capture), named apart so they do not stand in for its own, for TypeScript callers.

import type { SnapshotOptions } from "../trusted/lib/compare-api.d.mts";

/** One snapshot of a story, as openCapture().stories() lists it and shoot() returns it. */
export interface Story extends SnapshotOptions {
    type: "image" | "failed" | "excluded";
    project: string;
    file: string;
}

export function openCapture(options: {
    project: string;
    root?: string;
    storybook?: string;
    baselines?: string;
    stories?: string[] | null;
}): { stories(): Promise<Story[]>; shoot(story: Story): Promise<Story>; close(): Promise<void> };

export function capture(options: Record<string, unknown>): AsyncGenerator<Record<string, unknown>>;
