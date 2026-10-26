/*
 * The change statement itself (trusted/lib/change-approval.mjs): its shape, id and place, the
 * example statements of test/fixtures/approvals/ against the gate and the JSON Schema, and the
 * gate's counted work.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { canonical } from "../trusted/lib/approval.mjs";
import {
    changeApprovals,
    changeFolder,
    gitIn,
    statementId,
    statementPath,
    statementProblem,
} from "../trusted/lib/change-approval.mjs";
import { git } from "./helpers.mjs";
import {
    APPROVALS,
    BASELINES,
    CARD,
    KEY,
    REPO_ID,
    TOOLTIP,
    changeRepo,
    check,
    commit,
    entry,
    finish,
    hashAt,
    sign,
    statementOf,
} from "./change-statements.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const H = (c) => c.repeat(64);

/** The design's example statement (design 12.7), unsigned. */
const EXAMPLE = {
    version: 2,
    type: "change-approval",
    repository: "github:123456789",
    baselines: "visual-baselines",
    change: "pr:3486",
    capturedHead: "1".repeat(40),
    previous: null,
    approvedAt: "2026-10-25T14:02:11Z",
    entries: [
        { path: "app/button--primary.dark.png", from: H("a"), to: H("b"), decision: "accept" },
        { path: "app/old-id.png", from: H("c"), to: null, decision: "accept", movedTo: "app/new-id.png" },
        { path: "app/new-id.png", from: null, to: H("c"), decision: "accept", movedFrom: "app/old-id.png" },
        {
            path: "app/spinner--loading.json",
            from: null,
            to: H("d"),
            decision: "exclude",
            reason: "animation never settles",
        },
        {
            path: "app/empty.light.png",
            from: H("e"),
            to: H("f"),
            decision: "reject",
            reason: "the toolbar lost its border",
        },
    ],
};

const SCHEMA = JSON.parse(readFileSync(new URL("../docs/change-statement.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ allErrors: true }).compile(SCHEMA);

describe("the change statement", () => {
    it("has one id, the SHA-256 of its canonical JSON with the signature, and a place its content gives", () => {
        const signed = sign(EXAMPLE);
        expect(statementId(signed)).toBe(sha256(canonical(signed)));
        expect(statementId(signed)).not.toBe(statementId(EXAMPLE));
        // Key order and whitespace change nothing.
        const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(signed).reverse())));
        expect(statementId(reordered)).toBe(statementId(signed));
        expect(statementPath(APPROVALS, signed)).toBe(
            `${APPROVALS}/pr-3486/20261025T140211Z-${statementId(signed).slice(0, 12)}.json`,
        );
        expect(statementPath(APPROVALS, { ...signed, approvedAt: "2026-10-25T14:02:11.250Z" })).toMatch(
            /\/pr-3486\/20261025T140211Z-[0-9a-f]{12}\.json$/,
        );
        expect(changeFolder("branch:feat/x")).toBe("branch-feat-x");
        expect(changeFolder("mr:212")).toBe("mr-212");
    });

    it("accepts the design's example, signed or not, and the schema agrees", () => {
        expect(statementProblem(EXAMPLE)).toBe(null);
        expect(statementProblem(sign(EXAMPLE))).toBe(null);
        expect(validate(EXAMPLE)).toBe(true);
        expect(validate(sign(EXAMPLE))).toBe(true);
        expect(statementProblem({ ...EXAMPLE, previous: [H("1"), H("2")] })).toBe(null);
        expect(statementProblem({ ...EXAMPLE, entries: [] })).toBe(null);
    });

    it.each([
        ["a version 1 tree statement", { version: 1 }, "not a version 2 change-approval statement"],
        ["another type", { type: "tree-approval" }, "not a version 2 change-approval statement"],
        ["an unknown field", { note: "x" }, 'unknown field "note"'],
        ["no repository", { repository: "" }, "repository must be a non-empty string"],
        ["a change with no kind", { change: "3486" }, "change must be a change id"],
        ["a short capturedHead", { capturedHead: "abc123" }, "capturedHead must be a full commit hash"],
        ["a local time", { approvedAt: "2026-10-25T14:02:11+02:00" }, "approvedAt must be a UTC time"],
        ["previous as one id in an array", { previous: [H("1")] }, "previous must be null"],
        ["previous naming one id twice", { previous: [H("1"), H("1")] }, "previous must be null"],
        ["previous not a hash", { previous: "x" }, "previous must be null"],
        ["entries not an array", { entries: {} }, "entries must be an array"],
        ["an approval that is not an object", { approval: "x" }, "approval must be an object"],
        ["an unknown field in approval", { approval: { ...sign(EXAMPLE).approval, note: "x" } }, 'approval: unknown field "note"'],
        [
            "an approval with no signature",
            { approval: { ...sign(EXAMPLE).approval, signature: undefined } },
            "approval.signature must be base64url",
        ],
    ])("refuses %s", (_, change, problem) => {
        const s = { ...EXAMPLE, ...change };
        expect(statementProblem(s)).toContain(problem);
        expect(validate(s)).toBe(false);
    });

    it.each([
        ["a path outside the baselines", { path: "../x.png" }, "path must be a file inside the baselines directory"],
        ["an absolute path", { path: "/x.png" }, "path must be a file inside the baselines directory"],
        ["a review record", { path: "reviews/r.json" }, "not under reviews/"],
        ["a short hash", { from: "abc" }, "from must be a SHA-256 or null"],
        ["neither from nor to", { from: null, to: null }, "from and to are both null"],
        ["another decision", { decision: "approve" }, "decision must be accept, exclude or reject"],
        ["a reason that is not text", { reason: 3 }, "reason must be a string"],
        ["a movedTo outside the baselines", { movedTo: "../y.png" }, "movedTo must be a file inside"],
        ["an unknown field", { approvedBefore: true }, 'unknown field "approvedBefore"'],
    ])("refuses an entry with %s", (_, change, problem) => {
        const s = { ...EXAMPLE, entries: [{ ...EXAMPLE.entries[0], ...change }] };
        expect(statementProblem(s)).toContain(problem);
        expect(validate(s)).toBe(false);
    });

    it("refuses a file decided twice in one statement (which the schema cannot say)", () => {
        const s = { ...EXAMPLE, entries: [EXAMPLE.entries[0], { ...EXAMPLE.entries[0], decision: "reject" }] };
        expect(statementProblem(s)).toBe("entries[1]: app/button--primary.dark.png is decided twice");
    });
});

describe("the example statements (test/fixtures/approvals/)", () => {
    const dir = fileURLToPath(new URL("fixtures/approvals/", import.meta.url));
    const examples = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => [f, JSON.parse(readFileSync(`${dir}${f}`, "utf8"))]);

    it("cover passing and failing cases", () => {
        expect(examples.filter(([, x]) => x.expect === "pass").length).toBeGreaterThanOrEqual(5);
        expect(examples.filter(([, x]) => x.expect === "fail").length).toBeGreaterThanOrEqual(10);
    });

    it.each(examples)("%s passes or fails as marked, and validates against the schema when it should", (_, x) => {
        const r = changeRepo();
        commit(
            r,
            Object.fromEntries(Object.entries(x.head).map(([p, data]) => [`${BASELINES}/${p}`, data])),
            "the change",
        );
        const ids = [];
        const fill = (value) => {
            if (Array.isArray(value)) {
                return value.map(fill);
            }
            if (value !== null && typeof value === "object") {
                return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
            }
            if (typeof value !== "string") {
                return value;
            }
            const m = /^\{(\w+)(?::(.*))?\}$/.exec(value);
            if (!m) {
                return value;
            }
            const [, what, arg] = m;
            const at = { repository: () => REPO_ID, capturedHead: () => capturedHead };
            const by = {
                base: () => hashAt(r, "master", arg),
                head: () => hashAt(r, "pr", arg),
                hash: () => sha256(arg),
                id: () => ids[Number(arg)],
            };
            return arg === undefined ? at[what]() : by[what]();
        };
        const capturedHead = git(r.repo, "rev-parse", "pr");
        for (const raw of x.statements) {
            const { $unsigned, $file, ...rest } = raw;
            const done = finish(r, fill(rest), { key: $unsigned ? null : KEY, file: $file });
            ids.push(done.id);
            expect(validate(done.statement), `${done.file} against the schema`).toBe(x.schemaValid);
        }
        const problems = check(r);
        if (x.expect === "pass") {
            expect(problems).toEqual([]);
        } else {
            expect(problems.join("\n")).toContain(x.problem);
        }
    });
});

describe("the gate's work", () => {
    /**
     * A git runner that records each command's first word.
     * @param {string} cwd the repository
     * @returns {{ run: (args: string[], input?: string) => Buffer, calls: string[] }} it
     */
    const counting = (cwd) => {
        const real = gitIn(cwd);
        const calls = [];
        return { calls, run: (args, input) => (calls.push(args[0]), real(args, input)) };
    };
    const input = (r, git) => ({
        base: "master",
        head: "pr",
        baselines: BASELINES,
        approvals: APPROVALS,
        keys: [KEY.entry],
        repository: REPO_ID,
        changes: ["pr:7"],
        git,
    });

    it("is one diff, one log and one batch read, plus three commands per statement, however many files change", () => {
        const one = changeRepo();
        commit(one, { [`${BASELINES}/${CARD}`]: "new image" });
        finish(one, statementOf(one, [entry(one, CARD)]));
        const many = changeRepo();
        commit(many, {
            [`${BASELINES}/${CARD}`]: "new image",
            [`${BASELINES}/${TOOLTIP}`]: "another",
            [`${BASELINES}/compact-mantine/new--story.png`]: "a third",
        });
        finish(
            many,
            statementOf(many, [entry(many, CARD), entry(many, TOOLTIP), entry(many, "compact-mantine/new--story.png")]),
        );
        const expected = ["diff", "log", "cat-file", "cat-file", "merge-base", "merge-base"];
        for (const r of [one, many]) {
            const g = counting(r.repo);
            expect(changeApprovals(input(r, g.run)).coverage).toEqual([]);
            expect(g.calls).toEqual(expected);
        }
    });

    it("reads no history and no blob when the change adds no statement and alters no baseline", () => {
        const r = changeRepo();
        commit(r, { "src.txt": "code only" });
        const g = counting(r.repo);
        expect(changeApprovals(input(r, g.run))).toMatchObject({ coverage: [], statements: [], history: [] });
        expect(g.calls).toEqual(["diff"]);
    });

    it("never asks git for an LFS object: the hashes come from the pointers", () => {
        const r = changeRepo();
        commit(r, { [`${BASELINES}/${CARD}`]: "new image" });
        finish(r, statementOf(r, [entry(r, CARD)]));
        const real = gitIn(r.repo);
        const asked = [];
        const run = (args, stdin) => {
            const out = real(args, stdin);
            if (args[0] === "cat-file" && args[1] === "--batch") {
                asked.push(out.toString("latin1"));
            }
            return out;
        };
        expect(changeApprovals(input(r, run)).coverage).toEqual([]);
        expect(asked[0]).toContain(`oid sha256:${sha256("new image")}`);
        expect(asked[0]).not.toContain("new image\n");
    });
});
