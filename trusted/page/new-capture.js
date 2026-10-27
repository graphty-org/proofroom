/*
 * The New capture sheet (design 9.1): four questions, What, Against which baselines, Which projects
 * and stories, and Where, with defaults that make Start one Enter. A change from the code host
 * defaults to CI when CI can be asked for a capture; captured on this machine it asks once more,
 * naming its author, because a capture builds and runs that code here. Start capture [Enter]
 * closes the sheet and the capture's row is in the changes pane at once (POST /api/captures).
 */

import { control, runAction } from "./actions.js";
import { api } from "./api.js";
import { wordsOf } from "./messages.js";
import { el } from "./ui.js";

const PARTIAL =
    "A partial capture reports every story it skipped as removed, so it is look only: it can be viewed but not finished.";
const UNCOMMITTED = "Uncommitted changes are captured to look at only; commit them to review and finish.";
const AS_THEY_ARE = "The capture uses the files as they are when it starts.";

const radio = (name, value, checked, attrs = {}) =>
    el("input", { type: "radio", name, value, ...(checked && { checked: true }), ...attrs });

/**
 * Opens the New capture sheet.
 * @param {any} app the page
 * @param {any} [prefill] the changes row whose Capture again... opened it
 */
export async function newCapture(app, prefill = null) {
    let sources;
    try {
        sources = (await api("/api/captures?sources=1")).sources;
    } catch (err) {
        app.say(`New capture: the server did not answer: ${err.message}`, "err");
        return;
    }
    const caps = app.captures ?? {};
    const master = app.list?.defaultBranch ?? "master";
    const words = wordsOf(app.list);
    // A change from the code host: a pull request, or under plain git a branch only on a remote.
    const byBranch = words.numberPrefix === "";
    const fromHost = `A ${words.changeNoun} from ${byBranch ? "the remote" : (caps.hostName ?? words.hostName)}`;
    const prs = byBranch
        ? (sources.remote ?? []).map((r) => ({ id: r.name, pr: null, label: r.name, ...r }))
        : app.changes.filter((c) => c.kind === "PR" && c.capId === null && c.head);
    // Capture again... asks what the row was; otherwise the working tree when it has changes.
    const what0 =
        { PR: "pr", branch: "br", "working tree": "wt" }[prefill?.kind] ?? (sources.changed > 0 ? "wt" : "br");
    const branches = sources.branches;
    const brSelect = el(
        "select",
        { id: "nc-br", "aria-label": "Local branch" },
        branches.map((b) =>
            el("option", { value: b, ...(b === (prefill?.branch ?? sources.branch) && { selected: true }) }, b),
        ),
    );
    const prSelect = el(
        "select",
        {
            id: "nc-pr",
            "aria-label": fromHost,
            ...(prs.length === 0 && { disabled: true }),
        },
        prs.map((c) =>
            el(
                "option",
                { value: c.id, ...(!byBranch && prefill?.pr === c.pr && { selected: true }) },
                // A remote branch by its name on the remote (origin/feat/y is feat/y).
                `${byBranch ? c.name.slice(c.name.indexOf("/") + 1) : `${words.numberPrefix}${c.pr}`} ${c.title}${c.author ? ` (${c.author})` : ""}`,
            ),
        ),
    );
    const treeFacts = `${sources.branch ?? "detached"}, ${sources.changed} ${sources.changed === 1 ? "file" : "files"} changed`;
    const commit = el("input", {
        type: "text",
        id: "nc-commit",
        placeholder: "6dfc21d",
        size: "10",
        "aria-label": "Commit",
    });
    const prefix = el("input", {
        type: "text",
        id: "nc-prefix",
        placeholder: "button--, badge--",
        size: "22",
        autocomplete: "off",
        "aria-label": "Only stories whose id starts with",
    });
    const partial = el("div", { class: "warnbox", id: "nc-warn", hidden: true }, PARTIAL);
    const dirty = el("div", { class: "warnbox", id: "nc-dirty", hidden: true }, UNCOMMITTED);
    const asTheyAre = el("p", { class: "small muted", id: "nc-asis", hidden: true }, AS_THEY_ARE);
    const ci = caps.ci ?? { available: false, label: "CI", why: "your capture store cannot start CI jobs" };
    const start = control(app, "capstart", { zone: "box", attrs: { class: "primary", id: "nc-ok" } });
    const form = el(
        "form",
        { id: "ncf", class: "newcap" },
        el("h3", {}, "New capture"),
        el(
            "div",
            { class: "q" },
            el("b", {}, "1. What"),
            el("label", {}, radio("what", "wt", what0 === "wt"), `The working tree on this machine (${treeFacts})`),
            el("label", {}, radio("what", "br", what0 === "br"), "A local branch ", brSelect),
            el(
                "label",
                prs.length === 0
                    ? {
                          class: "muted",
                          title: byBranch ? "No branch is only on the remote" : `No ${words.changeNoun} is open`,
                          "aria-disabled": "true",
                      }
                    : {},
                radio("what", "pr", what0 === "pr", prs.length === 0 ? { disabled: true } : {}),
                `${fromHost} `,
                prSelect,
            ),
            asTheyAre,
            dirty,
        ),
        el(
            "div",
            { class: "q" },
            el("b", {}, "2. Against which baselines"),
            el("label", {}, radio("vs", "target", true), `The change's target branch (${master})`),
            el("label", {}, radio("vs", "default", false), `The default branch (${master})`),
            el("label", {}, radio("vs", "commit", false), "A commit ", commit),
        ),
        el(
            "div",
            { class: "q" },
            el("b", {}, "3. Which projects and stories"),
            (caps.projects ?? []).map((p) =>
                el("label", {}, el("input", { type: "checkbox", name: "project", value: p, checked: true }), p),
            ),
            el("label", {}, "Only stories whose id starts with ", prefix),
            partial,
        ),
        el(
            "div",
            { class: "q" },
            el("b", {}, "4. Where"),
            el("label", {}, radio("where", "here", true), "This machine"),
            ci.available
                ? el("label", {}, radio("where", "ci", false), ci.label)
                : el(
                      "label",
                      {
                          class: "muted",
                          title: `${ci.why[0].toUpperCase()}${ci.why.slice(1)}`,
                          "aria-disabled": "true",
                      },
                      radio("where", "ci", false, { disabled: true }),
                      `${ci.label}: unavailable, ${ci.why}`,
                  ),
        ),
        el("div", { class: "foot" }, control(app, "confirmcancel", { zone: "box" }), start),
    );
    const value = (name) =>
        /** @type {HTMLInputElement | null} */ (form.querySelector(`input[name=${name}]:checked`))?.value;
    // Someone else's change runs on CI unless the reader chose where.
    let whereTouched = false;
    const sync = () => {
        if (value("what") === "pr" && ci.available && !whereTouched) {
            /** @type {HTMLInputElement} */ (form.querySelector("input[name=where][value=ci]")).checked = true;
        }
        partial.hidden = prefix.value.trim() === "";
        dirty.hidden = !(value("what") === "wt" && sources.changed > 0);
        asTheyAre.hidden = value("what") !== "wt";
    };
    // A choice of Where is the reader's from then on; marked before sync runs, on whichever event
    // comes first.
    const changed = (e) => {
        whereTouched ||= /** @type {HTMLInputElement} */ (e.target).name === "where";
        sync();
    };
    form.addEventListener("change", changed);
    form.addEventListener("input", changed);
    // A choice in a picker or field chooses its option too.
    brSelect.addEventListener("change", () => (form.querySelector("input[value=br]").checked = true));
    prSelect.addEventListener("change", () => (form.querySelector("input[value=pr]").checked = true));
    commit.addEventListener("input", () => (form.querySelector("input[value=commit]").checked = true));
    // Enter anywhere in the sheet but on a button is Start capture, as its box prints.
    form.addEventListener("keydown", (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (e.key === "Enter" && !t.matches("button, select")) {
            e.preventDefault();
            if (!e.repeat) {
                runAction(app, "capstart", {}, "key");
            }
        }
    });
    form.addEventListener("submit", (e) => e.preventDefault());
    sync();
    app.capSheet = {
        form,
        start,
        request() {
            const what = value("what");
            const pr = byBranch ? prs.find((c) => c.id === prSelect.value) : app.change(prSelect.value);
            const vs = value("vs");
            return {
                body: {
                    what:
                        what === "wt"
                            ? { kind: "tree" }
                            : what === "br"
                              ? { kind: "branch", branch: brSelect.value }
                              : byBranch
                                ? { kind: "change", branch: pr?.name, head: pr?.head }
                                : { kind: "change", number: pr?.pr, head: pr?.head },
                    baselines: vs === "commit" ? { commit: commit.value.trim() } : vs,
                    projects: [...form.querySelectorAll("input[name=project]:checked")].map((n) => n.value),
                    stories: prefix.value.trim(),
                    where: value("where"),
                },
                change: what === "pr" ? pr : null,
                label: what === "wt" ? "working tree" : what === "br" ? `branch ${brSelect.value}` : (pr?.label ?? ""),
            };
        },
    };
    app.openForm(form);
    start.focus();
}

// A change named as its row is, or as the server's refusal names it (a number, or under plain git
// the remote branch).
const changeName = (app, c) => c.label ?? c.remote ?? `${wordsOf(app.list).numberPrefix}${c.pr}`;

/**
 * The sheet's second step for a change from the code host captured on this machine: it names the
 * change and its author, Capture here [Enter] and Cancel [Esc] (to the sheet as it was).
 * @param {any} app the page
 * @param {{ change: any }} req the sheet's request
 */
export function confirmChange(app, req) {
    const c = req.change;
    const ok = control(app, "capconfirm", { zone: "box", attrs: { class: "primary" } });
    app.openForm(
        el(
            "form",
            { id: "nc-confirm" },
            el("h3", {}, "Capture on this computer?"),
            el(
                "p",
                { class: "cbody" },
                `This builds and runs the code of ${changeName(app, c)} by ${c.author ?? "an unknown author"} on this computer.`,
            ),
            el("div", { class: "foot" }, control(app, "capback", { zone: "box" }), ok),
        ),
        () => runAction(app, "capback", {}, "key"),
    );
    ok.focus();
}

/**
 * Back to the New capture sheet as the reader left it.
 * @param {any} app the page
 */
export function sheetBack(app) {
    if (app.capSheet) {
        app.openForm(app.capSheet.form);
        app.capSheet.start.focus();
    }
}
