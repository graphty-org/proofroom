/**
 * The local folder capture store: capture sets already on this machine, as
 * `<root>/<project>/results.json` (`serve --results <root>`) or, for local previews of a change,
 * `<root>/<change>/<project>/results.json` beside the change's `status.json`, and captures staged
 * for a commit not pushed yet as `<root>/.pending-<commit>/`. Nothing is downloaded: `fetch` only
 * names the folder a set is in.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
};

const mtimeOf = (file) => {
    try {
        return statSync(file).mtimeMs;
    } catch {
        return null;
    }
};

/**
 * The local folder store over one directory.
 * @param {string} root the directory
 * @returns the adapter
 */
export function localFolderStore(root) {
    const folder = (change) => (change === null || change === undefined ? root : join(root, String(change)));
    const pendingNames = () => {
        try {
            return readdirSync(root).filter((n) => n.startsWith(".pending-"));
        } catch {
            return [];
        }
    };
    return {
        name: "local-folder",
        root,
        // Where a change's (or, with change null, the folder's own) capture set of a project is.
        dir: (change, project) => join(folder(change), project),
        // Whether that capture set is there.
        has: (change, project) => existsSync(join(folder(change), project, "results.json")),
        // Every capture set of a change, by project.
        async list(change) {
            let names = [];
            try {
                names = readdirSync(folder(change));
            } catch {
                return [];
            }
            return names
                .filter((n) => !n.startsWith(".") && existsSync(join(folder(change), n, "results.json")))
                .sort()
                .map((project) => ({
                    project,
                    dir: join(folder(change), project),
                    ref: join(folder(change), project),
                }));
        },
        // A set is already where it is read from.
        fetch: async (ref) => ref,
        // A change's status.json (written while its preview captures), or null.
        status: (change) => readJson(join(folder(change), "status.json")),
        // The captures staged for commits not pushed yet, each with its status.json.
        pending: () =>
            pendingNames().map((n) => ({ dir: join(root, n), status: readJson(join(root, n, "status.json")) })),
        // When a change's status.json, or any staged capture's, last changed.
        stamp: (change) =>
            [
                mtimeOf(join(folder(change), "status.json")),
                ...pendingNames().map((n) => `${n}:${mtimeOf(join(root, n, "status.json"))}`),
            ].join(","),
    };
}
