/**
 * Change statements: the signed record of one Finish, and the gate's check that they approve every
 * baseline file a change alters (docs/approval-format.md has the contract this module enforces).
 *
 * A change statement names the repository, the baselines directory, the change (`pr:3486`), the
 * commit whose capture the reviewer saw (`capturedHead`), the change's previous statement and one
 * entry per decided file: its path under the baselines directory, the hash it replaces (`from`),
 * the hash it becomes (`to`) and the decision. It sits at
 * `<approvals>/<change>/<approvedAt>-<first 12 hex of its id>.json`, its id being the SHA-256 of
 * its canonical JSON, signature included. The passkey signs it as it signs every other record
 * (approval.mjs, unchanged).
 *
 * The gate's part (changeApprovals) runs a fixed number of git commands whatever the size of the
 * change: one diff of the baselines and approvals directories, one log of the approvals directory's
 * history, one batch read of the blobs it needs (the statements in that history among them), and three per statement of this change to place
 * its captured commit. No image is read: a baseline PNG is a Git LFS pointer naming its SHA-256.
 * Standard library only, so the gate runs from a checkout without an install.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { canonical, PASSKEYS_FILE, recordHash, verifyApproval } from "./approval.mjs";

export const STATEMENT_VERSION = 2;
export const STATEMENT_TYPE = "change-approval";
/** A seed statement: a change statement whose reviewer saw a capture of the default branch itself. */
export const SEED_TYPE = "seed-approval";
// A closed list: a statement of any other type is refused, never skipped.
const TYPES = [STATEMENT_TYPE, SEED_TYPE];

const FIELDS = new Set([
    "version",
    "type",
    "repository",
    "baselines",
    "change",
    "capturedHead",
    "previous",
    "approvedAt",
    "entries",
    "approval",
]);
const APPROVAL_FIELDS = ["credentialId", "authenticatorData", "clientDataJSON", "signature"];
const B64U = /^[A-Za-z0-9_-]+$/;
const ENTRY_FIELDS = new Set(["path", "from", "to", "decision", "reason", "movedTo", "movedFrom"]);
const DECISIONS = new Set(["accept", "exclude", "reject"]);
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CHANGE = /^[a-z][a-z0-9-]*:\S+$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;
// A path inside the baselines directory: relative, no "..", no backslashes, not a review record.
const PATH = /^(?!\/)(?!reviews\/)(?!.*(^|\/)\.\.?(\/|$))[^\\\0]+$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The SHA-256 of the file a blob stands for. Baseline PNGs are Git LFS pointers in git, and a
 * pointer names its object's SHA-256 (`oid sha256:<hex>`), which is the PNG's own hash, so no
 * LFS object is ever downloaded to check a record. Any other blob is hashed as it is.
 * @param {Buffer} bytes the blob
 * @returns {string} the hex SHA-256 of the content
 */
export function contentHash(bytes) {
    const text = bytes.subarray(0, 200).toString("latin1");
    const oid = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\n/.exec(text);
    return oid ? oid[1] : sha256(bytes);
}

/**
 * A statement's id: the SHA-256 of its canonical JSON, `approval` included.
 * @param {object} statement the statement
 * @returns {string} 64 hex digits
 */
export function statementId(statement) {
    return sha256(Buffer.from(canonical(statement), "utf8"));
}

/**
 * The folder of a change's statements: its id with ":" and "/" written as "-".
 * @param {string} change the change id, e.g. `pr:3486` or `branch:feat/x`
 * @returns {string} the folder name, e.g. `pr-3486`
 */
export const changeFolder = (change) => change.replace(/[:/]/g, "-");

/**
 * Where a statement belongs: `<approvals>/<change>/<approvedAt>-<first 12 hex of its id>.json`,
 * the time written as `20261025T140211Z`.
 * @param {string} approvals the approvals directory
 * @param {{ change: string, approvedAt: string }} statement a statement that passes statementProblem
 * @returns {string} the path, relative to the repository
 */
export function statementPath(approvals, statement) {
    const [, y, mo, d, h, mi, s] = TIME.exec(statement.approvedAt);
    const name = `${y}${mo}${d}T${h}${mi}${s}Z-${statementId(statement).slice(0, 12)}`;
    return `${approvals}/${changeFolder(statement.change)}/${name}.json`;
}

/**
 * Why a parsed document is not a well-formed change statement, or null when it is. Checks the
 * shape only (docs/change-statement.schema.json says the same); signature, place and history are
 * the gate's (changeApprovals).
 * @param {any} s the parsed document (untrusted)
 * @returns {string | null} why not, or null
 */
export function statementProblem(s) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
        return "not a JSON object";
    }
    if (s.version !== STATEMENT_VERSION || !TYPES.includes(s.type)) {
        return `not a version ${STATEMENT_VERSION} ${TYPES.join(" or ")} statement`;
    }
    const extra = Object.keys(s).find((k) => !FIELDS.has(k));
    if (extra !== undefined) {
        return `unknown field ${JSON.stringify(extra)}`;
    }
    for (const key of ["repository", "baselines"]) {
        if (typeof s[key] !== "string" || s[key] === "") {
            return `${key} must be a non-empty string`;
        }
    }
    if (typeof s.change !== "string" || !CHANGE.test(s.change)) {
        return "change must be a change id such as pr:3486 or branch:feat/x";
    }
    if (typeof s.capturedHead !== "string" || !COMMIT.test(s.capturedHead)) {
        return "capturedHead must be a full commit hash";
    }
    if (typeof s.approvedAt !== "string" || !TIME.test(s.approvedAt)) {
        return "approvedAt must be a UTC time such as 2026-10-25T14:02:11Z";
    }
    const why = previousProblem(s.previous);
    if (why) {
        return why;
    }
    if (!Array.isArray(s.entries)) {
        return "entries must be an array";
    }
    const seen = new Set();
    for (const [i, e] of s.entries.entries()) {
        const bad = entryProblem(e);
        if (bad) {
            return `entries[${i}]: ${bad}`;
        }
        if (seen.has(e.path)) {
            return `entries[${i}]: ${e.path} is decided twice`;
        }
        seen.add(e.path);
    }
    return s.approval === undefined ? null : approvalShapeProblem(s.approval);
}

function approvalShapeProblem(a) {
    if (typeof a !== "object" || a === null || Array.isArray(a)) {
        return "approval must be an object";
    }
    const extra = Object.keys(a).find((k) => !APPROVAL_FIELDS.includes(k));
    if (extra !== undefined) {
        return `approval: unknown field ${JSON.stringify(extra)}`;
    }
    const bad = APPROVAL_FIELDS.find((k) => typeof a[k] !== "string" || !B64U.test(a[k]));
    return bad === undefined ? null : `approval.${bad} must be base64url`;
}

function previousProblem(previous) {
    if (previous === null || (typeof previous === "string" && HASH.test(previous))) {
        return null;
    }
    const ok =
        Array.isArray(previous) &&
        previous.length >= 2 &&
        previous.every((p) => typeof p === "string" && HASH.test(p)) &&
        new Set(previous).size === previous.length;
    return ok ? null : "previous must be null, a statement id, or an array of two or more different ids";
}

function entryProblem(e) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
        return "not an object";
    }
    const extra = Object.keys(e).find((k) => !ENTRY_FIELDS.has(k));
    if (extra !== undefined) {
        return `unknown field ${JSON.stringify(extra)}`;
    }
    if (typeof e.path !== "string" || !PATH.test(e.path)) {
        return "path must be a file inside the baselines directory, relative and not under reviews/";
    }
    for (const key of ["from", "to"]) {
        if (e[key] !== null && !(typeof e[key] === "string" && HASH.test(e[key]))) {
            return `${key} must be a SHA-256 or null`;
        }
    }
    if (e.from === null && e.to === null) {
        return "from and to are both null";
    }
    if (!DECISIONS.has(e.decision)) {
        return "decision must be accept, exclude or reject";
    }
    if (e.reason !== undefined && typeof e.reason !== "string") {
        return "reason must be a string";
    }
    for (const key of ["movedTo", "movedFrom"]) {
        if (e[key] !== undefined && !(typeof e[key] === "string" && PATH.test(e[key]))) {
            return `${key} must be a file inside the baselines directory`;
        }
    }
    return null;
}

/**
 * Runs git in a repository.
 * @param {string} cwd the repository
 * @returns {(args: string[], input?: string) => Buffer} the runner
 */
export const gitIn = (cwd) => (args, input) =>
    execFileSync("git", args, { cwd, input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "ignore"] });

const succeeds = (git, args) => {
    try {
        git(args);
        return true;
    } catch {
        return false;
    }
};

/**
 * The blobs of a list of object ids, read with one `git cat-file --batch`.
 * @param {(args: string[], input?: string) => Buffer} git the runner
 * @param {string[]} ids blob ids
 * @returns {Map<string, Buffer>} the contents by id
 */
function readBlobs(git, ids) {
    const out = new Map();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) {
        return out;
    }
    const buf = git(["cat-file", "--batch"], `${wanted.join("\n")}\n`);
    let at = 0;
    for (const id of wanted) {
        const nl = buf.indexOf(10, at);
        const [, type, size] = buf.subarray(at, nl).toString("utf8").split(" ");
        at = nl + 1;
        if (type === "blob") {
            out.set(id, buf.subarray(at, at + Number(size)));
            at += Number(size) + 1;
        }
    }
    return out;
}

/**
 * Every file the change adds, modifies or deletes under the given directories, from one
 * `git diff --raw --no-renames`.
 * @param {(args: string[], input?: string) => Buffer} git the runner
 * @param {string} base the base
 * @param {string} head the head
 * @param {string[]} dirs the directories
 * @returns {{ path: string, status: string, from: string | null, to: string | null }[]} the files,
 *     with their blob ids at base and head (null when absent)
 */
function changedFiles(git, base, head, dirs) {
    const parts = git([
        "diff",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        base,
        head,
        "--",
        ...dirs.map((d) => `${d}/`),
    ])
        .toString("utf8")
        .split("\0");
    const files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const [, , oldId, newId, status] = parts[i].split(" ");
        const none = /^0+$/;
        files.push({
            path: parts[i + 1],
            status: status[0],
            from: none.test(oldId) ? null : oldId,
            to: none.test(newId) ? null : newId,
        });
    }
    return files;
}

/**
 * The gate's check of change statements on `head` against `base`.
 * @param {object} input what to check
 * @param {string} input.base the base, or a merge-queue batch's base
 * @param {string} input.head the merge result
 * @param {string} input.baselines the baselines directory (the base's config)
 * @param {string} input.approvals the approvals directory (the base's config)
 * @param {object[] | null} input.keys the base's keys; null while approvals are not enforced, so no
 *     signature is checked
 * @param {string | null} input.repository this repository's id (`github:<id>` or the base config's
 *     `repositoryId`); null when it has none, which no statement can then name
 * @param {string[]} input.changes the changes being gated (`pr:7`); statements of any other change
 *     are not counted
 * @param {(args: string[], input?: string) => Buffer} input.git the git runner (gitIn)
 * @returns {{ history: string[], statements: string[], treeFiles: string[], counted: number,
 *     own: object[], coverage: string[], notices: string[] }} what fails the append-only rule, the
 *     statements that fail their checks, the top-level files added under the approvals directory
 *     (tree statements), how many statements of these changes count and those statements (each
 *     with its `file`), what of the change is not approved by them (empty: every altered file
 *     is), and what the gate only reports
 */
export function changeApprovals({ base, head, baselines, approvals, keys, repository, changes, git }) {
    const out = { history: [], statements: [], treeFiles: [], counted: 0, own: [], coverage: [], notices: [] };
    const files = changedFiles(git, base, head, [baselines, approvals]);
    const under = (dir, f) => f.path.startsWith(`${dir}/`);
    const reviews = `${baselines}/reviews`;
    for (const f of files) {
        if (f.status !== "A" && (under(approvals, f) || under(reviews, f))) {
            const what = f.status === "D" ? "deleted" : "modified";
            out.history.push(`${f.path}: ${what}; approvals and review records on the base are history, never changed`);
        }
    }
    const altered = files.filter((f) => under(baselines, f) && !under(reviews, f) && f.from !== f.to);
    const added = files.filter((f) => f.status === "A" && under(approvals, f));
    const statementFiles = added.filter((f) => f.path.slice(approvals.length + 1).includes("/"));
    out.treeFiles = added.filter((f) => !statementFiles.includes(f)).map((f) => f.path);
    const history = statementFiles.length === 0 ? [] : historyOf(git, base, approvals);
    const blobs = readBlobs(git, [
        ...altered.flatMap((f) => [f.from, f.to]).filter(Boolean),
        ...statementFiles.map((f) => f.to),
        ...history,
    ]);
    const landed = new Set(history.map((id) => signedHash(blobs.get(id))).filter(Boolean));
    const mine = [];
    for (const f of statementFiles) {
        const checked = checkStatement(f.path, blobs.get(f.to), {
            base,
            head,
            baselines,
            approvals,
            keys,
            repository,
            changes,
            landed,
            git,
        });
        if (checked.problem) {
            out.statements.push(`${f.path}: ${checked.problem}`);
        } else if (checked.other) {
            out.notices.push(`${f.path} approves ${checked.statement.change}, not this change, so it is not counted`);
        } else {
            mine.push({ file: f.path, id: checked.id, ...checked.statement });
        }
    }
    out.counted = mine.length;
    out.own = mine;
    const hashOf = (id) => (id === null ? null : contentHash(blobs.get(id)));
    const d = altered.map((f) => ({ path: f.path.slice(baselines.length + 1), b: hashOf(f.from), h: hashOf(f.to) }));
    out.coverage = coverageProblems(d, mine, baselines);
    return out;
}

/**
 * Every blob a commit of the base's history ever wrote to a change statement's place (a file in a
 * folder under the approvals directory), from one `git log --raw`; `--full-history` keeps a
 * statement added and deleted on a merged branch.
 * @param {(args: string[], input?: string) => Buffer} git the runner
 * @param {string} base the base
 * @param {string} approvals the approvals directory
 * @returns {string[]} the blob ids
 */
function historyOf(git, base, approvals) {
    const parts = git([
        "log",
        "--format=",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        "--full-history",
        base,
        "--",
        `${approvals}/`,
    ])
        .toString("utf8")
        .split("\0");
    const ids = new Set();
    for (let i = 0; i + 1 < parts.length; i++) {
        const meta = parts[i].replace(/^\n+/, "");
        if (!meta.startsWith(":")) {
            continue;
        }
        const id = meta.split(" ")[3];
        const path = parts[++i];
        if (!/^0+$/.test(id) && path.slice(approvals.length + 1).includes("/")) {
            ids.add(id);
        }
    }
    return [...ids];
}

/**
 * The hash a statement's passkey signs (its canonical JSON without `approval`), which no change to
 * `approval` alters; null when the blob is not a JSON object.
 * @param {Buffer | undefined} bytes the blob
 * @returns {string | null} the hex hash
 */
function signedHash(bytes) {
    try {
        const doc = JSON.parse(bytes.toString("utf8"));
        return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? recordHash(doc).toString("hex") : null;
    } catch {
        return null;
    }
}

/**
 * One statement file's checks.
 * @param {string} file its path
 * @param {Buffer | undefined} bytes its contents
 * @param {object} at as changeApprovals' input, plus `landed`, the signed hashes (signedHash) of
 *     every statement in the base's history
 * @returns {{ problem?: string, other?: true, statement?: any, id?: string }} why it fails; or
 *     that it names another change; or the statement and its id
 */
function checkStatement(file, bytes, at) {
    const { base, head, baselines, approvals, keys, repository, changes, landed, git } = at;
    let statement;
    try {
        statement = JSON.parse(bytes.toString("utf8"));
    } catch {
        return { problem: "not JSON" };
    }
    const shape = statementProblem(statement);
    if (shape) {
        return { problem: `not a change statement (${shape})` };
    }
    const where = statementPath(approvals, statement);
    if (where !== file) {
        return { problem: `its content belongs at ${where}: a statement is never moved or copied` };
    }
    // By what the passkey signed, not by file name: a copy with other `approval` bytes (an
    // alternate ECDSA signature) has another id and place but is the same landed review.
    if (landed.has(signedHash(bytes))) {
        return { problem: "it is already in the default branch's history, and a landed statement never counts again" };
    }
    const unsigned = keys ? verifyApproval(statement, keys) : null;
    if (unsigned) {
        return { problem: unsigned };
    }
    if (repository === null) {
        return {
            problem: 'this repository has no id, so no statement can name it (docs/approval-format.md, "Repository")',
        };
    }
    if (statement.repository !== repository) {
        return { problem: `it approves repository ${statement.repository}, not ${repository}` };
    }
    if (statement.baselines !== baselines) {
        return { problem: `it approves ${statement.baselines}/, not ${baselines}/` };
    }
    if (!changes.includes(statement.change)) {
        return { other: true, statement };
    }
    const c = statement.capturedHead;
    if (!succeeds(git, ["cat-file", "-e", `${c}^{commit}`])) {
        return { problem: `its capturedHead ${c} is not in this repository` };
    }
    const onBase = succeeds(git, ["merge-base", "--is-ancestor", c, base]);
    // A seed statement's reviewer saw a capture of the default branch, so its capturedHead must be on
    // the base; a change statement's must not, so neither kind stands in for the other.
    if (statement.type === SEED_TYPE) {
        return onBase
            ? { statement, id: statementId(statement) }
            : {
                  problem: `its capturedHead ${c} is not on the default branch, so it did not review a capture of the default branch`,
              };
    }
    if (!succeeds(git, ["merge-base", "--is-ancestor", c, head])) {
        return { problem: `its capturedHead ${c} is not in this change's history` };
    }
    if (onBase) {
        return { problem: `its capturedHead ${c} is already on the base, so it reviewed an earlier change` };
    }
    return { statement, id: statementId(statement) };
}

/**
 * The statements the change takes back: every statement file a commit of `base..head` adds that
 * the base does not hold and that the head no longer holds exactly as added, whether a later
 * commit, a merge, a revert or a rename dropped or changed it. A statement once pushed to a change
 * stays, byte for byte, so dropping a later reject takes rewriting the branch's history, which the
 * code host shows. A statement that did not verify against the base's keys as added (one committed
 * unsigned before the first key landed) approves nothing, so removing it takes nothing back.
 * @param {(args: string[], input?: string) => Buffer} git the runner
 * @param {object} at what to read
 * @param {string} at.base the base
 * @param {string} at.head the head
 * @param {string} at.approvals the approvals directory
 * @param {object[] | null} at.keys the base's keys; null while approvals are not enforced
 * @returns {string[]} one line per statement taken back
 */
export function withdrawnStatements(git, { base, head, approvals, keys }) {
    const parts = git([
        "log",
        "--format=%x01%H",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        "--diff-filter=A",
        `${base}..${head}`,
        "--",
        `${approvals}/`,
    ])
        .toString("utf8")
        .split("\0");
    const added = [];
    let commit = null;
    for (let i = 0; i < parts.length; i++) {
        const token = parts[i].replace(/^\n+/, "");
        if (token.startsWith("\x01")) {
            commit = token.slice(1);
        } else if (token.startsWith(":")) {
            const blob = token.split(" ")[3];
            const path = parts[++i];
            if (path.slice(approvals.length + 1).includes("/")) {
                added.push({ path, blob, commit });
            }
        }
    }
    if (added.length === 0) {
        return [];
    }
    const treeOf = (rev) =>
        new Map(
            git(["ls-tree", "-r", "-z", rev, "--", `${approvals}/`])
                .toString("utf8")
                .split("\0")
                .filter(Boolean)
                .map((line) => {
                    const tab = line.indexOf("\t");
                    return [line.slice(tab + 1), line.slice(0, tab).split(" ")[2]];
                }),
        );
    const onBase = treeOf(base);
    const atHead = treeOf(head);
    const blobs = readBlobs(
        git,
        added.map((a) => a.blob),
    );
    const out = [];
    const named = new Set();
    for (const { path, blob, commit: sha } of added) {
        if (named.has(path) || onBase.has(path) || atHead.get(path) === blob) {
            continue;
        }
        if (keys && !verifiesWith(blobs.get(blob), keys)) {
            continue;
        }
        named.add(path);
        const what = atHead.has(path) ? "changes it" : "no longer holds it";
        out.push(
            `${path}: commit ${sha.slice(0, 12)} of this change adds it, and the head ${what}; a Finish is never taken back, so finish again instead`,
        );
    }
    return out;
}

/**
 * Whether a statement blob carries a signature one of the keys verifies.
 * @param {Buffer | undefined} bytes the blob
 * @param {object[]} keys the keys
 * @returns {boolean} whether it does
 */
function verifiesWith(bytes, keys) {
    try {
        const doc = JSON.parse(bytes.toString("utf8"));
        return statementProblem(doc) === null && verifyApproval(doc, keys) === null;
    } catch {
        return false;
    }
}

/**
 * The newest decision of one change's chain for every path, or why the chain does not stand.
 * Order is position in the chain through `previous`, never `approvedAt`.
 * @param {{ file: string, id: string, previous: string | string[] | null, entries: object[] }[]} chain
 *     the change's statements
 * @returns {{ problem: string } | { decisions: Map<string, object | { conflict: true }> }} the result
 */
export function newestDecisions(chain) {
    const byId = new Map(chain.map((s) => [s.id, s]));
    const parents = new Map(chain.map((s) => [s.id, s.previous === null ? [] : [s.previous].flat()]));
    for (const s of chain) {
        const missing = parents.get(s.id).find((p) => !byId.has(p));
        if (missing) {
            return { problem: `${s.file}: its previous ${missing} names no statement of this change; finish again` };
        }
    }
    const named = new Set([...parents.values()].flat());
    const tips = chain.filter((s) => !named.has(s.id));
    if (tips.length !== 1) {
        return { problem: "two Finishes of this change were made at once; finish again" };
    }
    /** @type {Map<string, Set<string>>} */
    const ancestors = new Map();
    const ancestorsOf = (id) => {
        if (!ancestors.has(id)) {
            const set = new Set();
            ancestors.set(id, set);
            for (const p of parents.get(id)) {
                set.add(p);
                for (const a of ancestorsOf(p)) {
                    set.add(a);
                }
            }
        }
        return ancestors.get(id);
    };
    const deciders = new Map();
    for (const s of chain) {
        for (const e of s.entries) {
            deciders.set(e.path, [...(deciders.get(e.path) ?? []), { id: s.id, e }]);
        }
    }
    const decisions = new Map();
    for (const [path, list] of deciders) {
        const newest = list.filter((x) => !list.some((y) => y !== x && ancestorsOf(y.id).has(x.id)));
        const same = newest.every(
            (x) => x.e.decision === newest[0].e.decision && x.e.from === newest[0].e.from && x.e.to === newest[0].e.to,
        );
        decisions.set(path, same ? newest[0].e : { conflict: true });
    }
    return { decisions };
}

/**
 * What of the altered files the statements do not approve.
 * @param {{ path: string, b: string | null, h: string | null }[]} d the altered files, with their
 *     hashes at base and head
 * @param {any[]} statements the counted statements, of one or more changes
 * @param {string} baselines the baselines directory, for the messages
 * @returns {string[]} one line per problem
 */
function coverageProblems(d, statements, baselines) {
    if (d.length === 0) {
        return [];
    }
    const byChange = new Map();
    for (const s of statements) {
        byChange.set(s.change, [...(byChange.get(s.change) ?? []), s]);
    }
    const chains = [];
    for (const chain of byChange.values()) {
        const r = newestDecisions(chain);
        if ("problem" in r) {
            return [r.problem];
        }
        chains.push(r.decisions);
    }
    const problems = [];
    for (const { path, b, h } of d) {
        const full = `${baselines}/${path}`;
        const found = chains.map((c) => c.get(path)).filter(Boolean);
        const why = decisionProblem(found, { full, b, h });
        if (why) {
            problems.push(why);
        }
    }
    return problems;
}

function decisionProblem(found, { full, b, h }) {
    if (found.length === 0) {
        return `${full}: not reviewed; review it with \`proofroom serve\` and Finish`;
    }
    if (found.some((e) => e.conflict)) {
        return `${full}: two Finishes of this change decided it differently; finish again`;
    }
    const reject = found.find((e) => e.decision === "reject");
    if (reject) {
        return `${full}: rejected (${reject.reason ?? "no reason given"}); a rejected item needs a code change, not another review`;
    }
    const [first] = found;
    if (found.some((e) => e.decision !== first.decision || e.from !== first.from || e.to !== first.to)) {
        return `${full}: the changes checked together hold different decisions for it; check them one at a time, or decide it the same way in each`;
    }
    if (first.from === b && first.to === h) {
        return null;
    }
    if (first.from !== b) {
        return `the default branch changed ${full} after the review; update and decide it again`;
    }
    return `${full}: the head holds another file than the one approved; review it again`;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const hasControl = (text) => [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/**
 * The commits of a change, each with its parents and its author and committer e-mails, and
 * whether it counts as a contribution. Two kinds do not: the tool's own commit (Finish's),
 * recognized by what it changes, never by who made it -- it adds one statement and changes nothing
 * but the baseline files that statement's entries name -- and a merge that adds nothing of its own
 * (every file is one parent's, as in a clean merge of the default branch or a merge result CI
 * builds).
 *
 * The commits and their parents come from `git rev-list --parents`, which prints nothing a
 * contributor chooses; the files and the e-mails each from their own `git log`, whose output is
 * checked against that list, so an e-mail or a file name holding a separator cannot invent a
 * commit or hide one. Statements are read in one batch.
 * @param {(args: string[], input?: string) => Buffer} git the runner
 * @param {object} at what to read
 * @param {string} at.base the base
 * @param {string} at.head the head
 * @param {string} at.baselines the baselines directory
 * @param {string} at.approvals the approvals directory
 * @returns {Map<string, { counts: boolean, parents: string[], emails: string[] }>} by commit
 * @throws {Error} when git's output does not match the commit list, or an e-mail holds a control character
 */
export function changeCommits(git, { base, head, baselines, approvals }) {
    const range = `${base}..${head}`;
    const parentsOf = new Map();
    for (const line of git(["rev-list", "--parents", range]).toString("utf8").split("\n").filter(Boolean)) {
        const [sha, ...parents] = line.split(" ");
        parentsOf.set(sha, parents);
    }
    const filesOf = commitFiles(git, range, parentsOf);
    const emailsOf = commitEmails(git, range, parentsOf);
    const commits = new Map();
    const stated = new Map();
    for (const [sha, parents] of parentsOf) {
        const files = filesOf.get(sha);
        const added = files.filter((f) => f.startsWith(`${approvals}/`) && f.slice(approvals.length + 1).includes("/"));
        commits.set(sha, { counts: !(parents.length > 1 && files.length === 0), parents, emails: emailsOf.get(sha) });
        if (added.length === 1 && parents.length === 1) {
            stated.set(sha, { file: added[0], files });
        }
    }
    const blobs = readBlobs(
        git,
        [...stated].map(([sha, { file }]) => `${sha}:${file}`),
    );
    for (const [sha, { file, files }] of stated) {
        const bytes = blobs.get(`${sha}:${file}`);
        if (bytes && toolsOwn(bytes, files, file, baselines)) {
            commits.get(sha).counts = false;
        }
    }
    return commits;
}

/**
 * Takes one commit of a `git log` that names it, refusing one the commit list does not hold or
 * that the log names twice.
 * @param {Map<string, any>} seen what the log named so far
 * @param {string} sha the commit the log names
 * @param {Map<string, string[]>} parentsOf the commit list
 * @param {string} range the range
 */
function logCommit(seen, sha, parentsOf, range) {
    if (!SHA.test(sha) || !parentsOf.has(sha) || seen.has(sha)) {
        throw new Error(`git log of ${range} names a commit its commit list does not hold once`);
    }
}

/**
 * The files each commit changes (a merge's: what no parent has), from one `git log`.
 * @param {(args: string[]) => Buffer} git the runner
 * @param {string} range the range
 * @param {Map<string, string[]>} parentsOf the commit list
 * @returns {Map<string, string[]>} by commit
 */
function commitFiles(git, range, parentsOf) {
    const text = git([
        "log",
        "--format=%x01%H",
        "--name-only",
        "-z",
        "--no-renames",
        "--diff-merges=combined",
        range,
    ]).toString("utf8");
    const out = new Map();
    let files = null;
    for (const raw of text.split("\0")) {
        const token = raw.replace(/^\n/, "");
        if (token.startsWith("\x01")) {
            const sha = token.slice(1);
            logCommit(out, sha, parentsOf, range);
            files = [];
            out.set(sha, files);
        } else if (token && files) {
            files.push(token);
        } else if (token) {
            throw new Error(`git log of ${range} names a file before any commit`);
        }
    }
    if (out.size !== parentsOf.size) {
        throw new Error(`git log of ${range} leaves out a commit of its commit list`);
    }
    return out;
}

/**
 * Each commit's author and committer e-mails, from one `git log`.
 * @param {(args: string[]) => Buffer} git the runner
 * @param {string} range the range
 * @param {Map<string, string[]>} parentsOf the commit list
 * @returns {Map<string, string[]>} by commit
 */
function commitEmails(git, range, parentsOf) {
    const text = git(["log", "--format=%x01%H%x00%ae%x00%ce", range]).toString("utf8");
    const out = new Map();
    for (const record of text.split("\x01").slice(1)) {
        const fields = record.replace(/\n$/, "").split("\0");
        if (fields.length !== 3) {
            throw new Error(`git log of ${range} prints a commit whose e-mails do not parse`);
        }
        const [sha, ...emails] = fields;
        logCommit(out, sha, parentsOf, range);
        if (emails.some(hasControl)) {
            throw new Error(`commit ${sha.slice(0, 12)} carries an e-mail address holding a control character`);
        }
        out.set(sha, emails.filter(Boolean));
    }
    if (out.size !== parentsOf.size) {
        throw new Error(`git log of ${range} leaves out a commit of its commit list`);
    }
    return out;
}

/**
 * Whether a commit's files are exactly one statement and the baseline files its entries name.
 * @param {Buffer} bytes the statement the commit adds
 * @param {string[]} files every file the commit changes
 * @param {string} file the statement's path
 * @param {string} baselines the baselines directory
 * @returns {boolean} whether it is the tool's own commit
 */
function toolsOwn(bytes, files, file, baselines) {
    let s;
    try {
        s = JSON.parse(bytes.toString("utf8"));
    } catch {
        return false;
    }
    if (statementProblem(s) !== null) {
        return false;
    }
    const named = new Set(s.entries.map((e) => `${baselines}/${e.path}`));
    return files.every((f) => f === file || named.has(f));
}

/**
 * The self-approval rule (`"selfApproval": "forbid"`, docs/approval-format.md): no counted
 * statement may be signed by a key whose identity contributed to its change. It fails closed:
 * when no key is registered, when a key names no identity, and on every problem found gathering
 * the contributors (an unsigned or unverified commit, a code host that could not be asked).
 * @param {object} input what to check
 * @param {{ file: string, change: string, approval?: { credentialId?: string } }[]} input.statements
 *     the counted statements (changeApprovals' `own`)
 * @param {object[] | null} input.keys the base's keys, null when none is registered
 * @param {Map<string, { logins: Set<string>, emails: Set<string>, signers: Set<string>,
 *     problems: string[] }>} input.contributors by change: the code host user names and e-mail
 *     addresses that contributed, the ids of the keys whose signing keys signed a commit, and what
 *     stopped the gate from knowing them
 * @returns {string[]} one line per problem
 */
export function selfApprovalProblems({ statements, keys, contributors }) {
    if (statements.length === 0) {
        return [];
    }
    if (keys === null) {
        return [`no passkey is registered in ${PASSKEYS_FILE} on the base, so who signed a statement cannot be known`];
    }
    const name = (k) => (k.label ? `${k.label} (${k.id})` : k.id);
    const problems = keys
        .filter((k) => !k.identity)
        .map((k) => `the key ${name(k)} in ${PASSKEYS_FILE} names no identity, so it could be anyone's`);
    for (const change of new Set(statements.map((s) => s.change))) {
        problems.push(...(contributors.get(change)?.problems ?? [`who contributed to ${change} is not known`]));
    }
    const lower = (list) => (list ?? []).filter(Boolean).map((v) => v.toLowerCase());
    for (const s of statements) {
        const key = keys.find((k) => k.id === s.approval?.credentialId);
        const who = contributors.get(s.change);
        if (!key?.identity || !who) {
            continue;
        }
        const own =
            who.signers.has(key.id) ||
            lower([key.identity.user]).some((u) => who.logins.has(u)) ||
            lower(key.identity.emails).some((e) => who.emails.has(e));
        if (own) {
            problems.push(
                `${s.file}: signed by ${name(key)}, who contributed to ${s.change}; this repository forbids approving your own change`,
            );
        }
    }
    return problems;
}
