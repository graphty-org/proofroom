// Types for story-spike-setup.mjs, for the TypeScript setup files that import it (spike, issue #3389).

export function installStorySpike(options: {
    afterEach: unknown;
    beforeEach: unknown;
    vi: unknown;
    commands: unknown;
    waitFor: { selector: string; method: string } | null;
    mode: string | null;
    globals?: Record<string, unknown>;
    served: string;
}): void;
