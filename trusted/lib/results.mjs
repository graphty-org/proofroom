/**
 * results.json: what one capture run of one Storybook project found, item by item.
 *
 * Capture writes it; CI, the review page and later the MCP server read it. It arrives from a CI
 * artifact, so every reader validates it before using a field: nothing in it is trusted, and a
 * `file` name is later joined to a directory, so it may never leave that directory.
 */

/**
 * Every status an item can have. `unseeded` ("no baseline yet") is a story with no baseline whose
 * capture matches master's newest capture of it, so the pull request did not change it. `moved`
 * is a story that looks exactly as the baseline of the id it was renamed from (`from`, named in
 * the project's renames.json); a renamed story that looks different is `changed` with `from`.
 */
const STATUSES = ["unchanged", "moved", "changed", "new", "unseeded", "removed", "unstable", "failed", "excluded"];

/** The most items one file may hold (compact-mantine has about 830 today). */
export const MAX_ITEMS = 5000;

const MAX_STRING = 2000;
const MAX_CONSOLE = 100;
/** The most changed areas, picture kinds and earlier attempts one item may name. */
export const MAX_AREAS = 1000;
const MAX_PICTURES = 20;
export const MAX_ATTEMPTS = 20;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const PICTURE = /^[a-z0-9][a-z0-9.-]*\.(?:png|webp)$/;

// Which hashes a status requires (true), forbids (false) or leaves open (absent).
const HASHES = {
    unchanged: { baseline: true, capture: true },
    changed: { baseline: true, capture: true },
    moved: { baseline: true, capture: true },
    new: { baseline: false, capture: true },
    unseeded: { baseline: false, capture: true },
    removed: { baseline: true, capture: false },
};

const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;
const isStr = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_STRING;
const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => isInt(n, 1));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isBox = (v) =>
    Array.isArray(v) && v.length === 4 && isInt(v[0]) && isInt(v[1]) && isInt(v[2], 1) && isInt(v[3], 1);
const isConsole = (v) =>
    Array.isArray(v) &&
    v.length <= MAX_CONSOLE &&
    v.every((line) => typeof line === "string" && line.length <= MAX_STRING);
const validId = (v) => typeof v === "string" && v.length <= 200 && NAME.test(v);
const validMode = (v) => v === null || (typeof v === "string" && v.length <= 50 && NAME.test(v));
// A picture is a file beside the images, named by whoever made it; like `file`, never a path.
const isPictureFile = (v) => typeof v === "string" && v.length <= 300 && PICTURE.test(v) && !v.includes("..");

/**
 * Checks one item of a results.json, which is also the body of a result line (result-line.mjs).
 * @param {any} item the item, untrusted
 * @param {string} at how the messages name it, such as "items[3]"
 * @returns {string[]} one message per problem; empty when the item is valid
 */
export function itemProblems(item, at) {
    if (!isObj(item)) {
        return [`${at} must be an object`];
    }
    const errors = [];
    const check = (ok, message) => {
        if (!ok) {
            errors.push(message);
        }
    };
    const idOk = validId(item.id);
    const modeOk = validMode(item.mode);
    check(idOk, `${at}.id must be a Storybook story id`);
    check(modeOk, `${at}.mode must be a lowercase name or null`);
    // The file name is derived, never chosen: `<id>[.<mode>].png`. That alone keeps "/" and ".."
    // out of it, because neither the id nor the mode can contain them.
    if (idOk && modeOk) {
        const expected = item.mode === null ? `${item.id}.png` : `${item.id}.${item.mode}.png`;
        check(item.file === expected, `${at}.file must be "${expected}"`);
    } else {
        check(false, `${at}.file cannot be checked without a valid id and mode`);
    }

    check(STATUSES.includes(item.status), `${at}.status must be one of ${STATUSES.join(", ")}`);
    // The story id a renamed story's baseline was read under (absent when it was not renamed).
    check(
        item.from === undefined || item.from === null || validId(item.from),
        `${at}.from must be a Storybook story id or null`,
    );
    check(item.status !== "moved" || typeof item.from === "string", `${at}.from is required for a moved item`);
    // Still written, so an older gate (which requires it) reads the file; optional to read. True only
    // when the second of two shots matched the baseline.
    check(item.flaky === undefined || typeof item.flaky === "boolean", `${at}.flaky must be a boolean`);
    for (const key of ["baseline", "capture"]) {
        const v = item[key];
        check(v === null || (typeof v === "string" && SHA256.test(v)), `${at}.${key} must be a sha256 or null`);
        const rule = HASHES[item.status]?.[key];
        check(rule !== true || typeof v === "string", `${at}.${key} is required for a ${item.status} item`);
        check(rule !== false || v === null, `${at}.${key} must be null for a ${item.status} item`);
    }
    for (const key of ["size", "baselineSize"]) {
        check(item[key] === null || isPair(item[key]), `${at}.${key} must be [width, height] or null`);
    }
    check(item.changedPixels === null || isInt(item.changedPixels), `${at}.changedPixels must be a count or null`);
    check(
        item.bbox === null || (Array.isArray(item.bbox) && item.bbox.length === 4 && item.bbox.every((n) => isInt(n))),
        `${at}.bbox must be four integers or null`,
    );
    check(
        typeof item.threshold === "number" && item.threshold >= 0 && item.threshold <= 1,
        `${at}.threshold must be 0..1`,
    );
    check(typeof item.includeAA === "boolean", `${at}.includeAA must be a boolean`);
    check(item.reason === null || isStr(item.reason), `${at}.reason must be a string or null`);
    check(isConsole(item.console), `${at}.console must be at most ${MAX_CONSOLE} strings`);
    // Optional, written by compare and run: the changed areas, each [x, y, width, height] in image
    // pixels, largest first; the pictures made for the item, by kind; and its earlier attempts in
    // this run, oldest first (the item itself is the last attempt).
    check(
        item.areas === undefined ||
            (Array.isArray(item.areas) && item.areas.length <= MAX_AREAS && item.areas.every(isBox)),
        `${at}.areas must be at most ${MAX_AREAS} boxes [x, y, width, height]`,
    );
    check(
        item.pictures === undefined ||
            (isObj(item.pictures) &&
                Object.keys(item.pictures).length <= MAX_PICTURES &&
                Object.entries(item.pictures).every(([kind, file]) => NAME.test(kind) && isPictureFile(file))),
        `${at}.pictures must map at most ${MAX_PICTURES} kinds to .png or .webp file names`,
    );
    if (item.attempts !== undefined) {
        if (Array.isArray(item.attempts) && item.attempts.length <= MAX_ATTEMPTS) {
            item.attempts.forEach((a, n) => errors.push(...attemptProblems(a, `${at}.attempts[${n}]`)));
        } else {
            errors.push(`${at}.attempts must be an array of at most ${MAX_ATTEMPTS} earlier attempts`);
        }
    }
    return errors;
}

/**
 * Checks one earlier attempt of an item: what that shot was judged, without the images' sizes.
 * @param {any} a the attempt, untrusted
 * @param {string} at how the messages name it
 * @returns {string[]} one message per problem
 */
function attemptProblems(a, at) {
    if (!isObj(a)) {
        return [`${at} must be an object`];
    }
    const errors = [];
    const check = (ok, message) => {
        if (!ok) {
            errors.push(message);
        }
    };
    check(STATUSES.includes(a.status), `${at}.status must be one of ${STATUSES.join(", ")}`);
    check(
        a.capture === null || (typeof a.capture === "string" && SHA256.test(a.capture)),
        `${at}.capture must be a sha256 or null`,
    );
    check(
        a.from === undefined || a.from === null || validId(a.from),
        `${at}.from must be a Storybook story id or null`,
    );
    check(a.status !== "moved" || typeof a.from === "string", `${at}.from is required for a moved attempt`);
    check(a.changedPixels === null || isInt(a.changedPixels), `${at}.changedPixels must be a count or null`);
    check(a.reason === null || isStr(a.reason), `${at}.reason must be a string or null`);
    check(isConsole(a.console), `${at}.console must be at most ${MAX_CONSOLE} strings`);
    return errors;
}

/**
 * Checks a parsed results.json.
 * @param {any} r the parsed JSON, untrusted
 * @returns {string[]} one message per problem; empty when the file is valid
 */
export function validateResults(r) {
    if (!isObj(r)) {
        return ["results must be an object"];
    }
    const errors = [];
    const check = (ok, message) => {
        if (!ok) {
            errors.push(message);
        }
    };

    check(r.version === 1, "version must be 1");
    check(typeof r.project === "string" && NAME.test(r.project), "project must be a lowercase name");
    check(typeof r.commit === "string" && SHA1.test(r.commit), "commit must be a 40-character sha");
    check(
        r.headSha === null || (typeof r.headSha === "string" && SHA1.test(r.headSha)),
        "headSha must be a sha or null",
    );
    for (const key of ["pr", "runId", "runAttempt"]) {
        check(r[key] === null || isInt(r[key], 1), `${key} must be a positive integer or null`);
    }
    check(
        r.local === null ||
            (isObj(r.local) &&
                isStr(r.local.describe) &&
                typeof r.local.diff === "string" &&
                SHA256.test(r.local.diff) &&
                (r.local.preview === undefined ||
                    (isObj(r.local.preview) &&
                        typeof r.local.preview.merge === "string" &&
                        SHA1.test(r.local.preview.merge) &&
                        isStr(r.local.preview.host) &&
                        isStr(r.local.preview.tool)))),
        "local must be null or { describe, diff, preview? }",
    );
    // A preview of a pull request names it and the head it captured.
    check(
        r.local?.preview === undefined || (r.pr !== null && r.headSha !== null),
        "a local preview must name its pull request and head",
    );
    check(typeof r.seeded === "boolean", "seeded must be a boolean");
    check(typeof r.complete === "boolean", "complete must be a boolean");
    check(isInt(r.expected), "expected must be a non-negative integer");
    check(isStr(r.capturedAt) && !Number.isNaN(Date.parse(r.capturedAt)), "capturedAt must be a date");
    check(isObj(r.clock), "clock must be an object");
    check(isObj(r.environment), "environment must be an object");
    // Device pixels per CSS pixel. Captures made before it was recorded were at 1.
    check(r.scale === undefined || r.scale === 1 || r.scale === 2, "scale must be 1 or 2");
    // The browser that drew the images, as capture records it, and the one that drew the default
    // branch's capture compare was given (its baselines'). Absent in captures made before either was.
    for (const key of ["renderer", "baselineRenderer"]) {
        const v = r[key];
        check(v === undefined || (isObj(v) && isStr(v.name) && isStr(v.version)), `${key} must be { name, version }`);
    }

    if (!Array.isArray(r.items)) {
        errors.push("items must be an array");
        return errors;
    }
    if (r.items.length > MAX_ITEMS) {
        errors.push(`items holds ${r.items.length} entries; the most allowed is ${MAX_ITEMS}`);
        return errors;
    }

    const seen = new Set();
    r.items.forEach((item, i) => {
        const at = `items[${i}]`;
        errors.push(...itemProblems(item, at));
        if (isObj(item) && validId(item.id) && validMode(item.mode)) {
            const key = `${item.id}\u0000${item.mode}`;
            check(!seen.has(key), `${at} is a duplicate of ${item.id} ${item.mode ?? ""}`.trimEnd());
            seen.add(key);
        }
    });
    return errors;
}

/**
 * skipped.json: what a CI job writes in place of results.json when the run chose not to capture
 * a project because the pull request cannot affect it. It is not a capture: the gate accepts it
 * only on a pull request's own run, only for a project with baselines on the base branch whose
 * baselines the pull request does not change, and never in a merge-queue run (gate.mjs).
 */
export const SKIPPED_FILE = "skipped.json";

/** The problem the review server shows for a project the run left out: neutral, nothing to decide. */
export const NOT_AFFECTED = "not affected";

/**
 * Whether a parsed skipped.json is the marker for this project.
 * @param {any} m the parsed JSON, untrusted
 * @param {string} project the project the artifact is named for
 * @returns {boolean} true only for exactly `{ "skipped": "not affected", "project": <project> }`
 */
export const isSkipMarker = (m, project) =>
    isObj(m) && Object.keys(m).length === 2 && m.skipped === "not affected" && m.project === project;
