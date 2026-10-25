/**
 * What a story-test capture's outcomes mean for the run: the loud lines for unstable and broken
 * stories, the verdict, and the promotion flag release promotion reads.
 *
 * Behind a switch that is off by default, VISUAL_REVIEW_BLOCKING=1. Off, the run is report-only,
 * as before: the lines are printed and the exit code is 0. On:
 * - a `failed` story (it threw, failed to render, or its wait never settled) fails the run;
 * - a story that was `unstable` (two shots disagreed, now or before its retry) and is not on the
 *   quarantine list fails the run as `[NEW-FLAKY]`; a quarantined one passes loudly;
 * - a changed, new or removed picture sets `promotion.blocked`: promotion waits for the owner.
 */

const BLOCKING_ENV = "VISUAL_REVIEW_BLOCKING";

/** Statuses whose picture differs from the approved baselines tree, so the owner must approve it. */
const NEEDS_APPROVAL = new Set(["changed", "new", "removed"]);

/**
 * Whether the blocking path is on.
 * @param {Record<string, string | undefined>} [env] the environment
 * @returns {boolean} true only for `VISUAL_REVIEW_BLOCKING=1`
 */
export const blockingOn = (env = process.env) => env[BLOCKING_ENV] === "1";

/**
 * The loud line for a story whose two shots disagreed.
 * @param {string} project the project
 * @param {{ file: string }} item the item
 * @returns {string} the line
 */
export const unstableLine = (project, item) =>
    `[UNSTABLE] ${project}: ${item.file} drew two different pictures on the same inputs`;

/**
 * The promotion flag: the pictures that differ from the approved baselines.
 * @param {{ items: object[] }} results the results
 * @param {boolean} blocking whether the blocking path is on
 * @returns {{ blocking: boolean, blocked: boolean, files: string[] }} `blocked` only when blocking
 */
export function promotion(results, blocking) {
    const files = results.items.filter((i) => NEEDS_APPROVAL.has(i.status)).map((i) => i.file);
    return { blocking, blocked: blocking && files.length > 0, files };
}

/**
 * Whether an item's story test is on the quarantine list (tools/test-quarantine.json's entries,
 * `{ file, name }` of the test as its JUnit report names it).
 * @param {{ test?: { file: string, name: string } }} item the item
 * @param {{ file: string, name: string }[]} list the quarantine list
 * @returns {boolean} whether it is quarantined
 */
const isQuarantined = (item, list) =>
    !!item.test && list.some((q) => q.file === item.test.file && q.name === item.test.name);

/**
 * The run's verdict and its loud lines.
 * @param {{ project: string, items: object[] }} results the merged (or partial) results
 * @param {{ blocking: boolean, quarantine?: { file: string, name: string }[], gh?: boolean }} o the
 *     switch, the quarantine list, and whether to write GitHub Actions annotations
 * @returns {{ code: number, lines: string[], promotion: object }} exit code 1 only when blocking
 *     and a story is broken or newly unstable
 */
export function storyVerdict(results, { blocking, quarantine = [], gh = false }) {
    const { project, items } = results;
    const lines = [];
    let failing = 0;
    const say = (line, fails) => {
        failing += fails ? 1 : 0;
        lines.push(gh ? `::${fails ? "error" : "warning"}::${line}` : `visual-review: ${line}`);
    };
    for (const item of items) {
        if (item.status === "unstable" || item.unstableFirst) {
            say(unstableLine(project, item), false);
            if (isQuarantined(item, quarantine)) {
                say(`[QUARANTINED] ${project}: ${item.file} is quarantined, so it does not fail the run`, false);
            } else if (blocking) {
                say(`[NEW-FLAKY] ${project}: ${item.file} is unstable and not quarantined`, true);
            }
        }
        if (item.status === "failed") {
            const why = String(item.reason ?? "failed").split("\n")[0];
            say(`[BROKEN] ${project}: ${item.file}: ${why}${blocking ? "" : " (report only)"}`, blocking);
        }
    }
    const p = promotion(results, blocking);
    if (p.blocked) {
        say(`[PROMOTION] ${project}: ${p.files.length} changed picture(s) wait for the owner's approval`, false);
    }
    return { code: failing > 0 ? 1 : 0, lines, promotion: p };
}
