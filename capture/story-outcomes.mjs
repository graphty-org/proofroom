/**
 * What a story-test capture's outcomes mean for the run: the loud lines for unstable and broken
 * stories, the verdict, and the promotion flag release promotion reads.
 *
 * Behind a switch that is off by default, VISUAL_REVIEW_BLOCKING=1. Off, the run is report-only,
 * as before: the lines are printed and the exit code is 0. On:
 * - a `failed` story (it threw, failed to render, or its wait never settled) fails the run;
 * - a story still `unstable` at the end of the run (its two shots disagreed, and again on its
 *   retry, or it was not retried) fails the run unless it is on the quarantine list; one that was
 *   unstable and settled on its retry is `[FLAKY]`: loud, but it passes, as a test that fails and
 *   then passes on its retry does;
 * - any picture that is not `unchanged` or `excluded` (changed, new, unseeded, moved, removed,
 *   unstable, failed) sets `promotion.blocked`: promotion waits for the owner.
 *
 * The quarantine list is `{ quarantine: [{ file, name, expires? }] }`: a story test's file
 * (repository-relative) and full name as its JUnit report gives them, and an optional ISO date
 * after which the entry no longer counts.
 */

const BLOCKING_ENV = "VISUAL_REVIEW_BLOCKING";

/** Statuses whose picture is exactly the approved one, so promotion need not wait for the owner. */
const APPROVED = new Set(["unchanged", "excluded"]);

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
 * The promotion flag: the pictures that are not exactly the approved baselines.
 * @param {{ items: object[] }} results the results
 * @param {boolean} blocking whether the blocking path is on
 * @returns {{ blocking: boolean, blocked: boolean, files: string[] }} `blocked` only when blocking
 */
export function promotion(results, blocking) {
    const files = results.items.filter((i) => !APPROVED.has(i.status)).map((i) => i.file);
    return { blocking, blocked: blocking && files.length > 0, files };
}

/**
 * The entries of a quarantine file that count today: well formed and not expired.
 * @param {unknown} parsed the file's parsed JSON
 * @param {string} [day] today, as an ISO date
 * @returns {{ file: string, name: string }[]} the entries
 * @throws {TypeError} when it is not `{ quarantine: [...] }`
 */
export function quarantineEntries(parsed, day = new Date().toISOString().slice(0, 10)) {
    const list = /** @type {{ quarantine?: unknown }} */ (parsed)?.quarantine;
    if (!Array.isArray(list)) {
        throw new TypeError("a quarantine file holds { quarantine: [{ file, name, expires? }] }");
    }
    return list.filter(
        (q) =>
            typeof q?.file === "string" &&
            typeof q?.name === "string" &&
            (q.expires === undefined || (typeof q.expires === "string" && q.expires >= day)),
    );
}

/**
 * Whether an item's story test is on the quarantine list.
 * @param {{ test?: { file: string, name: string } }} item the item
 * @param {{ file: string, name: string }[]} list quarantineEntries()
 * @returns {boolean} whether it is quarantined
 */
const isQuarantined = (item, list) =>
    !!item.test && list.some((q) => q.file === item.test.file && q.name === item.test.name);

/**
 * The run's verdict and its loud lines.
 * @param {{ project: string, items: object[], promotion?: object }} results the merged (or partial)
 *     results; their `promotion` when mergeResults() set it
 * @param {{ blocking: boolean, quarantine?: { file: string, name: string }[], gh?: boolean }} o the
 *     switch, quarantineEntries(), and whether to write GitHub Actions annotations
 * @returns {{ code: number, lines: string[], promotion: object }} exit code 1 only when blocking
 *     and a story is broken or still unstable and not quarantined
 */
export function storyVerdict(results, { blocking, quarantine = [], gh = false }) {
    const { project, items } = results;
    const lines = [];
    let failing = 0;
    const say = (line, fails) => {
        failing += fails ? 1 : 0;
        const level = fails ? "error" : "warning";
        lines.push(gh ? `::${level}::${line}` : `visual-review: ${line}`);
    };
    for (const item of items) {
        if (item.status === "unstable") {
            say(unstableLine(project, item), false);
            if (isQuarantined(item, quarantine)) {
                say(`[QUARANTINED] ${project}: ${item.file} is quarantined, so it does not fail the run`, false);
            } else if (blocking) {
                say(`[UNSTABLE] ${project}: ${item.file} is still unstable after its retry and not quarantined`, true);
            }
        } else if (item.unstableFirst && item.status !== "failed") {
            say(unstableLine(project, item), false);
            say(`[FLAKY] ${project}: ${item.file} settled on its retry, so it does not fail the run`, false);
        }
        if (item.status === "failed") {
            const why = String(item.reason ?? "failed").split("\n")[0];
            say(`[BROKEN] ${project}: ${item.file}: ${why}${blocking ? "" : " (report only)"}`, blocking);
        }
    }
    const p = results.promotion ?? promotion(results, blocking);
    if (p.blocked) {
        say(`[PROMOTION] ${project}: ${p.files.length} picture(s) wait for the owner's approval`, false);
    }
    return { code: failing > 0 ? 1 : 0, lines, promotion: p };
}
