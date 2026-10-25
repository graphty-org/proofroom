/**
 * Stories as tests, the browser side (`@graphty/visual-review/vitest/setup`): installed by a
 * Storybook project's Vitest setup file, which hands in its own Vitest functions so this file
 * imports nothing (a second copy of vitest in the page never finishes its handshake).
 *
 * It repeats capture.mjs's page set-up -- no WebGPU, `chromatic=true`, a fresh store, the fixed
 * running clock -- and, after each story's play function, its waits, then asks the Node commands
 * of story-test.mjs for the shot of every mode. A first shot that differs from the baseline is
 * rendered and shot again, as capture.mjs does. A failed play, a render error, the project's
 * console rule and an unstable story (two shots that disagree) fail the test.
 */

/* global document, requestAnimationFrame, history, location, localStorage, sessionStorage, indexedDB -- browser only */

const CLOCK_START = "2026-01-01T12:00:00Z";
const TYPES = { log: "log", info: "info", warn: "warning", error: "error", debug: "debug" };

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

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
        request.onblocked = () => resolve();
    });

/**
 * Installs the visual step in the tester page.
 * @param {{ afterEach: Function, beforeEach: Function, vi: any, commands: any }} options the setup
 *     file's Vitest hooks, `vi` and `commands` from `vitest/browser`
 */
export function installVisualStoryTest({ afterEach, beforeEach, vi, commands }) {
    delete Object.getPrototypeOf(navigator).gpu;
    const url = new URL(location.href);
    url.searchParams.set("chromatic", "true");
    history.replaceState(history.state, "", url);

    // What capture.mjs reads from the page's console, for the project's failOnConsole rule.
    const lines = [];
    for (const [method, type] of Object.entries(TYPES)) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            lines.push(`${type}: ${args.map(String).join(" ")}`);
            original(...args);
        };
    }
    globalThis.addEventListener("error", (e) => lines.push(`pageerror: ${e.error?.stack ?? e.message}`));

    let head = null;
    const layout = (name) => {
        document.body.classList.remove("sb-main-padded", "sb-main-centered", "sb-main-fullscreen");
        document.body.classList.add("sb-show-main", `sb-main-${name}`);
    };
    // capture.mjs gives every render a fresh browser context: nothing the story before stored.
    const fresh = async () => {
        await commands.visualPark();
        localStorage.clear();
        sessionStorage.clear();
        await Promise.all((await indexedDB.databases()).map((db) => deleteDatabase(db.name)));
        vi.setSystemTime(new Date(CLOCK_START));
    };
    beforeEach(async () => {
        head ??= commands.visualHead().then((css) => {
            const style = document.createElement("style");
            style.textContent = css;
            document.head.append(style);
            // Storybook's own beforeEach runs before the story renders, so the body carries the
            // story's layout class (as iframe.html's does) from the first frame.
            const project = globalThis.globalProjectAnnotations;
            project.beforeEach = [
                ...(project.beforeEach ?? []),
                ({ parameters }) => layout(parameters.layout ?? "padded"),
            ];
        });
        await head;
        vi.useFakeTimers({ now: new Date(CLOCK_START), toFake: ["Date"], shouldAdvanceTime: true });
        await fresh();
        lines.length = 0;
    });

    const render = async (story, mode) => {
        await fresh();
        await story.run(mode.globals ? { globals: { ...story.globals, ...mode.globals } } : undefined);
    };
    // The test's own render is the first mode's when that mode changes no global.
    const rendered = (story, mode, i) =>
        i === 0 && Object.entries(mode.globals ?? {}).every(([k, v]) => story.globals?.[k] === v);

    const settle = async (plan) => {
        await document.fonts.ready;
        await frame();
        await document.fonts.ready;
        if (plan.waitFor) {
            const { selector, method, failOnConsole } = plan.waitFor;
            await Promise.all([...document.querySelectorAll(selector)].map((el) => el[method]()));
            await frame();
            if (failOnConsole && lines.some((l) => l.includes(failOnConsole))) {
                throw new Error(failOnConsole);
            }
        }
        if (plan.delay > 0) {
            // capture.mjs's fixed wait, repeated so the two captures are comparable.
            await new Promise((r) => setTimeout(r, plan.delay));
        }
    };

    const shootMode = async (story, chromatic, plan, mode, i) => {
        if (!rendered(story, mode, i)) {
            await render(story, mode);
        }
        await settle(plan);
        const shot = { id: story.id, mode: mode.name, chromatic };
        let r = await commands.visualShot({ ...shot, console: lines.splice(0) });
        if (r.again) {
            await render(story, mode);
            await settle(plan);
            r = await commands.visualShot({ ...shot, console: lines.splice(0) });
        }
        return r.status;
    };

    afterEach(async (context) => {
        const story = context.story;
        if (!story) {
            return;
        }
        // Through JSON, as capture.mjs reads it, so no function crosses to Node.
        const chromatic = JSON.parse(JSON.stringify(story.parameters?.chromatic ?? {})); // NOSONAR(S7784): structuredClone throws on the functions this drops
        const plan = await commands.visualPlan({ id: story.id, chromatic });
        const fail = (modes, reason) =>
            commands.visualFail({ id: story.id, modes, reason, chromatic, console: lines.splice(0) });
        const unstable = [];
        try {
            if (context.task.result?.state === "fail") {
                await fail(
                    plan.modes.map((m) => m.name),
                    context.task.result.errors?.[0]?.message ?? "the story test failed",
                );
                return;
            }
            for (const [i, mode] of plan.modes.entries()) {
                try {
                    if ((await shootMode(story, chromatic, plan, mode, i)) === "unstable") {
                        unstable.push(mode.name ?? story.id);
                    }
                } catch (e) {
                    await fail(
                        plan.modes.slice(i).map((m) => m.name),
                        String(e?.message ?? e),
                    );
                    throw e;
                }
            }
        } finally {
            vi.useRealTimers();
        }
        if (unstable.length > 0) {
            throw new Error(
                `visual-review: ${story.id} is unstable (two renders drew different pictures): ${unstable.join(", ")}`,
            );
        }
    });
}
