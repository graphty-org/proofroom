/**
 * SPIKE (issue #3389): the browser side of story-spike.mjs, installed by a Storybook project's
 * spike-only Vitest setup file, which hands in its own Vitest functions so this file imports
 * nothing (a second copy of vitest in the page never finishes its handshake).
 *
 * It repeats capture.mjs's page set-up -- no WebGPU, `chromatic=true`, the fixed running clock --
 * and its waits after the render, then asks the Node command for the shot.
 */

/* global document, requestAnimationFrame, history, location, localStorage, sessionStorage, indexedDB -- browser only */

const CLOCK_START = "2026-01-01T12:00:00Z";

/**
 * Deletes one IndexedDB database.
 * @param {string} name the database
 * @returns {Promise<void>} once it is deleted, or will be once its last connection closes
 */
const deleteDatabase = (name) =>
    new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        // Another connection still open: deleted once it closes, which the next story need not wait for.
        request.onblocked = () => resolve();
    });

/**
 * Installs the spike's hooks in the tester page.
 * @param {{ afterEach: Function, beforeEach: Function, vi: any, commands: any,
 *     waitFor: { selector: string, method: string } | null, mode: string | null, globals?: object, served: string }} options the setup file's Vitest
 *     hooks and commands, the project's readiness wait, the Storybook mode and its globals, and
 *     the page's own `import.meta.env.MODE` and NODE_ENV, as served
 */
export function installStorySpike({ afterEach, beforeEach, vi, commands, waitFor, mode, globals, served }) {
    delete Object.getPrototypeOf(navigator).gpu;
    const url = new URL(location.href);
    url.searchParams.set("chromatic", "true");
    history.replaceState(history.state, "", url);
    let head = null;
    const layout = (name) => {
        document.body.classList.remove("sb-main-padded", "sb-main-centered", "sb-main-fullscreen");
        document.body.classList.add("sb-show-main", `sb-main-${name}`);
    };
    beforeEach(async () => {
        head ??= commands.visualSpikeHead().then((css) => {
            const style = document.createElement("style");
            style.textContent = css;
            document.head.append(style);
            // Once the setup files have set the project annotations: Storybook's own beforeEach
            // runs before the story renders, so the body carries the story's layout class (as
            // iframe.html's does) from the first frame, and every story starts in this run's mode
            // (capture.mjs passes the mode's globals in the story URL).
            const project = globalThis.globalProjectAnnotations;
            project.initialGlobals = { ...project.initialGlobals, ...globals };
            project.beforeEach = [
                ...(project.beforeEach ?? []),
                ({ parameters }) => layout(parameters.layout ?? "padded"),
            ];
        });
        await head;
        await commands.visualSpikePark();
        // capture.mjs gives every story a fresh browser context: nothing the story before stored.
        localStorage.clear();
        sessionStorage.clear();
        await Promise.all((await indexedDB.databases()).map((db) => deleteDatabase(db.name)));
        vi.useFakeTimers({ now: new Date(CLOCK_START), toFake: ["Date"], shouldAdvanceTime: true });
    });
    afterEach(async (context) => {
        const story = context.story;
        try {
            if (!story || context.task.result?.state === "fail") {
                return;
            }
            await document.fonts.ready;
            await new Promise((r) => requestAnimationFrame(() => r()));
            await document.fonts.ready;
            if (waitFor) {
                const found = [...document.querySelectorAll(waitFor.selector)];
                await Promise.all(found.map((el) => el[waitFor.method]()));
                await new Promise((r) => requestAnimationFrame(() => r()));
            }
            // Through JSON, as capture.mjs reads it, so no function crosses to Node.
            const chromatic = JSON.parse(JSON.stringify(story.parameters?.chromatic ?? {})); // NOSONAR(S7784): structuredClone throws on the functions this drops
            if (chromatic.delay > 0) {
                // capture.mjs's fixed wait, repeated so the two shots are comparable.
                await new Promise((r) => setTimeout(r, chromatic.delay));
            }
            await commands.visualSpikeShot({ id: story.id, mode, chromatic, served });
        } finally {
            vi.useRealTimers();
        }
    });
}
