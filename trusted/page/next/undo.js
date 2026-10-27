/*
 * Decisions on their way to the server, and Undo (design 6.5). Every decision, single or bulk, is
 * a list of changes `{ s, to, model }`: the snapshot, what the server stores for it (a decision or
 * null), and what the page shows after (by default `to`). One change is one POST /api/decide; more
 * are one POST /api/accept-all per project (and per decision and reason), never one per snapshot.
 * A failed project leaves its snapshots as they were and is named, with the error.
 *
 * Undo [U] takes back the last step, single or bulk, in one step. A step is the changes as they
 * were applied, each with the decision it replaced; undoing sends the reverse. An accept that was
 * approved before is derived by the server, never stored: undoing a reject that replaced it
 * deletes the reject, and the server's approved before shows again.
 */

import { api } from "./api.js";
import { setDecision, updateHeads, updateRow } from "./list.js";

const sig = (to) => (to === null ? "" : `${to.decision}\n${to.reason ?? ""}`);

// The loaded run, as the routes take it: the decisions are checked against the capture shown.
function runFields(app) {
    if (!app.loadedRun) {
        return {};
    }
    const at = app.loadedRun.lastIndexOf("-");
    const runId = Number(app.loadedRun.slice(0, at));
    const runAttempt = Number(app.loadedRun.slice(at + 1));
    return { run: app.loadedRun, runId, runAttempt };
}

/**
 * Sends changes to the server: one /api/decide for one change, else one /api/accept-all per
 * project (and per decision and reason within it).
 * @param {any} app the page
 * @param {{ s: any, to: object | null }[]} changes the changes
 * @returns {Promise<{ done: any[], failed: { project: string, error: string, changes: any[] }[],
 *     unpublished: number | null }>} the changes the server applied, the projects that failed, and the
 *     server's count of decisions the next Finish publishes
 */
export async function send(app, changes) {
    const done = [];
    const failed = [];
    let unpublished = null;
    // A bulk accept of one snapshot still goes as a bulk accept, so the server marks it not opened.
    if (changes.length === 1 && !changes[0].to?.bulk) {
        const [c] = changes;
        try {
            const answer = await api("/api/decide", {
                id: app.openId,
                project: c.s.project,
                file: c.s.file,
                decision: c.to?.decision ?? null,
                reason: c.to?.reason ?? null,
                ...(c.to && { hash: c.s.capture ?? c.s.baseline ?? null }),
                ...runFields(app),
            });
            unpublished = answer.unpublished ?? null;
            done.push(c);
        } catch (err) {
            failed.push({ project: c.s.project, error: err.message, changes });
        }
        return { done, failed, unpublished };
    }
    const batches = new Map();
    for (const c of changes) {
        const k = `${c.s.project}\n${sig(c.to)}`;
        batches.set(k, [...(batches.get(k) ?? []), c]);
    }
    for (const batch of batches.values()) {
        const { project } = batch[0].s;
        const to = batch[0].to;
        try {
            const answer = await api("/api/accept-all", {
                id: app.openId,
                project,
                decision: to?.decision ?? null,
                ...(to && to.decision !== "accept" && { reason: to.reason }),
                files: batch.map((c) => c.s.file),
                ...runFields(app),
            });
            const files = new Set(answer.files ?? []);
            done.push(...batch.filter((c) => files.has(c.s.file)));
            unpublished = answer.unpublished ?? unpublished;
        } catch (err) {
            failed.push({ project, error: err.message, changes: batch });
        }
    }
    return { done, failed, unpublished };
}

/**
 * Shows applied changes: each row's decision, its row element and its group's header replaced in
 * place, the change's counts, and the rest of the page drawn again. A row a decision leaves stays
 * shown whatever Show says (it never disappears under the reader).
 * @param {any} app the page
 * @param {any[]} done the changes the server applied
 * @param {number | null} unpublished the server's count for the next Finish
 */
export function shown(app, done, unpublished) {
    const t = app.list?.targets?.find((x) => x.id === app.openId);
    for (const c of done) {
        const was = Boolean(c.s.decision);
        const to = c.model === undefined ? c.to : c.model;
        setDecision(c.s, to);
        app.lv.keep.add(c.s.key);
        const p = t?.projects.find((x) => x.project === c.s.project);
        const d = Number(Boolean(to)) - Number(was);
        if (p && d !== 0) {
            p.decided += d;
            p.undecided -= d;
        }
        updateRow(app, c.s.key);
    }
    if (t && unpublished !== null) {
        t.unpublished = unpublished;
    }
    app.rebuild();
    updateHeads(app, new Set(done.map((c) => c.s.key)));
    app.draw();
}

/**
 * The undo stack, on the page.
 * @param {any} app the page
 */
export function installUndo(app) {
    const steps = [];
    app.undoSteps = () => steps.length;
    app.pushStep = (step) => steps.push(step);
    app.clearSteps = () => {
        steps.length = 0;
    };
    app.popStep = () => steps.pop() ?? null;
}

/**
 * The reverse of a step: each snapshot back to the decision it had. A decision the server derives
 * (approved before) or one an earlier Finish posted is not sent back: deleting what replaced it is
 * all the server can do, and what the page shows after is what the server then holds.
 * @param {any[]} step the changes applied
 * @returns {any[]} the reverse changes
 */
export function reverse(step) {
    return step.map((c) => {
        const prev = c.prev ?? null;
        const stored = prev && !prev.approvedBefore && !prev.posted ? stripped(prev) : null;
        return {
            s: c.s,
            prev: c.model === undefined ? c.to : c.model,
            to: stored,
            model: prev?.approvedBefore ? prev : stored,
        };
    });
}

// A decision as the routes take it back.
const stripped = (d) => ({ decision: d.decision, reason: d.reason ?? null, ...(d.bulk && { bulk: true }) });
