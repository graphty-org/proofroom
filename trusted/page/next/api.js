/*
 * The server, as the new page talks to it: the session token (from the address or kept in this
 * browser, shared with today's page), the session cookie the server sets for it, JSON requests,
 * whether the server is reachable at all, and the usage events the server's owner may have turned
 * on.
 */

const TOKEN_KEY = "visual-review:token";

let token = (() => {
    const given = new URLSearchParams(location.hash.slice(1)).get("token");
    try {
        if (given) {
            localStorage.setItem(TOKEN_KEY, given);
            return given;
        }
        return localStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
        return given ?? "";
    }
})();

/**
 * The session token in use ("" when the page has none).
 * @returns {string} the token
 */
export const currentToken = () => token;

/**
 * Uses a token the reader pasted (the token alone, or the whole URL serve printed), and keeps it
 * in this browser.
 * @param {string} text what was pasted
 * @returns {boolean} whether it held a token
 */
export function useToken(text) {
    const v = text.trim();
    const part = v.includes("#") ? v.slice(v.indexOf("#") + 1) : v;
    const given = (part.includes("token=") ? new URLSearchParams(part).get("token") : v) ?? "";
    if (given === "") {
        return false;
    }
    token = given;
    try {
        localStorage.setItem(TOKEN_KEY, given);
    } catch {
        // Kept for this visit only.
    }
    signing = null;
    return true;
}

/** Forgets a token the server refused. */
function forget() {
    token = "";
    try {
        localStorage.removeItem(TOKEN_KEY);
    } catch {
        // Nothing kept to remove.
    }
}

let onRefused = () => {};
/**
 * What the page does when the server refuses the token (it asks for it).
 * @param {() => void} fn the handler
 */
export const whenRefused = (fn) => {
    onRefused = fn;
};

// Offline: since when no request reached the server (null while one does). Any answer, an error
// included, means it is reachable again; only a request that never got one means it is not.
let offlineAt = null;
let onConnection = () => {};

/**
 * Since when the server has been unreachable, or null while it answers.
 * @returns {number | null} the time it was first found unreachable
 */
export const offlineSince = () => offlineAt;

/**
 * What the page does when the server stops answering or answers again.
 * @param {() => void} fn the handler
 */
export const whenConnection = (fn) => {
    onConnection = fn;
};

// A request, noting whether it reached the server; one that did not fails as an ApiError.
async function reach(request) {
    // Checked when the answer comes, not when the request starts: several requests sent while
    // offline that all succeed report one change.
    try {
        const res = await request;
        if (offlineAt !== null) {
            offlineAt = null;
            onConnection();
        }
        return res;
    } catch {
        if (offlineAt === null) {
            offlineAt = Date.now();
            onConnection();
        }
        throw new ApiError("the server is unreachable", 0);
    }
}

// The session: the token posted once for an HttpOnly cookie every request then carries.
let signing = null;
function signIn() {
    if (signing?.token !== token) {
        const sent = token;
        const done = reach(
            fetch("/api/session", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: sent }),
            }),
        ).then((res) => res.status !== 401 && res.ok);
        signing = { token: sent, done };
        // Not signed in because the server was not reached: the next request tries again.
        done.catch(() => {
            if (signing?.done === done) {
                signing = null;
            }
        });
    }
    return signing.done;
}

/** An error the server answered with: its status and message. */
export class ApiError extends Error {
    /**
     * An error answer.
     * @param {string} message the server's message
     * @param {number} status the HTTP status
     * @param {any} [body] the whole answer
     */
    constructor(message, status, body = {}) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

/**
 * A JSON request to the server: a GET, or a POST of `body`. A refused token asks for it again and
 * never settles.
 * @param {string} path the route
 * @param {object} [body] the POST body
 * @returns {Promise<any>} the answer
 */
export async function api(path, body) {
    const sent = token;
    if (sent) {
        await signIn().catch(() => false);
    }
    const send = () =>
        reach(
            fetch(path, {
                method: body ? "POST" : "GET",
                headers: body ? { "content-type": "application/json" } : {},
                body: body ? JSON.stringify(body) : undefined,
            }),
        );
    let res = await send();
    // No cookie yet, or one of a server since restarted: signed in again, the request sent again.
    if (res.status === 401 && sent && sent === token) {
        signing = null;
        if (await signIn().catch(() => false)) {
            res = await send();
        }
    }
    if (res.status === 401) {
        if (sent === token) {
            forget();
            onRefused(sent !== "");
        }
        return new Promise(() => {});
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new ApiError(json.error ?? `${res.status} ${res.statusText}`, res.status, json);
    }
    return json;
}

// Usage events, only when the server's owner turned them on: sent to this page's own server and
// nowhere else. No image, no reason text, no token.
const usage = { on: null, queue: [], sending: false, session: crypto.randomUUID(), last: 0, seen: new Set() };
const IDLE_MS = 60000;

/**
 * Logs one usage event.
 * @param {string} type the event's type
 * @param {object} [data] its fields
 */
export function logUsage(type, data = {}) {
    if (usage.on === false) {
        return;
    }
    const at = Date.now();
    if (usage.last && at - usage.last > IDLE_MS) {
        usage.queue.push({ type: "idle", at, s: usage.session, ms: at - usage.last });
    }
    usage.last = at;
    usage.queue.push({ type, at, s: usage.session, ...data });
    usage.queue.splice(0, usage.queue.length - 500);
    if (usage.on) {
        queueMicrotask(sendUsage);
    }
}

/**
 * Logs the controls on screen, by action id, not seen before in this session, so the report can
 * name those never pressed. Each id not yet seen is looked up once, on its first control shown:
 * a list of 3,000 rows is not laid out to find its 3,000 row controls.
 * @param {Iterable<HTMLElement>} nodes the controls drawn, each with its id in `data-act`
 */
export function logControls(nodes) {
    if (usage.on === false) {
        return;
    }
    const fresh = [];
    for (const n of nodes) {
        const id = n.dataset.act;
        if (!usage.seen.has(id) && n.getClientRects().length > 0) {
            usage.seen.add(id);
            fresh.push(id);
        }
    }
    if (fresh.length > 0) {
        logUsage("controls", { c: fresh });
    }
}

async function sendUsage() {
    if (usage.sending || usage.queue.length === 0) {
        return;
    }
    usage.sending = true;
    const events = usage.queue.splice(0, 100);
    try {
        const res = await fetch("/api/usage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ events }),
        });
        await res.text();
    } catch {
        // Lost; usage is never worth a message.
    } finally {
        usage.sending = false;
    }
    if (usage.queue.length > 0) {
        sendUsage();
    }
}

/** Asks the server once whether to log; until it answers, events wait in the queue. */
export async function startUsage() {
    try {
        await signIn().catch(() => false);
        const res = await fetch("/api/usage-setting");
        if (res.status === 401) {
            return;
        }
        usage.on = res.ok && (await res.json()).on === true;
    } catch {
        usage.on = false;
    }
    if (usage.on) {
        sendUsage();
    } else {
        usage.queue.length = 0;
    }
}
