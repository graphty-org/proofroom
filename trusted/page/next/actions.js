/*
 * The one table of the page's actions: id, label, key, handler, and the rule that says whether it
 * is available (and why not). Every control is built from it by `control()`, and the key handler
 * (keys.js) acts only through a control built here, so a key cannot act without its printed label
 * and every press is logged with its action id.
 *
 * Each handler takes the page (`app`, app.js) and the control's context (`ctx`: the change or
 * snapshot it stands for). `available` answers true, or the reason it is not, which becomes the
 * control's tooltip and, when pressed, the message line.
 */

import { el, kb } from "./ui.js";

// Where a control sits, in the order that decides which of two controls showing the same key
// carries its key box (design 8.1.7): an open box or menu, the end card, the decision bar, the
// selection bar, the item line, the Changes pane header, the Snapshots pane header, rows and the
// message line, then the top bar.
export const ZONES = [
    "box",
    "menu",
    "end",
    "decision",
    "selection",
    "iline",
    "changes-head",
    "snaps-head",
    "rows",
    "msgline",
    "top",
];

const NO_CHANGES = "No changes yet";

/**
 * The actions, by id.
 * @type {Record<string, { label: string | ((app: any, ctx: any) => string), key?: string,
 *     title?: string | ((app: any, ctx: any) => string),
 *     run: (app: any, ctx: any) => void, available?: (app: any, ctx: any) => true | string }>}
 */
export const ACTIONS = {
    // The top bar.
    "screen-review": { label: "Review", run: (app) => app.showReview() },
    refresh: { label: (app) => app.statusText(), title: "Refresh now", run: (app) => app.refresh() },

    // Panes.
    pane1: {
        label: (app, ctx) => (ctx?.rail ? "Changes" : "Hide"),
        key: "Shift+1",
        title: "Show or hide Changes (Shift+1)",
        run: (app) => app.togglePane("changes"),
    },
    pane2: {
        label: (app, ctx) => (ctx?.rail ? "Snapshots" : "Hide"),
        key: "Shift+2",
        title: "Show or hide Snapshots (Shift+2)",
        run: (app) => app.togglePane("snaps"),
    },

    // The changes pane.
    nextchange: {
        label: "Next change",
        key: "Shift+N",
        title: "Opens the next change that needs you",
        run: (app) => app.nextChange(),
        available: (app) => (app.changes.length > 0 ? true : NO_CHANGES),
    },
    chgsort: {
        label: (app) => `Sort: ${app.sortLabel()}`,
        title: "The order of the changes",
        run: (app, ctx) => app.sortMenu(ctx.el),
        available: (app) => (app.changes.length > 0 ? true : NO_CHANGES),
    },
    "sort-needs": { label: "Needs me first", run: (app) => app.setSort("needs") },
    "sort-newest": { label: "Newest", run: (app) => app.setSort("newest") },
    "sort-most": { label: "Most undecided", run: (app) => app.setSort("most") },
    "sort-author": { label: "Author", run: (app) => app.setSort("author") },
    chgfind: { label: "Find", key: "/", run: (app) => app.focusFind() },
    section: { label: (app, ctx) => ctx.label, run: (app, ctx) => app.toggleSection(ctx.section) },
    pickchg: { label: "", run: (app, ctx) => app.pickChange(ctx.id) },
    openchg: { label: "Open", key: "Enter", run: (app, ctx) => app.openChange(ctx.id) },
    rowmenu: { label: "...", title: "More for this change", run: (app, ctx) => app.rowMenu(ctx.id, ctx.el) },
    about: { label: "About this change", run: (app, ctx) => app.aboutChange(ctx.id) },
    onhost: {
        label: "Open on GitHub",
        run: (app, ctx) => app.openOnHost(ctx.id),
        available: (app, ctx) => (app.change(ctx.id)?.url ? true : "Only a pull request is on GitHub"),
    },
    copylink: { label: "Copy link", run: (app, ctx) => app.copyLink(ctx.id) },
    dismiss: {
        label: "Dismiss",
        run: (app, ctx) => app.dismiss(ctx.id),
    },
    joblog: { label: "Job log", run: (app, ctx) => app.jobLog(ctx.id) },
    // The Snapshots pane's summary of the current change, while none is open.
    summaryopen: {
        label: "Open",
        title: "Enter opens it (the key is printed on its row)",
        run: (app, ctx) => app.openChange(ctx.id),
    },

    // Levels: the one Back, named by where it goes, and Open on the item line.
    back: {
        label: (app) => (app.level === 2 ? "Back to list" : "Back to changes"),
        key: "Esc",
        title: (app) => `${app.level === 2 ? "Back to list" : "Back to changes"} [Esc]`,
        run: (app) => app.back(),
    },
    openrow: {
        label: "Open",
        key: "Enter",
        title: "Open this snapshot: Snapshots collapses to its rail",
        run: (app) => app.openSnapshot(),
    },
    pickrow: { label: "", run: (app, ctx) => app.pickSnapshot(ctx.snap) },

    // Boxes and the message line.
    closebox: { label: "Close", key: "Esc", run: (app) => app.closeBox() },
    // The message line's own button: Retry after a failed list or a failed open (ctx.run retries it).
    retry: { label: "Retry", run: (app, ctx) => ctx.run() },
    messages: { label: "Messages", title: "The last 20 messages", run: (app) => app.messagesBox() },
    usetoken: { label: "Open", key: "Enter", run: (app) => app.submitToken() },
};

/**
 * Whether an action is available now, and why not.
 * @param {any} app the page
 * @param {string} id the action
 * @param {any} [ctx] the control's context
 * @returns {true | string} true, or the reason
 */
export function availability(app, id, ctx = {}) {
    return ACTIONS[id].available?.(app, ctx) ?? true;
}

/**
 * The label an action shows now.
 * @param {any} app the page
 * @param {string} id the action
 * @param {any} [ctx] the control's context
 * @returns {string} the label
 */
export function labelOf(app, id, ctx = {}) {
    const l = ACTIONS[id].label;
    return typeof l === "function" ? l(app, ctx) : l;
}

/**
 * Runs an action the reader pressed (by pointer or key) and logs it by its id. An unavailable one
 * says why on the message line instead.
 * @param {any} app the page
 * @param {string} id the action
 * @param {any} ctx the control's context
 * @param {"pointer" | "key"} via how it was pressed
 */
export function runAction(app, id, ctx, via) {
    app.logUsage("action", { a: id, via });
    const ok = availability(app, id, ctx);
    if (ok !== true) {
        app.say(`${labelOf(app, id, ctx)}: ${ok}.`);
        return;
    }
    ACTIONS[id].run(app, ctx);
}

// Each control's context, for the key handler: the change or snapshot it stands for.
const contexts = new WeakMap();

/**
 * The context a control was built with.
 * @param {Element} node the control
 * @returns {any} its context
 */
export const contextOf = (node) => contexts.get(node) ?? {};

/**
 * A control for an action: a button (or, with `tag`, another element) with the action's label and
 * key box, its id in `data-act`, its key in `data-key` and its zone in `data-zone`. Unavailable, it
 * stays in place, marked `aria-disabled` with the reason as its tooltip.
 * @param {any} app the page
 * @param {string} id the action
 * @param {{ zone: string, ctx?: any, tag?: string, attrs?: Record<string, any>, children?: any[],
 *     label?: string | null, keyed?: boolean }} where its zone, context, element, extra attributes,
 *     content in place of the label, and whether it prints its key (default: when it has one)
 * @returns {HTMLElement} the control
 */
export function control(
    app,
    id,
    { zone, ctx = {}, tag = "button", attrs = {}, children = null, label = null, keyed = true },
) {
    const a = ACTIONS[id];
    const ok = availability(app, id, ctx);
    const text = label ?? labelOf(app, id, ctx);
    const key = keyed ? a.key : undefined;
    const node = el(
        tag,
        {
            ...(tag === "button" && { type: "button" }),
            "data-act": id,
            "data-zone": zone,
            "data-key": key,
            "aria-disabled": ok === true ? null : "true",
            title:
                ok === true
                    ? (attrs.title ?? (typeof a.title === "function" ? a.title(app, ctx) : a.title) ?? null)
                    : ok,
            ...attrs,
            ...(ok !== true && { title: ok }),
        },
        children ?? [text, key ? kb(key) : null],
    );
    contexts.set(node, ctx);
    node.addEventListener("click", (e) => {
        e.stopPropagation();
        runAction(app, id, { ...ctx, el: node }, "pointer");
    });
    return node;
}
