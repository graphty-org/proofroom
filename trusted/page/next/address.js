/*
 * The page's address: every state a click reaches is after `#`, so a copied link opens it again and
 * the browser's Back and Forward move between states. A snapshot is named by its file (project and
 * file name), never by its number. Addresses today's page wrote (in pull request comments) are read
 * and converted. Pure functions, no DOM.
 */

// The keys the new page writes, in order. Later stages fill in show, find, view and the rest.
const KEYS = [
    "token",
    "change",
    "snap",
    "project",
    "show",
    "find",
    "group",
    "view",
    "zoom",
    "layout",
    "base",
    "outline",
    "blink",
];

/**
 * Reads an address's fragment, in the new page's form or today's page's.
 * @param {string} hash the fragment, with or without its "#"
 * @returns {{ token: string | null, change: string | null, snap: string | null, old: boolean } & Record<string, string | null>}
 *     the state it names; `old` when it was today's page's form
 */
export function parseAddress(hash) {
    const p = new URLSearchParams(String(hash).replace(/^#/, ""));
    const out = Object.fromEntries(KEYS.map((k) => [k, p.get(k)]));
    out.old = false;
    // Today's page: #token=..&target=123&project=p&filter=undecided&q=text&item=file.png&view=side&zoom=fit
    //   &box=on&baseline=on&focus=off&blink=off&flash=off
    if (!out.change && p.has("target")) {
        out.old = true;
        out.change = p.get("target");
        out.project = p.get("project");
        out.snap = p.get("project") && p.get("item") ? `${p.get("project")}/${p.get("item")}` : null;
        out.show = p.get("filter");
        out.find = p.get("q");
        out.view = p.get("view");
        out.zoom = p.get("zoom");
        out.base = p.get("baseline");
        out.outline = p.get("box");
        out.blink = p.get("blink");
    }
    return out;
}

/**
 * Writes a state as an address fragment, leaving out what is not set.
 * @param {Record<string, string | null | undefined>} state the state
 * @returns {string} the fragment, starting with "#" (just "#" for none)
 */
export function formatAddress(state) {
    const p = new URLSearchParams();
    for (const k of KEYS) {
        if (state[k] !== null && state[k] !== undefined && state[k] !== "") {
            p.set(k, String(state[k]));
        }
    }
    return `#${p}`;
}

/**
 * Splits a snapshot's address into its project and file.
 * @param {string | null} snap "<project>/<file>"
 * @returns {{ project: string, file: string } | null} its parts
 */
export function snapParts(snap) {
    const at = snap ? snap.indexOf("/") : -1;
    return at > 0 ? { project: snap.slice(0, at), file: snap.slice(at + 1) } : null;
}
