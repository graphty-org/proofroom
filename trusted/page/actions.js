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

import { beforeAction, wordsOf } from "./messages.js";
import { el, fmt, kb } from "./ui.js";

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
const paneName = (app, i) => (app.screen === "baselines" ? ["Projects", "Baselines"] : ["Changes", "Snapshots"])[i];
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
 *     run: (app: any, ctx: any) => void | boolean, available?: (app: any, ctx: any) => true | string }>}
 */
export const ACTIONS = {
    // The top bar.
    "screen-review": { label: "Review", run: (app) => app.showReview() },
    "screen-baselines": { label: "Baselines", run: (app) => app.showBaselines() },
    "screen-captures": { label: "Captures", run: (app) => app.showCaptures() },
    newcap: {
        label: "New capture...",
        title: (app) => {
            const w = wordsOf(app.list);
            return `Capture the working tree, a local branch or a ${w.changeNoun} from ${w.hostName === "git" ? "the remote" : w.hostName}`;
        },
        run: (app) => app.newCapture(),
    },
    refresh: { label: "Refresh", title: "Refresh now", run: (app) => app.refresh() },
    keys: { label: "Keys", key: "?", title: "Every key, grouped by task", run: (app) => app.keysSheet() },
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

    // Panes: Changes and Snapshots on Review, Projects and Baselines on Baselines.
    pane1: {
        label: (app, ctx) => (ctx?.rail ? paneName(app, 0) : "Hide"),
        key: "Shift+1",
        title: (app) => `Show or hide ${paneName(app, 0)} (Shift+1)`,
        run: (app) => app.togglePane("changes"),
    },
    pane2: {
        label: (app, ctx) => (ctx?.rail ? paneName(app, 1) : "Hide"),
        key: "Shift+2",
        title: (app) => `Show or hide ${paneName(app, 1)} (Shift+2)`,
        run: (app) => app.togglePane("snaps"),
    },

    // The Baselines screen (baselines.js).
    blref: { label: "Baselines of", run: (app, ctx) => app.setBaselineRef(ctx.value) },
    blnode: { label: "", run: (app, ctx) => app.pickNode(ctx.project, ctx.component) },
    blrow: { label: "", run: (app, ctx) => app.pickBaseline(ctx.key) },
    blgroupmenu: {
        label: (app) => `Group: ${app.groupLabel()}`,
        title: "Group",
        run: (app, ctx) => app.groupMenu(ctx.el),
    },
    blgroup: { label: (app, ctx) => ctx.grouping, run: (app, ctx) => app.setBaselineGroup(ctx.grouping) },
    bldl: {
        label: "Download",
        title: "Fetches exactly these images from Git LFS",
        writes: true,
        run: (app, ctx) => app.download(ctx.paths),
        available: (app) => (app.downloadBusy() ? "A download is running" : true),
    },
    bldlver: {
        label: "Download",
        title: "Fetches this version from Git LFS",
        writes: true,
        run: (app, ctx) => app.downloadVersion(ctx.i),
        available: (app) => (app.downloadBusy() ? "A download is running" : true),
    },
    blcmp: {
        label: "Compare",
        title: "Tick two versions to compare them",
        run: (app, ctx) => app.toggleCompare(ctx.i),
        available: (app, ctx) => (app.versionLocal(ctx.i) ? true : "Not downloaded: Download it first"),
    },

    // The changes pane.
    nextchange: {
        label: "Next change",
        key: "Shift+N",
        title: "Opens the next change that needs you",
        run: (app) => app.nextChange(),
        available: (app) => (app.changes.length > 0 ? true : NO_CHANGES),
    },
    // Up and Down: the current row of a list (Changes, Snapshots, Baselines, Captures). A button
    // moves its own pane's list (`ctx.pane`); the key moves the list the reader is in.
    rowup: {
        label: "Previous",
        key: "Up",
        title: "Previous row (Up)",
        run: (app, ctx) => app.arrow(-1, ctx.pane),
    },
    rowdown: {
        label: "Next",
        key: "Down",
        title: "Next row (Down)",
        run: (app, ctx) => app.arrow(1, ctx.pane),
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
        label: (app) => `Open on ${wordsOf(app.list).hostName}`,
        run: (app, ctx) => app.openOnHost(ctx.id),
        available: (app, ctx) => {
            const w = wordsOf(app.list);
            return app.change(ctx.id)?.url ? true : `Only a ${w.changeNoun} is on ${w.hostName}`;
        },
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
        // Printed only on the current row (finish.js), where it takes Enter in Open's place.
        key: "Enter",
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
    // The summary of the current change in the viewer's place, while none is open.
    summaryopen: {
        label: "Open",
        key: "Enter",
        title: "Opens this change",
        run: (app, ctx) => app.openChange(ctx.id),
    },

    // Levels: the one Back, named by where it goes, and Open on the item line.
    back: {
        label: "Back",
        key: "Esc",
        title: (app) => `${app.level === 2 ? "Back to the list" : "Back to the changes"} (Esc)`,
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
    clearfind: { label: "Clear", title: "Empty Find", run: (app) => app.clearFind() },
    showmenu: {
        label: "Show",
        title: "Which snapshots the list shows",
        run: (app, ctx) => app.listMenu("show", ctx.el),
    },
    listmenu: {
        label: "List",
        title: "Group by, pictures and selection for this list",
        run: (app, ctx) => app.listMenu("list", ctx.el),
    },
    show: { label: (app, ctx) => `Show: ${ctx.show}`, run: (app, ctx) => app.setShow(ctx.show) },
    group: { label: (app, ctx) => ctx.grouping, run: (app, ctx) => app.setGrouping(ctx.grouping) },
    picspot: {
        label: "Spotlight rows",
        title: "Dims what did not change",
        run: (app) => app.setPictures({ spot: !(app.lv.pics.spot && !app.lv.pics.none), none: false }),
    },
    piczoom: { label: (app, ctx) => ctx.zoom, run: (app, ctx) => app.setPictures({ zoom: ctx.zoom, none: false }) },
    picnone: { label: "No pictures (text rows)", run: (app) => app.setPictures({ none: !app.lv.pics.none }) },
    listlink: { label: "Copy link to this list", run: (app) => app.copyListLink() },
    // The open change's number and title, a menu of what is change-wide and rare (app.js).
    chgmenu: { label: "", run: (app, ctx) => app.changeMenu(ctx.el) },
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
    gmenu: {
        label: "Group menu",
        title: "Opens the group's menu",
        run: (app, ctx) => app.groupMenu(ctx.group, ctx.el),
    },
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
    // The selection bar (design 4.6): the count, Clear and its menu. The decision bar decides the
    // selection ("Accept 3") while the current row is in it.
    clearsel: { label: "Clear", key: "Esc", title: "Clear the selection", run: (app) => app.clearSel() },
    selmenu: {
        label: "...",
        title: "Extend up, Extend down, Select all shown",
        run: (app, ctx) => app.selMenu(ctx.el),
    },
    extendup: { label: "Extend up", key: "Shift+Up", run: (app) => app.extendSel(-1) },
    extenddown: { label: "Extend down", key: "Shift+Down", run: (app) => app.extendSel(1) },
    selshown: { label: "Select all shown", run: (app) => app.selectShown() },
    // The Show menu's last item, and the change's own menu's.
    acceptshown: {
        label: "Accept all shown...",
        run: (app) => app.acceptShown(),
        available: (app) => app.writeOK(),
    },
    undoall: { label: "Undo all decisions...", run: (app) => app.undoAll(), available: (app) => app.writeOK() },
    junit: { label: "Download the comparison report (JUnit)", run: (app) => app.downloadJunit() },
    // The renderer banner (design 10).
    rendereranyway: {
        label: "Show the changes anyway",
        title: "Show the rows, though every image may differ",
        run: (app) => app.showRendererChanges(),
    },
    recapture: {
        label: "Capture the baselines again...",
        title: "Capture again, so the baselines are drawn by the same renderer",
        run: (app) => app.newCapture(),
    },
    // The notice chips on the Snapshots header's line 1 (Behind master, Newer capture, or both
    // folded into "2 notices"): each opens its menu.
    stalechip: {
        label: "Notices",
        title: (app, ctx) =>
            ({
                stale: `This capture is behind ${master(app)}: what that means and what to do`,
                newer: "A newer capture is ready",
                both: "Two notices about this capture",
            })[ctx.which],
        run: (app, ctx) => app.noticeMenu(ctx.which, ctx.el),
    },
    // The stale capture: what changed on the default branch, and Update from it.
    chgonmaster: {
        label: (app) => `See what changed on ${master(app)}`,
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

    // The viewer (design 5, viewer.js): the four views, Blink, Zoom and its menu, the Display menu,
    // Next area and Details on the item line, the locator, and Previous and Next on the decision bar.
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
    // Zoom: Z steps Fit, 1x, 2x, 4x, 8x in one press; a click (or Enter on it) opens its menu,
    // whose digits act with the menu closed.
    zoomcycle: {
        label: (app) => app.viewer.zoomLabel(),
        key: "Z",
        title: "Z steps the zoom: Fit, 1x, 2x, 4x, 8x. Click for the menu (0, 1, 2, 4, 8)",
        run: (app, ctx) => (ctx.ev ? app.viewer.zoomMenu(ctx.el) : app.viewer.cycleZoom()),
    },
    "zoom-fit": { label: "Fit", key: "0", title: "Fit", run: (app) => app.viewer.setZoom("fit") },
    "zoom-1": { label: "Actual size", key: "1", title: "1x", run: (app) => app.viewer.setZoom(1) },
    "zoom-2": { label: "2x", key: "2", title: "2x", run: (app) => app.viewer.setZoom(2) },
    "zoom-4": { label: "4x", key: "4", title: "4x", run: (app) => app.viewer.setZoom(4) },
    "zoom-8": { label: "8x", key: "8", title: "8x", run: (app) => app.viewer.setZoom(8) },
    // The Display menu: the settings a reader sets once a session. Each prints its key, which acts
    // with the menu closed (the Display button's data-menukeys).
    displaymenu: {
        // Hidden baseline is said on the button, so the missing panel is never silently gone.
        label: (app) => (app.viewer.state.showBase || !app.viewer.twoImages() ? "Display" : "Display: baseline hidden"),
        title: "Show baseline, Image only, Layout, Outline changed areas, Start zoomed on the change",
        run: (app, ctx) => app.viewer.displayMenu(ctx.el),
    },
    baseline: {
        label: "Show baseline",
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
    // Layout: Y steps Auto, Side by side, Over and under in one press; the Display item, clicked or
    // given Enter, opens the three as a menu.
    layoutmenu: {
        label: (app) => `Layout: ${app.viewer.layoutName()}`,
        key: "Y",
        title: (app) => app.viewer.layoutTitle(),
        run: (app, ctx) => (ctx.ev ? app.viewer.layoutMenu(ctx.el) : app.viewer.cycleLayout()),
    },
    "layout-auto": { label: "Auto", run: (app) => app.viewer.setLayout("auto") },
    "layout-side": { label: "Side by side", run: (app) => app.viewer.setLayout("side") },
    "layout-stacked": { label: "Over and under", run: (app) => app.viewer.setLayout("stacked") },
    outline: { label: "Outline changed areas", key: "B", run: (app) => app.viewer.toggle("outline") },
    centerarea: { label: "Start zoomed on the change", key: "O", run: (app) => app.viewer.toggle("center") },
    // At the end of the item line: the image's technical details, and in them its link.
    details: {
        label: "Details",
        title: "Threshold, renderer, hashes, attempts and console of this image",
        run: (app) => app.viewer.toggle("details"),
    },
    imagelink: { label: "Copy link to this image", run: (app) => app.copyListLink() },
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
        label: (app) => (selN(app) ? `Accept ${fmt(selN(app))}` : "Accept"),
        key: "A",
        title: (app) => (selN(app) ? `Accept the ${fmt(selN(app))} selected` : app.acceptTitle()),
        run: (app) => app.accept(),
        available: (app) => app.decideOK("accept"),
    },
    reject: {
        label: (app) => (selN(app) ? `Reject ${fmt(selN(app))}...` : "Reject..."),
        key: "R",
        title: (app) =>
            selN(app) ? `Reject the ${selN(app)} selected, with one reason` : "Reject, with a reason the author sees",
        run: (app) => app.reject("reject"),
        available: (app) => app.decideOK("reject"),
    },
    exclude: {
        label: (app) => (selN(app) ? `Exclude ${fmt(selN(app))}...` : "Exclude..."),
        key: "E",
        title: (app) =>
            selN(app)
                ? `Exclude the ${selN(app)} selected, with one reason`
                : "Exclude, with a reason: the story stops being captured",
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
        title: "Previous snapshot (J or Left)",
        run: (app) => app.viewer.step(-1),
    },
    next: {
        label: "Next",
        key: "Right / K",
        title: "Next snapshot (K or Right)",
        run: (app) => app.viewer.step(1),
    },

    // Captures on this machine (captures.js, new-capture.js): the New capture sheet, its second step
    // for a change from the code host, the Captures screen and the capture rows of the changes pane.
    capstart: { label: "Start capture", key: "Enter", writes: true, run: (app) => app.startCapture(false) },
    capconfirm: { label: "Capture here", key: "Enter", writes: true, run: (app) => app.startCapture(true) },
    capback: { label: "Cancel", key: "Esc", title: "Back to New capture", run: (app) => app.captureSheetBack() },
    capagain: {
        label: (app, ctx) => ctx.label ?? "Capture again...",
        title: "New capture of the same thing",
        run: (app, ctx) => app.captureAgain(ctx),
    },
    pickcap: { label: "", run: (app, ctx) => app.pickCapture(ctx.cap) },
    capcancel: {
        label: "Cancel",
        title: "Stops the capture and every browser it started",
        writes: true,
        run: (app, ctx) => app.cancelCapture(ctx.cap),
    },
    capreview: {
        label: "Review results",
        key: "Enter",
        title: "Opens Review on what this capture made",
        run: (app, ctx) => app.reviewCapture(ctx.cap),
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
    gofirst: {
        label: "Go to the first",
        title: "Closes this sheet at the first undecided snapshot",
        run: (app) => app.goFirstUndecided(),
    },
    finishregister: {
        label: "Register passkey...",
        title: "Opens Settings; closing it brings this sheet back",
        run: (app) => app.finishRegister(),
    },
    // The message line's own button: Retry after a failed list or a failed open (ctx.run retries it).
    retry: { label: "Retry", run: (app, ctx) => ctx.run() },
    messages: { label: "Messages", title: "The last 20 messages", run: (app) => app.messagesBox() },
    // A message with a button stays until the button is used or this clears it.
    msgdismiss: { label: "Dismiss", title: "Clear the message line", run: () => {} },
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
 * @returns {void | boolean} what the handler answered (Up and Down: whether a row moved)
 */
export function runAction(app, id, ctx, via) {
    app.logUsage("action", { a: id, via });
    beforeAction(ctx?.el?.dataset?.zone === "msgline");
    const ok = availability(app, id, ctx);
    if (ok === OFFLINE_WHY) {
        app.notSaved();
        return;
    }
    if (ok !== true) {
        app.say(`${labelOf(app, id, ctx)}: ${ok}${String(ok).endsWith(".") ? "" : "."}`);
        return;
    }
    return ACTIONS[id].run(app, ctx);
}

// Each control's context, for the key handler: the change or snapshot it stands for.
const contexts = new WeakMap();
// The screen each control acts for (the page, or the Baselines screen standing in for it).
const hosts = new WeakMap();
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
 * What a control acts on: the page, or the screen that built it in the page's place.
 * @param {Element} node the control
 * @returns {any} it, or undefined for a control not built by `control()`
 */
export const hostOf = (node) => hosts.get(node);

// A printed key's names in aria-keyshortcuts' spelling ("Up" is "ArrowUp", "Left / J" is two).
const ARIA_KEYS = { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Esc: "Escape" };

/**
 * A printed key as an aria-keyshortcuts value.
 * @param {string} keys the printed keys, " / " between two ("Shift+2", "Left / J", "hold Space")
 * @returns {string} the value ("Shift+2", "ArrowLeft J", "Space")
 */
export const ariaKeys = (keys) =>
    keys
        .replace(/^hold /, "")
        .split(" / ")
        .map((k) =>
            k
                .split("+")
                .map((p) => ARIA_KEYS[p] ?? p)
                .join("+"),
        )
        .join(" ");

/**
 * A control for an action: a button (or, with `tag`, another element) with the action's label and
 * key box, its id in `data-act`, its key in `data-key` and its zone in `data-zone`. Unavailable, it
 * stays in place, marked `aria-disabled` with the reason as its tooltip.
 * @param {any} app the page
 * @param {string} id the action
 * @param {{ zone: string, ctx?: any, tag?: string, attrs?: Record<string, any>, children?: any[],
 *     label?: string | null, keyed?: boolean, quiet?: boolean }} where its zone, context, element,
 *     extra attributes, content in place of the label, whether it prints its key (default: when it
 *     has one), and whether that key is quiet (muted text, not a box: every control off the
 *     look-decide-next loop)
 * @returns {HTMLElement} the control
 */
export function control(
    app,
    id,
    { zone, ctx = {}, tag = "button", attrs = {}, children = null, label = null, keyed = true, quiet = false },
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
            "aria-keyshortcuts": key ? ariaKeys(key) : null,
            "aria-disabled": ok === true ? null : "true",
            ...attrs,
            title: ok === true ? own : ok,
        },
        children ?? [text, key ? kb(key, quiet) : null],
    );
    contexts.set(node, ctx);
    titles.set(node, own);
    hosts.set(node, app);
    node.addEventListener("click", (e) => {
        e.stopPropagation();
        runAction(app, id, { ...ctx, el: node, ev: e }, "pointer");
    });
    return node;
}

/**
 * Previous [Up] and Next [Down] for a list's pane: the buttons of the keys that move its current row.
 * Their word is in its own span: the pane headers have no room for it beside their other controls,
 * so a pair shows only its key boxes while it has them (page.css), and its words while the other
 * pane's pair has the boxes; the word stays the accessible name.
 * @param {any} app the page (or the screen standing in for it)
 * @param {string} pane the list's pane ("changes", "snaps"), which the buttons move whatever the
 *     reader is in, and whose pair carries the key boxes while the keys move that list
 * @param {string} zone the zone of the pane's header
 * @returns {HTMLElement[]} the two buttons
 */
export const rowButtons = (app, pane, zone) =>
    ["rowup", "rowdown"].map((id) => {
        const word = labelOf(app, id);
        return control(app, id, {
            zone,
            ctx: { pane },
            attrs: { "data-rows": pane, "aria-label": word },
            children: [el("span", { class: "rl" }, word), kb(ACTIONS[id].key, true)],
        });
    });
