/**
 * Stories as tests, the browser side (`@graphty/visual-review/vitest/setup`): installed by a
 * Storybook project's Vitest setup file, which hands in its own Vitest functions so this file
 * imports nothing (a second copy of vitest in the page never finishes its handshake).
 *
 * It repeats capture.mjs's page set-up -- no WebGPU, `chromatic=true`, a fresh store, the fixed
 * running clock -- and, after each story's play function, its waits, then asks the Node commands
 * of story-test.mjs for the shot of every mode. A first shot that differs from the baseline is
 * rendered and shot again (in an afterEach hook of its own), as capture.mjs does. A failed play, a render error, the project's
 * console rule and an unstable story (two shots that disagree) fail the test.
 */

/* global document, requestAnimationFrame, history, location, localStorage, sessionStorage, indexedDB -- browser only */

const CLOCK_START = "2026-01-01T12:00:00Z";
const TYPES = { log: "log", info: "info", warn: "warning", error: "error", debug: "debug" };

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * Empties one IndexedDB database: every object store cleared, the database kept. Deleting it
 * instead waits for every connection to close, and a connection the page keeps open from the
 * story before (an autosave store) would hold the delete, and every later open behind it, forever.
 * @param {string} name the database
 * @returns {Promise<void>} once its stores are empty
 */
const clearDatabase = (name) =>
    new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const stores = [...db.objectStoreNames];
            if (stores.length === 0) {
                db.close();
                resolve();
                return;
            }
            const tx = db.transaction(stores, "readwrite");
            for (const store of stores) {
                tx.objectStore(store).clear();
            }
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        };
    });

/**
 * A story test's file and name as its JUnit report names it (suites and test joined by " > "), so
 * the quarantine list's entries can be matched to its items.
 * @param {any} task the test's Vitest task
 * @returns {{ file: string, name: string } | undefined} the test, or undefined without a file
 */
const testOf = (task) => {
    const names = [];
    for (let t = task; t && t !== task.file; t = t.suite) {
        names.unshift(t.name);
    }
    return task?.file?.filepath ? { file: task.file.filepath, name: names.join(" > ") } : undefined;
};

const RealDate = globalThis.Date;

/**
 * capture.mjs's clock, as Playwright's page.clock installs it: `new Date()` and `Date.now()` start
 * at CLOCK_START and keep running. A Date subclass rather than Vitest's fake timers, which on
 * uninstall delete a global Date a story has replaced meanwhile (graphty's fixWallClock).
 * @returns {DateConstructor} the clock's Date
 */
function runningClock() {
    const start = RealDate.parse(CLOCK_START);
    const t0 = RealDate.now();
    const now = () => start + (RealDate.now() - t0);
    class ClockDate extends RealDate {
        /**
         * As Date's own constructor, but with no arguments it is the clock's now.
         * @param {...any} args as for Date
         */
        constructor(...args) {
            // One `any` stands for every Date overload, which TypeScript cannot pick from a rest array.
            super(.../** @type {[any]} */ (args.length === 0 ? [now()] : args));
        }

        static now() {
            return now();
        }
    }
    // A class has no call signature (`Date()` without `new` throws), so to TypeScript it is no
    // DateConstructor; it stands in for one only where a story constructs dates or asks the time.
    return /** @type {DateConstructor} */ (/** @type {unknown} */ (ClockDate));
}

/**
 * Installs the visual step in the tester page.
 * @param {{ afterEach: Function, beforeEach: Function, vi?: any, commands: any }} options the setup
 *     file's Vitest hooks and `commands` from `vitest/browser` (`vi` is accepted and not used)
 */
export function installVisualStoryTest({ afterEach, beforeEach, commands }) {
    delete Object.getPrototypeOf(navigator).gpu;
    // Playwright's page.clock (capture.mjs) also replaces `performance`, whose fake keeps no
    // timeline: no navigation entry, no resource entries. A story that prints one draws it the same.
    for (const method of ["getEntries", "getEntriesByType", "getEntriesByName"]) {
        performance[method] = () => [];
    }
    // Storybook's iframe.html is <html lang="en">, and the language picks the font a generic family
    // (monospace) resolves to; Vitest's tester page names none.
    document.documentElement.lang = "en";
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
    let clock = null;
    // Which test is running. A hook that timed out keeps running, and without this its render and shot
    // land in the next story's test: it shot that story's page as its own and drew it into the next
    // story's (#3740). A stale hook stops at its next step instead.
    let test = 0;
    const stale = (mine) => mine !== test;
    // capture.mjs gives every render a fresh browser context: nothing the story before stored.
    const fresh = async () => {
        await commands.visualPark();
        localStorage.clear();
        sessionStorage.clear();
        await Promise.all((await indexedDB.databases()).map((db) => clearDatabase(db.name)));
        clock = runningClock();
        globalThis.Date = clock;
    };
    beforeEach(async () => {
        test += 1;
        head ??= commands.visualHead().then((css) => {
            const style = document.createElement("style");
            style.textContent = css;
            document.head.append(style);
            // Storybook's own beforeEach runs before the story renders, so the body carries the
            // story's layout class (as iframe.html's does) from the first frame. The story mounts in
            // a plain div here; iframe.html's is #storybook-root, which the centered layout's
            // margin and padding rules select.
            const project = globalThis.globalProjectAnnotations;
            project.beforeEach = [
                ...(project.beforeEach ?? []),
                ({ parameters, canvasElement }) => {
                    layout(parameters.layout ?? "padded");
                    if (canvasElement && !document.getElementById("storybook-root")) {
                        canvasElement.id = "storybook-root";
                    }
                },
            ];
        });
        await head;
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

    // The project's wait on every matching element. `settled`: for a story that is not shot (excluded, or
    // already failed), so the wait only lets its scene finish here, not in the next story's test, and its
    // outcome (a rejection, an element without the method) decides nothing.
    const waitForElements = ({ selector, method }, settled) => {
        const els = [...document.querySelectorAll(selector)];
        if (!settled) {
            return Promise.all(els.map((el) => el[method]()));
        }
        return Promise.allSettled(els.filter((el) => typeof el[method] === "function").map((el) => el[method]()));
    };

    const settle = async (plan) => {
        await document.fonts.ready;
        await frame();
        await document.fonts.ready;
        if (plan.waitFor) {
            const { failOnConsole } = plan.waitFor;
            await waitForElements(plan.waitFor, false);
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

    const shot = async (story, chromatic, mode) =>
        commands.visualShot({ id: story.id, mode: mode.name, chromatic, console: lines.splice(0) });

    // The modes whose first shot differed from the baseline, for the confirming hook below. A
    // story's settle can take most of a hook's time (a gallery that lays out every tile), so the
    // second render, which capture.mjs makes for a changed picture, runs in a hook of its own
    // instead of doubling the first one's cost (#3740).
    let confirm = null;

    const restoreDate = () => {
        // Only when no story put its own Date in meanwhile: the story's cleanup puts back its own.
        if (globalThis.Date === clock) {
            globalThis.Date = RealDate;
        }
    };

    // Registered first so that it runs after the shooting hook: Vitest runs afterEach hooks in
    // reverse order (sequence.hooks "stack", the default).
    afterEach(async () => {
        const job = confirm;
        confirm = null;
        if (!job || job.modes.length === 0) {
            return;
        }
        const { story, chromatic, plan, fail, mine } = job;
        const unstable = [];
        try {
            for (const [i, mode] of job.modes.entries()) {
                try {
                    if (stale(mine)) {
                        return;
                    }
                    await render(story, mode);
                    await settle(plan);
                    if (stale(mine)) {
                        return;
                    }
                    if ((await shot(story, chromatic, mode)).status === "unstable") {
                        unstable.push(mode.name ?? story.id);
                    }
                } catch (e) {
                    if (stale(mine)) {
                        return;
                    }
                    await fail(
                        job.modes.slice(i).map((m) => m.name),
                        String(e?.message ?? e),
                    );
                    throw e;
                }
            }
        } finally {
            restoreDate();
        }
        if (unstable.length > 0) {
            throw new Error(
                `visual-review: ${story.id} is unstable (two renders drew different pictures): ${unstable.join(", ")}`,
            );
        }
    });

    // A failed story is recorded as failed, not shot; an excluded one has no modes. Either still
    // finishes here, not in the next story's test. True when the story is not shot.
    const unshot = async (context, plan, fail) => {
        const failed = context.task.result?.state === "fail";
        if (failed) {
            await fail(
                plan.modes.map((m) => m.name),
                context.task.result.errors?.[0]?.message ?? "the story test failed",
            );
        }
        if ((failed || plan.modes.length === 0) && plan.waitFor) {
            await waitForElements(plan.waitFor, true);
        }
        return failed;
    };

    afterEach(async (context) => {
        confirm = null;
        const story = context.story;
        if (!story) {
            return;
        }
        const mine = test;
        // Through JSON, as capture.mjs reads it, so no function crosses to Node.
        const chromatic = JSON.parse(JSON.stringify(story.parameters?.chromatic ?? {})); // NOSONAR(S7784): structuredClone throws on the functions this drops
        const plan = await commands.visualPlan({ id: story.id, chromatic, test: testOf(context.task) });
        const fail = (modes, reason) =>
            commands.visualFail({ id: story.id, modes, reason, chromatic, console: lines.splice(0) });
        const again = [];
        try {
            if (await unshot(context, plan, fail)) {
                return;
            }
            for (const [i, mode] of plan.modes.entries()) {
                try {
                    if (!rendered(story, mode, i)) {
                        await render(story, mode);
                    }
                    await settle(plan);
                    if (stale(mine)) {
                        return;
                    }
                    if ((await shot(story, chromatic, mode)).again) {
                        again.push(mode);
                    }
                } catch (e) {
                    if (stale(mine)) {
                        return;
                    }
                    await fail(
                        plan.modes.slice(i).map((m) => m.name),
                        String(e?.message ?? e),
                    );
                    throw e;
                }
            }
            confirm = { story, chromatic, plan, fail, mine, modes: again };
        } finally {
            if (!confirm) {
                restoreDate();
            }
        }
    });
}
