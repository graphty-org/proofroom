/*
 * The one table of the page's actions: id, label, key, handler, and the rule that says whether it
 * is available (and why not). Every control is built from it by `control()`, and the key handler
 * (keys.js) acts only through a control built here, so a key cannot act without its printed label
 * and every press is logged with its action id.
 *
 * Each handler takes the page (`app`, app.js) and the control's context (`ctx`: the change or
 * snapshot it stands for). `available` answers true, or the reason it is not, which becomes the
 * control's tooltip and, when pressed, the message line. An action that `writes` to the server is
 * unavailable while the server is unreachable, and pressed then, says it was not saved: nothing is
 * queued for later (design 10).
 */

import { el, kb } from "./ui.js";

// Where a control sits, in the order that decides which of two controls showing the same key
// carries its key box (design 8.1.7): an open box or menu, the end card, the decision bar, the
// selection bar, the item line, the Changes pane header, the Snapshots pane header, rows and the
// message line, then the top bar. The viewer's toolbar shares no key with another zone; it sits
// beside the item line.
export const ZONES = [
    "box",
    "menu",
    "end",
    "decision",
    "selection",
    "iline",
    "toolbar",
    "changes-head",
    "snaps-head",
    "rows",
    "msgline",
    "top",
];

const NO_CHANGES = "No changes yet";
const RUNNING = "A Finish is running: wait for it to end";
const master = (app) => app.list?.defaultBranch ?? "master";
// How many snapshots the selection holds while the current row is in it (then A, R and E act on
// the selection), else 0.
const selN = (app) => (app.curInSel() ? app.sel.size : 0);
const groupN = (app, ctx, what) => app.groupScope(ctx.group)?.[what].length ?? 0;

/** Why a control that writes is unavailable while the server is unreachable. */
export const OFFLINE_WHY = "Offline: decisions cannot be saved";

/**
 * The actions, by id.
 * @type {Record<string, { label: string | ((app: any, ctx: any) => string), key?: string,
 *     title?: string | ((app: any, ctx: any) => string), writes?: boolean,
 *     run: (app: any, ctx: any) => void, available?: (app: any, ctx: any) => true | string }>}
 */
export const ACTIONS = {
    // The top bar.
    "screen-review": { label: "Review", run: (app) => app.showReview() },
    refresh: { label: (app) => app.statusText(), title: "Refresh now", run: (app) => app.refresh() },
    keys: { label: "Keys", key: "?", title: "Every key, and the last 20 messages", run: (app) => app.keysSheet() },
    settings: { label: "Settings", run: (app) => app.settingsSheet() },
    finish: {
        label: (app) => app.finishLabel(),
        // A numbered change's label is short and whole on the button; any other's full name.
        title: (app) => (/^#/.test(app.open()?.label ?? "#") ? null : `Finish ${app.open().label}`),
        writes: true,
        run: (app) => app.finishOpen(),
        available: (app) => app.finishOK(),
    },

    // Settings and the Keys sheet (settings.js, keys-sheet.js).
    letterkeys: { label: "Letter keys", run: (app, ctx) => app.setLetters(ctx.el.checked) },
    hlcolor: { label: (app, ctx) => ctx.color, run: (app, ctx) => app.setHighlight(ctx.color) },
    theme: { label: (app, ctx) => ctx.theme, run: (app, ctx) => app.setTheme(ctx.theme) },
    register: {
        label: "Register passkey...",
        writes: true,
        run: (app, ctx) => app.startRegistration(ctx.row),
    },
    createpasskey: {
        label: "Create the passkey",
        writes: true,
        run: (app, ctx) => app.createPasskey(ctx),
    },
    cancelpasskey: { label: "Cancel", run: (app, ctx) => app.cancelPasskey(ctx) },

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
    // Find [/], in the changes pane and in the snapshot list: the box of the pane the reader is in.
    find: { label: "Find", key: "/", run: (app, ctx) => app.focusFind(ctx.el) },
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
    // Finish from the changes pane (design 7.4): one change, every decided change, and the run.
    finishchg: {
        label: "Finish...",
        title: "Opens the summary sheet for this change without opening it",
        writes: true,
        run: (app, ctx) => app.finishSheet([ctx.id]),
        available: (app) => (app.finishing() ? RUNNING : true),
    },
    finishall: {
        label: (app) => `Finish all ${app.finishable().length}...`,
        writes: true,
        run: (app) => app.finishSheet(app.finishable().map((r) => r.id)),
        available: (app) => (app.finishing() ? RUNNING : true),
    },
    stopfinish: {
        label: "Stop",
        title: "Ends the run after the change that is finishing now",
        run: (app) => app.stopFinish(),
    },
    signfinish: {
        label: (app, ctx) => app.signLabel(ctx.id),
        title: "Starts the passkey prompt for this change's turn in Finish all",
        writes: true,
        run: (app) => app.signFinish(),
    },
    unqueue: {
        label: "Remove from the run",
        title: "Takes this change out of the Finish all run",
        run: (app, ctx) => app.unqueue(ctx.id),
    },
    retryfinish: {
        label: "Retry",
        title: "Opens the summary sheet again: every decision is kept",
        writes: true,
        run: (app, ctx) => app.finishSheet([ctx.id]),
        available: (app) => (app.finishing() ? RUNNING : true),
    },
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
    // A click on a row makes it current; with Ctrl or Cmd it goes in or out of the selection instead.
    pickrow: {
        label: "",
        run: (app, ctx) => (ctx.ev?.ctrlKey || ctx.ev?.metaKey ? app.toggleSel(ctx.snap) : app.pickSnapshot(ctx.snap)),
    },

    // The snapshot list (design 4).
    statshow: {
        label: (app, ctx) => ctx.status,
        title: "Show only this status; pressed again, Undecided",
        run: (app, ctx) => app.setShowStatus(ctx.status),
    },
    statmore: { label: "+ more", title: "The other statuses", run: (app, ctx) => app.listMenu("more", ctx.el) },
    clearfind: { label: "Clear", title: "Empty Find", run: (app) => app.clearFind() },
    showmenu: { label: "Show", title: "Show", run: (app, ctx) => app.listMenu("show", ctx.el) },
    groupmenu: { label: "Group", title: "Group", run: (app, ctx) => app.listMenu("group", ctx.el) },
    picsmenu: { label: "Pictures", title: "Pictures", run: (app, ctx) => app.listMenu("pics", ctx.el) },
    listmenu: { label: "...", title: "More for this list", run: (app, ctx) => app.listMenu("list", ctx.el) },
    viewopts: { label: "View options", run: (app, ctx) => app.listMenu("view", ctx.el) },
    show: { label: (app, ctx) => `Show: ${ctx.show}`, run: (app, ctx) => app.setShow(ctx.show) },
    group: { label: (app, ctx) => ctx.grouping, run: (app, ctx) => app.setGrouping(ctx.grouping) },
    picspot: {
        label: "Spotlight rows (switch)",
        run: (app) => app.setPictures({ spot: !(app.lv.pics.spot && !app.lv.pics.none), none: false }),
    },
    piczoom: { label: (app, ctx) => ctx.zoom, run: (app, ctx) => app.setPictures({ zoom: ctx.zoom, none: false }) },
    picnone: { label: "No pictures (text rows)", run: (app) => app.setPictures({ none: !app.lv.pics.none }) },
    listlink: { label: "Copy link", run: (app) => app.copyListLink() },
    gtoggle: { label: "", run: (app, ctx) => app.toggleGroup(ctx.group) },
    gshowall: { label: "Show all", run: (app, ctx) => app.toggleGroup(ctx.group, true) },
    rowundo: {
        label: "Undo",
        title: "Undo this decision",
        writes: true,
        run: (app, ctx) => app.undoRow(ctx.key),
        available: (app) => app.writeOK(),
    },
    rowcheck: {
        label: "",
        title: "Select [X]; Shift-click selects a range",
        run: (app, ctx) => (ctx.ev?.shiftKey && app.anchor ? app.rangeSel(ctx.key) : app.toggleSel(ctx.key)),
    },
    // A group header's actions (design 4.5): on exactly the rows the group shows.
    gaccept: {
        label: (app, ctx) => app.groupAcceptLabel(ctx.group),
        key: "Shift+A",
        title: "Accept the current snapshot's group",
        run: (app, ctx) => app.groupAccept(ctx.group),
        available: (app) => app.writeOK(),
    },
    gundo: {
        label: (app, ctx) => `Undo ${groupN(app, ctx, "undoable")}`,
        run: (app, ctx) => app.groupUndo(ctx.group),
        available: (app) => app.writeOK(),
    },
    gmenu: { label: "...", title: "More for this group", run: (app, ctx) => app.groupMenu(ctx.group, ctx.el) },
    greject: {
        label: (app, ctx) => `Reject ${groupN(app, ctx, "all")}...`,
        run: (app, ctx) => app.groupReason("reject", ctx.group),
        available: (app) => app.writeOK(),
    },
    gexclude: {
        label: (app, ctx) => `Exclude ${groupN(app, ctx, "all")}...`,
        run: (app, ctx) => app.groupReason("exclude", ctx.group),
        available: (app) => app.writeOK(),
    },
    gselect: {
        label: (app, ctx) => `Select all ${app.groupScope(ctx.group)?.rows.length ?? 0}`,
        run: (app, ctx) => app.selectKeys(app.groupScope(ctx.group).rows.map((s) => s.key)),
    },
    // The selection bar (design 4.6).
    accsel: {
        label: (app) => `Accept ${app.sel.size}`,
        title: "Accept the selection",
        run: (app) => app.acceptMany(app.selected(), `${app.sel.size} selected`),
        available: (app) => app.writeOK(),
    },
    rejsel: {
        label: (app) => `Reject ${app.sel.size}...`,
        title: "Reject the selection, with one reason",
        run: (app) => app.reasonBox("reject", app.selected()),
        available: (app) => app.writeOK(),
    },
    excsel: {
        label: (app) => `Exclude ${app.sel.size}...`,
        title: "Exclude the selection, with one reason",
        run: (app) => app.reasonBox("exclude", app.selected()),
        available: (app) => app.writeOK(),
    },
    clearsel: { label: "Clear", key: "Esc", title: "Clear the selection", run: (app) => app.clearSel() },
    selmenu: {
        label: "...",
        title: "Extend up, Extend down, Select all shown",
        run: (app, ctx) => app.selMenu(ctx.el),
    },
    extendup: { label: "Extend up", key: "Shift+Up", run: (app) => app.extendSel(-1) },
    extenddown: { label: "Extend down", key: "Shift+Down", run: (app) => app.extendSel(1) },
    selshown: { label: "Select all shown", run: (app) => app.selectShown() },
    // The list menu.
    acceptshown: {
        label: "Accept all shown...",
        run: (app) => app.acceptShown(),
        available: (app) => app.writeOK(),
    },
    undoall: { label: "Undo all decisions...", run: (app) => app.undoAll(), available: (app) => app.writeOK() },
    // The stale capture: what changed on the default branch, and Update from it.
    chgonmaster: {
        label: (app) => `Changed on ${master(app)}`,
        title: "The baselines that changed there since this capture",
        run: (app, ctx) => app.changedOnMaster(ctx.id),
    },
    updatefrom: {
        label: (app) => `Update from ${master(app)}...`,
        title: (app) => `Merges ${master(app)} into the branch and pushes it; CI captures again`,
        run: (app, ctx) => app.updateFrom(ctx.id),
        available: (app, ctx) =>
            app.change(ctx.id)?.kind === "PR" ? true : `Only a pull request is updated from ${master(app)}`,
    },
    picretry: { label: "Retry", title: "Ask for the picture again", run: (app, ctx) => app.retryPicture(ctx.key) },
    loadnewer: { label: "Load it", title: "Show the newer capture's rows", run: (app) => app.loadNewer() },

    // The viewer (design 5, viewer.js): the four views, Blink, zoom, Baseline, the display group and
    // its menus, Next area, the locator, and Previous and Next on the decision bar.
    "view-side": {
        label: "Side by side",
        key: "V",
        title: (app) => app.viewer.viewTitle("side"),
        run: (app) => app.viewer.pressView("side"),
        available: (app) => app.viewer.viewOK("side"),
    },
    "view-flash": {
        label: "Flash",
        key: "F",
        title: (app) => app.viewer.viewTitle("flash"),
        run: (app) => app.viewer.pressView("flash"),
        available: (app) => app.viewer.viewOK("flash"),
    },
    "view-highlight": {
        label: "Highlight",
        key: "H",
        title: (app) => app.viewer.viewTitle("highlight"),
        run: (app) => app.viewer.pressView("highlight"),
        available: (app) => app.viewer.viewOK("highlight"),
    },
    "view-spotlight": {
        label: "Spotlight",
        key: "S",
        title: (app) => app.viewer.viewTitle("spotlight"),
        run: (app) => app.viewer.pressView("spotlight"),
        available: (app) => app.viewer.viewOK("spotlight"),
    },
    blink: {
        label: "Blink",
        key: "L",
        title: "Blink: the highlight on and off",
        run: (app) => app.viewer.toggle("blink"),
        available: (app) => (app.viewer.shownView() === "highlight" ? true : "Blink works in Highlight [H]"),
    },
    zoomcycle: {
        label: "Zoom",
        key: "Z",
        title: "Zoom: cycles Fit, 1x, 2x, 4x, 8x",
        run: (app) => app.viewer.cycleZoom(),
    },
    "zoom-fit": { label: "Fit", key: "0", title: "Fit", run: (app) => app.viewer.setZoom("fit") },
    "zoom-1": { label: "1x", key: "1", title: "1x", run: (app) => app.viewer.setZoom(1) },
    "zoom-2": { label: "2x", key: "2", title: "2x", run: (app) => app.viewer.setZoom(2) },
    "zoom-4": { label: "4x", key: "4", title: "4x", run: (app) => app.viewer.setZoom(4) },
    "zoom-8": { label: "8x", key: "8", title: "8x", run: (app) => app.viewer.setZoom(8) },
    baseline: {
        label: (app) => (app.viewer.twoImages() ? "Baseline" : "Baseline: none"),
        key: "P",
        title: (app) => (app.viewer.state.showBase ? "Baseline shown" : "Baseline hidden"),
        run: (app) => app.viewer.toggle("showBase"),
        available: (app) => (app.viewer.twoImages() ? true : "This snapshot has only one image"),
    },
    imageonly: {
        label: "Image only",
        key: "Shift+3",
        title: (app) =>
            app.viewer.imageOnly() ? "Both side panes are rails: Shift+3 brings them back" : "Hide both side panes",
        run: (app) => app.viewer.pressImageOnly(),
    },
    layoutmenu: {
        label: (app) => `Layout: ${app.viewer.layoutName()}`,
        key: "Y",
        title: (app) => app.viewer.layoutTitle(),
        run: (app, ctx) => app.viewer.layoutMenu(ctx.el),
    },
    "layout-auto": { label: "Auto", run: (app) => app.viewer.setLayout("auto") },
    "layout-side": { label: "Side by side", run: (app) => app.viewer.setLayout("side") },
    "layout-stacked": { label: "Over and under", run: (app) => app.viewer.setLayout("stacked") },
    options: {
        label: "Options",
        run: (app, ctx) => app.viewer.optionsMenu(ctx.el),
    },
    more: { label: "More", title: "Image only, Layout, Options", run: (app, ctx) => app.viewer.moreMenu(ctx.el) },
    outline: { label: "Outline", key: "B", run: (app) => app.viewer.toggle("outline") },
    centerarea: { label: "Open centered on the area", key: "O", run: (app) => app.viewer.toggle("center") },
    details: { label: "Details", run: (app) => app.viewer.toggle("details") },
    flashheld: {
        label: "Flash while held",
        run: (app) => app.say("Hold Space to flash the current view; release to stop."),
    },
    nextarea: {
        label: "Next area",
        key: "N",
        title: "Steps through the changed areas, scrolling each into the center",
        run: (app) => app.viewer.nextArea(),
    },
    locator: {
        label: "",
        title: "The whole image: click to move the view there",
        run: (app, ctx) => app.viewer.locate(ctx.el),
    },
    // The decision bar (design 6.1). A, R and E act on the selection while the current row is in it.
    accept: {
        label: (app) => (selN(app) ? `Accept ${selN(app)} selected` : "Accept"),
        key: "A",
        title: (app) => app.acceptTitle(),
        run: (app) => app.accept(),
        available: (app) => app.decideOK("accept"),
    },
    reject: {
        label: (app) => (selN(app) ? `Reject ${selN(app)} selected...` : "Reject..."),
        key: "R",
        title: "Reject, with a reason the author sees",
        run: (app) => app.reject("reject"),
        available: (app) => app.decideOK("reject"),
    },
    exclude: {
        label: (app) => (selN(app) ? `Exclude ${selN(app)} selected...` : "Exclude..."),
        key: "E",
        title: "Exclude, with a reason: the story stops being captured",
        run: (app) => app.reject("exclude"),
        available: (app) => app.decideOK("exclude"),
    },
    undo: {
        label: "Undo",
        key: "U",
        title: "Undo the last decision",
        run: (app) => app.undo(),
        available: (app) => (app.writeOK() !== true ? app.writeOK() : app.undoSteps() > 0 ? true : "Nothing to undo"),
    },
    select: {
        label: (app) => (app.sel.has(app.snap) ? "Unselect" : "Select"),
        key: "X",
        title: (app) => (app.sel.has(app.snap) ? "Selected: X takes it out of the selection" : "Add to the selection"),
        run: (app) => app.toggleSel(),
    },
    // The end card (design 6.6).
    endfinish: {
        label: (app) => app.endFinishLabel(),
        key: "Enter",
        // A numbered change's label is short and whole on the button; any other's full name.
        title: (app) => (/^#/.test(app.open()?.label ?? "#") ? null : `Finish ${app.open().label}`),
        writes: true,
        run: (app) => app.finishOpen(),
        available: (app) => app.finishOK(),
    },
    endback: {
        label: (app) => (app.level === 2 ? "Back to list" : "Back to changes"),
        key: "Esc",
        run: (app) => app.endBack(),
    },
    prev: {
        label: "Previous",
        key: "Left / J",
        title: "Previous snapshot",
        run: (app) => app.viewer.step(-1),
    },
    next: {
        label: "Next",
        key: "Right / K",
        title: "Next snapshot",
        run: (app) => app.viewer.step(1),
    },

    // Boxes and the message line.
    closebox: { label: "Close", key: "Esc", run: (app) => app.closeBox() },
    // The reason box of Reject and Exclude (design 6.3, 6.4), and the confirm box.
    reasonok: { label: (app, ctx) => ctx.label, key: "Enter", run: (app) => app.reasonOK() },
    reasoncancel: { label: (app, ctx) => ctx.label, key: "Esc", run: (app) => app.closeReason(true) },
    reasonpick: {
        label: (app, ctx) => ctx.reason,
        title: "Use this reason",
        run: (app, ctx) => app.pickReason(ctx.reason),
    },
    confirmok: { label: (app, ctx) => ctx.label, key: "Enter", run: (app) => app.confirmOK() },
    confirmcancel: { label: "Cancel", key: "Esc", run: (app) => app.closeBox() },
    // The Finish summary sheet (design 7.2).
    finishgo: {
        label: (app) => app.finishGoLabel(),
        key: "Enter",
        writes: true,
        run: (app) => app.finishGo(),
        available: (app) => app.finishGoOK(),
    },
    gofirst: { label: "Go to the first undecided", run: (app) => app.goFirstUndecided() },
    finishregister: {
        label: "Register passkey...",
        title: "Opens Settings; closing it brings this sheet back",
        run: (app) => app.finishRegister(),
    },
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
    if (ACTIONS[id].writes && app.offline()) {
        return OFFLINE_WHY;
    }
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
    if (ok === OFFLINE_WHY) {
        app.notSaved();
        return;
    }
    if (ok !== true) {
        app.say(`${labelOf(app, id, ctx)}: ${ok}${String(ok).endsWith(".") ? "" : "."}`);
        return;
    }
    ACTIONS[id].run(app, ctx);
}

// Each control's context, for the key handler: the change or snapshot it stands for.
const contexts = new WeakMap();
// Each control's tooltip while it is available.
const titles = new WeakMap();

/**
 * Marks every control inside `root` available or not as it is now, for a part of the page that is
 * not drawn again (an open box) when the server stops answering or answers again.
 * @param {any} app the page
 * @param {Element} root where the controls are
 */
export function syncAvailability(app, root) {
    for (const node of root.querySelectorAll("[data-act]")) {
        const ok = availability(app, node.dataset.act, contextOf(node));
        const set = (name, value) => (value ? node.setAttribute(name, value) : node.removeAttribute(name));
        set("aria-disabled", ok === true ? null : "true");
        set("title", ok === true ? titles.get(node) : ok);
    }
}

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
    const own = attrs.title ?? (typeof a.title === "function" ? a.title(app, ctx) : a.title) ?? null;
    const node = el(
        tag,
        {
            ...(tag === "button" && { type: "button" }),
            "data-act": id,
            "data-zone": zone,
            "data-key": key,
            "aria-disabled": ok === true ? null : "true",
            ...attrs,
            title: ok === true ? own : ok,
        },
        children ?? [text, key ? kb(key) : null],
    );
    contexts.set(node, ctx);
    titles.set(node, own);
    node.addEventListener("click", (e) => {
        e.stopPropagation();
        runAction(app, id, { ...ctx, el: node, ev: e }, "pointer");
    });
    return node;
}
