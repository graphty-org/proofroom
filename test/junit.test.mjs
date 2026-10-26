import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { junitFromLines, junitFromResults, xmlChar } from "../trusted/lib/junit.mjs";
import { resultLine } from "../trusted/lib/result-line.mjs";
import { validateResults } from "../trusted/lib/results.mjs";
import { tempDir } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../trusted/cli.mjs", import.meta.url));

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// One item per status, as capture and compare write them.
const BY_STATUS = {
    unchanged: { baseline: HASH_A, capture: HASH_A, changedPixels: 0 },
    moved: { baseline: HASH_A, capture: HASH_A, from: "old--story" },
    changed: { baseline: HASH_A, capture: HASH_B, changedPixels: 412 },
    new: { baseline: null, capture: HASH_B },
    unseeded: { baseline: null, capture: HASH_B },
    removed: { baseline: HASH_A, capture: null },
    unstable: { baseline: HASH_A, capture: HASH_B },
    failed: { baseline: null, capture: null, reason: "the story threw", console: ["Error: boom", "at play"] },
    excluded: { baseline: null, capture: null, reason: "excluded by the story's parameters" },
};

function item(id, status, overrides = {}) {
    return {
        id,
        mode: null,
        file: `${id}.png`,
        status,
        flaky: false,
        size: [1200, 900],
        baselineSize: [1200, 900],
        changedPixels: null,
        bbox: null,
        threshold: 0.063,
        includeAA: false,
        reason: null,
        console: [],
        ...BY_STATUS[status],
        ...overrides,
    };
}

function results(items, overrides = {}) {
    return {
        version: 1,
        project: "app",
        commit: "0123456789abcdef0123456789abcdef01234567",
        headSha: null,
        pr: null,
        runId: null,
        runAttempt: null,
        local: null,
        seeded: true,
        complete: true,
        expected: items.length,
        capturedAt: "2026-10-25T12:00:00Z",
        clock: {},
        environment: {},
        items,
        ...overrides,
    };
}

/*
 * A strict reader for the XML this package writes (no DTD, no CDATA, no comments), and the JUnit
 * schema the common tools read: Maven Surefire's test report (surefire-test-report-3.0.xsd, which
 * defines flakyFailure and rerunFailure) under the <testsuites> root that Jenkins, GitLab and the
 * GitHub test-report actions read.
 */
const ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;
const hasBadChar = (text) => [...text].some((ch) => !xmlChar(ch.codePointAt(0)));

function decode(text, where) {
    if (/&/.test(text.replace(ENTITY, "")) || text.includes("<")) {
        throw new Error(`unescaped & or < in ${where}`);
    }
    if (hasBadChar(text)) {
        throw new Error(`a character XML cannot hold in ${where}`);
    }
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return text.replace(ENTITY, (e) => {
        const body = e.slice(1, -1);
        if (body.startsWith("#x")) {
            return String.fromCodePoint(parseInt(body.slice(2), 16));
        }
        return body.startsWith("#") ? String.fromCodePoint(Number(body.slice(1))) : named[body];
    });
}

function parseXml(xml) {
    const prolog = '<?xml version="1.0" encoding="UTF-8"?>\n';
    expect(xml.startsWith(prolog)).toBe(true);
    const tag = /<(\/?)([A-Za-z][\w-]*)((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*(\/?)>/y;
    const attr = /\s+([A-Za-z][\w-]*)="([^"]*)"/g;
    const root = { name: "#root", children: [], text: "" };
    const stack = [root];
    let at = prolog.length;
    while (at < xml.length) {
        const next = xml.indexOf("<", at);
        const text = xml.slice(at, next === -1 ? undefined : next);
        stack.at(-1).text += decode(text, `text at ${at}`);
        if (next === -1) {
            break;
        }
        tag.lastIndex = next;
        const m = tag.exec(xml);
        if (!m) {
            throw new Error(`malformed tag at ${next}`);
        }
        const [, close, name, rawAttrs, selfClose] = m;
        if (close) {
            const open = stack.pop();
            if (open.name !== name || rawAttrs || selfClose) {
                throw new Error(`</${name}> closes <${open.name}>`);
            }
        } else {
            const attrs = {};
            for (const [, k, v] of rawAttrs.matchAll(attr)) {
                if (Object.hasOwn(attrs, k)) {
                    throw new Error(`attribute ${k} twice on <${name}>`);
                }
                attrs[k] = decode(v, `${name}@${k}`);
            }
            const el = { name, attrs, children: [], text: "" };
            stack.at(-1).children.push(el);
            if (!selfClose) {
                stack.push(el);
            }
        }
        at = tag.lastIndex;
    }
    if (stack.length !== 1 || root.children.length !== 1 || root.text.trim() !== "") {
        throw new Error("not one root element");
    }
    return root.children[0];
}

const ATTEMPT = {
    attrs: ["message", "type"],
    required: ["type"],
    children: ["stackTrace", "system-out", "system-err"],
};
const SCHEMA = {
    testsuites: {
        attrs: ["name", "tests", "failures", "errors", "skipped", "disabled", "time", "timestamp"],
        children: ["testsuite"],
    },
    testsuite: {
        attrs: [
            "name",
            "tests",
            "failures",
            "errors",
            "skipped",
            "time",
            "timestamp",
            "hostname",
            "id",
            "package",
            "group",
        ],
        required: ["name", "tests", "failures", "errors"],
        children: ["properties", "testcase", "system-out", "system-err"],
    },
    testcase: {
        attrs: ["name", "classname", "time", "group"],
        required: ["name"],
        children: [
            "failure",
            "error",
            "skipped",
            "flakyFailure",
            "flakyError",
            "rerunFailure",
            "rerunError",
            "system-out",
            "system-err",
        ],
        text: false,
    },
    failure: { attrs: ["message", "type"], required: ["type"], children: [], text: true },
    error: { attrs: ["message", "type"], required: ["type"], children: [], text: true },
    skipped: { attrs: ["message"], children: [], text: true },
    flakyFailure: ATTEMPT,
    flakyError: ATTEMPT,
    rerunFailure: ATTEMPT,
    rerunError: ATTEMPT,
    stackTrace: { attrs: [], children: [], text: true },
    "system-out": { attrs: [], children: [], text: true },
    "system-err": { attrs: [], children: [], text: true },
};
const COUNTS = ["tests", "failures", "errors", "skipped"];

function checkSchema(el) {
    const rule = SCHEMA[el.name];
    expect(rule, `<${el.name}> is not in the schema`).toBeDefined();
    for (const k of Object.keys(el.attrs)) {
        expect(rule.attrs, `<${el.name} ${k}>`).toContain(k);
    }
    for (const k of rule.required ?? []) {
        expect(el.attrs, `<${el.name}> needs ${k}`).toHaveProperty(k);
    }
    for (const k of COUNTS.filter((c) => c in el.attrs)) {
        expect(el.attrs[k]).toMatch(/^[0-9]+$/);
    }
    if ("time" in el.attrs) {
        expect(el.attrs.time).toMatch(/^[0-9]+(\.[0-9]+)?$/);
    }
    if (!rule.text) {
        expect(el.text.trim(), `text inside <${el.name}>`).toBe("");
    }
    for (const child of el.children) {
        expect(rule.children, `<${child.name}> inside <${el.name}>`).toContain(child.name);
        checkSchema(child);
    }
    if (el.name === "testcase") {
        const results = el.children.filter((c) => ["failure", "error", "skipped"].includes(c.name));
        expect(results.length).toBeLessThanOrEqual(1);
    }
    if (el.name === "testsuite" || el.name === "testsuites") {
        const cases = el.name === "testsuite" ? [el] : el.children;
        const all = cases.flatMap((s) => s.children.filter((c) => c.name === "testcase"));
        const count = (name) => all.filter((c) => c.children.some((r) => r.name === name)).length;
        expect(el.attrs.tests).toBe(String(all.length));
        expect(el.attrs.failures).toBe(String(count("failure")));
        expect(el.attrs.errors).toBe(String(count("error")));
        expect(el.attrs.skipped).toBe(String(count("skipped")));
    }
}

const cases = (doc) => doc.children.flatMap((s) => s.children.filter((c) => c.name === "testcase"));
const caseNamed = (doc, name) => cases(doc).find((c) => c.attrs.name === name);
const only = (testcase) => testcase.children.map((c) => ({ name: c.name, ...c.attrs }));

describe("junitFromResults", () => {
    const statuses = Object.keys(BY_STATUS);
    const r = results(statuses.map((s) => item(`story--${s}`, s)));
    const doc = parseXml(junitFromResults(r));

    it("is valid against the schema, with one test case per snapshot", () => {
        expect(validateResults(r)).toEqual([]);
        checkSchema(doc);
        expect(cases(doc).map((c) => [c.attrs.classname, c.attrs.name])).toEqual(
            statuses.map((s) => ["app", `story--${s}`]),
        );
    });

    it("passes exactly the snapshot whose capture is the approved baseline", () => {
        expect(only(caseNamed(doc, "story--unchanged"))).toEqual([]);
    });

    it("fails every other judged status with the status as its type", () => {
        expect(only(caseNamed(doc, "story--changed"))).toEqual([
            { name: "failure", message: "changed: 412 pixels differ", type: "changed" },
        ]);
        expect(only(caseNamed(doc, "story--moved"))).toEqual([
            { name: "failure", message: "moved from old--story", type: "moved" },
        ]);
        expect(only(caseNamed(doc, "story--new"))).toEqual([
            { name: "failure", message: "new: no baseline", type: "new" },
        ]);
        expect(only(caseNamed(doc, "story--unseeded"))).toEqual([
            { name: "failure", message: "no baseline yet", type: "unseeded" },
        ]);
        expect(only(caseNamed(doc, "story--removed"))).toEqual([
            { name: "failure", message: "removed: a baseline no story drew", type: "removed" },
        ]);
        expect(only(caseNamed(doc, "story--unstable"))).toEqual([
            { name: "failure", message: "unstable", type: "unstable" },
        ]);
    });

    it("reports a story that could not be shot as an error with its reason and console", () => {
        const failed = caseNamed(doc, "story--failed");
        expect(only(failed)).toEqual([{ name: "error", message: "the story threw", type: "failed" }]);
        expect(failed.children[0].text).toBe("Error: boom\nat play");
    });

    it("skips an excluded story", () => {
        expect(only(caseNamed(doc, "story--excluded"))).toEqual([
            { name: "skipped", message: "excluded by the story's parameters" },
        ]);
    });

    it("counts the results on the suite and on the root", () => {
        for (const el of [doc, doc.children[0]]) {
            expect(el.attrs).toMatchObject({ tests: "9", failures: "6", errors: "1", skipped: "1" });
        }
        expect(doc.children[0].attrs.name).toBe("app");
    });

    it("names a test case by its mode as well", () => {
        const withMode = results([item("story--a", "unchanged", { mode: "dark", file: "story--a.dark.png" })]);
        expect(cases(parseXml(junitFromResults(withMode)))[0].attrs.name).toBe("story--a.dark");
    });

    it("escapes what a reason or console holds, and drops what XML cannot hold", () => {
        const reason = `<b>"Tom" & 'Jerry'</b>\nline two`;
        const console = ['\u001b[31mred\u001b[0m <tag> & "q"', "nul \u0000 here"];
        const xml = junitFromResults(results([item("story--x", "failed", { reason, console })]));
        const error = caseNamed(parseXml(xml), "story--x").children[0];
        expect(error.attrs.message).toBe(reason);
        expect(error.text).toBe('[31mred[0m <tag> & "q"\nnul  here');
        expect(hasBadChar(xml)).toBe(false);
    });

    it("writes earlier attempts as flaky when the last passed and as reruns when it did not", () => {
        const changed = { status: "changed", capture: HASH_B, changedPixels: 9, reason: null, console: ["warn"] };
        const failed = { status: "failed", capture: null, changedPixels: null, reason: "timeout", console: [] };
        const r2 = results([
            item("story--flaky", "unchanged", { attempts: [changed, failed] }),
            item("story--rerun", "changed", { changedPixels: 9, attempts: [changed] }),
            item("story--mixed", "changed", { changedPixels: 9, attempts: [{ ...changed, status: "unchanged" }] }),
        ]);
        expect(validateResults(r2)).toEqual([]);
        const d = parseXml(junitFromResults(r2));
        checkSchema(d);
        expect(only(caseNamed(d, "story--flaky"))).toEqual([
            { name: "flakyFailure", message: "changed: 9 pixels differ", type: "changed" },
            { name: "flakyError", message: "timeout", type: "failed" },
        ]);
        expect(caseNamed(d, "story--flaky").children[0].children[0]).toMatchObject({
            name: "system-out",
            text: "warn",
        });
        expect(only(caseNamed(d, "story--rerun"))).toEqual([
            { name: "failure", message: "changed: 9 pixels differ", type: "changed" },
            { name: "rerunFailure", message: "changed: 9 pixels differ", type: "changed" },
        ]);
        // An earlier attempt that passed is not a failure of any kind.
        expect(only(caseNamed(d, "story--mixed"))).toEqual([
            { name: "failure", message: "changed: 9 pixels differ", type: "changed" },
        ]);
        expect(d.attrs).toMatchObject({ tests: "3", failures: "2", errors: "0", skipped: "0" });
    });

    it("writes a valid file for 3,000 snapshots", () => {
        const statuses3 = Object.keys(BY_STATUS);
        const items = Array.from({ length: 3000 }, (_, i) =>
            item(`story--s${String(i).padStart(4, "0")}`, statuses3[i % statuses3.length]),
        );
        const big = results(items);
        expect(validateResults(big)).toEqual([]);
        const d = parseXml(junitFromResults(big));
        checkSchema(d);
        expect(cases(d)).toHaveLength(3000);
    });
});

describe("junitFromLines", () => {
    it("equals the file made from the results.json of the same run", () => {
        const changed = { status: "changed", capture: HASH_B, changedPixels: 9, reason: null, console: [] };
        const r = results([
            item("story--a", "unchanged"),
            item("story--b", "changed", { changedPixels: 9, attempts: [changed] }),
            item("story--c", "unchanged", { attempts: [changed, changed] }),
            item("story--d", "removed"),
            item("story--e", "failed"),
            item("story--f", "moved"),
        ]);
        // The run's lines, as they would arrive: each attempt one line, the snapshots interleaved.
        const lines = [];
        for (const it2 of r.items) {
            const { attempts = [], ...last } = it2;
            attempts.forEach((a, n) => lines.push(resultLine({ ...last, ...a }, { project: "app", attempt: n + 1 })));
            lines.push(resultLine(last, { project: "app", attempt: attempts.length + 1 }));
        }
        lines.reverse();
        expect(junitFromLines(lines)).toBe(junitFromResults(r));
    });

    it("writes one suite per project, in name order", () => {
        const lines = [
            resultLine(item("story--a", "changed", { changedPixels: 1 }), { project: "web", attempt: 1 }),
            resultLine(item("story--a", "unchanged"), { project: "app", attempt: 1 }),
        ];
        const doc = parseXml(junitFromLines(lines));
        checkSchema(doc);
        expect(doc.children.map((s) => s.attrs.name)).toEqual(["app", "web"]);
        expect(doc.attrs).toMatchObject({ tests: "2", failures: "1" });
    });

    it("refuses a snapshot whose attempts repeat, skip a number or are too many", () => {
        const at = (attempt) =>
            resultLine(item("story--a", "changed", { changedPixels: 1 }), { project: "app", attempt });
        expect(() => junitFromLines([at(1), at(1)])).toThrow("app/story--a.png has attempts 1, 1; they must be 1 to 2");
        expect(() => junitFromLines([at(1), at(3)])).toThrow("app/story--a.png has attempts 1, 3");
        const many = Array.from({ length: 22 }, (_, i) => at(i + 1));
        expect(() => junitFromLines(many)).toThrow("app/story--a.png has 22 attempts; at most 21 are allowed");
        expect(() => junitFromLines(many.slice(0, 21))).not.toThrow();
    });
});

describe("proofroom junit", () => {
    const cli = (...args) => spawnSync(process.execPath, [CLI, "junit", ...args], { encoding: "utf8" });

    it("writes the JUnit file of a capture directory and exits 0 whatever the snapshots' results", () => {
        const dir = tempDir("vr-junit-");
        const r = results([item("story--a", "changed", { changedPixels: 3 }), item("story--b", "unchanged")]);
        writeFileSync(join(dir, "results.json"), JSON.stringify(r));
        const out = join(dir, "junit.xml");
        const run = cli("--results", dir, "--out", out);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        expect(readFileSync(out, "utf8")).toBe(junitFromResults(r));
    });

    it("exits 2 on a missing or invalid results.json, and without its options", () => {
        const dir = tempDir("vr-junit-");
        expect(cli("--results", dir, "--out", join(dir, "j.xml")).status).toBe(2);
        mkdirSync(join(dir, "bad"));
        writeFileSync(join(dir, "bad/results.json"), JSON.stringify(results([item("story--a", "approved")])));
        const bad = cli("--results", join(dir, "bad/results.json"), "--out", join(dir, "j.xml"));
        expect(bad.status).toBe(2);
        expect(bad.stderr).toMatch(/items\[0\]\.status must be one of/);
        expect(cli("--results", dir).status).toBe(2);
    });
});
