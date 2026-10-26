/**
 * The comparison results as a JUnit XML file, the test report CI systems and flaky-test tools read.
 *
 * One <testsuite> per project, one <testcase> per snapshot (named by its file without ".png", with
 * the project as its classname). The pass rule is result-line.mjs's `outcome()`: a failure carries
 * the status as its type, a story that could not be shot is an <error> with its console, and an
 * excluded story is <skipped>. A snapshot's earlier attempts in the same run are written inside its
 * test case as <flakyFailure> / <flakyError> when the last attempt passed and <rerunFailure> /
 * <rerunError> when it did not, the Maven Surefire convention; the tool itself calls nothing flaky.
 */

import { itemsFromLines, outcome } from "./result-line.mjs";

// Whether XML 1.0 can hold a character at all, even escaped: not the C0 controls but tab, newline
// and carriage return, not a lone surrogate, not U+FFFE or U+FFFF. A console line can hold any of
// them (ANSI colors).
export const xmlChar = (c) =>
    c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c < 0xd800) || (c > 0xdfff && c < 0xfffe) || c > 0xffff;
const PLAIN = /^[\t\n\r\x20-\x7e]*$/;
// Line breaks and tabs are escaped in an attribute only, where a parser would turn them into spaces.
const ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
    "\t": "&#9;",
    "\n": "&#10;",
    "\r": "&#13;",
};

/**
 * Text made safe for an XML attribute or element.
 * @param {string} text any text
 * @param {boolean} [inAttribute] whether it goes in an attribute
 * @returns {string} the text, escaped, with the characters XML cannot hold dropped
 */
export function escapeXml(text, inAttribute = false) {
    let s = String(text);
    // Printable ASCII and line breaks, nearly every name and message, need no character check.
    if (!PLAIN.test(s)) {
        s = [...s].filter((ch) => xmlChar(ch.codePointAt(0))).join("");
    }
    return s.replace(inAttribute ? /[&<>"'\t\n\r]/g : /[&<>"']/g, (c) => ESCAPES[c]);
}

const attrs = (map) =>
    Object.entries(map)
        .map(([k, v]) => ` ${k}="${escapeXml(v, true)}"`)
        .join("");

/**
 * One earlier attempt, as the element its kind and the snapshot's final result call for.
 * @param {object} attempt an earlier attempt of the snapshot
 * @param {boolean} finallyPassed whether the snapshot's last attempt passed
 * @returns {string} the element, or "" for an attempt that passed
 */
function attemptXml(attempt, finallyPassed) {
    const { result, type, message } = outcome(attempt);
    if (result === "passed" || result === "skipped") {
        return "";
    }
    const name = `${finallyPassed ? "flaky" : "rerun"}${result === "error" ? "Error" : "Failure"}`;
    const out = attempt.console.length > 0 ? `<system-out>${escapeXml(attempt.console.join("\n"))}</system-out>` : "";
    return `      <${name}${attrs({ message, type })}>${out}</${name}>\n`;
}

/**
 * One snapshot's test case.
 * @param {string} project the project it belongs to
 * @param {object} item its results.json item
 * @returns {{ xml: string, result: string }} the element and its result
 */
function testcase(project, item) {
    const { result, type, message } = outcome(item);
    const name = item.file.replace(/\.png$/, "");
    const children = [];
    if (result === "failure") {
        children.push(`      <failure${attrs({ message, type })}/>\n`);
    } else if (result === "error") {
        children.push(`      <error${attrs({ message, type })}>${escapeXml(item.console.join("\n"))}</error>\n`);
    } else if (result === "skipped") {
        children.push(`      <skipped${attrs({ message })}/>\n`);
    }
    const finallyPassed = result === "passed" || result === "skipped";
    for (const attempt of item.attempts ?? []) {
        children.push(attemptXml(attempt, finallyPassed));
    }
    const open = `    <testcase${attrs({ name, classname: project, time: "0" })}`;
    const body = children.join("");
    return { xml: body === "" ? `${open}/>\n` : `${open}>\n${body}    </testcase>\n`, result };
}

const counts = (results) => ({
    tests: results.length,
    failures: results.filter((r) => r === "failure").length,
    errors: results.filter((r) => r === "error").length,
    skipped: results.filter((r) => r === "skipped").length,
    time: "0",
});

/**
 * The JUnit file for one or more projects' items.
 * @param {Map<string, object[]> | [string, object[]][]} projects each project's items, in order
 * @returns {string} the XML document
 */
export function junitXml(projects) {
    const all = [];
    const suites = [...projects].map(([project, items]) => {
        const cases = items.map((item) => testcase(project, item));
        const results = cases.map((c) => c.result);
        all.push(...results);
        return `  <testsuite${attrs({ name: project, ...counts(results) })}>\n${cases.map((c) => c.xml).join("")}  </testsuite>\n`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites${attrs({ name: "proofroom", ...counts(all) })}>\n${suites.join("")}</testsuites>\n`;
}

/**
 * The JUnit file for one capture set.
 * @param {{ project: string, items: object[] }} results a valid, parsed results.json
 * @returns {string} the XML document
 */
export const junitFromResults = (results) => junitXml([[results.project, results.items]]);

/**
 * The JUnit file for result lines: the last attempt of each snapshot is its result, the earlier
 * ones its attempts.
 * @param {object[]} lines valid result lines
 * @returns {string} the XML document
 */
export const junitFromLines = (lines) => junitXml(itemsFromLines(lines));
