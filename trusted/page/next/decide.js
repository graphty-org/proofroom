/*
 * Decisions on the new page (design 6): Accept, Reject..., Exclude... and Undo on the decision
 * bar, the reason box with its recent reasons and Exclude's second step, auto-advance to the next
 * undecided snapshot and the end card, the selection bar's and the group headers' bulk decisions,
 * the list menu's Accept all shown and Undo all, and the stale capture's Update from the default
 * branch.
 *
 * The error prevention of today's page is kept: a held key decides once (keys.js), a decision
 * within a quarter second of its images being drawn is ignored and the message line says why,
 * Accept waits for the images, and a decision is saved before the next can be made. Every bulk
 * decision is one request per project it touches (undo.js send), and one step for Undo.
 */

import { control } from "./actions.js";
import { api } from "./api.js";
import { nextNeeding } from "./changes.js";
import { BEFORE, splitOf, splitWords, undecided } from "./groups.js";
import { acceptLabel, groupScope, layoutOf, shownUndecided, undoable } from "./list.js";
import { STATUS } from "./marks.js";
import { wordsOf } from "./messages.js";
import { shownNow } from "./panes.js";
import { el, fmt } from "./ui.js";
import { reverse, send, shown } from "./undo.js";
import { GUARD_MS } from "../viewer/stage.js";

const REASONS_KEY = "proofroom:reasons";
const SLOW_MS = 300; // a save longer than this says what it waits for
const ASK_OVER = 20; // a bulk accept of more than this asks first
const DONE = { accept: "accepted", reject: "rejected", exclude: "excluded" };
const WORD = { accept: "Accepted", reject: "Rejected", exclude: "Excluded" };

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

// The recent reasons, newest first, kept in this browser.
function loadReasons() {
    try {
        const v = JSON.parse(localStorage.getItem(REASONS_KEY) ?? "[]");
        return Array.isArray(v) ? v.filter((r) => typeof r === "string") : [];
    } catch {
        return [];
    }
}

function keepReason(reason) {
    const list = [reason, ...loadReasons().filter((r) => r !== reason)].slice(0, 20);
    try {
        localStorage.setItem(REASONS_KEY, JSON.stringify(list));
    } catch {
        // Kept for this visit only: the box offers none next time.
    }
}

// A row that arrived decided from an earlier review, which a new decision replaces.
const replaceable = (s) => s.before || s.rejectedBefore;

/**
 * Puts the decision actions on the page.
 * @param {any} app the page
 */
export function installDecide(app) {
    const drafts = new Map(); // the typed reason of each snapshot, kept across Esc and Undo
    let saving = null; // the decision being saved
    let box = null; // the open reason box: { kind, list, field, step2, reason }
    let confirmFn = null; // what the open confirm box's default button does

    const cur = () => app.snaps.find((s) => s.key === app.snap) ?? null;
    const walk = () => layoutOf(app.lv, app.snaps).groups.flatMap((g) => g.rows);
    const groupOf = (key) => layoutOf(app.lv, app.snaps).byKey.get(key) ?? null;
    const groupName = (g) =>
        g.key === BEFORE ? "Approved before" : g.kind === "status" ? STATUS[g.label]?.word : g.label;
    const acceptable = (s) =>
        app.list?.targets?.find((t) => t.id === app.openId)?.projects.find((p) => p.project === s.project)
            ?.acceptable !== false;
    const master = () => app.list?.defaultBranch ?? "master";
    const words = () => wordsOf(app.list);

    // Whether a control that writes is available: not on a look-only capture.
    app.writeOK = () => (app.open()?.lookOnly ? "A look-only capture is viewed, never decided" : true);

    app.groupScope = (key) => {
        const g = groupOf(key);
        return g ? { ...groupScope(app, g), rows: g.rows, g } : null;
    };
    // The group of the current snapshot.
    // A list drawn without group headers (Group: None, a small change) has no group to accept.
    app.currentGroup = () =>
        layoutOf(app.lv, app.snaps).groups.find((g) => g.headed && g.rows.some((s) => s.key === app.snap))?.key ?? null;
    app.groupAcceptLabel = (key) => {
        const sc = app.groupScope(key);
        return sc ? acceptLabel(sc) : "Accept";
    };

    /**
     * Whether a decision bar button applies to the current snapshot, and why not.
     * @param {"accept" | "reject" | "exclude"} kind the decision
     * @returns {true | string} true, or the reason
     */
    app.decideOK = (kind) => {
        const w = app.writeOK();
        if (w !== true) {
            return w;
        }
        const s = cur();
        if (!s) {
            return "Nothing shown here";
        }
        if (app.curInSel()) {
            return true;
        }
        if (s.finished) {
            return "Finished: it is on the branch";
        }
        if (kind === "accept" && s.before) {
            return "Already accepted: approved before. Reject or Exclude replaces it";
        }
        if (kind === "reject" && s.rejectedBefore) {
            return "Already rejected by an earlier Finish. Accept or Exclude replaces it";
        }
        if (s.decision && !replaceable(s)) {
            return `Already ${DONE[s.decision.decision]}. Undo it to change it`;
        }
        if (kind === "accept" && STATUS[s.status]?.accept === false) {
            return "Failed snapshots cannot be accepted. Exclude stops capturing the story";
        }
        if (kind !== "reject" && !acceptable(s)) {
            return `${s.project} is not seeded from ${master()}; its first review is on a ${words().changeNoun}`;
        }
        return true;
    };
    app.acceptTitle = () => {
        const s = cur();
        return s ? (STATUS[s.status]?.say ?? "Accept") : "Accept";
    };

    // Why a press came too soon to count: Accept before the images are drawn, or any decision on
    // images drawn less than a quarter second ago (the tail of a press meant for the snapshot before).
    function tooSoon(kind, s) {
        const st = app.viewer.stage;
        if (st.shownFile !== s.key) {
            return kind === "accept" ? "Loading images: Accept waits for them." : null;
        }
        if (performance.now() - st.appearedAt < GUARD_MS) {
            return "Ignored: this image appeared less than a quarter second ago.";
        }
        return null;
    }

    // Keyboard focus back on the list's current row (or the viewer, when the list is a rail), so a
    // Space or Enter after a decision never presses a button on the next, unseen snapshot. While
    // the end card shows, its Finish has focus.
    app.focusList = () => {
        if (app.endCard && $("endfinish")) {
            $("endfinish").focus({ preventScroll: true });
            return;
        }
        const list = shownNow()[1] && !app.viewer.imageOnly();
        app.focusPane = list ? "snaps" : "viewer";
        (list ? $("snap-list") : $("viewer")).focus({ preventScroll: true });
        app.settle();
    };

    // The next undecided snapshot after `s` in list order, wrapping to the top once.
    function nextUndecided(s) {
        const rows = walk();
        const at = rows.findIndex((x) => x.key === s.key);
        return rows.slice(at + 1).find((x) => !x.decision) ?? rows.slice(0, at).find((x) => !x.decision) ?? null;
    }

    // After the current snapshot was decided: the next undecided one, or the end card.
    function advance(s) {
        const next = nextUndecided(s);
        if (next) {
            app.stepTo(next.key);
        } else if (app.snaps.every((x) => x.decision)) {
            app.endCard = true;
            app.draw();
        }
    }

    const undoButton = () => [control(app, "undo", { zone: "msgline", keyed: false })];

    // Says which projects were left undecided, with Retry for them; none for a refusal (HTTP 403),
    // which a second try cannot change.
    function sayFailed(failed, retry) {
        const names = failed.map((f) => f.project).join(", ");
        const again = failed.filter((f) => f.status !== 403);
        app.say(
            `Not saved: ${failed[0].error}. ${names} left as ${failed.length === 1 ? "it was" : "they were"}.`,
            "err",
            again.length > 0
                ? [
                      control(app, "retry", {
                          zone: "msgline",
                          ctx: { run: () => retry(again.flatMap((f) => f.changes)) },
                      }),
                  ]
                : [],
        );
    }

    /**
     * Saves changes and shows them: one request for one, one per project for more. Nothing else
     * is saved meanwhile.
     * @param {any[]} changes `{ s, to, model? }` each
     * @param {{ said?: (done: any[]) => void, step?: boolean }} [opts] what to say once saved
     *     (default: nothing), and whether the changes are one step for Undo (default true)
     * @returns {Promise<any[] | null>} the changes saved, or null when none was
     */
    async function commit(changes, { said = null, step = true } = {}) {
        if (saving) {
            app.say("Still saving the last decision.");
            return null;
        }
        for (const c of changes) {
            c.prev = c.s.decision;
        }
        const slow = setTimeout(() => app.say("Saving the last decision..."), SLOW_MS);
        let out;
        saving = send(app, changes);
        try {
            out = await saving;
        } finally {
            clearTimeout(slow);
            saving = null;
        }
        if (out.done.length > 0) {
            shown(app, out.done, out.unpublished);
            if (step) {
                app.pushStep(out.done);
            }
        }
        if (out.failed.length > 0) {
            if (changes.length === 1) {
                const s = changes[0].s;
                app.say(
                    `Not saved: ${out.failed[0].error}. #${s.n} is ${s.decision ? `still ${DONE[s.decision.decision]}` : "still undecided"}.`,
                    "err",
                );
            } else {
                sayFailed(out.failed, (again) =>
                    commit(
                        again.map(({ s, to, model }) => ({ s, to, model })),
                        { said, step },
                    ),
                );
            }
            return out.done.length > 0 ? out.done : null;
        }
        said?.(out.done);
        return out.done;
    }

    // One decision on the current snapshot: saved, its row shown decided, then the next undecided.
    async function decideOne(s, kind, reason) {
        const to = { decision: kind, reason: kind === "accept" ? null : reason };
        const done = await commit([{ s, to }], {
            said: () => app.say(`${WORD[kind]} #${s.n}.`, "", undoButton()),
        });
        if (done && s.key === app.snap) {
            advance(s);
        }
        app.focusList();
    }

    /**
     * Many decisions with one reason: the rows a decision can take (a decided row only when it
     * arrived decided and this decision replaces it), one request per project, one step for Undo.
     * @param {"accept" | "reject" | "exclude"} kind the decision
     * @param {any[]} list the rows
     * @param {string | null} reason the reason (Reject and Exclude)
     * @param {{ said?: (done: any[], note: string) => void }} [opts] what to say once saved, given
     *     the sentence naming the projects left out ("" when none)
     * @returns {Promise<any[] | null>} the changes saved
     */
    async function decideMany(kind, list, reason, opts = {}) {
        // A project not seeded from the default branch is accepted (and excluded) only on a pull
        // request, as for one snapshot: its rows are left out and named.
        const refused = [...new Set(list.filter((s) => kind !== "reject" && !acceptable(s)).map((s) => s.project))];
        const note =
            refused.length > 0
                ? ` ${refused.join(", ")} left out: not seeded from ${master()}; its first review is on a ${words().changeNoun}.`
                : "";
        const take = list.filter(
            (s) =>
                !s.finished &&
                (!s.decision || (replaceable(s) && s.decision.decision !== kind)) &&
                (kind !== "accept" || undecided(s)) &&
                (kind === "reject" || acceptable(s)),
        );
        if (take.length === 0) {
            app.say(note ? note.trim() : "Nothing to decide there: those are decided already, or cannot be accepted.");
            return null;
        }
        const to = kind === "accept" ? { decision: "accept", reason: null, bulk: true } : { decision: kind, reason };
        const done = await commit(
            take.map((s) => ({ s, to })),
            {
                said: opts.said
                    ? (d) => opts.said(d, note)
                    : (d) =>
                          app.say(
                              `${WORD[kind]} ${d.length === 1 ? `#${d[0].s.n}` : plural(d.length, "snapshot")}.${note}`,
                              "",
                              undoButton(),
                          ),
            },
        );
        if (done) {
            const keys = [...app.sel];
            app.sel.clear();
            app.markSel(keys);
            app.draw();
        }
        app.focusList();
        return done;
    }

    // ------------------------------------------------------------ Accept, Reject, Exclude

    app.accept = () => {
        if (app.curInSel()) {
            app.acceptMany(app.selected(), `${fmt(app.sel.size)} selected`);
            return;
        }
        const s = cur();
        const why = tooSoon("accept", s);
        if (why) {
            app.say(why);
            return;
        }
        decideOne(s, "accept", null);
    };

    /**
     * Reject... and Exclude... on the decision bar: the box, for the selection while the current row
     * is in it.
     * @param {"reject" | "exclude"} kind the decision
     */
    app.reject = (kind) => {
        if (app.curInSel()) {
            app.reasonBox(kind, app.selected());
            return;
        }
        const s = cur();
        const why = tooSoon(kind, s);
        if (why) {
            app.say(why);
            return;
        }
        app.reasonBox(kind, [s]);
    };

    /**
     * A bulk accept, asking first above 20 rows.
     * @param {any[]} list the rows
     * @param {string} scope what they are, for the question ("12 selected")
     */
    app.acceptMany = (list, scope) => {
        const take = list.filter(undecided);
        if (take.length === 0) {
            app.say("Nothing left to accept there.");
            return;
        }
        if (take.length <= ASK_OVER) {
            decideMany("accept", take, null);
            return;
        }
        const never = take.filter((s) => !app.opened.has(s.key)).length;
        app.confirm(
            `Accept ${fmt(take.length)} snapshots without opening them?`,
            `${scope}. ${fmt(never)} of them were never opened; they will be marked Accepted (not opened).`,
            "Accept",
            () => decideMany("accept", take, null),
        );
    };

    // ------------------------------------------------------------ the reason box

    /**
     * The box Reject and Exclude ask their reason in, anchored above the decision bar: the field,
     * up to five recent reasons, Cancel [Esc] and Reject [Enter] (Exclude has a second step).
     * @param {"reject" | "exclude"} kind the decision
     * @param {any[]} list the rows it decides
     */
    app.reasonBox = (kind, list) => {
        const take = list.filter(Boolean);
        if (take.length === 0) {
            app.say("Nothing shown here.");
            return;
        }
        app.closeReason(false);
        const one = take.length === 1 ? take[0] : null;
        const title = kind === "reject" ? "Reject" : "Exclude";
        const field = el("input", {
            type: "text",
            id: "reason",
            placeholder: "What looks wrong?",
            autocomplete: "off",
            maxlength: "2000",
            "aria-label": `${title}: the reason`,
        });
        field.value = (one && drafts.get(one.key)) || "";
        const form = el("form", { class: "popbox", id: "popbox", "aria-label": title });
        box = { kind, list: take, one, field, form, step2: false, reason: null };
        const ok = control(app, "reasonok", {
            zone: "box",
            ctx: { label: title },
            attrs: { class: "primary", id: "popok" },
        });
        const sync = () => {
            ok.setAttribute("aria-disabled", field.value.trim() ? "false" : "true");
            if (field.value.trim()) {
                form.querySelector(".perr")?.remove();
            }
        };
        form.append(
            el("b", {}, `${title}${one ? ` #${one.n} ${one.component} / ${one.name}` : ""}`),
            el(
                "span",
                { class: "small muted" },
                `${one ? "" : `One reason for ${fmt(take.length)} snapshots. `}${kind === "reject" ? "The author sees this reason." : "The reason is kept in the story settings file."}`,
            ),
            field,
            el(
                "div",
                { class: "recent" },
                loadReasons()
                    .slice(0, 5)
                    .map((r) =>
                        control(app, "reasonpick", { zone: "box", ctx: { reason: r }, attrs: { class: "rr" } }),
                    ),
            ),
            el("div", { class: "pfoot" }, control(app, "reasoncancel", { zone: "box", ctx: { label: "Cancel" } }), ok),
        );
        field.addEventListener("input", sync);
        field.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                if (!e.repeat) {
                    app.runKey("reasonok");
                }
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                form.querySelector(".rr")?.focus();
            }
        });
        // The box's own keys stop here: no letter key acts while it is open (design 6.3).
        form.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                app.runKey("reasoncancel");
            } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target !== field) {
                e.preventDefault();
                const rr = [...form.querySelectorAll(".rr")];
                const at = rr.indexOf(/** @type {HTMLElement} */ (e.target));
                (rr[at + (e.key === "ArrowDown" ? 1 : -1)] ?? field).focus();
            }
            e.stopPropagation();
        });
        form.addEventListener("submit", (e) => e.preventDefault());
        sync();
        $("viewer").append(form);
        field.focus();
        app.settle();
    };

    /** Reject [Enter] (Exclude [Enter]): needs a reason; Exclude then states its scope once. */
    app.reasonOK = () => {
        if (!box) {
            return;
        }
        const b = box;
        if (!b.step2) {
            const r = b.field.value.trim();
            if (!r) {
                const t = "Type a reason first: the author sees it.";
                if (!b.form.querySelector(".perr")) {
                    b.field.after(el("span", { class: "perr", role: "alert" }, t));
                }
                app.say(t, "err");
                return;
            }
            b.reason = r;
            if (b.kind === "exclude") {
                exclusionStep(b);
                return;
            }
        }
        if (b.one) {
            drafts.delete(b.one.key);
        }
        closeBox(false);
        keepReason(b.reason);
        if (b.one && b.list.length === 1 && b.one.key === app.snap && !app.curInSel()) {
            decideOne(b.one, b.kind, b.reason);
        } else {
            decideMany(b.kind, b.list, b.reason);
        }
    };

    // Exclude's second step: what it stops, then Exclude [Enter] / Back [Esc].
    function exclusionStep(b) {
        b.step2 = true;
        const one = b.list.length === 1;
        const exclude = control(app, "reasonok", {
            zone: "box",
            ctx: { label: "Exclude" },
            attrs: { class: "primary", id: "popok2" },
        });
        b.form.replaceChildren(
            el("b", {}, `Exclude ${one ? `#${b.list[0].n}` : plural(b.list.length, "snapshot")}`),
            el(
                "span",
                {},
                `Exclude stops capturing every mode of ${one ? "this story" : "these stories"} on every later change, until ${one ? "its" : "their"} settings file is removed.`,
            ),
            el(
                "div",
                { class: "pfoot" },
                control(app, "reasoncancel", { zone: "box", ctx: { label: "Back" } }),
                exclude,
            ),
        );
        exclude.focus();
        app.settle();
    }

    // Closes the box; Esc keeps the typed reason for that snapshot.
    function closeBox(keepDraft) {
        if (!box) {
            return;
        }
        if (keepDraft && box.one && !box.step2) {
            drafts.set(box.one.key, box.field.value);
        }
        box.form.remove();
        box = null;
    }

    /**
     * Cancel [Esc] (Back [Esc] in Exclude's second step): the box closes, the typed text kept.
     * @param {boolean} keepDraft keep the typed reason for that snapshot
     */
    app.closeReason = (keepDraft) => {
        const had = box !== null;
        closeBox(keepDraft);
        if (had) {
            app.focusList();
        }
    };
    app.reasonOpen = () => box !== null;

    /**
     * A recent reason, by click or by Down then Enter: put in the field.
     * @param {string} reason the reason
     */
    app.pickReason = (reason) => {
        if (box && !box.step2) {
            box.field.value = reason;
            box.field.dispatchEvent(new Event("input"));
            box.field.focus();
        }
    };

    // ------------------------------------------------------------ Undo

    /** Undo [U]: the last step, single or bulk, taken back in one step; the viewer goes back to it. */
    app.undo = async () => {
        if (saving) {
            app.say("Still saving the last decision.");
            return;
        }
        const step = app.popStep();
        if (!step) {
            app.say("Nothing to undo.");
            return;
        }
        const back = reverse(step);
        const done = await commit(back, { step: false });
        if (!done) {
            app.pushStep(step);
            return;
        }
        // Undoing a reject or an exclusion puts its own reason back in the box.
        for (const c of step) {
            const d = c.model === undefined ? c.to : c.model;
            if (d?.reason) {
                drafts.set(c.s.key, d.reason);
            }
        }
        const first = step[0];
        app.endCard = false;
        app.stepTo(first.s.key);
        app.say(step.length === 1 ? `Undone: #${first.s.n}.` : `Undone: ${plural(step.length, "snapshot")}.`);
        app.focusList();
    };

    // A row's Undo: that decision taken back (one step, so Undo [U] would decide it again).
    app.undoRow = async (key) => {
        const s = app.snaps.find((x) => x.key === key);
        if (!s || !undoable(s)) {
            return;
        }
        const was = s.decision;
        const done = await commit([{ s, to: null }], { step: false });
        if (done) {
            if (was.reason) {
                drafts.set(key, was.reason);
            }
            app.say(`Undone: #${s.n}.`);
        }
    };

    // ------------------------------------------------------------ group headers

    /**
     * A group's Accept N, by click or Shift+A: its undecided rows shown (asks over 20). The rows stay,
     * dimmed; the current snapshot moves to the first undecided row of the next group with any, and
     * focus to the list's current row, so Shift+A walks group by group.
     * @param {string} key the group
     */
    app.groupAccept = (key) => {
        const sc = app.groupScope(key);
        if (!sc) {
            return;
        }
        const name = groupName(sc.g);
        if (sc.und.length === 0) {
            app.say(`Nothing left to accept in ${name}`);
            return;
        }
        const label = acceptLabel(sc);
        const i = layoutOf(app.lv, app.snaps).groups.findIndex((g) => g.key === key);
        const run = () =>
            decideMany("accept", sc.und, null, {
                said: (done, note) => {
                    const after = layoutOf(app.lv, app.snaps).groups;
                    const nx = [...after.slice(i + 1), ...after.slice(0, i)].find((g) => g.rows.some(undecided));
                    if (!nx) {
                        app.say(
                            `Accepted ${fmt(done.length)} in ${name}. No group has anything left to accept.${note}`,
                            "",
                            undoButton(),
                        );
                        return;
                    }
                    app.stepTo(nx.rows.find(undecided).key);
                    app.say(
                        `Accepted ${fmt(done.length)} in ${name}. Next: ${groupName(nx)} (${fmt(nx.rows.filter(undecided).length)}).${note}`,
                        "",
                        undoButton(),
                    );
                },
            });
        if (sc.und.length <= ASK_OVER) {
            run();
            return;
        }
        const split = splitOf({ rows: sc.und });
        const never = sc.und.filter((s) => !app.opened.has(s.key)).length;
        app.confirm(
            `${label} in ${name} without opening them?`,
            `${split ? `The group holds ${splitWords(split)}. ` : ""}They will be marked Accepted (not opened). ${fmt(never)} of them were never opened.${sc.hidden > 0 ? " Hidden rows are not touched." : ""}`,
            "Accept",
            run,
        );
    };

    /**
     * A group's Undo N: asks first, then one step for Undo [U].
     * @param {string} key the group
     */
    app.groupUndo = (key) => {
        const sc = app.groupScope(key);
        if (!sc || sc.undoable.length === 0) {
            return;
        }
        const name = groupName(sc.g);
        const list = sc.undoable;
        app.confirm(
            `Undo ${fmt(list.length)} decisions in ${name}?`,
            "They go back to undecided. One step for Undo [U].",
            "Undo",
            () =>
                commit(
                    list.map((s) => ({ s, to: null })),
                    { said: (d) => app.say(`Undone: ${plural(d.length, "decision")} in ${name}.`, "", undoButton()) },
                ).then(() => app.focusList()),
        );
    };

    /**
     * A group's [...] menu: Reject N..., Exclude N..., Select all N, Show all.
     * @param {string} key the group
     * @param {HTMLElement} anchor its button
     */
    app.groupMenu = (key, anchor) => {
        const sc = app.groupScope(key);
        app.showMenu(anchor, [
            { id: "greject", label: `Reject ${fmt(sc.all.length)}...`, ctx: { group: key } },
            { id: "gexclude", label: `Exclude ${fmt(sc.all.length)}...`, ctx: { group: key } },
            { id: "gselect", label: `Select all ${fmt(sc.rows.length)}`, ctx: { group: key } },
            { id: "gshowall", label: "Show all", ctx: { group: key } },
        ]);
    };

    /**
     * A group's Reject N... and Exclude N...: the box, for its undecided rows (for Approved before,
     * every row: the server replaces an approved-before accept).
     * @param {"reject" | "exclude"} kind the decision
     * @param {string} key the group
     */
    app.groupReason = (kind, key) => {
        const sc = app.groupScope(key);
        if (sc) {
            app.reasonBox(kind, sc.all);
        }
    };

    // ------------------------------------------------------------ the selection bar's menu and the list menu

    app.selMenu = (anchor) =>
        app.showMenu(anchor, [
            { id: "extendup", label: "Extend up" },
            { id: "extenddown", label: "Extend down" },
            { id: "selshown", label: `Select all shown (${fmt(walk().length)})` },
        ]);

    /** Accept all shown (N)...: every undecided row Show and Find keep; always asks. */
    app.acceptShown = () => {
        const list = shownUndecided(app);
        if (list.length === 0) {
            app.say("Nothing left to accept there.");
            return;
        }
        app.confirm(
            `Accept ${fmt(list.length)} matching?`,
            "Every undecided row the filter and Find show.",
            "Accept",
            () => decideMany("accept", list, null),
        );
    };

    /** Undo all decisions...: asks once; one request per project. */
    app.undoAll = () => {
        const list = app.snaps.filter(undoable);
        if (list.length === 0) {
            app.say("Nothing to undo.");
            return;
        }
        app.confirm("Undo all decisions?", `${plural(list.length, "decision")} go back to undecided.`, "Undo all", () =>
            commit(
                list.map((s) => ({ s, to: null })),
                {
                    step: false,
                    said: (d) => {
                        app.clearSteps();
                        app.say(`Undone: ${plural(d.length, "decision")}.`);
                    },
                },
            ).then(() => app.focusList()),
        );
    };

    // ------------------------------------------------------------ the confirm box

    /**
     * A question in the page's box: Cancel [Esc] and its default button [Enter], which has focus.
     * @param {string} title the question
     * @param {string} body what it does
     * @param {string} okLabel the default button
     * @param {() => void} fn what the default button does
     */
    app.confirm = (title, body, okLabel, fn) => {
        const d = /** @type {HTMLDialogElement} */ ($("dlg"));
        confirmFn = fn;
        const ok = control(app, "confirmok", { zone: "box", ctx: { label: okLabel }, attrs: { class: "primary" } });
        d.replaceChildren(
            el("h3", {}, title),
            el("p", { class: "cbody" }, body),
            el("div", { class: "foot" }, control(app, "confirmcancel", { zone: "box" }), ok),
        );
        d.showModal();
        ok.focus();
        app.settle();
    };
    app.confirmOK = () => {
        const fn = confirmFn;
        confirmFn = null;
        /** @type {HTMLDialogElement} */ ($("dlg")).close();
        fn?.();
    };

    // ------------------------------------------------------------ the end card

    app.endFinishLabel = () => app.finishLabel();
    app.endBack = () => {
        app.endCard = false;
        app.back();
    };

    /**
     * The end card (design 6.6), in place of the image: "All 214 decided.", Finish [Enter] (focused),
     * Back named as the item line's Back is, and Next change [Shift+N].
     * @returns {HTMLElement} the card
     */
    app.endCardOf = () => {
        const next = nextNeeding(app.changes, app.sort, app.openId);
        return el(
            "div",
            { class: "card endcard" },
            el("h2", {}, `All ${fmt(app.snaps.length)} decided.`),
            control(app, "endfinish", { zone: "end", attrs: { class: "primary", id: "endfinish" } }),
            control(app, "endback", { zone: "end" }),
            next
                ? control(app, "nextchange", {
                      zone: "end",
                      label: `Next change: ${next.label} (${fmt(next.undecided)} undecided)`,
                  })
                : null,
        );
    };

    // ------------------------------------------------------------ Update from the default branch

    /**
     * Changed on master: the baselines the default branch changed since this capture.
     * @param {string} id the change
     */
    app.changedOnMaster = (id) => {
        const t = app.list?.targets?.find((x) => x.id === id);
        const files = (t?.projects ?? []).flatMap((p) => (p.newer ?? []).map((f) => `${p.project}/${f}`));
        app.openBox(
            `Changed on ${master()} (${fmt(files.length)})`,
            el(
                "p",
                { class: "small" },
                `Finish still records your decisions against this capture. When the ${words().changeNoun} merges, ${words().ciName ?? "the gate"} compares it with these baselines again, and any image they change comes back to you. Update only when the ${words().changeNoun} conflicts with ${master()}.`,
            ),
            el(
                "ul",
                { class: "small" },
                files.map((f) => el("li", {}, f)),
            ),
        );
    };

    /**
     * Update from master...: asks, then the server merges the default branch into the pull request's
     * branch and pushes (POST /api/update), the page following the job's steps; then the list again.
     * @param {string} id the change
     */
    app.updateFrom = (id) => {
        const c = app.change(id);
        const m = master();
        app.confirm(
            `Update ${c.label} from ${m}?`,
            `This merges ${m} into ${c.branch} with a merge commit and pushes it. A conflicting file under the baselines takes ${m}'s side; any other conflict stops it with nothing changed. It accepts nothing: CI captures again, and your decisions on stories whose capture and baseline are unchanged apply again.`,
            `Update ${c.label}`,
            () => followUpdate(c),
        );
    };

    async function followUpdate(c) {
        let job;
        try {
            job = (await api("/api/update", { id: c.id })).job;
        } catch (err) {
            app.say(`Update of ${c.label} failed: ${err.message}`, "err");
            return;
        }
        await followJob(c, job);
    }

    // Follows an update job of change `c` to its end, as today's page follows Finish: a status ask
    // that fails says so and tries again two seconds later.
    async function followJob(c, job) {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const mine = (j) => j?.kind === "update" && j.target === c.id;
        let said = "";
        while (mine(job) && job.running) {
            const step = `Updating ${c.label}: ${job.step}...`;
            if (step !== said) {
                app.say(step);
                said = step;
            }
            // The status is an in-memory read on the server: a quarter second between asks.
            await pause(250);
            try {
                job = (await api("/api/finish-status")).job;
            } catch (err) {
                app.say(`Lost contact with the server (${err.message}); the update goes on there. Retrying...`, "err");
                said = "";
                await pause(2000);
            }
        }
        if (mine(job) && job.error) {
            app.say(`Update of ${c.label} failed: ${job.error}`, "err");
            return;
        }
        // The server refreshes its list once the update is pushed: the page follows that refresh,
        // and says Updated only once it has the new list (a failed refresh has said why).
        await app.refresh();
        if (mine(job) && app.failed === null) {
            app.say(`Updated ${c.label} from ${master()}: CI captures it again.`);
        }
    }

    /**
     * Picks up an update or a Finish the server is running (one started before a reload, or on
     * another tab) and follows it to its end.
     */
    app.resumeUpdate = async () => {
        let job;
        try {
            job = (await api("/api/finish-status")).job;
        } catch {
            return; // the list's own asks say when the server does not answer
        }
        const c = job?.kind === "update" && job.running ? app.change(job.target) : null;
        if (c) {
            await followJob(c, job);
        } else {
            await app.resumeFinish(job);
        }
    };

    // Runs an action as a key press would (a box's default button by Enter, Cancel by Esc).
    app.runKey = (id) => app.runAction(id, {}, "key");
}
