/**
 * The review page's server: the static page and a small JSON API over the downloaded captures.
 *
 * Every /api request carries the session token in `x-review-token`; the page reads it from the
 * URL fragment `serve` prints. State-changing requests are POST only and must come from the
 * served origin. Images are served only when their file is named by results.json and its bytes
 * hash to the hash results.json gives, so the page shows exactly what CI compared. Decisions
 * are kept in `<tmp>/state/<target>.json` until Finish, each with the hash of the image it was
 * taken on, so a restart resumes them and a new CI run or attempt shows only those whose image is
 * unchanged. The file is the only copy: every request reads it and every change rewrites it, so a
 * failed write changes nothing, and a decision whose item is missing from this run (a project
 * still capturing, a download that failed) is kept for when it comes back.
 *
 * Finish runs in the background: a large seed takes minutes, longer than a browser (Safari on an
 * iPad) keeps one request open. POST /api/finish starts it and GET /api/finish-status reports its
 * step, then its result or error, so a reload finds the running Finish. The job is also written
 * to `<tmp>/state/finish.json`, so a server restarted during a Finish says it was interrupted.
 * POST /api/update runs an update from the default branch (accept.mjs updateFromMaster) the same
 * way, as the same job, so only one of them runs at a time.
 *
 * Passkeys: once any key is known (passkeys.json on the fetched default branch, or one this server
 * registered whose pull request is not merged yet, `<tmp>/state/passkeys-pending.json`), a Finish
 * that commits decisions needs one passkey approval from the owner, which also makes its accepts
 * count as "approved before" later (filters.mjs approvalIndex). A pending key approves only while the
 * default branch holds none: once it does, only its keys count, as in the gate, so a key
 * registered later (by anyone who can reach this page) approves nothing until its pull request
 * merges. A Finish also signs the baselines tree it leaves only when it rejects nothing and, on a
 * pull request, leaves nothing undecided and every project loaded (signingProblem). POST
 * /api/finish-prepare commits the accepts (not pushed, accept.mjs prepareApproval) and returns the
 * WebAuthn challenge: when the tree is signed, the hash of the statement about that commit's
 * baselines tree, which holds the review record, so the one approval covers the decisions too
 * (accept.mjs treeSignedRecords); otherwise the hash of the record, and the same route with that
 * approval signs the record into the commit (signRecord). POST /api/finish takes the tree's
 * approval when there is one, checks it, and pushes the commit with the signed statement on it, or
 * the commit alone. A Finish with nothing new to decide signs the record of an earlier Finish that was
 * pushed unsigned, when the branch tip is that Finish's accept commit (`resign`). The server
 * decides whether approval is required, so leaving it out never skips it. The rpId is the host
 * name of the page's own origin.
 *
 * Against the base: a pull request's capture is compared with its own branch's baselines, which an
 * earlier Finish or a branch merged in may already have changed. Each project is also compared
 * with the default branch's baselines (againstBase), so every image the signed tree would hold that
 * differs from the default branch's is shown and decided, those already on the branch too.
 *
 * The list of targets is cached: `GET /api/prs?cached=1` answers at once with the cache, its age,
 * the progress of a refresh, why the last one failed and any network retry under way, and
 * `?refresh=1` starts one in the background, so the page never waits on GitHub to change screens.
 * The list is also kept in `<tmp>/state/list.json`, so a restarted server shows it at once and
 * refreshes it behind. With `warm` the server refreshes at start and every two minutes, so the
 * captures of a CI run that just finished are downloaded before the owner opens them. A target
 * whose captures are still downloading is listed with `downloading: true` and its progress, and
 * rebuilt in the cache when they land; `GET /api/pr/...` of a project still downloading answers
 * 202 and moves its download to the front of the queue. What GitHub says about a finished run
 * (its jobs and artifacts) is asked once and kept beside its downloads. Grid tiles load
 * thumbnails (`GET /api/thumb/...`), scaled down in worker threads as soon as a capture lands and
 * kept on disk; with Spotlight all or Zoom to changes on, a changed item's tile
 * (`GET /api/spot/...`) is made the same way, after every plain thumbnail.
 *
 * Safe filters (filters.mjs): an item whose capture is an image the owner already approved for the
 * same story and mode, in a review record on the default branch or an open pull request's branch,
 * counts as accepted ("approved before", never saved in the decisions file, and replaced by any
 * decision the owner takes on it), and Finish names that record in the new one. Every refresh adds what the captures show about capture noise to
 * `<tmp>/state/noise-evidence.json` and writes the stories proven noisy to
 * `<tmp>/state/known-noise.json` (also `GET /api/noise`); they are labeled, never accepted. `GET
 * /api/pr` groups each project's changed items into clusters the page can decide as one.
 * `GET /api/pr-context/<id>` answers a pull request's title, description and comments (untrusted
 * text), asked from GitHub once per head.
 *
 * Coupled pull requests (inbox.mjs coupledGroups) change the same baseline files. POST
 * /api/decide-group and /api/accept-all-group do what /api/decide and /api/accept-all do, then the
 * same on every other member of the target's group whose item shows the same image against the
 * same baseline, so the owner reviews a shared image once. Each call is logged to
 * `<tmp>/state/groups.jsonl`, to count approvals per group.
 */

import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { contentHash } from "../gate.mjs";

import {
    AcceptError,
    behindMaster,
    cleanReason,
    commitStatus,
    decisionProblem,
    finish,
    closeCandidatePullRequest,
    isPreviewOf,
    masterSubject,
    newerOnMaster,
    onlyFinishCommits,
    prepareApproval,
    proposeKey,
    signRecord,
    treeSignedRecords,
    treeStatement,
    unsignedRecordAt,
    updateFromMaster,
} from "./accept.mjs";
import { PASSKEYS_FILE, parsePasskeys, recordHash, verifyApproval, verifyRegistration } from "./approval.mjs";
import { isLfsPointer, sha256 } from "./compare.mjs";
import {
    downloadCaptures,
    exec,
    getRun,
    hurry,
    openPullRequests,
    pullRequestContext,
    retrying,
    reviewerLogin,
    visualJobs,
} from "./github.mjs";
import { CONFIG_FILE } from "./config.mjs";
import { approvalIndex, clusters, isNoise, knownNoise, observations } from "./filters.mjs";
import { coupledGroups, inboxOf, PREVIEW_CAPTURING, readyKey, writeJson } from "./inbox.mjs";
import { isSkipMarker, NOT_AFFECTED, SKIPPED_FILE, validateResults } from "./results.mjs";
import { SPOT_KINDS, scaled } from "./thumbs.mjs";
import { USAGE_FILE } from "./usage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = {
    "/": ["../page/index.html", "text/html; charset=utf-8"],
    "/review.js": ["../page/review.js", "text/javascript; charset=utf-8"],
    "/review.css": ["../page/review.css", "text/css; charset=utf-8"],
    "/pixelmatch.mjs": ["../vendor/pixelmatch.mjs", "text/javascript; charset=utf-8"],
    "/spot.js": ["../page/spot.js", "text/javascript; charset=utf-8"],
    "/passkey.js": ["../page/passkey.js", "text/javascript; charset=utf-8"],
    "/manifest.webmanifest": ["../page/manifest.webmanifest", "application/manifest+json"],
    "/icon.svg": ["../page/icon.svg", "image/svg+xml"],
    "/icon.png": ["../page/icon.png", "image/png"],
};
const HEADERS = {
    "content-security-policy":
        "default-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
};
/**
 * The component a story belongs to: its id before "--" (`components-overlays-tooltip--states`).
 * @param {string} id the story id
 * @returns {string} the component part
 */
const componentOf = (id) => id.split("--")[0];

const REVIEWABLE = new Set(["changed", "moved", "new", "unseeded", "removed", "unstable", "failed"]);
// The statuses whose accept changes the baseline file: two pull requests with one of these on the
// same file conflict once the first merges.
const CHANGES = new Set(["changed", "moved", "new", "unseeded", "removed"]);
const WRITES = new Set([
    "decide",
    "decide-group",
    "accept-all",
    "accept-all-group",
    "finish",
    "finish-prepare",
    "passkey-challenge",
    "register",
    "update",
    "usage",
]);
// A registration challenge is good for one use within this long; a prepared approval for this long.
const CHALLENGE_MS = 5 * 60000;
const APPROVAL_MS = 10 * 60000;
// How long a page load waits for a run's captures to download before it lists the target as
// downloading; the download goes on, and a reload picks it up.
const PATIENCE = 1000;
// An unknown target id refreshes from GitHub at most this often: a closed pull request's open
// grid asks for dozens of images at once.
const UNKNOWN_REFRESH = 60000;
// With `warm`, the list is refreshed this often, so a CI run that finished meanwhile is downloaded
// before the owner opens it.
const POLL = 2 * 60000;

/**
 * The newest gh call waiting to retry after a network failure, for the page.
 * @returns {{ error: string, attempt: number, of: number, until: number } | null} it, or null
 */
const networkTrouble = () => [...retrying].at(-1) ?? null;

const execFileAsync = promisify(execFile);

/**
 * The image a decision was taken on: the capture, or for a removed item its baseline.
 * @param {{ capture: string | null, baseline: string | null }} item the results.json item
 * @returns {string | null} its SHA-256
 */
const imageHash = (item) => item.capture ?? item.baseline ?? null;

/**
 * The newest `to` hash per path in this pull request's review records at `head`. A record is
 * data from the branch and only decides whether a "re-review" flag is shown.
 * @param {string} repo the repository
 * @param {string | null} head the captured head
 * @param {number | null} pr the pull request
 * @param {string} baselines the baselines directory
 * @returns {Promise<Map<string, string | null>>} `to` by baseline path
 */
async function earlierAccepts(repo, head, pr, baselines) {
    const out = new Map();
    if (pr === null || !head) {
        return out;
    }
    const git = (args) => exec("git", args, { cwd: repo });
    const names = await git(["ls-tree", "--name-only", head, `${baselines}/reviews/`]).catch(() => "");
    // Record names start with their UTC time, so sorting by name applies the newest last.
    for (const name of names
        .split("\n")
        .filter((n) => n.endsWith(".json"))
        .sort()) {
        const record = await git(["show", `${head}:${name}`])
            .then(JSON.parse)
            .catch(() => null);
        if (record?.pr === pr && Array.isArray(record.items)) {
            for (const item of record.items) {
                out.set(item.path, item.to);
            }
        }
    }
    return out;
}

/**
 * The accepts of `records` the files at `tip` still hold. An update from the default branch can
 * take that branch's side of a baseline and leave the record behind: the gate then sees the change
 * unaccepted, so the accept is not published, whatever the record says.
 * @param {string} repo the repository
 * @param {string} tip the branch's commit
 * @param {Map<string, string | null>} records `to` by baseline path (earlierAccepts)
 * @returns {Promise<Map<string, string | null>>} those whose file at `tip` has that content
 */
async function heldAt(repo, tip, records) {
    const out = new Map();
    for (const [path, to] of records) {
        const held = await execFileAsync("git", ["show", `${tip}:${path}`], {
            cwd: repo,
            encoding: "buffer",
            maxBuffer: 64 << 20,
        }).then(
            ({ stdout }) => contentHash(stdout),
            () => null,
        );
        if (held === (to ?? null)) {
            out.set(path, to);
        }
    }
    return out;
}

/**
 * Who Finish's commit will be signed by: the git configuration of the server's own environment.
 * An agent that starts the server passes on its GIT_CONFIG_* overrides, and with them its own
 * signing key, so the page shows this before every Finish, with where git found the key.
 * @param {string} repo the repository
 * @returns {Promise<{ signs: boolean, format: string, key: string | null, keyFrom: string | null,
 *     author: string | null, fromEnv: boolean }>} the signing settings git will use, where the key
 *     is set (`file:<path>` or `command line:`, as `git config --show-origin` says), the committer,
 *     and whether the environment overrides git's config files
 */
async function signingIdentity(repo) {
    const get = (...k) => exec("git", ["config", ...k], { cwd: repo }).catch(() => "");
    const [sign, format, keyLine, name, email] = await Promise.all([
        get("--type=bool", "--get", "commit.gpgsign"),
        get("--get", "gpg.format"),
        get("--show-origin", "--get", "user.signingkey"),
        get("--get", "user.name"),
        get("--get", "user.email"),
    ]);
    const [keyFrom, key] = keyLine ? keyLine.split("\t") : [null, null];
    return {
        signs: sign === "true",
        format: format || "openpgp",
        key: key || null,
        keyFrom: keyFrom || null,
        author: name || email ? `${name} <${email}>` : null,
        fromEnv: Boolean(process.env.GIT_CONFIG_COUNT || process.env.GIT_CONFIG_PARAMETERS),
    };
}

const USAGE_TYPE = /^[a-z][a-z-]{0,31}$/;

/**
 * A page's batch of usage events as JSONL lines, or null when it is not one. Each event is a small
 * object with a short `type`, a time `at` and a session id `s`; one whose JSON holds the session
 * token is dropped, so the token is never written whatever the page sends.
 * @param {unknown} events the page's batch
 * @param {string} token the session token
 * @returns {string | null} the lines to append
 */
export function usageLines(events, token) {
    if (!Array.isArray(events) || events.length > 100) {
        return null;
    }
    let out = "";
    for (const e of events) {
        const line = JSON.stringify(e);
        if (
            typeof e !== "object" ||
            e === null ||
            Array.isArray(e) ||
            !USAGE_TYPE.test(e.type) ||
            !Number.isFinite(e.at) ||
            typeof e.s !== "string" ||
            line.length > 2000
        ) {
            return null;
        }
        if (!line.includes(token)) {
            out += `${line}\n`;
        }
    }
    return out;
}

/**
 * The session token, created once so a restart keeps the owner's URL.
 * @param {string} stateDir where the token file lives
 * @returns {string} the token
 */
export function sessionToken(stateDir) {
    const file = join(stateDir, "token");
    // An empty file (a full disk on the first start) would be an empty token: write a new one.
    if (!existsSync(file) || readFileSync(file, "utf8").trim() === "") {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
    }
    return readFileSync(file, "utf8").trim();
}

/**
 * Runs git and resolves with its output as bytes.
 * @param {string} repo the repository
 * @param {string[]} args git's arguments
 * @param {Buffer | string} [input] stdin
 * @returns {Promise<Buffer>} stdout
 */
const gitBytes = (repo, args, input) =>
    new Promise((resolve, reject) => {
        const child = execFile(
            "git", // NOSONAR(S4036): the review server runs the owner's own git, as the rest of it does
            args,
            { cwd: repo, encoding: "buffer", maxBuffer: 1 << 28 },
            (err, out, stderr) => (err ? reject(new Error(stderr.toString().trim() || err.message)) : resolve(out)),
        );
        child.stdin.on("error", () => {});
        child.stdin.end(input ?? "");
    });

/**
 * The contents of git blobs, read by one `git cat-file --batch`.
 * @param {string} repo the repository
 * @param {string[]} names the blobs: ids, or `<commit>:<path>`
 * @returns {Promise<Map<string, Buffer>>} each blob's bytes, by name; a missing one is left out
 */
async function blobsOf(repo, names) {
    const out = new Map();
    if (names.length === 0) {
        return out;
    }
    const all = await gitBytes(repo, ["cat-file", "--batch"], `${names.join("\n")}\n`);
    let at = 0;
    for (const name of names) {
        const nl = all.indexOf(10, at);
        const header = all.subarray(at, nl).toString("utf8");
        if (header.endsWith(" missing")) {
            at = nl + 1;
            continue;
        }
        const size = Number(header.split(" ")[2]);
        out.set(name, all.subarray(nl + 1, nl + 1 + size));
        at = nl + 2 + size;
    }
    return out;
}

/**
 * Compares one project's capture of a pull request with the default branch's baselines as well as
 * the branch's own, changing `results` in place. An item unchanged against a baseline the branch
 * already changed becomes `changed` against the default branch's image (`new` where it has none),
 * and a baseline the branch deleted becomes a `removed` item; each is marked `vsBase: true`. The
 * default branch's image of each is written to `<dir>/baselines/<file>`, where capture writes a
 * changed item's baseline, and the capture (which capture does not keep for an unchanged item: it
 * is the branch's baseline) to `<dir>/<file>`, so the page shows, diffs and Finish accepts it like
 * any other.
 * @param {object} input the work
 * @param {string} input.repo the repository
 * @param {string} input.ref the default branch as fetched
 * @param {string} input.head the captured head of the pull request, whose baselines are the
 *     captures of its unchanged items
 * @param {string} input.baselines the baselines directory
 * @param {string} input.project the project
 * @param {string} input.dir the capture's directory
 * @param {{ items: object[] }} input.results its results.json, validated
 * @returns {Promise<void>} resolves once the items and images are in place; rejects when the
 *     default branch's baselines or images cannot be read
 */
async function againstBase({ repo, ref, head, baselines, project, dir, results }) {
    const prefix = `${baselines}/${project}/`;
    const blobs = await pngBlobs(repo, ref, prefix);
    const contents = await blobsOf(repo, [...new Set(blobs.values())]);
    const hashOf = (file) => (blobs.has(file) ? contentHash(contents.get(blobs.get(file))) : null);
    const shown = compareWithBase(results, blobs, hashOf);
    for (const file of shown) {
        await putImage(repo, join(dir, "baselines", file), contents.get(blobs.get(file)), hashOf(file));
    }
    const captured = results.items.filter((i) => i.vsBase && i.capture);
    const names = captured.map((i) => `${head}:${prefix}${i.file}`);
    let atHead = await blobsOf(repo, names);
    if (atHead.size < names.length) {
        await gitBytes(repo, ["fetch", "-q", "--no-tags", "origin", head]).catch(() => null);
        atHead = await blobsOf(repo, names);
    }
    for (const [i, item] of captured.entries()) {
        await putImage(repo, join(dir, item.file), atHead.get(names[i]) ?? null, item.capture);
    }
}

/**
 * The baseline PNGs under a directory at a ref, with their blob ids.
 * @param {string} repo the repository
 * @param {string} ref the ref
 * @param {string} prefix the directory, with its trailing "/"
 * @returns {Promise<Map<string, string>>} blob id by file name below the directory
 */
async function pngBlobs(repo, ref, prefix) {
    const blobs = new Map();
    for (const entry of (await gitBytes(repo, ["ls-tree", "-r", "-z", ref, "--", prefix]))
        .toString("utf8")
        .split("\0")) {
        const [meta, path] = entry.split("\t");
        if (path?.endsWith(".png")) {
            blobs.set(path.slice(prefix.length), meta.split(" ")[2]);
        }
    }
    return blobs;
}

/**
 * Rewrites a capture's items against the default branch's baselines (againstBase).
 * @param {{ items: object[] }} results the results.json, changed in place
 * @param {Map<string, string>} blobs the default branch's baselines, by file
 * @param {(file: string) => string | null} hashOf the image hash of a default branch baseline
 * @returns {string[]} the files whose default branch image the page needs
 */
function compareWithBase(results, blobs, hashOf) {
    const seen = new Set();
    const shown = [];
    for (const item of results.items) {
        seen.add(item.file);
        if (item.from) {
            seen.add(item.mode === null ? `${item.from}.png` : `${item.from}.${item.mode}.png`);
        }
        const base = hashOf(item.file);
        // Unchanged means within the story's tolerance of `baseline`, not byte for byte: when the
        // default branch holds that same baseline, the capture's verdict stands.
        if (item.status !== "unchanged" || base === item.baseline || base === item.capture) {
            continue;
        }
        const status = base === null ? "new" : "changed";
        // What the branch holds, and what a signature covers, is its baseline: the capture only
        // matched it within tolerance, and the artifact does not keep an unchanged capture.
        Object.assign(item, {
            status,
            capture: item.baseline,
            baseline: base,
            baselineSize: null,
            changedPixels: null,
            bbox: null,
            vsBase: true,
        });
        if (base !== null) {
            shown.push(item.file);
        }
    }
    for (const file of [...blobs.keys()].filter((f) => !seen.has(f))) {
        const [id, mode = null] = file.slice(0, -".png".length).split(".");
        results.items.push({
            id,
            mode,
            file,
            status: "removed",
            baseline: hashOf(file),
            capture: null,
            size: null,
            baselineSize: null,
            changedPixels: null,
            bbox: null,
            flaky: false,
            threshold: 0,
            includeAA: false,
            reason: null,
            console: [],
            vsBase: true,
        });
        shown.push(file);
    }
    return shown;
}

/**
 * Writes the image a blob stands for (a Git LFS pointer is read from Git LFS), unless the file
 * already holds it.
 * @param {string} repo the repository
 * @param {string} path where the image goes
 * @param {Buffer | null} blob the blob
 * @param {string} hash the image's SHA-256
 * @returns {Promise<void>} resolves once the image is there; rejects when it cannot be read
 */
async function putImage(repo, path, blob, hash) {
    const have = await readFile(path).catch(() => null);
    if (have && sha256(have) === hash) {
        return;
    }
    const bytes = blob && isLfsPointer(blob) ? await gitBytes(repo, ["lfs", "smudge"], blob) : blob;
    if (!bytes || sha256(bytes) !== hash) {
        throw new Error(`${basename(path)}: the image ${hash} could not be read (git lfs fetch it)`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
}

/**
 * Reads and validates one project's results.json. An artifact holding the not-affected marker
 * instead is "not affected": the run left the project out, so there is nothing to decide.
 * @param {string} dir the capture directory
 * @param {string} name the project
 * @returns {Promise<{ results: object | null, problem: string | null }>} the results, or why not
 */
async function loadResults(dir, name) {
    let results;
    try {
        results = JSON.parse(await readFile(join(dir, "results.json"), "utf8"));
    } catch {
        if (!existsSync(join(dir, "results.json"))) {
            const marker = await readFile(join(dir, SKIPPED_FILE), "utf8")
                .then((t) => JSON.parse(t))
                .catch(() => null);
            if (isSkipMarker(marker, name)) {
                return { results: null, problem: NOT_AFFECTED };
            }
        }
        return { results: null, problem: "capture failed" };
    }
    const problems = validateResults(results);
    if (problems.length > 0) {
        return { results: null, problem: `invalid results.json: ${problems[0]}` };
    }
    const problem = results.complete ? null : `incomplete: ${results.items.length} of ${results.expected} stories`;
    return { results, problem };
}

/**
 * Builds the request handler.
 * @param {object} options the server's settings
 * @param {string} options.repo the repository accepts are committed in
 * @param {Function} options.gh the gh runner
 * @param {ReturnType<typeof import("./config.mjs").normalizeConfig>} options.config the
 *     repository's settings (visual-review.config.json)
 * @param {string} options.tmp where artifacts are downloaded
 * @param {string} options.token the session token
 * @param {string} options.origin the origin the page is served from
 * @param {number} [options.masterRun] the default branch's CI run to seed from (the target the
 *     page calls "master")
 * @param {() => Promise<{ commit: string, runId: number, waiting: boolean, at: number }[]>} [options.candidates]
 *     lists the default branch's full runs (the config's `candidates` command), `waiting` when one
 *     waits for its screenshots' approval: the page offers the oldest waiting one as the target
 *     "master" and keeps offering it until it stops waiting, its accept commit reaches the default
 *     branch, or a Finish rejects something in it; newer ones queue behind it. Decisions are kept by
 *     image hash, so an image decided on one candidate arrives decided on the next. `masterRun`, when
 *     given, wins
 * @param {string} [options.results] a local directory of `<project>/results.json` instead of CI:
 *     a preview to look at, with no decisions and no Finish
 * @param {string} [options.startCommand] the shell command that starts this server, shown so the
 *     owner can restart it from their own shell and sign Finish with their own key
 * @param {boolean} [options.warm] start downloading every target's captures right away
 * @param {string | null} [options.previews] where tools/visual-preview.sh writes its local previews
 *     (`<previews>/<pr>/<project>/results.json`): a complete preview of a pull request's current
 *     head stands in for each project CI has not captured yet, marked "CI pending", and is decided
 *     and finished like a CI capture. CI's capture replaces it project by project as it lands.
 *     A capture staged as `<previews>/.pending-<commit>/` for a pull request, of a commit that holds
 *     its head but is not pushed yet (the pre-push gate's own, `visual-preview.sh --head`), is
 *     offered as "pending push": decided, never finished, until GitHub lists that commit as the head.
 * @param {number} [options.patience] how long, in milliseconds, a page load waits for a run's
 *     captures before listing the target as downloading; Infinity waits for them
 * @param {number[]} [options.retryDelays] milliseconds before each retry of a Finish's network call
 * @returns {((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>) & { idle: () => Promise<void> }}
 *     the handler, for node:https in the CLI and node:http in the tests; `idle()` settles once no
 *     tile is being made in the background
 */
export function createApp({
    repo,
    gh,
    config,
    tmp,
    token,
    origin,
    masterRun,
    candidates = null,
    results,
    startCommand = null,
    warm,
    previews = null,
    patience = PATIENCE,
    retryDelays,
}) {
    const stateDir = join(tmp, "state");
    const { projects, defaultBranch } = config;
    const names = Object.keys(projects);
    /** @type {Map<string, object>} targets by id: a pull request number, or "master" */
    let targets = new Map();
    // Each pull request branch's fetched tip, read once per refresh, and the review records at a
    // tip (by tip and pull request, kept while the tip is current) for decisionsOf's "still on
    // the branch" check.
    let tips = new Map();
    let recordsAt = new Map();
    // The commit each Finish pushed, by branch, and how many pushes there were: a refresh reads the
    // branch tips once, and while a Finish runs it fetches nothing, so the tips it read can predate
    // the push. Without these, that refresh put back the branch as it was before the push, and the
    // decisions the Finish published read as unpublished again (issue #3040).
    const pushedTips = new Map();
    let pushes = 0;
    /** What the last refresh could not read from GitHub (the pull request list, a git fetch). */
    let listWarnings = [];
    /**
     * Each pull request run REST answered, by run id, with the list's status, conclusion and update
     * time it was read at: a run whose three are unchanged is not asked for again, so a steady
     * refresh costs GitHub one GraphQL query.
     * @type {Map<number, { stamp: string, run: object }>}
     */
    let runsRead = new Map();
    /** The images the owner approved, by `<baseline path> <hash>` (filters.mjs approvalIndex). */
    let approved = new Map();
    /** Review records by blob id: a blob never changes, so each is read once. */
    const recordBlobs = new Map();
    /** The default branch's commit that added each review record blob. */
    const addedIn = new Map();
    /** The record blobs each signed tree statement covers (accept.mjs treeSignedRecords). */
    const statementRecords = new Map();
    /** The stories proven to be capture noise, by `<project>/<file>` (filters.mjs knownNoise). */
    let noise = new Map();
    const evidenceFile = join(stateDir, "noise-evidence.json");
    const noiseFile = join(stateDir, "known-noise.json");
    /** Pull request context by `<pr> <head>`, and the reviewer's login, each asked once. */
    const contexts = new Map();
    let reviewer = null;
    /** Why a target's saved decisions were set aside, by target id. */
    const stateProblems = new Map();
    let finishing = false;
    const jobFile = join(stateDir, "finish.json");
    /**
     * The newest Finish (or update from the default branch, `kind: "update"`), kept after it ends
     * so a reload still shows its result.
     * @type {{ id: number, kind?: "update", target: string, pr: number | null, branch: string | null,
     *     running: boolean, step: string | null, result: object | null, error: string | null,
     *     warnings: string[], interrupted?: true } | null}
     */
    let job = null;
    try {
        const saved = JSON.parse(readFileSync(jobFile, "utf8"));
        if (saved?.running) {
            const where = saved.branch ?? "the visual/seed-* or visual/approve-* branch";
            job = {
                ...saved,
                running: false,
                step: null,
                interrupted: true,
                warnings: saved.warnings ?? [],
                error:
                    `the server stopped while this Finish was at "${saved.step}", so it never ended: check ` +
                    `whether ${where} on origin has its commit before pressing Finish again`,
            };
            console.error(`visual-review: ${job.error}`);
        }
    } catch {
        // No Finish ran yet.
    }
    const persist = (j) => {
        try {
            writeJson(jobFile, j);
        } catch (err) {
            const warning = `could not save the Finish job (a restart would not report it): ${err.message}`;
            if (!j.warnings.includes(warning)) {
                j.warnings.push(warning);
                console.error(`visual-review: ${warning}`);
            }
        }
    };
    let signer = null;
    const rpId = new URL(origin).hostname;
    const pendingFile = join(stateDir, "passkeys-pending.json");
    /** Registration challenges (base64url) and when each expires. */
    const challenges = new Map();
    /**
     * The accept commit each target's Finish was prepared with, and what it waits for: the
     * record's approval (`stage` "record"), the tree statement's ("tree"), or nothing more
     * ("signed").
     * @type {Map<string, { stage: "record" | "tree" | "signed", challenge: string, commit: string,
     *     branch: string, record: string, recordBody: object, pushed: boolean, tree: boolean,
     *     resign: boolean, statement?: object, now: string, work: object, digest: string,
     *     expires: number }>}
     */
    const approvals = new Map();
    // Fails closed: only a missing file means no pending key; any other failure throws.
    const readPending = () => {
        let text;
        try {
            text = readFileSync(pendingFile, "utf8");
        } catch (err) {
            if (err.code === "ENOENT") {
                return [];
            }
            throw err;
        }
        try {
            return parsePasskeys(text);
        } catch (err) {
            throw new Error(`${pendingFile} is invalid: ${err.message}`);
        }
    };
    /**
     * The keys an approval may come from: the fetched default branch's passkeys.json, and the
     * keys this server registered that it does not hold yet. A git failure or an invalid file
     * throws: approval is never skipped because a key could not be read. `trusted` is what may
     * approve: the default branch's keys, or the pending ones while it has none.
     * @returns {Promise<{ main: object[], pending: object[], trusted: object[] }>} the keys
     */
    async function knownKeys() {
        const ref = `refs/remotes/origin/${defaultBranch}`;
        const git = (args) => exec("git", args, { cwd: repo });
        const listed = await git(["ls-tree", "--name-only", ref, "--", PASSKEYS_FILE]);
        const text = listed === "" ? null : await git(["show", `${ref}:${PASSKEYS_FILE}`]);
        let main = [];
        try {
            main = text === null ? [] : parsePasskeys(text);
        } catch (err) {
            throw new Error(`${PASSKEYS_FILE} on ${defaultBranch} is invalid: ${err.message}`);
        }
        const ids = new Set(main.map((k) => k.id));
        const pending = readPending().filter((k) => !ids.has(k.id));
        return { main, pending, trusted: main.length > 0 ? main : pending };
    }
    /** The passkey state the targets screen shows, read when the target list refreshes. */
    let passkeyState = { main: [], pending: [], problem: null };
    // Whether a passkey is known (passkeyState): without one there is nothing to sign with.
    const keysKnown = () => passkeyState.main.length + passkeyState.pending.length > 0;
    const readPasskeys = async () => {
        if (results) {
            return;
        }
        try {
            passkeyState = { ...(await knownKeys()), problem: null };
        } catch (err) {
            passkeyState = { main: [], pending: [], problem: err.message };
        }
    };
    /** An open pull request that registers a passkey, waiting for the owner to merge it. */
    let passkeyPr = null;
    /** The passkey pull request this server opened: listed until GitHub's list or the file has it. */
    let passkeyOpened = null;
    const busy = (t) => finishing && job?.target === t.id;
    const BUSY = "a Finish is running on this target: wait for it to end";

    const itemOf = (t, key) => {
        const at = key.indexOf("/");
        const p = t.projects.find((x) => x.project === key.slice(0, at));
        return p?.results?.items.find((i) => i.file === key.slice(at + 1));
    };
    const stateFile = (t) => join(stateDir, `${t.id}.json`);
    const warned = new Set();
    const warnOnce = (message) => {
        if (!warned.has(message)) {
            warned.add(message);
            console.error(`visual-review: ${message}`);
        }
    };

    /**
     * A target's saved decisions by `<project>/<file>`, each with the hash of the image it was
     * taken on and of the baseline it was compared with (`base`); `bulk` marks an accept from Accept all that was never opened one by one, `posted`
     * a reject an earlier Finish already commented. A file that is not a decisions file is moved
     * aside, never overwritten, so the owner can still recover what it held.
     * @param {object} t the target
     * @returns {Record<string, { decision: string, reason: string | null, hash: string | null,
     *     base?: string | null, bulk?: true, posted?: true }>} the decisions
     */
    const readState = (t) => {
        const file = stateFile(t);
        let saved;
        try {
            saved = JSON.parse(readFileSync(file, "utf8"));
        } catch (err) {
            if (err.code === "ENOENT") {
                return {};
            }
            if (!(err instanceof SyntaxError)) {
                throw err;
            }
        }
        if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
            const aside = `${file}.unreadable-${Date.now()}`;
            renameSync(file, aside);
            stateProblems.set(t.id, `the saved decisions were unreadable; the file was moved to ${aside}`);
            console.error(`visual-review: ${file} is not a decisions file: moved it to ${aside}`);
            return {};
        }
        for (const [k, d] of Object.entries(saved)) {
            if (typeof d !== "object" || d === null || typeof d.decision !== "string") {
                warnOnce(`${file}: ignoring the malformed entry ${JSON.stringify(k)}`);
                delete saved[k];
            }
        }
        return saved;
    };

    /**
     * Changes a target's saved decisions. The file is read, changed and written in one go, so a
     * failed write changes nothing and a second server on the same directory is not overwritten.
     * ponytail: no lock between processes; two writes in the same millisecond can still race.
     * @param {object} t the target
     * @param {(saved: Record<string, object>) => void} change edits the decisions in place
     */
    const update = (t, change) => {
        const saved = readState(t);
        change(saved);
        writeJson(stateFile(t), saved);
    };

    /**
     * Whether the branch still holds what Finish published for a decision: its review record
     * there names the baseline (or the exclusion's settings file) with what Finish wrote. A
     * reject's comment is not on the branch, and with the branch unknown `posted` is trusted.
     * @param {object} t the target
     * @param {string} project the project
     * @param {object} item the results.json item
     * @param {string} decision the decision
     * @returns {boolean} whether it is still published
     */
    const onBranch = (t, project, item, decision) => {
        if (decision === "reject" || !t.published) {
            return true;
        }
        const dir = `${config.baselines}/${project}`;
        if (decision === "exclude") {
            return (t.published.get(`${dir}/${item.id}.json`) ?? null) !== null;
        }
        const to = t.published.get(`${dir}/${item.file}`);
        return to !== undefined && to === (item.status === "removed" ? null : item.capture);
    };

    /**
     * The decisions that apply to this run: those whose item is in it, with the image the decision
     * was taken on and the baseline it was compared with (`base`; a decision saved before it was
     * kept matches any), and still decidable that way. The others stay in the file. So after the
     * branch is updated from the default branch and captured again, a story whose capture and
     * baseline are both unchanged keeps its decision, and one whose baseline moved comes back
     * undecided. An accept or exclusion an earlier Finish published counts as published (`posted`)
     * only while the branch still holds it: after its commit is reverted, Finish publishes it again.
     * @param {object} t the target
     * @returns {Map<string, { decision: string, reason: string | null, bulk?: true, posted?: true,
     *     approvedBefore?: object }>}
     *     by `<project>/<file>`
     */
    const decisionsOf = (t) => {
        const mine = new Map();
        for (const [k, { hash, base, ...d }] of Object.entries(readState(t))) {
            const item = itemOf(t, k);
            const project = k.slice(0, k.indexOf("/"));
            if (
                item &&
                imageHash(item) === hash &&
                (base === undefined || base === (item.baseline ?? null)) &&
                !decisionProblem(item, d.decision, d.reason ?? null) &&
                (d.decision === "reject" || acceptable(t, project))
            ) {
                const { posted, ...rest } = d;
                mine.set(k, posted && !onBranch(t, project, item, d.decision) ? rest : d);
            }
        }
        addApprovedBefore(t, mine);
        return mine;
    };

    // Adds an accept to `mine` for each undecided item whose exact image was approved before.
    const addApprovedBefore = (t, mine) => {
        for (const p of t.projects) {
            for (const item of p.results?.items ?? []) {
                const k = `${p.project}/${item.file}`;
                const before = mine.has(k) ? null : approvedBefore(t, p.project, item);
                if (before) {
                    // Published once the branch's own record takes the file to this image.
                    const posted = t.published?.get(`${config.baselines}/${k}`) === item.capture;
                    mine.set(k, {
                        decision: "accept",
                        reason: null,
                        approvedBefore: before,
                        ...(posted && { posted }),
                    });
                }
            }
        }
    };

    /**
     * The earlier approval of exactly this image for this story, when the item can be accepted on
     * it: a change, a new story or one with no baseline yet, never a rename or a removal.
     * @param {object} t the target
     * @param {string} project the project
     * @param {object} item the results.json item
     * @returns {{ pr: number | null, commit: string, record: string, reviewedAt: string } | null} it
     */
    const approvedBefore = (t, project, item) =>
        ["changed", "new", "unseeded"].includes(item.status) && !item.from && item.capture && acceptable(t, project)
            ? (approved.get(`${config.baselines}/${project}/${item.file} ${item.capture}`) ?? null)
            : null;

    /**
     * Reads the review records on the default branch and on every listed pull request's branch,
     * each blob once, into the index of approved images. Records verify as the gate verifies them,
     * by their own approval or by a signed statement of a baselines tree that holds them; with the
     * keys unreadable, nothing counts as approved before.
     * @param {object[]} list the targets
     */
    async function readApprovals(list) {
        if (passkeyState.problem !== null) {
            approved = new Map();
            return;
        }
        const keys = passkeyState.main.length > 0 ? passkeyState.main : null;
        const records = [];
        for (const { sha, main } of await approvalRefs(list)) {
            const signed = keys ? await treeSignedRecords(repo, sha, config, keys, statementRecords) : new Set();
            for (const r of await reviewRecordsAt(sha, main)) {
                records.push({ ...r, treeSigned: signed.has(r.blob) });
            }
        }
        approved = approvalIndex(records, keys);
    }

    const gitIn = (args) => exec("git", args, { cwd: repo });
    const haveCommit = (sha) =>
        gitIn(["cat-file", "-e", `${sha}^{commit}`]).then(
            () => true,
            () => false,
        );

    /**
     * Where earlier approvals are read: the default branch's tip, and each pull request's head as
     * GitHub names it, a fork's too, fetched from refs/pull/<n>/head (never a branch of the same
     * name on origin).
     * @param {object[]} list the targets
     * @returns {Promise<{ sha: string, main: boolean }[]>} the commits
     */
    async function approvalRefs(list) {
        const refs = tips.get(defaultBranch) ? [{ sha: tips.get(defaultBranch), main: true }] : [];
        for (const t of list.filter((x) => x.pr !== null && /^[0-9a-f]{40}$/.test(x.head ?? ""))) {
            if (!(await haveCommit(t.head))) {
                const ref = `+refs/pull/${t.pr}/head:refs/visual-review/pull/${t.pr}`;
                await gitIn(["fetch", "-q", "origin", ref]).catch(() => {});
            }
            if (await haveCommit(t.head)) {
                refs.push({ sha: t.head, main: false });
            }
        }
        return refs;
    }

    /**
     * The review records at a commit, each blob read once. On the default branch each names the
     * commit that added it, which the gate finds on the base of every pull request branched later.
     * @param {string} sha the commit
     * @param {boolean} main whether it is the default branch's tip
     * @returns {Promise<{ ref: string, commit: string, path: string, blob: string, record: any,
     *     main: boolean }[]>} them
     */
    async function reviewRecordsAt(sha, main) {
        const out = [];
        const listing = await gitIn(["ls-tree", sha, "--", `${config.baselines}/reviews/`]).catch(() => "");
        for (const line of listing.split("\n")) {
            const [meta, path] = line.split("\t");
            const blob = meta.split(" ")[2];
            if (!path?.endsWith(".json")) {
                continue;
            }
            if (!recordBlobs.has(blob)) {
                recordBlobs.set(blob, await gitIn(["cat-file", "blob", blob]).then(JSON.parse, () => null));
            }
            if (main && !addedIn.has(blob)) {
                addedIn.set(blob, await gitIn(["log", "-1", "--format=%H", "--diff-filter=A", sha, "--", path]));
            }
            const commit = (main && addedIn.get(blob)) || sha;
            out.push({ ref: sha, commit, path, blob, record: recordBlobs.get(blob), main });
        }
        return out;
    }

    /**
     * The directory of a project's package: its Storybook directory's parent.
     * @param {string} name the project
     * @returns {string} the directory, relative to the repository
     */
    const packageOf = (name) => dirname(projects[name]?.storybook ?? name);
    // Whether a target's pull request changes no file of a project's package.
    const untouched = (t, name) =>
        Array.isArray(t.changedFiles) && !t.changedFiles.some((f) => f.startsWith(`${packageOf(name)}/`));

    /**
     * Adds what these targets' captures show about capture noise to the evidence kept on disk,
     * and writes the stories it proves noisy where `GET /api/noise` and githerd read them.
     * ponytail: keeps the newest 20,000 observations; a real store if that ever forgets too soon.
     * @param {object[]} list the targets
     */
    function recordNoise(list) {
        let evidence = [];
        try {
            evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
        } catch (err) {
            // None kept yet, or not JSON: start again. A file that cannot be read is kept as it
            // is, never overwritten with this refresh's evidence alone.
            if (err.code && err.code !== "ENOENT") {
                const warning = `could not read the capture noise evidence (${evidenceFile}): ${err.message}`;
                console.error(`visual-review: ${warning}`);
                listWarnings.push(warning);
                return;
            }
        }
        const id = (o) => `${o.key} ${o.pr} ${o.baseline} ${o.capture}`;
        const have = new Set(evidence.map(id));
        for (const t of list) {
            for (const o of observations(t, packageOf)) {
                if (!have.has(id(o))) {
                    have.add(id(o));
                    evidence.push(o);
                }
            }
        }
        evidence = evidence.slice(-20000);
        noise = knownNoise(evidence);
        try {
            writeJson(evidenceFile, evidence);
            writeJson(noiseFile, noiseReport());
        } catch (err) {
            const warning = `could not keep the capture noise evidence (${noiseFile} is not current): ${err.message}`;
            console.error(`visual-review: ${warning}`);
            listWarnings.push(warning);
        }
    }
    const noiseReport = () => ({
        at: Date.now(),
        stories: [...noise].map(([key, n]) => ({
            project: key.slice(0, key.indexOf("/")),
            file: key.slice(key.indexOf("/") + 1),
            ...n,
        })),
    });

    // `problem` is what CI said (the job failed, or no artifact); results.json can add its own. A
    // pull request's capture (`vsBase`) is also compared with the default branch's baselines.
    async function project(name, dir, problem, vsBase = false) {
        const loaded = dir ? await loadResults(dir, name) : { results: null, problem: null };
        if (loaded.results && vsBase) {
            const ref = `refs/remotes/origin/${defaultBranch}`;
            const { headSha: head } = loaded.results;
            await againstBase({
                repo,
                ref,
                head,
                baselines: config.baselines,
                project: name,
                dir,
                results: loaded.results,
            }).catch((err) => {
                loaded.results = null;
                loaded.problem = `not compared with ${defaultBranch}'s baselines: ${err.message}`;
            });
        }
        if (loaded.results) {
            prewarm(dir, loaded.results);
        }
        return { project: name, dir, results: loaded.results, problem: problem ?? loaded.problem, logUrl: null };
    }

    /**
     * The gh runner for one finished run: what GitHub says about it (its jobs, its artifacts) no
     * longer changes, so each answer is asked once and kept on disk beside the run's downloads,
     * and pruned with them. A refresh then asks GitHub only for the pull requests and their newest
     * runs. ponytail: an artifact that expires later is still listed as there; its download fails
     * and says so, which only matters for a capture never downloaded in its 90 days.
     * @param {{ id: number, attempt: number }} run the finished run
     * @returns {Function} the gh runner
     */
    const kept = (run) => async (args, input) => {
        if (args[0] !== "api") {
            return gh(args, input);
        }
        const name = sha256(args.join(" ")).slice(0, 16);
        const file = join(tmp, `${run.id}-${run.attempt}`, "gh", `${name}.json`);
        const saved = await readFile(file, "utf8").catch(() => null);
        if (saved !== null) {
            return saved;
        }
        const answer = await gh(args, input);
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(`${file}.tmp`, answer);
            renameSync(`${file}.tmp`, file);
        } catch (err) {
            warnOnce(`could not keep GitHub's answers in ${dirname(file)}: ${err.message}`);
        }
        return answer;
    };

    /**
     * A listed pull request's CI run as REST answers it: the attempt is only there, so REST is
     * asked only when the list shows the run changed since the last refresh.
     * @param {{ run: { id: number, status: string, conclusion: string | null, updatedAt: string } | null }} pr
     *     the listed pull request
     * @param {Map<number, { stamp: string, run: object }>} read collects this refresh's runs
     * @returns {Promise<object | null>} the run, or null when CI never ran on the head
     */
    async function runOf({ run }, read) {
        if (!run) {
            return null;
        }
        const stamp = `${run.status} ${run.conclusion} ${run.updatedAt}`;
        const was = runsRead.get(run.id);
        const got = was?.stamp === stamp ? was.run : await getRun(gh, run.id);
        // Kept only when REST agrees with the list, so an answer that lags it is asked again.
        if (got.status === run.status && got.conclusion === run.conclusion) {
            read.set(run.id, { stamp, run: got });
        }
        return got;
    }

    async function build(info, run) {
        const g = run.status === "completed" ? kept(run) : gh;
        const jobs = await visualJobs(g, run, run.attempt, names);
        const others = [];
        // Each project's capture as its download lands; `partial` is the target listed while the
        // rest are still downloading, whose rows fill in one by one. `download` counts the
        // artifacts and their bytes, for the page's progress.
        const landed = new Map();
        const download = { done: 0, total: names.length, bytesDone: 0, bytes: null, startedAt: Date.now() };
        let sizes = {};
        let partial = null;
        const fill = async (name) => {
            const p = await project(
                name,
                landed.get(name)?.dir,
                problemOf(name, landed.get(name), run, jobs),
                info.pr !== null,
            );
            p.logUrl = jobs[name]?.url ?? run.url;
            p.bytes = sizes[name] ?? null;
            partial.projects[names.indexOf(name)] = p;
            await withPreviews(partial);
            await decorate(partial);
        };
        const downloads = downloadCaptures(
            g,
            run,
            names,
            tmp,
            others,
            (name, got) => {
                landed.set(name, got);
                if (got) {
                    download.done++;
                    download.bytesDone += got.bytes;
                }
                if (partial) {
                    fill(name).catch((err) => console.error(`visual-review: ${name} of ${info.id}: ${err.message}`));
                }
            },
            (planned) => {
                sizes = planned;
                download.total = Object.keys(planned).length;
                download.bytes = Object.values(planned).reduce((a, b) => a + b, 0);
            },
        );
        downloads.catch(() => {}); // A download still running after `patience` fails on a later refresh.
        const downloaded = await (patience === Infinity
            ? downloads
            : Promise.race([downloads, new Promise((resolve) => setTimeout(resolve, patience, null).unref())]));
        if (!downloaded) {
            // Listed as downloading, and rebuilt in the cache when the download lands, so the page
            // (which asks again every few seconds) fills the rows in without a refresh.
            downloads
                .then(async () => {
                    await refreshing?.catch(() => {});
                    const shown = targets.get(info.id);
                    if (shown?.downloading && shown.runId === run.id && shown.runAttempt === run.attempt) {
                        const built = await build(info, run);
                        await decorate(built);
                        if (targets.get(info.id) === shown) {
                            targets.set(info.id, built);
                            save();
                        }
                    }
                })
                .catch((err) => console.error(`visual-review: rebuilding ${info.id} failed: ${err.message}`));
            partial = blank(info, null, run);
            partial.downloading = true;
            partial.download = download;
            for (const p of partial.projects) {
                p.downloading = true;
                p.bytes = sizes[p.project] ?? null;
            }
            for (const name of landed.keys()) {
                await fill(name);
            }
            return partial;
        }
        const list = [];
        for (const name of names) {
            const p = await project(
                name,
                downloaded[name]?.dir,
                problemOf(name, downloaded[name], run, jobs),
                info.pr !== null,
            );
            p.logUrl = jobs[name]?.url ?? run.url;
            list.push(p);
        }
        const warnings = others.map(
            (p) =>
                `the run captured ${p}, which this server's ${CONFIG_FILE} does not list: serve from a checkout that has it`,
        );
        return withPreviews({
            ...info,
            runId: run.id,
            runAttempt: run.attempt,
            runUrl: run.url,
            projects: list,
            warnings,
        });
    }

    /**
     * Puts a pull request's local preview in place of every project CI has not captured (nor is
     * downloading): only a complete preview of the head GitHub lists now, or of an older head the
     * branch has since added only a Finish's own commits to (onlyFinishCommits: they change no
     * capture), so one of an older push, or one still capturing, is never offered. A draft (whose CI
     * never captures) with a preview of an older push says a new preview is needed instead. While
     * a preview of this head is still capturing (its status.json), or it finished without a project
     * it lists, that project shows as not loaded, never as having nothing to decide; `previewStamp`
     * is when status.json last changed, so a change re-reads the list (previewsChanged).
     * @param {object} t the target, changed in place; `head` is the pull request's head
     * @returns {Promise<object>} the target
     */
    async function withPreviews(t) {
        if (!previews || t.pr === null) {
            return t;
        }
        t.previewStamp = previewStamp(t.pr);
        t.pendingPush = null;
        const pending = await pendingPreview(t);
        for (const [i, p] of t.projects.entries()) {
            t.projects[i] = (pending && (await withPending(t, p, pending))) ?? (await withPreview(t, p));
        }
        await markPreviewStatus(t);
        return t;
    }

    /**
     * The newest capture of a commit not pushed yet that holds the pull request's head: the pre-push
     * gate's own capture (tools/visual-preview.sh --head, staged as `.pending-<commit>`), made for this
     * pull request while the gate checks the commit it is about to push. It is offered as "pending push":
     * decided like any preview of the pull request (its decisions are saved by story file and image
     * hash, so a later capture with the same picture keeps them), but never finished, since Finish signs
     * only a capture of the head GitHub lists. A capture that failed is never offered.
     * @param {object} t the target
     * @returns {Promise<{ dir: string, head: string, at?: string } | null>} the capture
     */
    async function pendingPreview(t) {
        const sha = (x) => /^[0-9a-f]{40}$/.test(x ?? "");
        if (!sha(t.head)) {
            return null;
        }
        let best = null;
        for (const name of pendingNames()) {
            const dir = join(previews, name);
            const status = readStatusIn(dir);
            if (status?.pr !== t.pr || !sha(status.head) || status.head === t.head || status.state === "failed") {
                continue;
            }
            if (best && String(best.at) >= String(status.updatedAt)) {
                continue;
            }
            if (!(await haveCommit(t.head))) {
                await branchesFetched;
            }
            const holds = await gitIn(["merge-base", "--is-ancestor", t.head, status.head]).then(
                () => true,
                () => false,
            );
            if (holds) {
                best = { dir, head: status.head, at: status.updatedAt };
            }
        }
        return best;
    }

    // One project of a target with the pending capture in place when CI has not captured it and the
    // capture has it complete; null otherwise (the project as withPreview leaves it).
    async function withPending(t, p, pending) {
        const dir = join(pending.dir, p.project);
        if (p.results || p.downloading || !existsSync(join(dir, "results.json"))) {
            return null;
        }
        const local = await project(p.project, dir, null, true);
        const r = local.results;
        if (!r?.complete || !isPreviewOf(r, t.pr) || r.headSha !== pending.head) {
            return null;
        }
        t.pendingPush = pending.head;
        return { ...local, preview: true, pending: true, ciProblem: p.problem, logUrl: p.logUrl ?? null };
    }

    // One project of a target with its local preview in place when CI has not captured it and the
    // preview is of this head; as it was otherwise (or saying a draft needs a new preview).
    async function withPreview(t, p) {
        const dir = join(previews, String(t.pr), p.project);
        if (p.results || p.downloading || !existsSync(join(dir, "results.json"))) {
            return p;
        }
        const local = await project(p.project, dir, null, true);
        const r = local.results;
        if (!r?.complete || !isPreviewOf(r, t.pr)) {
            return p;
        }
        // A head pushed since the last fetch (a Finish's commits): wait for this refresh's fetch.
        if (r.headSha !== t.head && !(await haveCommit(t.head))) {
            await branchesFetched;
        }
        if (await onlyFinishCommits(repo, r.headSha, t.head, config)) {
            return { ...local, preview: true, ciProblem: p.problem, logUrl: p.logUrl ?? null };
        }
        return t.draft ? { ...p, problem: newPreviewNeeded(t) } : p;
    }

    // Marks each project a preview of this head is still capturing, or finished without loading,
    // as not loaded (from the preview's status.json).
    async function markPreviewStatus(t) {
        const status = readPreviewStatus(t.pr);
        if (!status?.head || !(await onlyFinishCommits(repo, status.head, t.head, config))) {
            return;
        }
        for (const [i, p] of t.projects.entries()) {
            const listed = (status.projects ?? []).includes(p.project);
            if (p.results || p.downloading || p.problem === NOT_AFFECTED) {
                continue;
            }
            if (status.state === "running") {
                t.projects[i] = { ...p, problem: PREVIEW_CAPTURING };
            } else if (listed) {
                t.projects[i] = { ...p, problem: `local preview not loaded (${status.state}): reload the page` };
            }
        }
    }

    const previewStatusFile = (pr) => join(previews, String(pr), "status.json");
    const readStatusIn = (dir) => {
        try {
            return JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
        } catch {
            return null;
        }
    };
    const readPreviewStatus = (pr) => readStatusIn(join(previews, String(pr)));
    // The captures the pre-push gate staged under the commit it checks (pendingPreview).
    const pendingNames = () => {
        try {
            return readdirSync(previews).filter((n) => n.startsWith(".pending-"));
        } catch {
            return [];
        }
    };
    const mtimeOf = (file) => {
        try {
            return statSync(file).mtimeMs;
        } catch {
            return null;
        }
    };
    // When a pull request's preview status.json, or any staged capture's, last changed: a staged
    // capture may be a pending push of this pull request.
    const previewStamp = (pr) =>
        [
            mtimeOf(previewStatusFile(pr)),
            ...pendingNames().map((n) => `${n}:${mtimeOf(join(previews, n, "status.json"))}`),
        ].join(",");
    // Whether a listed pull request's local preview changed since the list read it, each change
    // counted once: a refresh that cannot reach GitHub keeps the old list, and must not start another.
    const previewSeen = new Map();
    const previewsChanged = () => {
        let changed = false;
        for (const t of previews ? targets.values() : []) {
            const now = previewStamp(t.pr);
            if ("previewStamp" in t && now !== t.previewStamp && now !== previewSeen.get(t.pr)) {
                previewSeen.set(t.pr, now);
                changed = true;
            }
        }
        return changed;
    };

    // Why a target has no Finish now, as a response; null when it has one.
    const finishRefused = (t) => {
        if (t.local) {
            return [403, { error: "a local preview has no Finish" }];
        }
        if (t.pendingPush) {
            return [409, { error: pendingPushText(t) }];
        }
        return null;
    };
    const pendingPushText = (t) =>
        `pending push: these screenshots are of ${t.pendingPush.slice(0, 10)}, which the gate is still checking; ` +
        `Finish opens once it is the head of #${t.pr}`;
    const newPreviewNeeded = (t) =>
        `a new preview is needed for this head (${t.head.slice(0, 10)}): run tools/visual-preview.sh ${t.pr}`;

    // Why a project's capture is missing, from its download and its CI job; null when it is there.
    function problemOf(name, got, run, jobs) {
        const job = jobs[name];
        if (got?.error) {
            return retryLater("download failed", got.error);
        }
        if (got?.expired) {
            return "artifact expired: re-run the visual job";
        }
        if (!got && run.status !== "completed" && job?.conclusion !== "failure") {
            return "CI still running; reload when it finishes";
        }
        if (!got || job?.conclusion === "failure") {
            return job ? "capture failed" : "no capture";
        }
        return null;
    }

    const retryLater = (what, message) => `${what}: ${message.split("\n")[0]}; reload the page to retry`;

    // A target with no capture to show: GitHub would not give it to us (after gh's retries), CI has
    // not run yet, or its download is still going. The other targets still load.
    const blank = (info, problem, run = null) => ({
        ...info,
        runId: run?.id ?? null,
        runAttempt: run?.attempt ?? null,
        runUrl: run?.url ?? null,
        projects: names.map((n) => ({ project: n, dir: null, results: null, problem, logUrl: run?.url ?? null })),
        warnings: [],
    });

    // A target that loaded before keeps what it showed when a later refresh of it fails.
    const keptOr = (info, err) => {
        const old = targets.get(info.id);
        return old?.runId && old.candidate?.commit === info.candidate?.commit
            ? { ...old, draft: info.draft, warnings: [retryLater("could not refresh", err.message)] }
            : blank(info, retryLater("failed to load", err.message));
    };

    // Concurrent callers (the startup refresh, the page's first request) share one refresh.
    let refreshing = null;
    /** The running refresh's fetch of the pull requests' branches (load). */
    let branchesFetched = Promise.resolve();
    let refreshedAt = 0;
    let loadedOnce = false;
    /** Why the last refresh failed as a whole (no list at all), for the page; null once one works. */
    let failure = null;
    /** What the running refresh is doing, for the page: a step, a count, and when it began. */
    let progress = null;
    const step = (name, done = null, total = null) => {
        if (progress) {
            Object.assign(progress, { step: name, done, total });
        }
    };
    const refresh = () =>
        (refreshing ??= (async () => {
            progress = { step: "starting", done: null, total: null, startedAt: Date.now() };
            try {
                await load();
                loadedOnce = true;
                failure = null;
            } catch (err) {
                failure = err.message.split("\n")[0];
                throw err;
            } finally {
                refreshing = null;
                refreshedAt = Date.now();
                progress = null;
            }
        })());

    /**
     * The default branch's target: the run given with --master-run (a seed), or the candidate
     * offered (offeredCandidate), or null when there is neither.
     * @returns {Promise<object | null>} the target
     */
    async function masterTarget() {
        // A Finish of the offered candidate is running: it stays offered until the Finish ends.
        if (finishing && targets.get("master")?.candidate) {
            return targets.get("master");
        }
        const pick = !masterRun && candidates ? await offeredCandidate() : null;
        const runId = masterRun ?? pick?.offered?.runId;
        if (!runId) {
            return null;
        }
        step(`reading ${defaultBranch}'s CI run`);
        const info = { id: "master", pr: null, title: defaultBranch, url: null, branch: null };
        if (pick?.offered) {
            const { commit } = pick.offered;
            info.title = `${defaultBranch} candidate ${commit.slice(0, 10)} (${pick.queued.length} queued)`;
            info.candidate = { commit, runId, queued: pick.queued.map((c) => ({ commit: c.commit, runId: c.runId })) };
        }
        return getRun(gh, runId)
            .then((run) => build(info, run))
            .catch((err) => keptOr(info, err));
    }

    async function load() {
        const next = new Map();
        if (results) {
            const list = await Promise.all(
                names.map((n) =>
                    existsSync(join(results, n, "results.json"))
                        ? project(n, join(results, n), null)
                        : project(n, null, "no capture"),
                ),
            );
            const r = list.find((p) => p.results)?.results;
            if (r) {
                // Never "master" or a pull request: a preview is not a seed and has no Finish.
                next.set("local", {
                    id: "local",
                    pr: null,
                    local: true,
                    title: `local preview of ${results}`,
                    url: null,
                    branch: null,
                    runId: r.runId,
                    runAttempt: r.runAttempt,
                    runUrl: null,
                    projects: list,
                });
            }
        } else {
            // When the list of pull requests cannot be read, the ones listed before stay, and the
            // master seed still loads.
            listWarnings = [];
            const kept = [...targets.values()].filter((t) => t.pr !== null);
            step("listing pull requests");
            // This refresh's runs (runOf); a failed list keeps what the last one learned.
            let read = new Map();
            const prs = await openPullRequests(gh, config).catch((err) => {
                if (!masterRun && !candidates && kept.length === 0) {
                    throw err;
                }
                console.error(`visual-review: pull requests not listed: ${err.message}`);
                const warning = retryLater("could not list the pull requests", err.message);
                listWarnings.push(warning);
                for (const t of kept) {
                    next.set(t.id, { ...t, warnings: [warning] });
                }
                read = runsRead;
                return [];
            });
            // Best effort: the default branch and the pull requests' branches, so the badge below
            // sees what accept will see. Skipped while a Finish runs, which fetches and pushes too.
            const fetch = (refs) =>
                exec("git", ["fetch", "-q", "origin", ...refs], {
                    cwd: repo,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
                });
            const ref = (b) => `+refs/heads/${b}:refs/remotes/origin/${b}`;
            const logFetch = (what) => (err) => {
                console.error(`visual-review: git fetch of ${what} failed: ${err.message}`);
                listWarnings.push(`git fetch of ${what} failed, so "behind master" may be wrong: ${err.message}`);
            };
            const fetched = (async () => {
                if (finishing) {
                    return;
                }
                await fetch([ref(defaultBranch)]).catch(logFetch(defaultBranch));
                // One fetch for every branch; one missing on origin (a fork's, a deleted one) fails
                // them all, so then one at a time.
                if (prs.length > 0) {
                    await fetch(prs.map((p) => ref(p.branch))).catch(async () => {
                        for (const p of prs) {
                            await fetch([ref(p.branch)]).catch(logFetch(`${p.branch} (#${p.number})`));
                        }
                    });
                }
            })();
            branchesFetched = fetched;
            // Every pull request at once: one after another took about 40 s for 18 of them.
            let found = 0;
            step("finding CI runs", 0, prs.length);
            const built = await Promise.all(
                prs.map(async (pr) => {
                    const info = {
                        id: String(pr.number),
                        pr: pr.number,
                        title: pr.title,
                        url: pr.url,
                        branch: pr.branch,
                        head: pr.headSha,
                        draft: pr.draft,
                    };
                    try {
                        const run = await runOf(pr, read);
                        return run
                            ? await build(info, run)
                            : await withPreviews(blank(info, `waiting for CI on ${pr.headSha.slice(0, 10)}`));
                    } catch (err) {
                        return keptOr(info, err);
                    } finally {
                        step("finding CI runs", ++found, prs.length);
                    }
                }),
            );
            runsRead = read;
            step("fetching branches");
            await fetched;
            await readPasskeys();
            // GitHub's list can lag a pull request just opened: keep it a while, until its key is merged.
            const opened =
                passkeyOpened &&
                Date.now() - passkeyOpened.at < 5 * 60000 &&
                !passkeyState.main.some((k) => k.id === passkeyOpened.id)
                    ? passkeyOpened.number
                    : null;
            passkeyPr = prs.find((p) => p.branch.startsWith("visual/passkey-"))?.number ?? opened;
            for (const t of built) next.set(t.id, t);
            const master = await masterTarget();
            if (master) {
                next.set("master", master);
            }
        }
        let seen = pushes;
        await readTips();
        step("checking the baselines", 0, next.size);
        let checked = 0;
        for (const t of next.values()) {
            await decorate(t);
            step("checking the baselines", ++checked, next.size);
        }
        if (!results) {
            step("reading earlier approvals");
            await readApprovals([...next.values()]);
            recordNoise([...next.values()]);
        }
        signer = await signingIdentity(repo);
        await republish(next, seen);
        targets = next;
        save();
        prune();
    }

    /**
     * The candidate mode's state: the candidates a Finish rejected something in, by commit (never
     * offered again), and the one offered last.
     */
    const candidatesFile = join(stateDir, "candidates.json");
    let dropped = new Set();
    let offeredBefore = null;
    /** Dropped candidates whose accept pull request could not be closed yet: tried at every refresh. */
    let toClose = new Set();
    try {
        const kept = JSON.parse(readFileSync(candidatesFile, "utf8"));
        dropped = new Set(kept.dropped);
        offeredBefore = kept.offered ?? null;
        toClose = new Set(kept.toClose ?? []);
    } catch {
        // No candidate offered yet.
    }
    const saveCandidates = () =>
        writeJson(candidatesFile, { dropped: [...dropped], offered: offeredBefore, toClose: [...toClose] });
    // Closes the accept pull requests a rejecting Finish could not close; a failure stays a warning.
    const closeLeftOpen = async () => {
        for (const commit of toClose) {
            const { closeError } = await closeCandidatePullRequest(gh, { candidate: commit });
            if (closeError) {
                listWarnings.push(
                    `the accept pull request of rejected candidate ${commit.slice(0, 10)} is still open: ${closeError}`,
                );
            } else {
                toClose.delete(commit);
                saveCandidates();
            }
        }
    };
    const dropCandidate = (commit) => {
        dropped.add(commit);
        saveCandidates();
    };
    /**
     * Starts a newly offered candidate: its decisions are the saved ones, by image hash, but none
     * of them is published on it yet, so its Finish sends them all again (the rejects too, so a
     * rejected image drops it as well).
     * @param {string} commit the candidate
     */
    const offerCandidate = (commit) => {
        update({ id: "master" }, (saved) => {
            for (const d of Object.values(saved)) {
                delete d.posted;
            }
        });
        offeredBefore = commit;
        saveCandidates();
    };
    /**
     * Refuses a candidate list that is not the `candidates` command's shape.
     * @param {unknown} list what the command printed, parsed
     * @returns {object[]} the list
     */
    const checkedCandidates = (list) => {
        const ok = (c) =>
            typeof c?.commit === "string" &&
            /^[0-9a-f]{40}$/.test(c.commit) &&
            Number.isInteger(c.runId) &&
            typeof c.waiting === "boolean" &&
            typeof c.at === "number";
        if (!Array.isArray(list)) {
            throw new TypeError("the candidates command must print [{ commit, runId, waiting, at }]");
        }
        const bad = list.filter((c) => !ok(c)).length;
        if (bad > 0) {
            listWarnings.push(`the candidates command listed ${bad} malformed ${bad === 1 ? "row" : "rows"}, left out`);
        }
        return list.filter(ok);
    };
    /** The last candidate list read, kept when the next read fails. */
    let lastList = [];
    /**
     * Whether a candidate's accept commit (exactly masterSubject's subject) is on the default branch
     * as last fetched, with its review record still there: its approval merged, so it is done
     * whatever the list says.
     * @param {string} commit the candidate
     * @returns {Promise<boolean>} whether it merged
     */
    const approvalMerged = async (commit) => {
        const tip = `refs/remotes/origin/${defaultBranch}`;
        const subject = masterSubject(config.commitPrefix, commit);
        const log = await gitIn(["log", "--format=%x01%s%n%b", "--fixed-strings", `--grep=${subject}`, tip]).catch(
            () => "",
        );
        for (const message of log.split("\x01")) {
            const [first, ...body] = message.split("\n");
            const record = first === subject ? /^Record: (.+)$/m.exec(body.join("\n"))?.[1] : undefined;
            // Its record still on the default branch: a revert of the accept pull request removes it.
            const kept =
                record &&
                (await gitIn(["cat-file", "-e", `${tip}:${record}`]).then(
                    () => true,
                    () => false,
                ));
            if (kept) {
                return true;
            }
        }
        return false;
    };
    /**
     * The candidate to offer: the oldest waiting full run not dropped and not approved on the
     * default branch, and the newer ones queued behind it. Oldest first, so a newer run never moves
     * the one under review.
     * @returns {Promise<{ offered: object | null, queued: object[] }>} the pick
     */
    async function offeredCandidate() {
        await closeLeftOpen();
        try {
            lastList = checkedCandidates(await candidates());
        } catch (err) {
            console.error(`visual-review: candidates not listed: ${err.message}`);
            listWarnings.push(retryLater("could not list the candidates", err.message));
        }
        const waiting = [];
        for (const c of [...lastList].filter((x) => x.waiting).sort((a, b) => a.at - b.at)) {
            if (!dropped.has(c.commit) && !(await approvalMerged(c.commit))) {
                waiting.push(c);
            }
        }
        if (waiting[0] && waiting[0].commit !== offeredBefore) {
            offerCandidate(waiting[0].commit);
        }
        return { offered: waiting[0] ?? null, queued: waiting.slice(1) };
    }

    const listFile = join(stateDir, "list.json");
    const inboxFile = join(stateDir, "inbox.json");
    /** When each pull request entered the inbox's ready list, by readyKey; kept across restarts. */
    let readySince = new Map();
    try {
        const kept = JSON.parse(readFileSync(inboxFile, "utf8"));
        readySince = new Map(kept.ready.map((r) => [readyKey(r), r.since]));
    } catch {
        // No inbox kept yet.
    }
    /**
     * The pending-approvals inbox of the listed pull requests (inbox.mjs).
     * @param {object[]} [summaries] their summaries, when the caller has them already
     * @returns {ReturnType<typeof inboxOf>} the inbox
     */
    const inbox = (summaries = [...targets.values()].map(summary)) => {
        const now = Date.now();
        const box = inboxOf(summaries, { now, since: readySince, coupling: couplings() });
        readySince = new Map(box.ready.map((r) => [readyKey(r), r.since]));
        return box;
    };
    /**
     * Keeps the list of targets on disk, without the captures' results (results.json is read again
     * from each capture's directory), so a restarted server shows it before GitHub answers.
     */
    function save() {
        if (results) {
            return;
        }
        try {
            // For the notifier (`visual-review notify`), which reads only this file.
            writeJson(inboxFile, { at: Date.now(), origin, ...inbox() });
        } catch (err) {
            const warning = `could not keep the inbox (the notifier reads it): ${err.message}`;
            console.error(`visual-review: ${warning}`);
            if (!listWarnings.includes(warning)) {
                listWarnings.push(warning);
            }
        }
        try {
            writeJson(listFile, {
                at: Date.now(),
                targets: [...targets.values()].map((t) => ({
                    ...t,
                    earlier: [...(t.earlier ?? [])],
                    published: t.published ? [...t.published] : null,
                    projects: t.projects.map((p) => ({ ...p, results: undefined })),
                })),
            });
        } catch (err) {
            const warning = `could not keep the list of targets (a restart would wait for GitHub): ${err.message}`;
            console.error(`visual-review: ${warning}`);
            if (!listWarnings.includes(warning)) {
                listWarnings.push(warning);
            }
        }
    }

    // One project of the kept list with its results read again; listed as downloading when they
    // are gone.
    async function restoredProject(p, t) {
        const there = p.dir && (existsSync(join(p.dir, "results.json")) || existsSync(join(p.dir, SKIPPED_FILE)));
        const loaded = there ? await project(p.project, p.dir, p.problem, t.pr !== null && !t.local) : null;
        return p.dir && !loaded?.results && loaded?.problem !== NOT_AFFECTED
            ? { ...p, dir: null, results: null, problem: null, downloading: true }
            : { ...p, results: loaded?.results ?? null };
    }

    /**
     * The list a previous run of this server kept, shown until the first refresh replaces it. A
     * capture whose directory is gone is listed as downloading: that refresh downloads it again.
     */
    async function restore() {
        let saved;
        try {
            saved = JSON.parse(readFileSync(listFile, "utf8"));
        } catch {
            return; // Never saved, or unreadable: the first refresh builds the list.
        }
        try {
            const next = new Map();
            for (const t of saved.targets) {
                const list = [];
                for (const p of t.projects) {
                    list.push(await restoredProject(p, t));
                }
                const downloading = t.downloading === true || list.some((p) => p.downloading);
                next.set(t.id, {
                    ...t,
                    earlier: new Map(t.earlier),
                    published: t.published ? new Map(t.published) : null,
                    projects: list,
                    downloading,
                });
            }
            signer = await signingIdentity(repo);
            await readPasskeys();
            await readTips();
            if (!loadedOnce) {
                targets = next;
                loadedOnce = true;
                refreshedAt = saved.at;
            }
        } catch (err) {
            console.error(`visual-review: ignoring the kept list in ${listFile}: ${err.message}`);
        }
    }

    // A Finish that pushed while a refresh ran (after `seen` pushes): reads what each branch
    // publishes again. The caller swaps in the list right after, with no await between.
    async function republish(next, seen) {
        while (seen !== pushes) {
            seen = pushes;
            for (const t of next.values()) {
                t.published = await publishedOn(t);
            }
        }
    }

    // Every fetched branch tip in one git call, once per refresh.
    async function readTips() {
        const out = await exec(
            "git",
            ["for-each-ref", "--format=%(objectname) %(refname:lstrip=3)", "refs/remotes/origin/"],
            { cwd: repo },
        ).catch(() => "");
        tips = new Map(
            out
                .split("\n")
                .filter(Boolean)
                .map((l) => [l.slice(l.indexOf(" ") + 1), l.slice(0, l.indexOf(" "))]),
        );
        // A commit's records never change: keep those of tips still current.
        const current = new Set(tips.values());
        recordsAt = new Map([...recordsAt].filter(([key]) => current.has(key.split(" ")[0])));
    }

    // What this pull request's review records at its branch's fetched tip publish: the newest `to`
    // per path, where the file at the tip still holds it (heldAt). The records are the captured
    // head's (`earlier`) when the tip is that head; null when the branch was never fetched, so
    // nothing is known about it.
    async function publishedOn(t) {
        const fetched = t.branch ? tips.get(t.branch) : undefined;
        const mine = t.branch ? pushedTips.get(t.branch) : undefined;
        // Our own push counts until a fetch shows a tip that holds it, or one that replaced it.
        const stale =
            mine !== undefined &&
            mine !== fetched &&
            (fetched === undefined ||
                (await exec("git", ["merge-base", "--is-ancestor", fetched, mine], { cwd: repo }).then(
                    () => true,
                    () => false,
                )));
        const tip = stale ? mine : fetched;
        // An earlier Finish's record a Finish with nothing new to decide can sign.
        t.unsignedRecord = await unsignedRecordAt(repo, tip, t.pr, config);
        if (tip === undefined) {
            return null;
        }
        const key = `${tip} ${t.pr}`;
        if (!recordsAt.has(key)) {
            const records = tip === t.headSha ? t.earlier : await earlierAccepts(repo, tip, t.pr, config.baselines);
            recordsAt.set(key, await heldAt(repo, tip, records));
        }
        return recordsAt.get(key);
    }

    // A target's captured commits, its earlier accepts and whether it is behind the default branch.
    async function decorate(t) {
        const first = t.projects.find((p) => p.results)?.results;
        t.commit = first?.commit ?? null;
        t.headSha = first?.headSha ?? null;
        const base = t.pr === null ? t.commit : t.headSha;
        t.earlier = await earlierAccepts(repo, t.headSha, t.pr, config.baselines);
        t.published = await publishedOn(t);
        // null: unknown, when the captured head was never fetched or git fails.
        const known =
            base !== null &&
            (await exec("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: repo }).then(
                () => true,
                () => false,
            ));
        // Every file the pull request changes, for the inbox's coupled groups (null: unknown).
        t.changedFiles =
            known && t.pr !== null && !t.local
                ? await exec(
                      "git",
                      ["diff", "--name-only", "--no-renames", `refs/remotes/origin/${defaultBranch}...${base}`],
                      {
                          cwd: repo,
                      },
                  ).then(
                      (out) => out.split("\n").filter(Boolean),
                      () => null,
                  )
                : null;
        await markBehind(t, base, known);
    }

    // Whether each of a target's projects is behind the default branch, and what is newer there.
    async function markBehind(t, base, known) {
        t.mergeMasterFirst = false;
        for (const p of t.projects) {
            p.newer = [];
            if (!t.local && p.results && base) {
                const behind = known ? await behindMaster(repo, base, p.project, config).catch(() => null) : null;
                if (behind !== false && t.mergeMasterFirst !== true) {
                    t.mergeMasterFirst = behind;
                }
                // What the review page lists as out of date when the project opens.
                if (behind && t.pr !== null) {
                    p.newer = await newerOnMaster(repo, base, p.project, config).catch(() => []);
                }
            }
        }
    }

    // Deletes the downloads of runs no target shows any more (never state/). Not while a Finish
    // reads its captures, nor after a refresh that could not load some target.
    function prune() {
        const runs = new Set([...targets.values()].map((t) => t.runId));
        if (results || finishing || runs.has(null) || !existsSync(tmp)) {
            return;
        }
        for (const d of readdirSync(tmp)) {
            const run = /^(\d+)-\d+$/.exec(d)?.[1];
            if (run && !runs.has(Number(run))) {
                rmSync(join(tmp, d), { recursive: true, force: true });
            }
        }
    }

    const summary = (t) => {
        const warnings = [...(t.warnings ?? [])];
        let decided = new Map();
        try {
            decided = decisionsOf(t);
        } catch (err) {
            // One unreadable state file never fails the whole list.
            console.error(`visual-review: ${stateFile(t)}: ${err.message}`);
            warnings.push(`could not read the saved decisions: ${err.message}`);
        }
        if (stateProblems.has(t.id)) {
            warnings.push(stateProblems.get(t.id));
        }
        return {
            id: t.id,
            pr: t.pr,
            local: t.local === true,
            title: t.title,
            url: t.url,
            branch: t.branch,
            // Its author is still working on it: the inbox never offers it (inbox.mjs).
            draft: t.draft === true,
            runId: t.runId,
            runAttempt: t.runAttempt,
            runUrl: t.runUrl,
            commit: t.commit,
            headSha: t.headSha,
            // On the default branch in candidate mode: the full run offered and the ones queued behind it.
            candidate: t.candidate ?? null,
            mergeMasterFirst: t.mergeMasterFirst,
            // The commit a pending push's capture is of (withPending): decisions yes, Finish not yet.
            pendingPush: t.pendingPush ?? null,
            downloading: t.downloading === true,
            // While downloading: how many artifacts and bytes have landed of how many, and since when
            // (server time). `bytes` is null until GitHub has listed the artifacts.
            download: t.downloading
                ? { done: 0, total: names.length, bytesDone: 0, bytes: null, startedAt: null, ...t.download }
                : null,
            defaultBranch,
            // Decisions the next Finish would publish (a reject an earlier Finish posted is not).
            unpublished: [...decided.values()].filter((d) => !d.posted).length,
            // Nothing new to decide, and the next Finish signs the record an earlier one pushed
            // unsigned (resignOf).
            resign:
                keysKnown() &&
                Boolean(t.unsignedRecord) &&
                [...decided.values()].every((d) => d.posted) &&
                [...decided.values()].some((d) => d.posted),
            warnings,
            signer,
            startCommand,
            // What the targets screen and Finish's header say about the passkey. The Finish routes
            // read the keys again themselves: this is for display only.
            passkey: {
                rpId,
                required: passkeyState.problem !== null || passkeyState.main.length + passkeyState.pending.length > 0,
                keys: [
                    ...passkeyState.main.map(({ id, label, rpId: host }) => ({
                        id,
                        label,
                        rpId: host,
                        pending: false,
                    })),
                    ...passkeyState.pending.map(({ id, label, rpId: host }) => ({
                        id,
                        label,
                        rpId: host,
                        pending: true,
                    })),
                ],
                problem: passkeyState.problem,
                waiting: passkeyPr,
            },
            projects: t.projects.map((p) => {
                const counts = {};
                for (const item of p.results?.items ?? []) {
                    counts[item.status] = (counts[item.status] ?? 0) + 1;
                }
                const reviewable = (p.results?.items ?? []).filter((i) => REVIEWABLE.has(i.status)).length;
                const prefix = `${p.project}/`;
                const mine = [...decided].filter(([k]) => k.startsWith(prefix));
                return {
                    project: p.project,
                    problem: p.problem,
                    downloading: p.downloading === true,
                    // The size of the project's artifact, while it downloads.
                    bytes: p.downloading ? (p.bytes ?? null) : null,
                    logUrl: p.logUrl,
                    counts,
                    // The stories whose capture failed: the inbox holds the pull request back for them.
                    failed: (p.results?.items ?? [])
                        .filter((i) => i.status === "failed")
                        .map((i) => ({ id: i.id, mode: i.mode, reason: i.reason })),
                    reviewable,
                    decided: mine.length,
                    undecided: reviewable - mine.length,
                    // Accepts and exclusions an earlier Finish pushed, waiting for a new CI run.
                    finished: mine.filter(([, d]) => d.posted && d.decision !== "reject").length,
                    // Rejects an earlier Finish posted, waiting for a fix (or for the owner to change them).
                    rejected: mine.filter(([, d]) => d.posted && d.decision === "reject").length,
                    notOpened: mine.filter(([, d]) => d.bulk).length,
                    acceptable: acceptable(t, p.project),
                    local: p.results?.local ?? null,
                    // A local preview of the head, decided like CI's capture until CI's replaces it.
                    preview: p.preview === true,
                    // A capture of a commit the gate is still checking, not yet the head (pendingPreview).
                    pending: p.pending === true,
                    // The default branch's baseline files this capture was not compared with.
                    newer: p.newer ?? [],
                };
            }),
        };
    };

    /**
     * What the inbox groups a pull request by: the baseline files it changes (`<project>/<file>`,
     * from its captures and from its own commits under the baselines directory), its undecided
     * images, and the top-level directories of its other files.
     * @param {object} t the target
     * @returns {{ paths: string[], images: string[], packages: string[] | null }} its coupling
     */
    const couplingOf = (t) => {
        const prefix = `${config.baselines}/`;
        const files = t.changedFiles ?? [];
        const paths = new Set(
            files.filter((f) => f.startsWith(prefix) && f.endsWith(".png")).map((f) => f.slice(prefix.length)),
        );
        let decided = new Map();
        try {
            decided = decisionsOf(t);
        } catch {
            // summary() reports an unreadable decisions file; here every image counts as undecided.
        }
        const images = [];
        for (const p of t.projects) {
            for (const item of p.results?.items ?? []) {
                const key = `${p.project}/${item.file}`;
                if (CHANGES.has(item.status)) {
                    paths.add(key);
                }
                if (REVIEWABLE.has(item.status) && !decided.has(key)) {
                    images.push(`${key} ${imageHash(item)} ${item.baseline ?? ""}`);
                }
            }
        }
        const top = (f) => (f.includes("/") ? f.slice(0, f.indexOf("/")) : ".");
        return {
            paths: [...paths],
            images,
            packages: t.changedFiles ? [...new Set(files.filter((f) => !f.startsWith(prefix)).map(top))] : null,
        };
    };
    const couplings = () =>
        new Map([...targets.values()].filter((t) => t.pr !== null && !t.local).map((t) => [t.id, couplingOf(t)]));

    /**
     * The coupled group `t` is in, and for an item of it, the other members whose item of the same
     * file shows the same image against the same baseline.
     * @param {object} t the target
     * @returns {{ prs: number[], sharing: (project: string, item: object) => object[] }} the group's
     *     pull requests (none: not in a group) and the members sharing an item
     */
    const groupOf = (t) => {
        const c = couplings();
        const group = coupledGroups(
            [...targets.values()].filter((x) => c.has(x.id)).map((x) => ({ ...x, ...c.get(x.id) })),
        ).find((g) => g.ids.includes(t.id));
        const others = (group?.ids ?? []).filter((id) => id !== t.id).map((id) => targets.get(id));
        const sharing = (project, item) =>
            others.filter((o) => {
                const same = itemOf(o, `${project}/${item.file}`);
                return (
                    same && imageHash(same) === imageHash(item) && (same.baseline ?? null) === (item.baseline ?? null)
                );
            });
        return { prs: group?.prs ?? [], sharing };
    };

    /**
     * Keeps one line per group decision, so approvals per coupled group can be counted.
     * @param {object} entry what was decided, on which pull requests
     */
    const logGroup = (entry) => {
        if (entry.group.length === 0) {
            return;
        }
        try {
            mkdirSync(join(tmp, "state"), { recursive: true });
            appendFileSync(join(tmp, "state", "groups.jsonl"), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
        } catch (err) {
            warnOnce(`could not log a group decision: ${err.message}`);
        }
    };

    // A local capture (--results, or any capture not made by CI) is only looked at: no decision is
    // taken on it and it has no Finish. The exception is a preview of this pull request's head
    // (tools/visual-preview.sh): Finish accepts it, and the gate checks CI's capture against the
    // baselines it leaves.
    const isLocal = (t, name) => {
        const r = t.projects.find((x) => x.project === name)?.results;
        return t.local === true || (Boolean(r?.local) && !isPreviewOf(r, t.pr));
    };
    const acceptable = (t, name) =>
        // seedFromDefaultBranch is about seeding: a candidate's changed images are accepted like a pull request's.
        !isLocal(t, name) && (t.pr !== null || Boolean(t.candidate) || projects[name].seedFromDefaultBranch === true);
    const LOCAL = "is a local preview: nothing is decided on it; only CI captures of a pushed commit are";

    async function targetOf(id) {
        if (!targets.has(id) && (refreshing || Date.now() - refreshedAt > UNKNOWN_REFRESH)) {
            await refresh();
        }
        return targets.get(id);
    }

    async function projectOf(id, name) {
        const t = await targetOf(id);
        const p = t?.projects.find((x) => x.project === name);
        return { t, p: p?.results ? p : undefined };
    }

    const gone = (id) => {
        const name = id === "master" ? defaultBranch : `#${id}`;
        return [404, { error: `${name} is not listed any more (closed, or it could not be loaded): reload the list` }];
    };

    // Whether a write is about the capture the page shows: `hash` (the image), or `runId` and
    // `runAttempt`. A page that sends neither is not checked.
    const sameCapture = (t, body, item) =>
        body.hash !== undefined
            ? body.hash === imageHash(item)
            : body.runId === undefined || (body.runId === t.runId && body.runAttempt === t.runAttempt);
    const CHANGED = "the capture changed since the page loaded it (a new CI run or attempt): reload the page";

    /**
     * The decisions a Finish of `t` would apply now: every one but the rejects an earlier Finish
     * already posted, in a fixed order, and a digest of them that changes when any of them does.
     * @param {object} t the target
     * @param {boolean} [resign] the decisions an earlier Finish published instead, to sign its record
     * @returns {{ list: { project: string, file: string, decision: string, reason: string | null,
     *     approvedBefore?: object }[],
     *     digest: string }} the decisions and their digest
     */
    const finishList = (t, resign = false) => {
        // A candidate's Finish builds its accept commit again from every decision on it, published or
        // not, and replaces its branch: a second Finish never drops what the first one committed.
        const list = [...decisionsOf(t)]
            .filter(([, v]) => (t.candidate ? !resign : Boolean(v.posted) === resign))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => {
                const at = k.indexOf("/");
                return {
                    project: k.slice(0, at),
                    file: k.slice(at + 1),
                    decision: v.decision,
                    reason: v.reason,
                    ...(v.approvedBefore && { approvedBefore: v.approvedBefore }),
                };
            });
        // A candidate with a rejected image cannot promote, so its Finish posts only the rejects: its
        // accepts stay saved by image hash for the next candidate, and no accept pull request opens.
        const rejects = list.filter((d) => d.decision === "reject");
        const sent = t.candidate && rejects.length > 0 ? rejects : list;
        // A candidate's digest names it, so an approval prepared on one candidate never finishes another.
        return { list: sent, digest: sha256(JSON.stringify(t.candidate ? [t.candidate.commit, sent] : sent)) };
    };
    const CHANGED_SINCE = "Decisions changed since this sheet opened: check the summary again.";

    // What Finish's sheet states before it runs: what it commits and posts, and the status it sets.
    // The passkey's challenge comes from POST /api/finish-prepare.
    const finishPreview = (t) => {
        const { list, digest } = finishList(t, resignOf(t));
        const s = summary(t);
        const count = (d) => list.filter((x) => x.decision === d).length;
        const unloaded = t.projects.filter((p) => !p.results && p.problem !== NOT_AFFECTED).map((p) => p.project);
        const undecided = s.projects.reduce((n, p) => n + p.undecided, 0);
        const notes = list
            .filter((x) => x.reason !== null && x.decision !== "exclude")
            .map((x) => ({ decision: x.decision, project: x.project, file: x.file, note: x.reason }));
        return {
            accepts: count("accept"),
            excludes: count("exclude"),
            rejects: count("reject"),
            acceptNotes: notes.filter((n) => n.decision === "accept").length,
            notes,
            // Accepts taken because the owner approved the same image before; the sheet lists them.
            approvedBefore: list.filter((x) => x.approvedBefore).length,
            // Each of them, so the sheet lists them and opens any one: none is included unseen.
            approvedBeforeItems: list
                .filter((x) => x.approvedBefore)
                .map((x) => ({ project: x.project, file: x.file, pr: x.approvedBefore.pr })),
            notOpened: s.projects.reduce((n, p) => n + p.notOpened, 0),
            undecided: s.projects
                .filter((p) => p.undecided > 0)
                .map((p) => ({ project: p.project, undecided: p.undecided })),
            unloaded,
            // The projects whose capture is a local preview: CI checks them after Finish.
            previews: t.projects.filter((p) => p.preview && p.results).map((p) => p.project),
            status: commitStatus({
                accepted: count("accept"),
                rejected: count("reject"),
                excluded: count("exclude"),
                undecided,
                unloaded,
            }),
            digest,
        };
    };

    /**
     * What a Finish of this target applies: its decisions (a reject an earlier Finish posted stays
     * shown as rejected, never posted again), their digest, the captures, and what is left
     * undecided or unloaded.
     * @param {object} t the target
     * @param {boolean} [resign] see finishList
     * @returns {{ list: object[], digest: string, captures: object, undecided: number,
     *     unloaded: string[] }} the work
     */
    const finishWork = (t, resign = false) => ({
        ...finishList(t, resign),
        captures: capturesOf(t),
        undecided: summary(t).projects.reduce((n, p) => n + p.undecided, 0),
        unloaded: t.projects.filter((p) => !p.results && p.problem !== NOT_AFFECTED).map((p) => p.project),
    });

    /**
     * Whether a Finish of this target has nothing new to decide and signs the record of an earlier
     * Finish instead: the branch tip is that Finish's accept commit, its record unsigned, and the
     * decisions it published are still saved here (prepareApproval checks the record holds exactly
     * them).
     * @param {object} t the target
     * @returns {boolean} whether it does
     */
    const resignOf = (t) =>
        keysKnown() &&
        Boolean(t.unsignedRecord) &&
        finishList(t).list.length === 0 &&
        finishList(t, true).list.length > 0;

    // Whether a Finish of this work commits anything (a Finish of rejects alone only comments).
    const commitsOf = (work) => work.list.some((d) => d.decision !== "reject");

    /**
     * finish-prepare's answer when this Finish needs no passkey (no key is known, it commits
     * nothing, or it cannot sign the tree and no key is for this host), or when it needs one and
     * none is registered for this host.
     * @param {object} t the target
     * @param {{ list: object[] }} work as finishWork returns
     * @param {object} keys the keys
     * @param {object[]} keys.trusted every trusted key
     * @param {object[]} keys.here the trusted keys for this host
     * @param {string | null} keys.unsigned why the tree cannot be signed, if it cannot
     * @returns {Array<unknown> | null} the answer, or null when finish-prepare goes on to sign
     */
    const prepareWithoutKey = (t, work, { trusted, here, unsigned }) => {
        if (trusted.length === 0 || !commitsOf(work) || (unsigned && here.length === 0)) {
            approvals.delete(t.id);
            return [200, { required: false, ...(trusted.length > 0 && unsigned && { unsigned }) }];
        }
        if (here.length > 0) {
            return null;
        }
        const hosts = [...new Set(trusted.map((k) => k.rpId))].join(", ");
        return [
            409,
            {
                error: `no passkey is registered for ${rpId}: serve this page from the host your passkey is for (${hosts}), or register one here`,
            },
        ];
    };

    /**
     * Makes a Finish's accept commit in the accept worktree, holding the Finish lock meanwhile so
     * nothing else uses that worktree.
     * @param {object} t the target
     * @param {{ captures: object, list: object[] }} work as finishWork returns
     * @param {Date} now the Finish's time
     * @returns {Promise<{ prepared?: object, refused?: Array<unknown> }>} what prepareApproval
     *     returned, or the answer refusing it
     */
    async function prepareLocked(t, work, now) {
        finishing = true;
        try {
            const prepared = await prepareApproval({
                repo,
                target: finishTarget(t),
                projects: work.captures,
                decisions: work.list,
                now,
                config,
                retryDelays,
            });
            return { prepared };
        } catch (err) {
            if (err instanceof AcceptError) {
                return { refused: [409, { error: err.message }] };
            }
            throw err;
        } finally {
            finishing = false;
        }
    }

    /**
     * The owner's approval POST /api/finish carries, checked against what finish-prepare built and
     * signed: the tree statement's approval when the Finish signs the tree, else the commit holding
     * the signed record.
     * @param {object} t the target
     * @param {{ digest: string, list: object[] }} work as finishWork returns now
     * @param {{ challenge?: string, approval?: object }} body the request
     * @param {boolean} sign whether this Finish signs the tree (signingProblem)
     * @returns {Promise<{ refused?: Array<unknown>, approval?: object | null, work?: object }>} the
     *     answer refusing it, or finish's `approval` (null when none is needed) and the prepared
     *     work it signs
     */
    async function approvalOf(t, work, body, sign) {
        if (body.approval && !sign) {
            return { refused: [409, { error: "the approval is stale (the decisions changed): press Finish again" }] };
        }
        const { main, trusted } = await knownKeys();
        const here = trusted.some((k) => k.rpId === rpId);
        if (trusted.length === 0 || (!sign && (!here || !commitsOf(work)))) {
            return { approval: null };
        }
        const p = approvals.get(t.id);
        const fresh = p !== undefined && p.expires >= Date.now() && p.digest === work.digest;
        const pendingKeys = main.length > 0 ? [] : trusted;
        if (!sign) {
            if (!fresh || p.stage !== "signed") {
                return {
                    refused: [400, { error: "this Finish needs your passkey approval (Face ID): press Finish again" }],
                };
            }
            approvals.delete(t.id);
            const { commit, branch, record, resign } = p;
            return { approval: { commit, branch, record, resign, pendingKeys, origin, now: p.now }, work: p.work };
        }
        if (!body.approval) {
            return {
                refused: [400, { error: "this Finish needs your passkey approval (Face ID): press Finish again" }],
            };
        }
        if (!fresh || p.stage !== "tree" || p.challenge !== body.challenge) {
            return STALE;
        }
        const statement = { ...p.statement, approval: body.approval };
        const why = verifyApproval(statement, trusted, { origin });
        if (why) {
            return { refused: [403, { error: `the approval was refused: ${why}` }] };
        }
        approvals.delete(t.id);
        const { commit, branch, record } = p;
        return { approval: { statement, commit, branch, record, pendingKeys, origin, now: p.now }, work: p.work };
    }

    const STALE = {
        refused: [
            409,
            {
                error: "the approval is stale (made on another tab, expired, or the decisions changed): press Finish again",
            },
        ],
    };

    /**
     * POST /api/finish-prepare's second call, for a Finish that does not sign the tree: the owner's
     * approval of the prepared record, written into the accept commit (not pushed).
     * @param {object} t the target
     * @param {{ digest: string }} work as finishWork returns now
     * @param {{ challenge?: string, approval: object }} body the request
     * @returns {Promise<Array<unknown>>} the answer
     */
    async function signPrepared(t, work, body) {
        const p = approvals.get(t.id);
        if (p?.stage !== "record" || p.challenge !== body.challenge || p.expires < Date.now()) {
            return STALE.refused;
        }
        if (p.digest !== work.digest) {
            return [409, { error: CHANGED_SINCE }];
        }
        const { trusted } = await knownKeys();
        const signed = { ...p.recordBody, approval: body.approval };
        const why = verifyApproval(signed, trusted, { origin });
        if (why) {
            return [403, { error: `the approval was refused: ${why}` }];
        }
        let out;
        finishing = true;
        try {
            out = await signRecord({
                repo,
                target: { pr: t.pr },
                prepared: p,
                approval: body.approval,
                keys: trusted,
                origin,
                config,
            });
        } catch (err) {
            if (err instanceof AcceptError) {
                return [409, { error: err.message }];
            }
            throw err;
        } finally {
            finishing = false;
        }
        p.commit = out.commit;
        p.expires = Date.now() + APPROVAL_MS;
        p.stage = "signed";
        return [200, { required: false, signed: true }];
    }

    /**
     * Why a Finish of this work signs nothing, or null when it signs the baselines tree it leaves.
     * A reject means the owner did not approve what the branch shows. On a pull request an image
     * left undecided, or a project not loaded, may be a baseline the branch already changed, which
     * the signature would cover unseen. A seed's tree holds only what it accepts. A reject an
     * earlier Finish posted counts while its image is still the one captured.
     * @param {object} t the target
     * @param {{ undecided: number, unloaded: string[] }} work as finishWork returns
     * @returns {"rejects" | "undecided" | null} why not
     */
    const signingProblem = (t, work) => {
        if ([...decisionsOf(t).values()].some((d) => d.decision === "reject")) {
            return "rejects";
        }
        if (t.pr !== null && (work.undecided > 0 || work.unloaded.length > 0)) {
            return "undecided";
        }
        return null;
    };

    const capturesOf = (t) =>
        Object.fromEntries(
            t.projects.filter((p) => p.results).map((p) => [p.project, { dir: p.dir, results: p.results }]),
        );

    /** Tiles being made, by the first file they are kept in, and whether a tile is waiting for them. */
    const making = new Map();

    /**
     * Grid tiles made in a child process (`scaled`) unless on disk already, and kept there, one
     * file per image the child makes. A tile waiting for one (`when` "now") goes ahead of those
     * made in advance, even of its own made in advance.
     * @param {Record<string, string>} kept where each image the child makes is kept, by its name
     * @param {string} want the name of the one to answer with
     * @param {"now" | "ahead" | "last"} when see `scaled`
     * @param {() => Promise<unknown>} load what the child works on; an error carrying an `answer`
     *     is answered with it
     * @returns {Promise<Array<unknown>>} the answer: the PNG, or why not
     */
    async function keptOnce(kept, want, when, load) {
        const urgent = when === "now";
        // Made in advance, it was just found missing: reading here, for a thousand items at once,
        // would fill Node's file thread pool and stall every other request's file reads.
        const cached = urgent ? await readFile(kept[want]).catch(() => null) : null;
        if (cached) {
            return [200, cached, "image/png"];
        }
        const id = Object.values(kept)[0];
        const was = making.get(id);
        let done = was && (was.urgent || !urgent) ? was.done : null;
        if (!done) {
            done = (async () => {
                let images;
                try {
                    images = await scaled(load, when);
                } catch (err) {
                    if (err.answer) {
                        return err.answer;
                    }
                    throw err;
                }
                try {
                    for (const [name, path] of Object.entries(kept)) {
                        // Its own temporary name: the advance copy and a tile's may be written at once.
                        const part = `${path}.${urgent ? "tile" : "ahead"}.tmp`;
                        mkdirSync(dirname(path), { recursive: true });
                        writeFileSync(part, images[name]);
                        renameSync(part, path);
                    }
                } catch (err) {
                    warnOnce(`could not keep thumbnails in ${dirname(id)}: ${err.message}`);
                }
                return images;
            })().finally(() => {
                if (making.get(id)?.done === done) {
                    making.delete(id);
                }
            });
            making.set(id, { urgent, done });
        }
        const made = await done;
        return Array.isArray(made) ? made : [200, made[want], "image/png"];
    }

    // Reads an image for a child process, or throws with the answer to send instead.
    const imageFor = async (where) => {
        const full = await readImage(where);
        if (full[0] !== 200) {
            throw Object.assign(new Error(full[1].error), { answer: full });
        }
        return full[1];
    };

    /**
     * An image's thumbnail, kept by the image's hash.
     * @param {{ path: string, hash: string, file: string, dir: string }} where the image
     * @param {boolean} urgent a tile is waiting for it
     * @returns {Promise<Array<unknown>>} the answer: the PNG, or why not
     */
    const thumbOf = (where, urgent) =>
        keptOnce({ png: join(tmp, "thumbs", `${where.hash}.png`) }, "png", urgent ? "now" : "ahead", () =>
            imageFor(where),
        );

    // Where a changed item's spotlit tiles are kept: by both images' hashes and the diff's settings.
    const spotFiles = (baseline, capture, { threshold, includeAA }) =>
        Object.fromEntries(
            SPOT_KINDS.map((k) => [
                k,
                join(tmp, "spots", `${baseline}-${capture}-${threshold}-${includeAA ? 1 : 0}-${k}.png`),
            ]),
        );

    /**
     * A changed item's spotlit tile of one kind, its pair's three tiles made at once.
     * @param {{ path: string, hash: string, file: string, dir: string }} a where the baseline is
     * @param {{ path: string, hash: string, file: string, dir: string }} b where the capture is
     * @param {{ threshold: number, includeAA: boolean }} item the item's diff settings
     * @param {string} kind one of SPOT_KINDS
     * @param {"now" | "last"} when see `scaled`
     * @returns {Promise<Array<unknown>>} the answer: the PNG, or why not
     */
    const spotOf = (a, b, { threshold, includeAA }, kind, when) =>
        keptOnce(spotFiles(a.hash, b.hash, { threshold, includeAA }), kind, when, async () => ({
            baseline: await imageFor(a),
            capture: await imageFor(b),
            threshold,
            includeAA,
        }));

    /**
     * Makes, in the background, the grid thumbnail of every item of a capture that needs a
     * decision, so a grid opens with its tiles ready; and, after all of them, the spotlit tiles of
     * every changed one.
     * @param {string} dir the capture's directory
     * @param {{ items: object[] }} r its results.json
     */
    function prewarm(dir, r) {
        const warn = (path) => (err) => warnOnce(`could not make the thumbnail of ${path}: ${err.message}`);
        for (const item of r.items.filter((i) => REVIEWABLE.has(i.status) && i.status !== "failed")) {
            const kind = item.capture ? "capture" : "baseline";
            const hash = item[kind];
            const own = kind === "capture" || item.baseline === item.capture;
            const path = own ? join(dir, item.file) : join(dir, "baselines", item.file);
            if (hash && !existsSync(join(tmp, "thumbs", `${hash}.png`))) {
                thumbOf({ path, hash, file: item.file, dir }, false).catch(warn(path));
            }
            if (
                item.baseline &&
                item.capture &&
                item.baseline !== item.capture &&
                !existsSync(spotFiles(item.baseline, item.capture, item).both)
            ) {
                const a = { path: join(dir, "baselines", item.file), hash: item.baseline, file: item.file, dir };
                spotOf(a, { path, hash, file: item.file, dir }, item, "both", "last").catch(warn(path));
            }
        }
    }

    // The unpublished count after a write, so the page's Finish button stays current.
    const unpublishedOf = (t) => finishList(t).list.length;

    /**
     * Where a target's image is on this disk, by results.json.
     * @param {string} id the target
     * @param {string} name the project
     * @param {string} kind "capture" or "baseline"
     * @param {string} file the image's file name
     * @returns {Promise<Array<unknown> | { path: string, hash: string, file: string, dir: string, item: any }>}
     *     where the image is, or the answer to send instead
     */
    async function imageOf(id, name, kind, file) {
        const { t, p } = await projectOf(id, name);
        if (!t) {
            return gone(id);
        }
        const item = p?.results.items.find((i) => i.file === file);
        // A failed item has no image in the artifact: capture keeps no copy of its baseline.
        const hash = item && item.status !== "failed" && { capture: item.capture, baseline: item.baseline }[kind];
        if (!hash) {
            return [404, { error: "no such image" }];
        }
        // A moved item's baseline is its capture's bytes, so the artifact holds only the capture.
        const own = kind === "capture" || item.baseline === item.capture;
        const path = own ? join(p.dir, file) : join(p.dir, "baselines", file);
        return { path, hash, file, dir: p.dir, item };
    }

    async function readImage({ path, hash, file, dir }) {
        const bytes = await readFile(path).catch(() => null);
        if (!bytes || sha256(bytes) !== hash) {
            // CI hashed the bytes it uploaded, so the copy on this disk is damaged: drop it,
            // and the next reload downloads it again.
            console.error(
                `visual-review: ${path} does not match results.json: downloading it again on the next reload`,
            );
            rmSync(join(dir, "results.json"), { force: true });
            return [409, { error: `${file}: the downloaded copy is damaged; reload the page to download it again` }];
        }
        return [200, bytes, "image/png"];
    }

    /**
     * Runs a write route from another route, as the router would.
     * @param {string} route the route
     * @param {object} body its body
     * @returns {Promise<[number, { error?: string, files?: string[], accepted?: number }]>} its status
     *     and answer
     */
    const call = async (route, body) => {
        const [status, answer] = await routes[route]([], body);
        return [/** @type {number} */ (status), /** @type {{ error?: string, files?: string[] }} */ (answer)];
    };
    const routes = {
        "GET /api/prs": async (_, __, query) => {
            // ?cached=1 answers at once (starting the first load if there is none); ?refresh=1
            // also starts a refresh. Neither waits for GitHub. After a first load that failed, only
            // ?refresh=1 (the page's Retry) tries again.
            await restored;
            const cachedOnly = query?.get("cached") === "1" || query?.get("refresh") === "1";
            if (cachedOnly) {
                // A local preview that moved on (a project's capture written, or the preview done)
                // is read again at once, so a project is never left showing a capture it lacked.
                if (query.get("refresh") === "1" || previewsChanged() || (!loadedOnce && failure === null)) {
                    refresh().catch((err) => console.error(`visual-review: refresh failed: ${err.message}`));
                }
            } else {
                await refresh();
            }
            const summaries = loadedOnce || !cachedOnly ? [...targets.values()].map(summary) : null;
            return [
                200,
                {
                    targets: summaries,
                    inbox: summaries && !results ? inbox(summaries) : null,
                    warning: listWarnings.join("\n") || null,
                    defaultBranch,
                    updatedAt: refreshedAt || null,
                    now: Date.now(),
                    refreshing: progress,
                    // Why the last refresh got no list at all; a gh call waiting to retry.
                    error: failure,
                    network: networkTrouble(),
                },
            ];
        },
        // The pending-approvals inbox, from the cached list.
        "GET /api/inbox": async () => {
            await restored;
            return [200, { ...inbox(), updatedAt: refreshedAt || null, now: Date.now() }];
        },
        // One target's counts without refetching from GitHub; with ?finish=1, what Finish would do.
        "GET /api/target": async ([id], _, query) => {
            const t = await targetOf(id);
            if (!t) {
                return gone(id);
            }
            if (query?.get("finish") === "1") {
                return [200, { ...summary(t), finish: finishPreview(t) }];
            }
            return [200, summary(t)];
        },
        "GET /api/pr": async ([id, name]) => {
            const { t, p } = await projectOf(id, name);
            if (!t) {
                return gone(id);
            }
            if (t.projects.find((x) => x.project === name)?.downloading) {
                // The reviewer is waiting for this one: it downloads next. The page asks again.
                hurry((dir) => basename(dir) === name && dir.startsWith(join(tmp, `${t.runId}-`)));
                return [202, { downloading: true, target: summary(t), network: networkTrouble(), now: Date.now() }];
            }
            if (!p) {
                return [404, { error: "no such capture" }];
            }
            const { items, ...meta } = p.results;
            const prefix = `${name}/`;
            const mine = [...decisionsOf(t)].filter(([k]) => k.startsWith(prefix));
            const quiet = untouched(t, name);
            const shown = items.map((i) => {
                const to = t.earlier.get(`${config.baselines}/${name}/${i.file}`);
                const n = noise.get(`${prefix}${i.file}`);
                return {
                    ...i,
                    ...(to !== undefined && to !== i.baseline && { reReview: true }),
                    ...(isNoise(n, i, quiet) && { noise: { prs: n.prs, why: n.why } }),
                };
            });
            const decided = new Map(mine.map(([k, v]) => [k.slice(prefix.length), v]));
            // The clusters leave out what has a group of its own: known noise and approved before.
            const grouped = clusters(
                shown.filter((i) => REVIEWABLE.has(i.status) && !i.noise && !decided.get(i.file)?.approvedBefore),
            );
            return [
                200,
                {
                    target: summary(t),
                    project: name,
                    acceptable: acceptable(t, name),
                    results: meta,
                    items: shown,
                    decisions: Object.fromEntries(decided),
                    clusters: grouped.clusters,
                },
            ];
        },
        // The stories proven to be capture noise, for filing fixes.
        "GET /api/noise": async () => [200, noiseReport()],
        // A pull request's title, description and comments: untrusted text, shown as text.
        "GET /api/pr-context": async ([id]) => {
            const t = await targetOf(id);
            if (!t) {
                return gone(id);
            }
            if (t.pr === null || t.local) {
                return [404, { error: "only a pull request has a description and comments" }];
            }
            const key = `${t.pr} ${t.head ?? t.headSha}`;
            if (!contexts.has(key)) {
                reviewer ??= reviewerLogin(gh).catch(() => null);
                contexts.set(
                    key,
                    reviewer.then((login) => pullRequestContext(gh, t.pr, login)),
                );
            }
            try {
                return [200, await contexts.get(key)];
            } catch (err) {
                contexts.delete(key);
                return [502, { error: `GitHub did not give the pull request's description: ${err.message}` }];
            }
        },
        "GET /api/img": async ([id, name, kind, file]) => {
            const where = await imageOf(id, name, kind, file);
            return Array.isArray(where) ? where : readImage(where);
        },
        // The same image scaled down for a grid tile, made once and kept by the image's hash.
        "GET /api/thumb": async ([id, name, kind, file]) => {
            const where = await imageOf(id, name, kind, file);
            if (Array.isArray(where)) {
                return where;
            }
            return thumbOf(where, true);
        },
        // A changed item's grid tile spotlit ("spot"), cropped toward its change ("zoom") or both.
        "GET /api/spot": async ([id, name, kind, file]) => {
            if (!SPOT_KINDS.includes(kind)) {
                return [404, { error: "no such tile" }];
            }
            const a = await imageOf(id, name, "baseline", file);
            if (Array.isArray(a)) {
                return a;
            }
            const b = await imageOf(id, name, "capture", file);
            if (Array.isArray(b)) {
                return b;
            }
            if (a.hash === b.hash) {
                return [404, { error: "nothing changed" }];
            }
            return spotOf(a, b, b.item, kind, "now");
        },
        "POST /api/decide": async (_, body) => {
            const { p, t } = await projectOf(String(body.id), body.project);
            if (!t) {
                return gone(String(body.id));
            }
            const item = p?.results.items.find((i) => i.file === body.file);
            if (!item) {
                return [404, { error: "no such item" }];
            }
            const key = `${body.project}/${body.file}`;
            if (busy(t)) {
                return [409, { error: BUSY }];
            }
            if (isLocal(t, body.project)) {
                return [403, { error: `${body.project} ${LOCAL}` }];
            }
            if (body.decision === null) {
                update(t, (saved) => {
                    delete saved[key];
                });
                return [200, { ok: true, unpublished: unpublishedOf(t) }];
            }
            if (!sameCapture(t, body, item)) {
                return [409, { error: `${body.file}: ${CHANGED}` }];
            }
            if (body.opened === true) {
                // Opening an item Accept all decided marks it opened. It never decides anything,
                // so a stale page cannot bring back a decision undone or finished meanwhile.
                if (decisionsOf(t).get(key)?.bulk) {
                    update(t, (saved) => {
                        delete saved[key].bulk;
                    });
                }
                return [200, { ok: true }];
            }
            if (body.decision !== "reject" && !acceptable(t, body.project)) {
                return [
                    403,
                    {
                        error: `${body.project} is not seeded from ${defaultBranch}; its first review is on a pull request`,
                    },
                ];
            }
            const reason = cleanReason(body.reason);
            const problem = decisionProblem(item, body.decision, reason);
            if (problem) {
                return [problem.status, { error: problem.message }];
            }
            // Nothing silently reverses a decision: changing one takes an explicit Undo first. The
            // same decision again is allowed (opening an item Accept all decided re-sends it).
            // An accept taken because the image was approved before is replaced by any decision, and
            // a reject an earlier Finish posted by an accept or exclusion (that Finish's record keeps
            // the reject; the next Finish commits the new decision).
            const before = decisionsOf(t).get(key);
            const replaceable =
                before?.approvedBefore ||
                (before?.posted && before.decision === "reject" && body.decision !== "reject");
            if (before && !replaceable && (before.decision !== body.decision || before.reason !== reason)) {
                const done = { accept: "accepted", reject: "rejected", exclude: "excluded" }[before.decision];
                return [409, { error: `${body.file} is already ${done}: Undo it first to change it` }];
            }
            update(t, (saved) => {
                saved[key] = { decision: body.decision, reason, hash: imageHash(item), base: item.baseline ?? null };
            });
            return [200, { ok: true, unpublished: unpublishedOf(t) }];
        },
        "POST /api/accept-all": async (_, body) => {
            const { p, t } = await projectOf(String(body.id), body.project);
            if (!t) {
                return gone(String(body.id));
            }
            if (!p) {
                return [404, { error: "no such capture" }];
            }
            if (!sameCapture(t, { runId: body.runId, runAttempt: body.runAttempt }, null)) {
                return [409, { error: CHANGED }];
            }
            if (busy(t)) {
                return [409, { error: BUSY }];
            }
            // `decision` (accept when absent) and `reason`: a cluster of the grouped review rejected
            // or excluded as one, stored per item exactly as one decision is.
            const decision = body.decision ?? "accept";
            const reason = cleanReason(body.reason);
            if (!["accept", "reject", "exclude"].includes(decision) || (decision !== "accept" && reason === null)) {
                return [
                    400,
                    { error: "decision must be accept, reject or exclude, and reject and exclude need a reason" },
                ];
            }
            if (decision !== "reject" && !acceptable(t, body.project)) {
                return [
                    403,
                    {
                        error: `${body.project} cannot be accepted here (a local preview, or not seeded from ${defaultBranch})`,
                    },
                ];
            }
            if (isLocal(t, body.project)) {
                return [403, { error: `${body.project} ${LOCAL}` }];
            }
            // With `files`, only those: what the page's filter shows. Each is stored as any bulk accept.
            if (
                body.files !== undefined &&
                !(Array.isArray(body.files) && body.files.every((f) => typeof f === "string"))
            ) {
                return [400, { error: "files must be a list of file names" }];
            }
            const only = body.files === undefined ? null : new Set(body.files);
            // With `component`, only that component's stories: the story id before "--".
            const inScope = (item) =>
                (typeof body.component !== "string" || componentOf(item.id) === body.component) &&
                (only === null || only.has(item.file));
            const mine = decisionsOf(t);
            // The files it accepted, so the page updates their tiles in place instead of reloading.
            const files = [];
            update(t, (saved) => {
                for (const item of p.results.items) {
                    const key = `${body.project}/${item.file}`;
                    const was = mine.get(key);
                    // An accept taken as approved before is replaced only by a reject or exclusion.
                    const open = !was || (was.approvedBefore && decision !== "accept");
                    if (inScope(item) && open && !decisionProblem(item, decision, reason)) {
                        saved[key] = {
                            decision,
                            reason: decision === "accept" ? null : reason,
                            ...(decision === "accept" && { bulk: true }),
                            hash: imageHash(item),
                            base: item.baseline ?? null,
                        };
                        files.push(item.file);
                    }
                }
            });
            return [200, { accepted: files.length, files, unpublished: unpublishedOf(t) }];
        },
        // /api/decide, then the same decision on the coupled pull requests showing the same image.
        // An Undo there undoes only the same decision; one decided otherwise is listed in `failed`.
        "POST /api/decide-group": async (_, body) => {
            const { t, p } = await projectOf(String(body.id), body.project);
            const item = p?.results.items.find((i) => i.file === body.file);
            const key = `${body.project}/${body.file}`;
            const before = t && item ? decisionsOf(t).get(key) : undefined;
            const [status, answer] = await call("POST /api/decide", body);
            if (status !== 200 || body.opened === true) {
                return [status, answer];
            }
            const group = groupOf(t);
            const also = [];
            const failed = [];
            for (const o of group.sharing(body.project, item)) {
                const theirs = decisionsOf(o).get(key);
                if (body.decision === null && theirs?.decision !== (before?.decision ?? null)) {
                    continue;
                }
                const [s, a] = await call("POST /api/decide", { ...body, id: o.id, hash: imageHash(item) });
                if (s === 200) {
                    // Decided here, not opened there: its Finish counts it as not opened, as Accept all.
                    if (!theirs && body.decision !== null) {
                        update(o, (saved) => {
                            if (saved[key]) {
                                saved[key].bulk = true;
                            }
                        });
                    }
                    also.push(o.pr);
                } else {
                    failed.push({ pr: o.pr, error: a.error });
                }
            }
            logGroup({ group: group.prs, pr: t.pr, action: "decide", decision: body.decision, files: 1, also });
            return [200, { ...answer, also, failed }];
        },
        // /api/accept-all, then the same accepts on the coupled pull requests showing the same images.
        "POST /api/accept-all-group": async (_, body) => {
            const [status, answer] = await call("POST /api/accept-all", body);
            if (status !== 200) {
                return [status, answer];
            }
            const { t } = await projectOf(String(body.id), body.project);
            const group = groupOf(t);
            const saved = readState(t);
            // Each member with the capture it had when it was found sharing an image: its accept-all
            // is refused if a refresh replaced that capture meanwhile.
            const byMember = new Map();
            for (const file of answer.files) {
                // What was accepted here, not what the capture shows now: it may have been replaced.
                const d = saved[`${body.project}/${file}`];
                if (!d) {
                    continue;
                }
                for (const o of group.sharing(body.project, { file, capture: d.hash, baseline: d.base })) {
                    const m = byMember.get(o.id) ?? { o, runId: o.runId, runAttempt: o.runAttempt, files: [] };
                    m.files.push(file);
                    byMember.set(o.id, m);
                }
            }
            const also = [];
            const failed = [];
            for (const { o, runId, runAttempt, files } of byMember.values()) {
                const [s, a] = await call("POST /api/accept-all", {
                    id: o.id,
                    project: body.project,
                    decision: body.decision,
                    reason: body.reason,
                    files,
                    runId,
                    runAttempt,
                });
                if (s === 200) {
                    also.push(o.pr);
                } else {
                    failed.push({ pr: o.pr, error: a.error });
                }
            }
            logGroup({ group: group.prs, pr: t.pr, action: "accept-all", files: answer.files.length, also });
            return [200, { ...answer, also, failed }];
        },
        "GET /api/passkeys": async () => {
            const { main, pending } = await knownKeys();
            const show = (k, isPending) => ({ id: k.id, rpId: k.rpId, label: k.label ?? null, pending: isPending });
            return [
                200,
                {
                    rpId,
                    keys: [...main.map((k) => show(k, false)), ...pending.map((k) => show(k, true))],
                    required: main.length + pending.length > 0,
                },
            ];
        },
        "POST /api/passkey-challenge": async () => {
            if (results) {
                return [403, { error: "a local preview registers no passkey" }];
            }
            const now = Date.now();
            for (const [c, expires] of challenges) {
                if (expires < now) {
                    challenges.delete(c);
                }
            }
            const challenge = randomBytes(32).toString("base64url");
            challenges.set(challenge, now + CHALLENGE_MS);
            const { main, pending } = await knownKeys();
            return [
                200,
                {
                    challenge,
                    userId: randomBytes(16).toString("base64url"),
                    rpId,
                    known: [...main, ...pending].map((k) => k.id),
                },
            ];
        },
        "POST /api/register": async (_, body) => {
            const expires = challenges.get(body.challenge);
            challenges.delete(body.challenge);
            if (!expires || expires < Date.now()) {
                return [409, { error: "the registration expired or was already used: press Register passkey again" }];
            }
            const why = verifyRegistration(body, { challenge: body.challenge, origin, rpId });
            if (why) {
                return [400, { error: `the passkey was not accepted: ${why}` }];
            }
            const { main, pending } = await knownKeys();
            if ([...main, ...pending].some((k) => k.id === body.credentialId)) {
                return [409, { error: "this passkey is already registered" }];
            }
            if (finishing) {
                return [409, { error: "a Finish is running: register when it ends" }];
            }
            const label = typeof body.label === "string" ? body.label.replaceAll(/\s+/g, " ").trim().slice(0, 60) : "";
            const entry = {
                id: body.credentialId,
                publicKey: body.publicKey,
                rpId,
                label: label || "passkey",
                registeredAt: new Date().toISOString(),
            };
            let proposed;
            try {
                proposed = await proposeKey({ repo, gh, entry, config });
            } catch (err) {
                if (err instanceof AcceptError) {
                    return [409, { error: err.message }];
                }
                throw err;
            }
            writeJson(pendingFile, { version: 1, keys: [...readPending(), entry] });
            passkeyPr = Number(proposed.pullRequest.split("/").pop()) || passkeyPr;
            passkeyOpened = { number: passkeyPr, id: entry.id, at: Date.now() };
            await readPasskeys();
            console.log(
                `visual-review: registered passkey ${entry.id}; merge ${proposed.pullRequest} to enforce approvals`,
            );
            return [200, { entry, ...proposed }];
        },
        "POST /api/finish-prepare": async (_, body) => {
            const t = await targetOf(String(body.id));
            if (!t) {
                return gone(String(body.id));
            }
            const resign = resignOf(t);
            const refused = finishRefused(t);
            if (refused) {
                return refused;
            }
            if (finishing) {
                return [409, { error: "a Finish is already running" }];
            }
            const work = finishWork(t, resign);
            if (body.approval !== undefined) {
                return signPrepared(t, work, body);
            }
            const { trusted } = await knownKeys();
            const unsigned = signingProblem(t, work);
            const here = trusted.filter((k) => k.rpId === rpId);
            const keyless = prepareWithoutKey(t, work, { trusted, here, unsigned });
            if (keyless) {
                return keyless;
            }
            const now = new Date();
            // The accept commit is made now, in the accept worktree: nothing else may use it meanwhile.
            const { prepared, refused: notPrepared } = await prepareLocked(t, work, now);
            if (notPrepared) {
                return notPrepared;
            }
            if (resign && !prepared.pushed) {
                return [
                    409,
                    { error: "the earlier Finish's record is not on the branch tip any more: reload the page" },
                ];
            }
            // Signing an earlier Finish's record signs nothing else: the tree is a Finish's of its own.
            const tree = !unsigned && !resign;
            // The tree holds the record, so signing the tree signs the decisions too: one approval.
            const statement = tree
                ? await treeStatement({ repo, commit: prepared.commit, config, pr: t.pr, now })
                : undefined;
            const challenge = recordHash(statement ?? prepared.recordBody).toString("base64url");
            approvals.set(t.id, {
                ...prepared,
                stage: tree ? "tree" : "record",
                challenge,
                statement,
                tree,
                resign,
                now: now.toISOString(),
                work,
                digest: work.digest,
                expires: Date.now() + APPROVAL_MS,
            });
            return [
                200,
                {
                    required: true,
                    signs: tree ? "tree" : "record",
                    tree,
                    resign,
                    ...(tree && { statement }),
                    ...(unsigned && { unsigned }),
                    challenge,
                    rpId,
                    allowCredentials: here.map((k) => k.id),
                    record: prepared.recordBody,
                    accepts: prepared.accepts,
                    excludes: prepared.excludes,
                    rejects: prepared.rejects,
                },
            ];
        },
        "POST /api/finish": async (_, body) => {
            const t = await targetOf(String(body.id));
            if (!t) {
                return gone(String(body.id));
            }
            const resign = resignOf(t);
            const refused = finishRefused(t);
            if (refused) {
                return refused;
            }
            if (finishing) {
                return [409, { error: "a Finish is already running" }];
            }
            let work = finishWork(t, resign);
            // The page's sheet stated what Finish would do; a decision changed since (in another
            // tab, say) would make that statement wrong.
            if (body.digest !== undefined && body.digest !== work.digest) {
                return [409, { error: CHANGED_SINCE }];
            }
            const sign = !resign && signingProblem(t, work) === null;
            const checked = await approvalOf(t, work, body, sign);
            if (checked.refused) {
                return checked.refused;
            }
            const { approval } = checked;
            // The decisions the approved commit was built from, not a fresh read of the state.
            work = checked.work ?? work;
            const { list, captures, undecided } = work;
            finishing = true;
            job = {
                id: (job?.id ?? 0) + 1,
                target: t.id,
                pr: t.pr,
                branch: t.branch,
                running: true,
                step: "starting",
                result: null,
                error: null,
                warnings: [],
            };
            persist(job);
            console.log(
                `visual-review: Finish of ${finishLabel(t)} started: ${list.length} decisions, ${undecided} undecided`,
            );
            runFinish(job, t, list, {
                repo,
                gh,
                target: finishTarget(t),
                projects: captures,
                decisions: list,
                undecided,
                unloaded: work.unloaded,
                config,
                retryDelays,
                sign,
                ...(approval && { approval, now: new Date(approval.now) }),
            });
            return [202, { job }];
        },
        "GET /api/finish-status": async () => [200, { job }],
        // Usage events (config `usage`): whether the page sends them, and the page's batches,
        // appended to usage-events.jsonl. Off, nothing is written.
        "GET /api/usage-setting": async () => [200, { on: config.usage === true }],
        "POST /api/usage": async (_, body) => {
            if (config.usage !== true) {
                return [404, { error: "usage events are off" }];
            }
            const lines = usageLines(body.events, token);
            if (lines === null) {
                return [400, { error: "events must be at most 100 small usage events" }];
            }
            mkdirSync(stateDir, { recursive: true });
            appendFileSync(join(stateDir, USAGE_FILE), lines);
            return [200, { kept: lines.split("\n").length - 1 }];
        },
        // Update from the default branch: a background job like Finish, followed the same way.
        "POST /api/update": async (_, body) => {
            const t = await targetOf(String(body.id));
            if (!t) {
                return gone(String(body.id));
            }
            if (t.local || t.pr === null) {
                return [403, { error: `only a pull request is updated from ${defaultBranch}` }];
            }
            if (finishing) {
                return [409, { error: "a Finish or an update is already running" }];
            }
            finishing = true;
            job = {
                id: (job?.id ?? 0) + 1,
                kind: "update",
                target: t.id,
                pr: t.pr,
                branch: t.branch,
                running: true,
                step: "starting",
                result: null,
                error: null,
                warnings: [],
            };
            persist(job);
            runUpdate(job, t);
            return [202, { job }];
        },
    };

    /**
     * Runs one update from the default branch to its end, then refreshes the list so the target
     * shows the new head waiting for CI. Decisions stay saved and apply again where the new capture
     * and its baseline are unchanged. It never throws: nothing awaits it.
     * @param {object} j the job
     * @param {object} t the target
     */
    async function runUpdate(j, t) {
        console.log(`visual-review: update of #${t.pr} from ${defaultBranch} started`);
        try {
            j.result = await updateFromMaster({
                repo,
                pr: t.pr,
                branch: t.branch,
                config,
                progress: (step) => {
                    j.step = step;
                    persist(j);
                },
            });
            console.log(`visual-review: update of #${t.pr} done: commit ${j.result.commit}`);
        } catch (err) {
            j.error = err.message;
            console.error(`visual-review: update of #${t.pr} failed: ${j.error}`);
        } finally {
            j.running = false;
            j.step = null;
            finishing = false;
            persist(j);
        }
        if (j.result) {
            await refresh().catch((err) => console.error(`visual-review: refresh failed: ${err.message}`));
        }
    }

    /**
     * Runs one Finish to its end, recording its steps and outcome on `j` (and in the log). It
     * never throws: nothing awaits it.
     * @param {object} j the job
     * @param {object} t the target
     * @param {{ project: string, file: string, decision: string }[]} sent the decisions it applies
     * @param {object} input finish's input
     */
    async function runFinish(j, t, sent, input) {
        // Marks what Finish published, so no later Finish publishes it again. The accepts and
        // exclusions it pushed stay shown as finished until a new CI run replaces this capture (their
        // hash then no longer matches, or the item is unchanged); rejects stay keyed by image hash,
        // so an unchanged rejected capture on the next CI run still reads as rejected.
        const clear = (posted) =>
            update(t, (saved) => {
                for (const { project, file, decision } of sent) {
                    const k = `${project}/${file}`;
                    if (saved[k] && (decision !== "reject" || posted)) {
                        saved[k].posted = true;
                    }
                }
            });
        // The commit Finish pushed is the branch's tip now, before a refresh fetches it.
        const pushed = async (commit) => {
            if (t.branch) {
                pushedTips.set(t.branch, commit);
                pushes++;
            }
            t.published = await earlierAccepts(repo, commit, t.pr, config.baselines);
            t.unsignedRecord = await unsignedRecordAt(repo, commit, t.pr, config);
            // A refresh that ended while this Finish ran listed a new object for the target.
            const shown = targets.get(t.id);
            if (shown && shown !== t) {
                shown.published = t.published;
                shown.unsignedRecord = t.unsignedRecord;
            }
        };
        try {
            j.result = await finish({
                ...input,
                progress: (step) => {
                    j.step = step;
                    persist(j);
                },
            });
            if (j.result.commit) {
                await pushed(j.result.commit);
            }
            try {
                clear(true);
            } catch (err) {
                // What was pushed and posted stands; the decisions it applied are still saved.
                j.warnings.push(`pushed and posted, but the decisions could not be cleared: ${err.message}`);
                console.error(`visual-review: Finish of ${finishLabel(t)}: ${j.warnings.at(-1)}`);
            }
            const r = j.result;
            candidateFinished(j, t, r);
            const status = r.statusError ? `; status not posted: ${r.statusError}` : "";
            console.log(
                r.alreadyFinished
                    ? `visual-review: Finish of ${finishLabel(t)} done: already finished as commit ${r.commit}`
                    : `visual-review: Finish of ${finishLabel(t)} done: commit ${r.commit ?? "none"}, ${r.rejects} rejects${status}`,
            );
        } catch (err) {
            if (err instanceof AcceptError && err.committed && !err.pullRequestMissing) {
                // The accepts are on the branch; keep only the rejects, so Finish again only comments.
                await pushed(err.committed);
                try {
                    clear(false);
                } catch (e) {
                    j.warnings.push(`the accepts pushed could not be cleared from the decisions: ${e.message}`);
                    console.error(`visual-review: Finish of ${finishLabel(t)}: ${j.warnings.at(-1)}`);
                }
            }
            // Refused before anything ran, the message says it all; later, it names the step.
            j.error = ["starting", "checking"].includes(j.step) ? err.message : `${j.step}: ${err.message}`;
            console.error(`visual-review: Finish of ${finishLabel(t)} failed: ${j.error}`);
        } finally {
            j.running = false;
            j.step = null;
            finishing = false;
            persist(j);
        }
    }

    /**
     * What a Finish of a candidate leaves behind: a candidate whose rejects were filed is dropped (the
     * next queued one is offered, and the rejects stay saved by image hash), and an accept pull request
     * it could not close is a warning and is closed by a later refresh.
     * @param {object} j the job
     * @param {object} t the target
     * @param {object} r finish's result
     */
    function candidateFinished(j, t, r) {
        if (!t.candidate || r.rejects === 0 || !r.issue) {
            return;
        }
        if (r.closeError) {
            // Closed by a later refresh, never by filing the rejects again.
            j.warnings.push(`the accept pull request of this rejected candidate is still open: ${r.closeError}`);
            toClose.add(t.candidate.commit);
        }
        dropCandidate(t.candidate.commit);
    }

    const finishLabel = (t) => {
        if (t.candidate) {
            return `the candidate ${t.candidate.commit.slice(0, 10)}`;
        }
        return t.pr === null ? "the master seed" : `#${t.pr}`;
    };
    // What accept.mjs is told about the target: on a candidate, its commit too.
    const finishTarget = (t) => ({ pr: t.pr, branch: t.branch, ...(t.candidate && { candidate: t.candidate.commit }) });

    const tokenOk = (given) => {
        const a = Buffer.from(String(given ?? ""));
        const b = Buffer.from(token);
        return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    };

    function send(res, status, body, type = "application/json") {
        const data = type === "application/json" ? JSON.stringify(body) : body;
        res.writeHead(status, { ...HEADERS, "content-type": type });
        res.end(data);
    }

    async function readBody(req) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 65536) {
                throw new Error("body too large");
            }
            chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof body !== "object" || body === null) {
            throw new Error("body must be an object");
        }
        return body;
    }

    // The list a previous run of the server kept: read before any request for the list is answered.
    const restored = warm && !results ? restore() : Promise.resolve();
    if (warm) {
        // Download the captures now, and again every POLL so that a CI run that finished meanwhile
        // is on disk before the page first asks for it.
        const failed = (when) => (err) => console.error(`visual-review: ${when} refresh failed: ${err.message}`);
        restored.then(() => refresh().catch(failed("startup")));
        setInterval(() => refresh().catch(failed("background")), POLL).unref();
    }

    // The page's own files: GET only, and only those it names.
    async function sendStatic(req, res, pathname) {
        const entry = req.method === "GET" && Object.hasOwn(STATIC, pathname) ? STATIC[pathname] : null;
        return entry
            ? send(res, 200, await readFile(join(HERE, entry[0])), entry[1])
            : send(res, 404, { error: "not found" });
    }

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, origin);
            if (!url.pathname.startsWith("/api/")) {
                return await sendStatic(req, res, url.pathname);
            }
            if (!tokenOk(req.headers["x-review-token"])) {
                return send(res, 401, { error: "missing or wrong session token: open the URL serve printed" });
            }
            const [, , route, ...args] = url.pathname.split("/").map(decodeURIComponent);
            const writes = WRITES.has(route);
            const handler = routes[`${req.method} /api/${route}`];
            if (!handler) {
                return send(res, writes || Object.hasOwn(routes, `GET /api/${route}`) ? 405 : 404, {
                    error: "not allowed",
                });
            }
            if (writes && req.headers.origin !== origin) {
                return send(res, 403, { error: "foreign origin" });
            }
            const [status, body, type] = await handler(
                args,
                writes ? await readBody(req) : undefined,
                url.searchParams,
            );
            return send(res, status, body, type);
        } catch (err) {
            // A malformed request (bad JSON, bad escape, oversized body) is the client's; the rest,
            // gh and git failures included, is ours.
            const client = err instanceof SyntaxError || err instanceof URIError || err.message.startsWith("body ");
            if (!client) {
                console.error(`visual-review: ${req.method} ${req.url} failed: ${err.message}`);
            }
            return send(res, client ? 400 : 500, { error: err.message });
        }
    };
    /**
     * Settles once no tile is being made in the background (the thumbnails and spotlit tiles made
     * in advance), so whoever stops the server can wait for that work instead of leaving it running.
     * @returns {Promise<void>}
     */
    handler.idle = async () => {
        while (making.size) {
            await Promise.allSettled([...making.values()].map((m) => m.done));
        }
    };
    return handler;
}
