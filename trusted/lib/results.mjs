/**
 * results.json: what one capture run of one Storybook project found, item by item.
 *
 * Capture writes it; CI, the review page and later the MCP server read it. It arrives from a CI
 * artifact, so every reader validates it before using a field: nothing in it is trusted, and a
 * `file` name is later joined to a directory, so it may never leave that directory.
 */

/** Every status an item can have. */
const STATUSES = ["unchanged", "changed", "new", "removed", "unstable", "failed", "excluded"];

/** The most items one file may hold (compact-mantine has about 830 today). */
export const MAX_ITEMS = 5000;

const MAX_STRING = 2000;
const MAX_CONSOLE = 100;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

// Which hashes a status requires (true), forbids (false) or leaves open (absent).
const HASHES = {
    unchanged: { baseline: true, capture: true },
    changed: { baseline: true, capture: true },
    new: { baseline: false, capture: true },
    removed: { baseline: true, capture: false },
};

const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;
const isStr = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_STRING;
const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => isInt(n, 1));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks a parsed results.json.
 * @param {unknown} r the parsed JSON
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
                SHA256.test(r.local.diff)),
        "local must be null or { describe, diff }",
    );
    check(typeof r.seeded === "boolean", "seeded must be a boolean");
    check(typeof r.complete === "boolean", "complete must be a boolean");
    check(isInt(r.expected), "expected must be a non-negative integer");
    check(isStr(r.capturedAt) && !Number.isNaN(Date.parse(r.capturedAt)), "capturedAt must be a date");
    check(isObj(r.clock), "clock must be an object");
    check(isObj(r.environment), "environment must be an object");

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
        if (!isObj(item)) {
            errors.push(`${at} must be an object`);
            return;
        }
        const idOk = typeof item.id === "string" && item.id.length <= 200 && NAME.test(item.id);
        const modeOk =
            item.mode === null || (typeof item.mode === "string" && item.mode.length <= 50 && NAME.test(item.mode));
        check(idOk, `${at}.id must be a Storybook story id`);
        check(modeOk, `${at}.mode must be a lowercase name or null`);
        // The file name is derived, never chosen: `<id>[.<mode>].png`. That alone keeps "/" and ".."
        // out of it, because neither the id nor the mode can contain them.
        if (idOk && modeOk) {
            const expected = item.mode === null ? `${item.id}.png` : `${item.id}.${item.mode}.png`;
            check(item.file === expected, `${at}.file must be "${expected}"`);
            const key = `${item.id}\u0000${item.mode}`;
            check(!seen.has(key), `${at} is a duplicate of ${item.id} ${item.mode ?? ""}`.trimEnd());
            seen.add(key);
        } else {
            check(false, `${at}.file cannot be checked without a valid id and mode`);
        }

        check(STATUSES.includes(item.status), `${at}.status must be one of ${STATUSES.join(", ")}`);
        check(typeof item.flaky === "boolean", `${at}.flaky must be a boolean`);
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
            item.bbox === null ||
                (Array.isArray(item.bbox) && item.bbox.length === 4 && item.bbox.every((n) => isInt(n))),
            `${at}.bbox must be four integers or null`,
        );
        check(
            typeof item.threshold === "number" && item.threshold >= 0 && item.threshold <= 1,
            `${at}.threshold must be 0..1`,
        );
        check(typeof item.includeAA === "boolean", `${at}.includeAA must be a boolean`);
        check(item.reason === null || isStr(item.reason), `${at}.reason must be a string or null`);
        check(
            Array.isArray(item.console) &&
                item.console.length <= MAX_CONSOLE &&
                item.console.every((line) => typeof line === "string" && line.length <= MAX_STRING),
            `${at}.console must be at most ${MAX_CONSOLE} strings`,
        );
    });
    return errors;
}
