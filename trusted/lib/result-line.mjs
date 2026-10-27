/**
 * Result lines: one JSON line per snapshot per attempt, written the moment the snapshot is judged.
 *
 * A result line is a results.json item (the same fields, checked by the same code) plus `project`,
 * `attempt` (1 for the first shot of the snapshot in this run, 2 for the next) and `passed`.
 * `outcome()` is the one place the pass rule lives: the JUnit file, the result lines and every
 * other report of a snapshot's result read it from there.
 */

import { itemProblems, MAX_ATTEMPTS } from "./results.mjs";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * How one judged snapshot reports as a test result. A snapshot passes exactly when its capture is
 * the approved baseline (`unchanged`). Every other judged status is a failure typed by its status,
 * a story that could not be shot is an error with its reason, and an excluded story is skipped.
 * @param {{ status: string, from?: string | null, changedPixels?: number | null, reason?: string | null }} item
 *     an item or an earlier attempt
 * @returns {{ result: "passed" | "failure" | "error" | "skipped", type: string, message: string }} the
 *     result, its type (the status) and a one-line message
 */
export function outcome(item) {
    const renamed = item.from ? ` (renamed from ${item.from})` : "";
    switch (item.status) {
        case "unchanged":
            return { result: "passed", type: "unchanged", message: `unchanged${renamed}` };
        case "excluded":
            return { result: "skipped", type: "excluded", message: item.reason ?? "excluded" };
        case "failed":
            return { result: "error", type: "failed", message: item.reason ?? "the story could not be captured" };
        case "moved":
            // Its image is approved only under the old name; the rename still needs an Accept.
            return { result: "failure", type: "moved", message: `moved from ${item.from}` };
        case "changed": {
            const pixels = item.changedPixels == null ? "" : `: ${item.changedPixels} pixels differ`;
            return { result: "failure", type: "changed", message: `changed${pixels}${renamed}` };
        }
        case "new":
            return { result: "failure", type: "new", message: "new: no baseline" };
        case "unseeded":
            return { result: "failure", type: "unseeded", message: "no baseline yet" };
        case "removed":
            return { result: "failure", type: "removed", message: "removed: a baseline no story drew" };
        default:
            // `unstable`, from captures made before one shot per snapshot.
            return { result: "failure", type: item.status, message: item.status };
    }
}

/**
 * Whether a snapshot did not fail: it passed, or it was excluded (skipped).
 * @param {{ status: string }} item an item or an earlier attempt
 * @returns {boolean} false for a failure or an error
 */
export const passed = (item) => ["passed", "skipped"].includes(outcome(item).result);

/**
 * The result line for one attempt of a snapshot.
 * @param {object} item the results.json item the attempt was judged
 * @param {{ project: string, attempt: number }} where its project and attempt number
 * @returns {object} the line, ready for JSON.stringify
 */
export const resultLine = (item, { project, attempt }) => ({ ...item, project, attempt, passed: passed(item) });

/**
 * Checks a parsed result line.
 * @param {any} line the parsed JSON, untrusted
 * @returns {string[]} one message per problem; empty when the line is valid
 */
export function validateResultLine(line) {
    const errors = itemProblems(line, "line");
    if (errors[0] === "line must be an object") {
        return errors;
    }
    if (typeof line.project !== "string" || !NAME.test(line.project)) {
        errors.push("line.project must be a lowercase name");
    }
    if (!Number.isInteger(line.attempt) || line.attempt < 1) {
        errors.push("line.attempt must be a positive integer");
    }
    if (typeof line.passed !== "boolean") {
        errors.push("line.passed must be a boolean");
    } else if (errors.length === 0 && line.passed !== passed(line)) {
        errors.push(`line.passed must be ${passed(line)} for a ${line.status} item`);
    }
    return errors;
}

/**
 * Reads result lines from text, one JSON object per line; blank lines are ignored.
 * @param {string} text the contents of a result-line file
 * @returns {object[]} the lines, each valid
 * @throws {Error} naming the first bad line's number and its problems
 */
export function parseResultLines(text) {
    const lines = [];
    text.split("\n").forEach((raw, i) => {
        if (raw.trim() === "") {
            return;
        }
        let line;
        try {
            line = JSON.parse(raw);
        } catch {
            throw new Error(`result line ${i + 1} is not JSON`);
        }
        const problems = validateResultLine(line);
        if (problems.length > 0) {
            throw new Error(`result line ${i + 1}: ${problems.join("; ")}`);
        }
        lines.push(line);
    });
    return lines;
}

/**
 * The earlier attempt a result line becomes once a later attempt of its snapshot exists.
 * @param {object} line a result line
 * @returns {{ status: string, capture: string | null, from?: string | null, changedPixels: number | null,
 *     reason: string | null, console: string[] }} the attempt as results.json holds it
 */
export function attemptOf(line) {
    const { status, capture, from, changedPixels, reason, console } = line;
    return { status, capture, ...(from !== undefined && { from }), changedPixels, reason, console };
}

/**
 * What is wrong with one snapshot's attempts, if anything: too many, or not numbered 1 to n.
 * @param {object[]} tries its result lines, sorted by attempt
 * @returns {string | null} the problem
 */
export function attemptsProblem(tries) {
    const where = `${tries[0].project}/${tries[0].file}`;
    if (tries.length > MAX_ATTEMPTS + 1) {
        return `${where} has ${tries.length} attempts; at most ${MAX_ATTEMPTS + 1} are allowed`;
    }
    if (tries.some((t, i) => t.attempt !== i + 1)) {
        return `${where} has attempts ${tries.map((x) => x.attempt).join(", ")}; they must be 1 to ${tries.length}`;
    }
    return null;
}

/**
 * Groups result lines into results.json items, per project: the last attempt of each snapshot is
 * its item, and the earlier ones its `attempts`.
 * @param {object[]} lines valid result lines, in any order
 * @returns {Map<string, object[]>} each project's items, sorted by file, the projects by name
 */
export function itemsFromLines(lines) {
    const bySnapshot = new Map();
    for (const line of lines) {
        const key = `${line.project}\u0000${line.file}`;
        bySnapshot.set(key, [...(bySnapshot.get(key) ?? []), line]);
    }
    const projects = new Map();
    for (const tries of bySnapshot.values()) {
        tries.sort((a, b) => a.attempt - b.attempt);
        const problem = attemptsProblem(tries);
        if (problem) {
            throw new Error(problem);
        }
        const { project, ...item } = tries.at(-1);
        delete item.attempt;
        delete item.passed;
        if (tries.length > 1) {
            item.attempts = tries.slice(0, -1).map(attemptOf);
        }
        projects.set(project, [...(projects.get(project) ?? []), item]);
    }
    for (const items of projects.values()) {
        items.sort((a, b) => (a.file < b.file ? -1 : 1));
    }
    return new Map([...projects].sort(([a], [b]) => (a < b ? -1 : 1)));
}
