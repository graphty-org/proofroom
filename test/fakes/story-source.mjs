/*
 * An in-memory story source with the Storybook adapter's functions: its stories are a list of
 * ids, its URLs are made up, and a build records its command.
 */

/**
 * The fake story source.
 * @param {string[]} ids the story ids
 * @returns {{ build: (command: string | null, cwd: string) => Promise<void>, stories: (dir: string) => Promise<string[]>,
 *     url: (base: string, id: string, globals: Record<string, string> | null) => string, built: string[] }} the adapter
 */
export function fakeStorySource(ids) {
    const built = [];
    return {
        built,
        build: async (command) => void (command && built.push(command)),
        stories: async () => [...ids].sort(),
        url: (base, id, globals) =>
            `${base}story/${encodeURIComponent(id)}${globals ? `?${new URLSearchParams(globals)}` : ""}`,
    };
}
