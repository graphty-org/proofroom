/*
 * The message line: one fixed line at the bottom of the window where every message goes. Never a
 * timer: a plain message clears on the reader's next action; a message with a button (Undo, Retry,
 * Load it) stays until that button is used or the message is dismissed, or another replaces it.
 * The last 20 are kept, behind Messages. Every word a message says about changes comes from the
 * code host's vocabulary (`wordsOf`).
 */

const kept = [];
const KEEP = 20;
// Whether the line shows a message that has a button: it outlives the reader's next action.
let held = false;
// Builds the line's Dismiss control (the page sets it: controls come from the action table).
let dismissControl = () => null;

/**
 * Sets how the line's Dismiss control is built.
 * @param {() => HTMLElement} make it
 */
export const setDismiss = (make) => {
    dismissControl = make;
};

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
    held = actions.length > 0;
    document.getElementById("msg-x").replaceChildren(...actions, ...(held ? [dismissControl()].filter(Boolean) : []));
}

/** Empties the message line (the history keeps what it said). */
export function clearMessage() {
    const t = document.getElementById("msg-t");
    if (!t) {
        return;
    }
    t.textContent = "";
    t.className = "t";
    t.title = "";
    document.getElementById("msg-x").replaceChildren();
    held = false;
}

/**
 * Called as each action starts: a plain message has been read and goes; one with a button stays
 * unless that button (or the line's Dismiss) is what was pressed.
 * @param {boolean} fromLine the action is a control on the message line
 */
export function beforeAction(fromLine) {
    if (!held || fromLine) {
        clearMessage();
    }
}

/**
 * Whether the line shows a message with a button.
 * @returns {boolean} it does
 */
export const messageHeld = () => held;

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

/** The code host's words for its changes before the list says which host it is: GitHub's. */
export const GITHUB_WORDS = {
    hostName: "GitHub",
    changeNoun: "pull request",
    changeTag: "PR",
    numberPrefix: "#",
    ciName: "CI",
};

/**
 * The code host's words for its changes (design 12.4, `vocabulary`), from the server's list.
 * @param {any} list the GET /api/prs answer
 * @returns {{ hostName: string, changeNoun: string, changeTag: string, numberPrefix: string, ciName: string | null }} them
 */
export const wordsOf = (list) => list?.adapters?.codeHost?.vocabulary ?? GITHUB_WORDS;

/**
 * Whether the code host has a function: the page hides every button that needs one it lacks.
 * @param {any} list the GET /api/prs answer
 * @param {string} fn the function (comment, setStatus, fileIssue, openChange, describe, whoAmI)
 * @returns {boolean} it has it
 */
export const hostCan = (list, fn) => !(list?.adapters?.codeHost?.lacks ?? []).includes(fn);

/**
 * Who answers for the code host in a message: plain git's is the git remote.
 * @param {any} list the GET /api/prs answer
 * @returns {string} it
 */
export const hostWho = (list) => (wordsOf(list).hostName === "git" ? "The git remote" : wordsOf(list).hostName);
