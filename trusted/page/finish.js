/*
 * Finish on the page (design 7): Finish in the top bar, the summary sheet, the step list on the
 * changes row while a Finish runs, the row's state after it (finished with its links, or failed with
 * Retry), Finish... on each row of Decided, not finished, and Finish all, which this page drives one
 * change at a time over the server's routes: prepare (POST /api/finish-prepare), the passkey touch
 * (passkey.js), Finish (POST /api/finish), then the job followed (GET /api/finish-status) to its
 * end, then the next. A failure stops only its change; Stop ends the run after the current one, and
 * so does leaving the page. A seed (a default branch run opened with `serve --master-run`) finishes
 * the same way: the server pushes its branch, opens its pull request and files its rejects.
 */

import { approve, passkeyWrongHost } from "./passkey.js";
import { control } from "./actions.js";
import { api } from "./api.js";
import { hostCan } from "./messages.js";
import { el, fmt } from "./ui.js";

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => {
    const at = new Date();
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** The measured median time of one Finish, in seconds (design 7.4). */
const FINISH_SECONDS = 11.6;

/**
 * What a run of `n` Finishes costs the reader, as the Finish all sheet says it: whole minutes at
 * the measured median, at least one.
 * @param {number} n the changes
 * @returns {number} the minutes
 */
const runMinutes = (n) => Math.max(1, Math.round((n * FINISH_SECONDS) / 60));

/**
 * "1st", "2nd", "3rd", "4th", "11th".
 * @param {number} n the place
 * @returns {string} it, in words
 */
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;

// The steps of a Finish, as the step list names them, and the server's step each matches. The
// passkey's step is the page's own, before the job starts.
const STEPS = [
    ["passkey", () => "confirm passkey", null],
    ["check", () => "check", /^(starting|checking)/],
    ["write", () => "write", /^writing (?!the rejects)/],
    ["commit", () => "commit", /^committing/],
    [
        "upload",
        (step) => {
            const m = /\((\d+) of (\d+) done\)/.exec(step ?? "");
            return m ? `upload ${m[1]} of ${m[2]} images` : "upload images";
        },
        /^uploading images/,
    ],
    ["push", () => "push", /^pushing/],
    ["pull", () => "open the pull request", /^opening the pull request/],
    [
        "comment",
        (step, plan) => (plan?.seed ? "open the issue" : "comment"),
        /^(posting the comment|opening the issue)/,
    ],
    ["rejects", () => "write the rejects", /^writing the rejects/],
    ["status", () => "status", /^posting the status/],
];

/**
 * Where a branch's rejects are written when the code host cannot post them (plain git), as the
 * server names the file (adapters/plain-git.mjs rejectsFile).
 * @param {string} branch the branch
 * @returns {string} the path
 */
const rejectsFile = (branch) => `visual-review-rejects/${branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-")}.md`;

/**
 * The steps a Finish goes through, for what it does (null: not known, after a reload).
 * @param {{ seed: boolean, commits: boolean, posts: boolean, signed: boolean, file?: boolean } | null} plan the plan;
 *     `file`: the rejects go to a file on the branch, and no status is set (a code host that cannot post)
 * @param {any} list the server's list, whose code host decides the steps when the plan is not known
 * @returns {Array<typeof STEPS[number]>} the steps
 */
function stepsOf(plan, list) {
    return STEPS.filter(([key]) => {
        if (!plan) {
            // What the code host can do decides the rest: a host that cannot comment writes the file.
            const comments = hostCan(list, "comment");
            const can = { comment: comments, rejects: !comments, status: hostCan(list, "setStatus") };
            return key !== "passkey" && (can[key] ?? true);
        }
        if (["write", "commit", "upload", "push"].includes(key)) {
            return plan.commits;
        }
        return (
            {
                passkey: plan.signed,
                pull: plan.seed && plan.commits,
                comment: plan.posts && !plan.file,
                rejects: plan.posts && plan.file === true,
                status: !plan.file,
            }[key] ?? true
        );
    });
}

/**
 * "Step 3 of 8: commit": where a running Finish is.
 * @param {{ step: string | null, plan: any }} run the running Finish
 * @param {any} list the server's list
 * @returns {string} the step line
 */
function stepLine(run, list) {
    const steps = stepsOf(run.plan, list);
    let at = run.step === null ? 0 : steps.findIndex(([, , match]) => match?.test(run.step));
    at = Math.max(at, 0);
    return `Step ${at + 1} of ${steps.length}: ${steps[at][1](run.step, run.plan)}`;
}

/**
 * The commit status a Finish sets, as the server computes it (accept.mjs commitStatus).
 * @param {{ status: { state: string, description: string } }} f the server's preview
 * @returns {string} "the commit status "Reviewed: ..." (pending)"
 */
const statusText = (f) => `the commit status "${f.status.description}" (${f.status.state})`;

// A failed step in plain words, from the step the server puts before the reason ("pushing: ...").
const FAILED_AT = [
    [/^(starting|checking)/, "check failed"],
    [/^writing the rejects/, "rejects not written"],
    [/^writing/, "write failed"],
    [/^committing/, "commit failed"],
    [/^uploading images/, "upload failed"],
    [/^pushing/, "push rejected"],
    [/^opening the pull request/, "pull request not opened"],
    [/^posting the comment/, "comment not posted"],
    [/^opening the issue/, "issue not opened"],
    [/^posting the status/, "status not set"],
];
const failedAt = (why, fallback) => FAILED_AT.find(([match]) => match.test(why))?.[1] ?? fallback;

// "a", "a and b", "a, b and c".
const andList = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

const committer = (t) => t.signer?.author?.replace(/ <[^>]*>$/, "") ?? "this server's git identity";

/**
 * Puts Finish on the page.
 * @param {any} app the page
 */
export function installFinish(app) {
    const queue = []; // the changes waiting their turn in Finish all, in order
    let running = null; // the change finishing now: { id, step, plan }
    let run = null; // the Finish all run: { stop }
    const done = new Map(); // finished here: id -> { at, signed, links, short, why }
    const failed = new Map(); // failed here: id -> { at: the failed step in words, why }
    let signing = null; // the press a queued change's passkey prompt waits for: { id, start, cancel }
    let sheet = null; // the open summary sheet: { list, items }

    const targetOf = (id) => app.list?.targets?.find((t) => t.id === id) ?? null;
    const label = (id) => app.change(id)?.label ?? id;
    const registered = (t) => (t?.passkey?.keys ?? []).some((k) => k.rpId === t.passkey.rpId);

    app.finishing = () => running !== null || queue.length > 0;
    app.finishRunning = () => run !== null;

    /**
     * The decisions the open change's next Finish publishes: its snapshots' decisions that no
     * Finish published yet, as the page holds them, else the server's count.
     * @returns {number} the count
     */
    app.finishCount = () =>
        app.snaps.length > 0
            ? app.snaps.filter((s) => s.decision && !s.finished && !s.rejectedBefore).length
            : (targetOf(app.openId)?.unpublished ?? 0);
    app.finishLabel = () => `Finish ${app.open()?.label ?? ""} (${fmt(app.finishCount())})`;
    app.finishOK = () => {
        if (app.finishing()) {
            return "A Finish is running: wait for it to end";
        }
        const t = targetOf(app.openId);
        if (app.open()?.lookOnly) {
            return "A look-only capture is viewed, never finished";
        }
        if (t?.pendingPush) {
            return "Finish opens once this commit is pushed";
        }
        return app.finishCount() > 0 || (t?.resign && t.passkey?.required) ? true : "Nothing new to finish";
    };

    /**
     * The row as Finish shows it: queued, finishing with its step, finished here, or failed here.
     * @param {any} r the changes row (changes.js changeOf)
     * @returns {any} the row
     */
    app.withFinish = (r) => {
        const n = queue.indexOf(r.id);
        if (n >= 0) {
            return {
                ...r,
                state: "queued",
                mark: ["clock", "c-ink2"],
                count: `Queued: Finish all, ${ordinal(n + 1)}`,
                section: "decided",
            };
        }
        if (running?.id === r.id) {
            return {
                ...r,
                state: "finishing",
                mark: ["spin", "c-ink2"],
                count: "Finishing",
                steps: stepLine(running, app.list),
                section: "decided",
            };
        }
        if (done.has(r.id)) {
            const d = done.get(r.id);
            return {
                ...r,
                state: "finished",
                mark: ["accept", "c-accept"],
                count: `Finished ${d.at}${d.signed ? ", signed" : ""}${d.short ? `; ${d.short}` : ""}`,
                why: d.why,
                links: d.links,
                dismissable: true,
                section: r.section === "decided" ? "nothing" : r.section,
            };
        }
        if (failed.has(r.id)) {
            return {
                ...r,
                state: "finishfailed",
                mark: ["failed", "c-failed"],
                count: `Finish failed: ${failed.get(r.id).at}`,
                why: failed.get(r.id).why,
                section: "decided",
            };
        }
        return r;
    };

    const redraw = () => {
        app.rebuild();
        app.draw();
    };

    const dismissed = app.dismiss;
    app.dismiss = (id) => {
        done.delete(id);
        dismissed(id);
    };

    /**
     * The changes Finish all takes: every row of Decided, not finished that is not running or queued.
     * @returns {any[]} the rows
     */
    app.finishable = () =>
        app.changes.filter((r) => r.section === "decided" && !["queued", "finishing"].includes(r.state));

    // ------------------------------------------------------------ the summary sheet

    // A change's preview (what its Finish commits, posts and sets), and, for the first change of a
    // sheet, its prepared approval: the passkey's challenge is fetched before the sheet's button
    // shows, so the button starts the prompt inside its own press (Safari needs that).
    const previewOf = (id) => api(`/api/target/${encodeURIComponent(id)}?finish=1`);
    const prepare = (id) =>
        api("/api/finish-prepare", { id }).catch((err) => {
            if (err.status === 409) {
                return { error: err.message };
            }
            throw err;
        });

    /**
     * Opens the summary sheet for one change or for several (Finish all).
     * @param {string[]} ids the changes
     * @param {string} [notice] why the last try did not start
     */
    app.finishSheet = async (ids, notice = "") => {
        let items;
        try {
            items = await Promise.all(ids.map((id) => previewOf(id).then((t) => ({ id, t }))));
            items[0].prepared = await prepare(ids[0]);
        } catch (err) {
            app.say(`Finish not started: ${err.message}`, "err");
            return;
        }
        sheet = { list: ids, items };
        const d = /** @type {HTMLDialogElement} */ ($("dlg"));
        d.className = ids.length > 1 ? "finish many" : "finish";
        d.replaceChildren(
            ...[ids.length > 1 ? manyBody(items) : oneBody(items[0], notice), sheetFoot(items)]
                .flat(Infinity)
                .filter((k) => k !== null && k !== undefined && k !== false),
        );
        d.showModal();
        /** @type {HTMLElement} */ (d.querySelector('[data-act="finishgo"]')).focus();
        app.settle();
    };

    function oneBody({ id, t, prepared }, notice) {
        const f = t.finish;
        const c = app.change(id);
        const seed = t.pr === null;
        const rejects = f.notes.filter((x) => x.decision === "reject");
        const undecided = f.undecided.reduce((k, p) => k + p.undecided, 0);
        return [
            el("h3", {}, `Finish ${c?.label ?? id} ${c?.title ?? ""}`),
            notice ? el("p", { class: "c-failed" }, notice) : null,
            undecided > 0
                ? el(
                      "div",
                      { class: "warnbox" },
                      el(
                          "b",
                          {},
                          `${plural(undecided, "snapshot")} ${undecided === 1 ? "is" : "are"} still undecided; ${undecided === 1 ? "it" : "they"} will block the merge.`,
                      ),
                      id === app.openId ? [" ", control(app, "gofirst", { zone: "box" })] : null,
                  )
                : null,
            el("p", {}, el("b", {}, "Will commit:"), ` ${commitLine(t)}`),
            rejects.length > 0 || (!seed && f.acceptNotes > 0)
                ? [
                      toFile(t)
                          ? el("p", {}, el("b", {}, "Will write"), ` ${fileLine(t)}`)
                          : el("p", {}, el("b", {}, "Will post:"), ` ${postLine(t, c)}`),
                      rejects.length > 0
                          ? el(
                                "details",
                                {},
                                el("summary", { class: "small" }, "The reasons"),
                                el(
                                    "ul",
                                    { class: "small" },
                                    rejects.map((x) => el("li", {}, `${x.project}/${x.file}: ${x.note}`)),
                                ),
                            )
                          : null,
                  ]
                : null,
            toFile(t) ? null : el("p", {}, el("b", {}, "Will set:"), ` ${statusText(f)}.`),
            signsLine(t, prepared),
        ];
    }

    function commitLine(t) {
        const f = t.finish;
        // Under plain git the rejects file is committed too, so the line is the branch's even then.
        if (f.accepts + f.excludes === 0 && !(toFile(t) && f.rejects > 0)) {
            return f.rejects > 0 ? "nothing; only rejects are posted." : "nothing.";
        }
        const what = `${fmt(f.accepts)} accepted (${fmt(f.notOpened)} not opened), ${fmt(f.excludes)} excluded`;
        if (t.pr === null && !t.localBranch) {
            const branch = t.candidate
                ? `visual/approve-${t.candidate.commit.slice(0, 12)}`
                : `visual/seed-${new Date().toISOString().slice(0, 10)}`;
            return `${what}, to branch ${branch} as ${committer(t)}, and open its pull request.`;
        }
        return `${what}, to branch ${t.branch} as ${committer(t)}.`;
    }

    // A code host that cannot post (plain git): a local branch's rejects go to a file on it, and no
    // commit status is set.
    function toFile(t) {
        return t.localBranch === true && !hostCan(app.list, "comment");
    }

    function fileLine(t) {
        const f = t.finish;
        const parts = [
            f.rejects > 0 ? plural(f.rejects, "reject") : null,
            f.acceptNotes > 0 ? plural(f.acceptNotes, "accept note") : null,
        ];
        return `${parts.filter(Boolean).join(" and ")} to ${rejectsFile(t.branch)} on the branch.`;
    }

    function postLine(t, c) {
        const f = t.finish;
        if (t.pr === null) {
            return `${plural(f.rejects, "reject")} as one issue.`;
        }
        const parts = [
            f.rejects > 0 ? plural(f.rejects, "reject") : null,
            f.acceptNotes > 0 ? plural(f.acceptNotes, "accept note") : null,
        ];
        return `${parts.filter(Boolean).join(" and ")} as one comment on ${c?.label ?? `#${t.pr}`}.`;
    }

    // Signs with: the passkey that signs, why nothing is signed, or that nothing is protected yet.
    // Finish all names the passkeys of this host: each change's preparation comes at its turn.
    function signsLine(t, prepared, many = false) {
        const line = (...text) => el("p", {}, el("b", {}, "Signs with:"), ...text);
        const keys = t.passkey?.keys ?? [];
        if (prepared?.error && !many) {
            return el(
                "p",
                { class: "c-failed" },
                el("b", {}, "Signs with:"),
                ` nothing: Finish cannot be approved now: ${prepared.error}`,
            );
        }
        if (keys.length === 0) {
            return line(" Not yet protected: no passkey registered. ", control(app, "finishregister", { zone: "box" }));
        }
        if (many || prepared?.required) {
            const names = keys
                .filter((k) => (many ? k.rpId === t.passkey.rpId : prepared.allowCredentials.includes(k.id)))
                .map((k) => `'${k.label}'`);
            return line(` Passkey ${names.join(" or ") || "registered here"}${many ? "." : ""}`);
        }
        if (prepared?.unsigned) {
            return line(
                ` nothing, because ${prepared.unsigned === "rejects" ? "something is rejected" : "snapshots are still undecided"}.`,
            );
        }
        return line(" nothing: a Finish of rejects alone signs nothing.");
    }

    function manyBody(items) {
        const none = items.filter((x) => x.t.finish.accepts + x.t.finish.excludes === 0).length;
        const keyed = registered(items[0].t) ? items.length - none : 0;
        const min = runMinutes(items.length);
        const free = registered(items[0].t) ? none : items.length;
        return [
            el("h3", {}, `Finish all ${items.length} decided changes`),
            el(
                "div",
                { class: "finlist" },
                items.map(({ id, t }) => {
                    const f = t.finish;
                    const c = app.change(id);
                    const und = f.undecided.reduce((k, p) => k + p.undecided, 0);
                    return el(
                        "div",
                        { class: "small" },
                        el("b", {}, `${c?.label ?? id} ${c?.title ?? ""}`),
                        el("br"),
                        `commit ${fmt(f.accepts)} accepted, ${fmt(f.excludes)} excluded` +
                            (f.rejects > 0
                                ? toFile(t)
                                    ? `; write ${plural(f.rejects, "reject")} to ${rejectsFile(t.branch)}`
                                    : `; post ${plural(f.rejects, "reject")}`
                                : "") +
                            (toFile(t) ? "" : `; set "${f.status.description}"`),
                        und > 0 ? ["; ", el("b", {}, `${fmt(und)} undecided left`)] : null,
                        failed.has(id) ? "; retries the failed Finish" : null,
                    );
                }),
            ),
            el(
                "p",
                {},
                "This page runs them one after another; a failure stops only that change. Stop, on the section header, ends the run after the current change.",
            ),
            el(
                "p",
                { class: "warnbox" },
                el(
                    "b",
                    {},
                    `Stay on this page: about ${plural(min, "minute")}, ${plural(keyed, "passkey confirmation")}, one as each change's turn comes.`,
                ),
                free > 0
                    ? ` ${fmt(free)} need no passkey (${registered(items[0].t) ? "rejects only" : "no passkey registered"}) and run back to back.`
                    : null,
            ),
            signsLine(items[0].t, null, true),
        ];
    }

    function sheetFoot(items) {
        const t = items[0].t;
        return [
            t.startCommand
                ? el(
                      "details",
                      {},
                      el("summary", { class: "small" }, "Start this server from your own shell"),
                      el("pre", { class: "small" }, t.startCommand),
                  )
                : null,
            el(
                "div",
                { class: "foot" },
                control(app, "confirmcancel", { zone: "box" }),
                control(app, "finishgo", { zone: "box", attrs: { class: "primary" } }),
            ),
        ];
    }

    app.finishGoLabel = () => {
        if (!sheet) {
            return "Finish";
        }
        if (sheet.list.length > 1) {
            return `Finish all ${sheet.list.length}`;
        }
        return `${sheet.items[0].prepared?.required ? "Sign and finish" : "Finish"} ${label(sheet.list[0])}`;
    };
    app.finishGoOK = () =>
        sheet?.list.length === 1 && sheet.items[0].prepared?.error
            ? "Finish cannot be approved now: see the sheet"
            : true;

    // The sheet's final button: the passkey prompt starts inside this press, then the run.
    app.finishGo = () => {
        const s = sheet;
        sheet = null;
        const first = s.items[0];
        if (first.prepared?.required) {
            first.approval = approve(first.prepared);
            // Answered when its turn comes; a refusal before then is not unhandled.
            first.approval.catch(() => {});
        }
        /** @type {HTMLDialogElement} */ ($("dlg")).close();
        runAll(s.items);
    };

    // Go to the first undecided: the sheet closes and the first undecided snapshot is current.
    app.goFirstUndecided = () => {
        sheet = null;
        /** @type {HTMLDialogElement} */ ($("dlg")).close();
        const s = app.snaps.find((x) => !x.decision);
        if (s) {
            app.stepTo(s.key);
            app.focusList();
        }
    };

    // Register passkey... in the sheet: Settings opens in its place, and closing Settings opens the
    // sheet again, read anew.
    app.finishRegister = () => {
        const ids = sheet.list;
        sheet = null;
        const d = /** @type {HTMLDialogElement} */ ($("dlg"));
        d.addEventListener(
            "close",
            () => {
                app.settingsSheet();
                d.addEventListener("close", () => app.finishSheet(ids), { once: true });
            },
            { once: true },
        );
        d.close();
    };

    $("dlg").addEventListener("close", () => {
        sheet = null;
    });

    // ------------------------------------------------------------ the run

    // Runs each change in turn. A failure stops only its change; Stop ends the run after the
    // current one, the rest back in Decided, not finished.
    async function runAll(items) {
        if (items.length > 1) {
            run = { stop: false };
        }
        queue.push(...items.map((x) => x.id));
        failedClear(items);
        redraw();
        const byId = new Map(items.map((x) => [x.id, x]));
        while (queue.length > 0) {
            if (run?.stop) {
                const n = queue.length;
                queue.length = 0;
                app.say(`Finish all stopped. ${plural(n, "change")} returned to Decided, not finished.`);
                break;
            }
            const id = queue.shift();
            await finishOne(byId.get(id), queue.length);
        }
        run = null;
        redraw();
    }

    const failedClear = (items) => items.forEach((x) => failed.delete(x.id));

    async function finishOne(item, more) {
        const { id } = item;
        const after = more > 0 ? `; ${more} more after it` : "";
        running = { id, step: null, plan: null };
        redraw();
        try {
            const t = item.t;
            const prepared = item.prepared ?? (await prepare(id));
            if (prepared.error) {
                throw new Error(prepared.error);
            }
            const f = t.finish;
            const seed = t.pr === null;
            running.plan = {
                seed,
                commits: f.accepts + f.excludes > 0,
                posts: seed ? f.rejects > 0 : f.rejects + f.acceptNotes > 0,
                signed: prepared.required === true,
                file: toFile(t),
            };
            app.say(
                prepared.required
                    ? `Touch your passkey to sign ${label(id)}${after}. Stay on this page.`
                    : `Finishing ${label(id)}${after}.`,
                "",
                prepared.required && !item.approval ? [control(app, "signfinish", { zone: "msgline", ctx: { id } })] : [],
            );
            redraw();
            let approval = null;
            if (prepared.required) {
                try {
                    approval = await (item.approval ?? pressToSign(id, prepared));
                } catch (err) {
                    running = null;
                    app.say(
                        err?.name === "NotAllowedError" || err?.name === "AbortError"
                            ? "Passkey cancelled: nothing was changed."
                            : (passkeyWrongHost(t.passkey?.keys ?? []) ??
                                  `Passkey failed (${err?.message ?? err}): nothing was changed.`),
                        "err",
                    );
                    return;
                }
            }
            if (approval && prepared.signs === "record") {
                await api("/api/finish-prepare", { id, challenge: prepared.challenge, approval });
                approval = null;
            }
            let job;
            try {
                job = (
                    await api("/api/finish", {
                        id,
                        digest: f.digest,
                        ...(approval && { challenge: prepared.challenge, approval }),
                    })
                ).job;
            } catch (err) {
                if (err.status === 409 && /Decisions changed/.test(err.message) && run === null) {
                    // A decision changed in another tab: the sheet again, with the new counts.
                    running = null;
                    redraw();
                    await app.finishSheet([id], err.message);
                    return;
                }
                job = (await api("/api/finish-status").catch(() => null))?.job;
                if (!job?.running || job.target !== id) {
                    throw err;
                }
            }
            await follow(id, job);
        } catch (err) {
            fail(id, err.message, "not started");
        }
    }

    // A passkey prompt starts only inside a press (Safari refuses one without it), so a change
    // whose turn comes after the sheet's press waits for its own: Sign on the message line.
    function pressToSign(id, prepared) {
        return new Promise((resolve, reject) => {
            signing = {
                id,
                start: () => {
                    signing = null;
                    approve(prepared).then(resolve, reject);
                },
                cancel: () => {
                    signing = null;
                    reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
                },
            };
        });
    }
    app.signLabel = (id) => `Sign ${label(id)}`;
    app.signFinish = () => signing?.start();

    // Follows the job of change `id` to its end: a status ask a quarter second after the last
    // (an in-memory read on the server), two seconds after one that failed.
    async function follow(id, job) {
        running ??= { id, step: null, plan: null };
        let said = "";
        while (job?.running && job.target === id) {
            if (job.step !== running.step) {
                running.step = job.step;
                redraw();
            }
            const net = /\((retrying after a network error[^)]*)\)$/.exec(job.step ?? "")?.[1];
            if (net && net !== said) {
                app.say(`Finishing ${label(id)}: ${net}.`);
                said = net;
            }
            await pause(250);
            try {
                job = (await api("/api/finish-status")).job;
            } catch (err) {
                app.say(`Lost contact with the server (${err.message}); Finish goes on there. Retrying...`, "err");
                await pause(2000);
            }
        }
        if (!job || job.error || job.interrupted) {
            fail(
                id,
                job?.error ??
                    "the server restarted during it and kept no record: check the branch before finishing again",
                job?.error ? "check failed" : "server restarted",
            );
            return;
        }
        await succeed(id, job.result ?? {}, job.warnings ?? []);
    }

    function fail(id, why, fallback) {
        running = null;
        const at = failedAt(why, fallback);
        failed.set(id, { at, why });
        redraw();
        // The reason without the step it names, which the words before it say already.
        const reason = (FAILED_AT.some(([match]) => match.test(why)) ? why.replace(/^[^:]*: /, "") : why).replace(
            /^./,
            (x) => x.toUpperCase(),
        );
        app.say(`Finish of ${label(id)} failed: ${at}. ${reason.replace(/\.$/, "")}. Every decision is kept.`, "err", [
            control(app, "retryfinish", { zone: "msgline", ctx: { id } }),
        ]);
    }

    async function succeed(id, r, warnings) {
        const c = app.change(id);
        const repo = c?.url ? c.url.replace(/\/pull\/\d+$/, "") : null;
        // The comment holds the rejects and the accept notes; the server gives no address of its
        // own, so its link is the pull request it is on.
        const commented = c?.url && !r.issue && !r.commentError && (r.rejects > 0 || r.acceptNotes > 0);
        const links = [
            r.commit && repo ? { text: "Commit", href: `${repo}/commit/${r.commit}` } : null,
            commented ? { text: "Comment", href: c.url } : null,
            r.pullRequest ? { text: "Pull request", href: r.pullRequest } : null,
            r.issue ? { text: "Issue", href: r.issue } : null,
        ].filter(Boolean);
        const signed = running?.plan?.signed === true;
        // What went wrong after the push, in a few words for the row and in full for the message.
        const short = [r.commentError ? "comment not posted" : null, r.statusError ? "status not set" : null];
        const why = [
            r.commentError ? `The comment was not posted: ${r.commentError}.` : null,
            r.statusError ? `The commit status was not set: ${r.statusError}.` : null,
            ...warnings,
        ].filter(Boolean);
        const at = clock();
        done.set(id, {
            at,
            signed,
            links,
            short: andList(short.filter(Boolean)),
            why: why.length > 0 ? why.join(" ") : null,
        });
        running = null;
        await app.reload();
        if (app.openId === id) {
            await app.openChange(id, { snap: app.snap, quiet: true });
        }
        redraw();
        const linked = links.map((l) => l.text.toLowerCase());
        const said = [
            r.resigned
                ? `Signed the decisions of the earlier Finish of ${label(id)} at ${at}.`
                : r.alreadyFinished
                  ? `${label(id)} was already finished: an earlier Finish committed these decisions. Nothing was pushed or posted now.`
                  : `Finished ${label(id)} at ${at}${signed ? ", signed" : ""}.`,
            r.rejectsFile ? `The rejects are in ${r.rejectsFile} on the branch.` : null,
            ...why,
            linked.length > 0
                ? `${andList(linked).replace(/^./, (x) => x.toUpperCase())} ${linked.length === 1 ? "is" : "are"} linked on its row.`
                : null,
        ];
        app.say(said.filter(Boolean).join(" "), why.length > 0 ? "err" : "", [
            control(app, "nextchange", { zone: "msgline" }),
        ]);
    }

    /** Stop: the run ends after the change finishing now. */
    app.stopFinish = () => {
        if (run) {
            run.stop = true;
        }
        if (signing) {
            signing.cancel();
            return;
        }
        app.say("Stopping after the change that is finishing now.");
    };

    /**
     * Remove from the run: the change goes back to Decided, not finished.
     * @param {string} id the change
     */
    app.unqueue = (id) => {
        const at = queue.indexOf(id);
        if (at >= 0) {
            queue.splice(at, 1);
        }
        redraw();
        app.say(`${label(id)} taken out of the run.`);
    };

    /**
     * Picks up a Finish the server is running (one started before a reload, or on another tab) and
     * follows it to its end.
     * @param {any} job the server's newest job
     */
    app.resumeFinish = async (job) => {
        if (job?.kind !== "update" && job?.running && app.change(job.target)) {
            await follow(job.target, job);
        }
    };

    // ------------------------------------------------------------ the changes pane's controls

    /**
     * The Finish controls of a changes row.
     * @param {any} r the row
     * @returns {HTMLElement[]} its step list, links and buttons
     */
    app.finishControls = (r) => {
        const out = [];
        if (r.steps) {
            out.push(el("span", { class: "ell steps" }, r.steps));
        }
        if (r.state === "queued") {
            out.push(control(app, "unqueue", { zone: "rows", ctx: { id: r.id } }));
        } else if (r.state === "finishfailed") {
            out.push(control(app, "retryfinish", { zone: "rows", ctx: { id: r.id } }));
        } else if (r.section === "decided" && r.state !== "finishing") {
            out.push(control(app, "finishchg", { zone: "rows", ctx: { id: r.id } }));
        }
        for (const l of r.links ?? []) {
            out.push(el("a", { href: l.href, target: "_blank", rel: "noreferrer" }, l.text));
        }
        return out;
    };

    /**
     * The Decided, not finished header's control: Stop while Finish all runs, else Finish all N...
     * when more than one change can be finished.
     * @returns {HTMLElement | null} the control
     */
    app.finishAllControl = () => {
        if (run) {
            return control(app, "stopfinish", { zone: "rows", attrs: { class: "small" } });
        }
        return app.finishable().length > 1
            ? control(app, "finishall", { zone: "rows", attrs: { class: "small" } })
            : null;
    };

    /**
     * Finish in the top bar (and the end card's): the open change's summary sheet.
     * @returns {Promise<void>} once the sheet shows
     */
    app.finishOpen = () => app.finishSheet([app.openId]);
}
