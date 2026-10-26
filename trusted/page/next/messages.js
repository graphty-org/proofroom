/*
 * The message line: one fixed line at the bottom of the window where every message goes. A
 * message stays until the next one replaces it (never a timer); the last 20 are kept.
 */

const kept = [];
const KEEP = 20;

/**
 * Writes a message on the line, and keeps it in the history.
 * @param {string} text what just happened
 * @param {"" | "err"} [kind] "err" for an error
 * @param {HTMLElement[]} [actions] controls beside it (a Retry, an Undo), built from the action table
 *     in the "msgline" zone, with no key box
 */
export function say(text, kind = "", actions = []) {
    const at = new Date();
    kept.unshift({
        text,
        kind,
        at: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`,
    });
    kept.length = Math.min(kept.length, KEEP);
    const t = document.getElementById("msg-t");
    t.textContent = text;
    t.className = `t ${kind}`;
    t.title = text;
    document.getElementById("msg-x").replaceChildren(...actions);
}

/**
 * Replaces the newest message's text in place (a count that moves while the reader types), without
 * adding one to the history.
 * @param {string} text the new text
 */
export function sayAgain(text) {
    if (kept[0]) {
        kept[0].text = text;
    }
    const t = document.getElementById("msg-t");
    t.textContent = text;
    t.title = text;
}

/**
 * The last 20 messages, newest first.
 * @returns {{ text: string, kind: string, at: string }[]} the messages
 */
export const history = () => [...kept];
