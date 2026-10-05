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
 * registered whose pull request is not merged yet, `<tmp>/state/passkeys-pending.json`), Finish
 * needs the owner's approval. A pending key approves only while the default branch holds none: once
 * it does, only its keys count, as in the gate, so a key registered later (by anyone who can reach
 * this page) approves nothing until its pull request merges. POST /api/finish-prepare builds the
 * record and returns its hash as the WebAuthn challenge; POST /api/finish takes the approval,
 * checks it, and commits exactly that record. The server decides whether approval is required, so
 * leaving it out never skips it. The rpId is the host name of the page's own origin.
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
 * kept on disk.
 */

import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    AcceptError,
    behindMaster,
    cleanReason,
    commitStatus,
    decisionProblem,
    finish,
    isPreviewOf,
    legacyApprovals,
    newerOnMaster,
    prepareRecord,
    proposeKey,
    updateFromMaster,
} from "./accept.mjs";
import { PASSKEYS_FILE, parsePasskeys, recordHash, verifyApproval, verifyRegistration } from "./approval.mjs";
import { sha256 } from "./compare.mjs";
import {
    downloadCaptures,
    exec,
    getRun,
    hurry,
    newestCiRun,
    openPullRequests,
    retrying,
    visualJobs,
} from "./github.mjs";
import { CONFIG_FILE } from "./config.mjs";
import { inboxOf, readyKey, writeJson } from "./inbox.mjs";
import { validateResults } from "./results.mjs";
import { scaled } from "./thumbs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = {
    "/": ["../page/index.html", "text/html; charset=utf-8"],
    "/review.js": ["../page/review.js", "text/javascript; charset=utf-8"],
    "/review.css": ["../page/review.css", "text/css; charset=utf-8"],
    "/pixelmatch.mjs": ["../vendor/pixelmatch.mjs", "text/javascript; charset=utf-8"],
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
const WRITES = new Set(["decide", "accept-all", "finish", "finish-prepare", "passkey-challenge", "register", "update"]);
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
 * Reads and validates one project's results.json.
 * @param {string} dir the capture directory
 * @returns {Promise<{ results: object | null, problem: string | null }>} the results, or why not
 */
async function loadResults(dir) {
    let results;
    try {
        results = JSON.parse(await readFile(join(dir, "results.json"), "utf8"));
    } catch {
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
 * @param {string} [options.results] a local directory of `<project>/results.json` instead of CI:
 *     a preview to look at, with no decisions and no Finish
 * @param {string} [options.startCommand] the shell command that starts this server, shown so the
 *     owner can restart it from their own shell and sign Finish with their own key
 * @param {boolean} [options.warm] start downloading every target's captures right away
 * @param {string | null} [options.previews] where tools/visual-preview.sh writes its local previews
 *     (`<previews>/<pr>/<project>/results.json`): a complete preview of a pull request's current
 *     head stands in for each project CI has not captured yet, marked "CI pending", and is decided
 *     and finished like a CI capture. CI's capture replaces it project by project as it lands.
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 *     the handler, for node:https in the CLI and node:http in the tests
 */
export function createApp({
    repo,
    gh,
    config,
    tmp,
    token,
    origin,
    masterRun,
    results,
    startCommand = null,
    warm,
    previews = null,
}) {
    const stateDir = join(tmp, "state");
    const { projects, defaultBranch } = config;
    const names = Object.keys(projects);
    /** @type {Map<string, object>} targets by id: a pull request number, or "master" */
    let targets = new Map();
    /** What the last refresh could not read from GitHub (the pull request list, a git fetch). */
    let listWarnings = [];
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
            const where = saved.branch ?? "the visual/seed-* branch";
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
     * The record each target's Finish was prepared with, waiting for its approval.
     * @type {Map<string, { challenge: string, record: object, work: object, digest: string,
     *     expires: number, legacy?: { items: object[], drop: string[] } | null }>}
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
     * The decisions that apply to this run: those whose item is in it, with the image the decision
     * was taken on and the baseline it was compared with (`base`; a decision saved before it was
     * kept matches any), and still decidable that way. The others stay in the file. So after the
     * branch is updated from the default branch and captured again, a story whose capture and
     * baseline are both unchanged keeps its decision, and one whose baseline moved comes back
     * undecided.
     * @param {object} t the target
     * @returns {Map<string, { decision: string, reason: string | null, bulk?: true, posted?: true }>}
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
                mine.set(k, d);
            }
        }
        return mine;
    };

    // `problem` is what CI said (the job failed, or no artifact); results.json can add its own.
    async function project(name, dir, problem) {
        const loaded = dir ? await loadResults(dir) : { results: null, problem: null };
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
            const p = await project(name, landed.get(name)?.dir, problemOf(name, landed.get(name), run, jobs));
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
        downloads.catch(() => {}); // A download still running after PATIENCE fails on a later refresh.
        const downloaded = await Promise.race([
            downloads,
            new Promise((resolve) => setTimeout(resolve, PATIENCE, null).unref()),
        ]);
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
            const p = await project(name, downloaded[name]?.dir, problemOf(name, downloaded[name], run, jobs));
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
     * downloading): only a complete preview of the head GitHub lists now, so one of an older push,
     * or one still capturing, is never offered.
     * @param {object} t the target, changed in place; `head` is the pull request's head
     * @returns {Promise<object>} the target
     */
    async function withPreviews(t) {
        if (!previews || t.pr === null) {
            return t;
        }
        for (const [i, p] of t.projects.entries()) {
            const dir = join(previews, String(t.pr), p.project);
            if (p.results || p.downloading || !existsSync(join(dir, "results.json"))) {
                continue;
            }
            const local = await project(p.project, dir, null);
            const r = local.results;
            if (r?.complete && isPreviewOf(r, t.pr) && r.headSha === t.head) {
                t.projects[i] = { ...local, preview: true, ciProblem: p.problem, logUrl: p.logUrl ?? null };
            }
        }
        return t;
    }

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
        return old?.runId
            ? { ...old, warnings: [retryLater("could not refresh", err.message)] }
            : blank(info, retryLater("failed to load", err.message));
    };

    // Concurrent callers (the startup refresh, the page's first request) share one refresh.
    let refreshing = null;
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
            const prs = await openPullRequests(gh).catch((err) => {
                if (!masterRun && kept.length === 0) {
                    throw err;
                }
                console.error(`visual-review: pull requests not listed: ${err.message}`);
                const warning = retryLater("could not list the pull requests", err.message);
                listWarnings.push(warning);
                for (const t of kept) {
                    next.set(t.id, { ...t, warnings: [warning] });
                }
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
                    };
                    try {
                        const run = await newestCiRun(gh, pr.headSha, config);
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
            if (masterRun) {
                step(`reading ${defaultBranch}'s CI run`);
                const info = { id: "master", pr: null, title: defaultBranch, url: null, branch: null };
                next.set(
                    "master",
                    await getRun(gh, masterRun)
                        .then((run) => build(info, run))
                        .catch((err) => keptOr(info, err)),
                );
            }
        }
        step("checking the baselines", 0, next.size);
        let checked = 0;
        for (const t of next.values()) {
            await decorate(t);
            step("checking the baselines", ++checked, next.size);
        }
        signer = await signingIdentity(repo);
        targets = next;
        save();
        prune();
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
        const box = inboxOf(summaries, { now, since: readySince });
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
                    const there = p.dir && existsSync(join(p.dir, "results.json"));
                    const loaded = there ? await project(p.project, p.dir, p.problem) : null;
                    list.push(
                        p.dir && !loaded?.results
                            ? { ...p, dir: null, results: null, problem: null, downloading: true }
                            : { ...p, results: loaded?.results ?? null },
                    );
                }
                const downloading = t.downloading === true || list.some((p) => p.downloading);
                next.set(t.id, { ...t, earlier: new Map(t.earlier), projects: list, downloading });
            }
            signer = await signingIdentity(repo);
            await readPasskeys();
            if (!loadedOnce) {
                targets = next;
                loadedOnce = true;
                refreshedAt = saved.at;
            }
        } catch (err) {
            console.error(`visual-review: ignoring the kept list in ${listFile}: ${err.message}`);
        }
    }

    // A target's captured commits, its earlier accepts and whether it is behind the default branch.
    async function decorate(t) {
        const first = t.projects.find((p) => p.results)?.results;
        t.commit = first?.commit ?? null;
        t.headSha = first?.headSha ?? null;
        const base = t.pr === null ? t.commit : t.headSha;
        t.earlier = await earlierAccepts(repo, t.headSha, t.pr, config.baselines);
        // null: unknown, when the captured head was never fetched or git fails.
        const known =
            base !== null &&
            (await exec("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: repo }).then(
                () => true,
                () => false,
            ));
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
            runId: t.runId,
            runAttempt: t.runAttempt,
            runUrl: t.runUrl,
            commit: t.commit,
            headSha: t.headSha,
            mergeMasterFirst: t.mergeMasterFirst,
            downloading: t.downloading === true,
            // While downloading: how many artifacts and bytes have landed of how many, and since when
            // (server time). `bytes` is null until GitHub has listed the artifacts.
            download: t.downloading
                ? { done: 0, total: names.length, bytesDone: 0, bytes: null, startedAt: null, ...t.download }
                : null,
            defaultBranch,
            // Decisions the next Finish would publish (a reject an earlier Finish posted is not).
            unpublished: [...decided.values()].filter((d) => !d.posted).length + legacyCount(t),
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
                    notOpened: mine.filter(([, d]) => d.bulk).length,
                    acceptable: acceptable(t, p.project),
                    local: p.results?.local ?? null,
                    // A local preview of the head, decided like CI's capture until CI's replaces it.
                    preview: p.preview === true,
                    // The default branch's baseline files this capture was not compared with.
                    newer: p.newer ?? [],
                };
            }),
        };
    };

    // A local capture (--results, or any capture not made by CI) is only looked at: no decision is
    // taken on it and it has no Finish. The exception is a preview of this pull request's head
    // (tools/visual-preview.sh): Finish accepts it, and the gate checks CI's capture against it.
    const isLocal = (t, name) => {
        const r = t.projects.find((x) => x.project === name)?.results;
        return t.local === true || (Boolean(r?.local) && !isPreviewOf(r, t.pr));
    };
    const acceptable = (t, name) =>
        !isLocal(t, name) && (t.pr !== null || projects[name].seedFromDefaultBranch === true);
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

    const gone = (id) => [
        404,
        {
            error: `${id === "master" ? defaultBranch : `#${id}`} is not listed any more (closed, or it could not be loaded): reload the list`,
        },
    ];

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
     * @returns {{ list: { project: string, file: string, decision: string, reason: string | null }[],
     *     digest: string }} the decisions and their digest
     */
    const finishList = (t) => {
        const list = [...decisionsOf(t)]
            .filter(([, v]) => !v.posted)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => {
                const at = k.indexOf("/");
                return { project: k.slice(0, at), file: k.slice(at + 1), decision: v.decision, reason: v.reason };
            });
        return { list, digest: sha256(JSON.stringify(list)) };
    };
    const CHANGED_SINCE = "Decisions changed since this sheet opened: check the summary again.";

    // What Finish's sheet states before it runs: what it commits and posts, and the status it sets.
    // The passkey's challenge comes from POST /api/finish-prepare.
    const finishPreview = (t) => {
        const { list, digest } = finishList(t);
        const s = summary(t);
        const count = (d) => list.filter((x) => x.decision === d).length;
        const unloaded = t.projects.filter((p) => !p.results).map((p) => p.project);
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
            notOpened: s.projects.reduce((n, p) => n + p.notOpened, 0),
            undecided: s.projects
                .filter((p) => p.undecided > 0)
                .map((p) => ({ project: p.project, undecided: p.undecided })),
            unloaded,
            // The projects whose capture is a local preview: CI checks them after Finish.
            previews: t.projects.filter((p) => p.preview && p.results).map((p) => p.project),
            // Approvals from before passkeys a signed Finish signs again, and the unsigned records
            // it removes.
            legacy: legacyOf(t) && { files: legacyOf(t).items.length, records: legacyOf(t).drop },
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
     * @returns {{ list: object[], digest: string, captures: object, undecided: number,
     *     unloaded: string[] }} the work
     */
    const finishWork = (t) => ({
        ...finishList(t),
        captures: capturesOf(t),
        undecided: summary(t).projects.reduce((n, p) => n + p.undecided, 0),
        unloaded: t.projects.filter((p) => !p.results).map((p) => p.project),
    });

    /**
     * A pull request's approvals from before passkeys (legacyApprovals): what a signed Finish
     * signs again and which unsigned records it removes. Cached per captured head and default
     * branch tip; null when there are none or they cannot be read here.
     */
    const legacyCache = new Map();
    const legacyOf = (t) => {
        if (t.local || t.pr === null || !t.headSha) {
            return null;
        }
        const base = `refs/remotes/origin/${defaultBranch}`;
        let tip;
        try {
            tip = execFileSync("git", ["rev-parse", base], { cwd: repo }).toString("utf8").trim();
        } catch {
            return null;
        }
        const key = `${t.headSha}:${tip}`;
        if (!legacyCache.has(t.id) || legacyCache.get(t.id).key !== key) {
            let value = null;
            try {
                value = legacyApprovals({ repo, pr: t.pr, head: t.headSha, base: tip, config });
            } catch (err) {
                console.error(`visual-review: could not read the approvals of #${t.pr}: ${err.message}`);
            }
            legacyCache.set(t.id, { key, value });
        }
        return legacyCache.get(t.id).value;
    };
    // How many things a signed Finish of the old approvals publishes: the files it signs again,
    // or, when none are left, the unsigned records it removes.
    const legacyCount = (t) => {
        const l = legacyOf(t);
        return l === null ? 0 : l.items.length || l.drop.length;
    };

    const capturesOf = (t) =>
        Object.fromEntries(
            t.projects.filter((p) => p.results).map((p) => [p.project, { dir: p.dir, results: p.results }]),
        );

    /** Thumbnails being made, by the file they are kept in, and whether a tile is waiting for one. */
    const making = new Map();

    /**
     * An image's thumbnail, made in a worker thread unless it is on disk already. A tile waiting
     * for one (`urgent`) goes ahead of those made in advance, even of its own made in advance.
     * @param {{ path: string, hash: string, file: string, dir: string }} where the image
     * @param {boolean} urgent a tile is waiting for it
     * @returns {Promise<Array<unknown>>} the answer: the PNG, or why not
     */
    function thumbOf(where, urgent) {
        const kept = join(tmp, "thumbs", `${where.hash}.png`);
        const was = making.get(kept);
        if (was && (was.urgent || !urgent)) {
            return was.done;
        }
        const done = (async () => {
            // Made in advance, it was just found missing: reading here, for a thousand items at once,
            // would fill Node's file thread pool and stall every other request's file reads.
            const cached = urgent ? await readFile(kept).catch(() => null) : null;
            if (cached) {
                return [200, cached, "image/png"];
            }
            let small;
            try {
                small = await scaled(async () => {
                    const full = await readImage(where);
                    if (full[0] !== 200) {
                        throw Object.assign(new Error(full[1].error), { answer: full });
                    }
                    return full[1];
                }, urgent);
            } catch (err) {
                if (err.answer) {
                    return err.answer;
                }
                throw err;
            }
            // Its own temporary name: the advance copy and a tile's may be written at once.
            const part = `${kept}.${urgent ? "tile" : "ahead"}.tmp`;
            try {
                mkdirSync(dirname(kept), { recursive: true });
                writeFileSync(part, small);
                renameSync(part, kept);
            } catch (err) {
                warnOnce(`could not keep thumbnails in ${dirname(kept)}: ${err.message}`);
            }
            return [200, small, "image/png"];
        })().finally(() => {
            if (making.get(kept)?.done === done) {
                making.delete(kept);
            }
        });
        making.set(kept, { urgent, done });
        return done;
    }

    /**
     * Makes, in the background, the grid thumbnail of every item of a capture that needs a
     * decision, so a grid opens with its tiles ready.
     * @param {string} dir the capture's directory
     * @param {{ items: object[] }} r its results.json
     */
    function prewarm(dir, r) {
        for (const item of r.items) {
            const kind = item.capture ? "capture" : "baseline";
            const hash = item[kind];
            if (
                REVIEWABLE.has(item.status) &&
                item.status !== "failed" &&
                hash &&
                !existsSync(join(tmp, "thumbs", `${hash}.png`))
            ) {
                const own = kind === "capture" || item.baseline === item.capture;
                const path = own ? join(dir, item.file) : join(dir, "baselines", item.file);
                thumbOf({ path, hash, file: item.file, dir }, false).catch((err) =>
                    warnOnce(`could not make the thumbnail of ${path}: ${err.message}`),
                );
            }
        }
    }

    // The unpublished count after a write, so the page's Finish button stays current: the
    // decisions, plus the files approved before passkeys that a signed Finish signs again.
    const unpublishedOf = (t) => finishList(t).list.length + legacyCount(t);

    /**
     * Where a target's image is on this disk, by results.json.
     * @param {string} id the target
     * @param {string} name the project
     * @param {string} kind "capture" or "baseline"
     * @param {string} file the image's file name
     * @returns {Promise<Array<unknown> | { path: string, hash: string, file: string, dir: string }>}
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
        return { path, hash, file, dir: p.dir };
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

    const routes = {
        "GET /api/prs": async (_, __, query) => {
            // ?cached=1 answers at once (starting the first load if there is none); ?refresh=1
            // also starts a refresh. Neither waits for GitHub. After a first load that failed, only
            // ?refresh=1 (the page's Retry) tries again.
            await restored;
            const cachedOnly = query?.get("cached") === "1" || query?.get("refresh") === "1";
            if (cachedOnly) {
                if (query.get("refresh") === "1" || (!loadedOnce && failure === null)) {
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
            return [200, query?.get("finish") === "1" ? { ...summary(t), finish: finishPreview(t) } : summary(t)];
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
            return [
                200,
                {
                    target: summary(t),
                    project: name,
                    acceptable: acceptable(t, name),
                    results: meta,
                    items: items.map((i) => {
                        const to = t.earlier.get(`${config.baselines}/${name}/${i.file}`);
                        return to !== undefined && to !== i.baseline ? { ...i, reReview: true } : i;
                    }),
                    decisions: Object.fromEntries(mine.map(([k, v]) => [k.slice(prefix.length), v])),
                },
            ];
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
            const before = decisionsOf(t).get(key);
            if (before && (before.decision !== body.decision || before.reason !== reason)) {
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
            if (!acceptable(t, body.project)) {
                return [
                    403,
                    {
                        error: `${body.project} cannot be accepted here (a local preview, or not seeded from ${defaultBranch})`,
                    },
                ];
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
                    if (inScope(item) && !mine.has(key) && !decisionProblem(item, "accept", null)) {
                        saved[key] = {
                            decision: "accept",
                            reason: null,
                            bulk: true,
                            hash: imageHash(item),
                            base: item.baseline ?? null,
                        };
                        files.push(item.file);
                    }
                }
            });
            return [200, { accepted: files.length, files, unpublished: unpublishedOf(t) }];
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
            const label = typeof body.label === "string" ? body.label.replace(/\s+/g, " ").trim().slice(0, 60) : "";
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
            if (t.local) {
                return [403, { error: "a local preview has no Finish" }];
            }
            if (finishing) {
                return [409, { error: "a Finish is already running" }];
            }
            const { trusted: keys } = await knownKeys();
            if (keys.length === 0) {
                approvals.delete(t.id);
                return [200, { required: false }];
            }
            const here = keys.filter((k) => k.rpId === rpId);
            if (here.length === 0) {
                const hosts = [...new Set(keys.map((k) => k.rpId))].join(", ");
                return [
                    409,
                    {
                        error: `no passkey is registered for ${rpId}: serve this page from the host your passkey is for (${hosts}), or register one here`,
                    },
                ];
            }
            const work = finishWork(t);
            const legacy = legacyOf(t);
            let prepared;
            try {
                prepared = await prepareRecord({
                    repo,
                    target: { pr: t.pr, branch: t.branch },
                    projects: work.captures,
                    decisions: work.list,
                    now: new Date(),
                    config,
                    legacy,
                });
            } catch (err) {
                if (err instanceof AcceptError) {
                    return [409, { error: err.message }];
                }
                throw err;
            }
            const challenge = recordHash(prepared.record).toString("base64url");
            approvals.set(t.id, {
                challenge,
                record: prepared.record,
                work,
                legacy,
                digest: work.digest,
                expires: Date.now() + APPROVAL_MS,
            });
            return [
                200,
                {
                    required: true,
                    challenge,
                    rpId,
                    allowCredentials: here.map((k) => k.id),
                    record: prepared.record,
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
            if (t.local) {
                return [403, { error: "a local preview has no Finish" }];
            }
            if (finishing) {
                return [409, { error: "a Finish is already running" }];
            }
            let work = finishWork(t);
            // The page's sheet stated what Finish would do; a decision changed since (in another
            // tab, say) would make that statement wrong.
            if (body.digest !== undefined && body.digest !== work.digest) {
                return [409, { error: CHANGED_SINCE }];
            }
            let approval = null;
            let legacy = null;
            const { main, trusted } = await knownKeys();
            if (trusted.length > 0) {
                if (!body.approval) {
                    return [400, { error: "this Finish needs your passkey approval (Face ID): press Finish again" }];
                }
                const p = approvals.get(t.id);
                if (!p || p.challenge !== body.challenge || p.expires < Date.now() || p.digest !== work.digest) {
                    return [
                        409,
                        {
                            error: "the approval is stale (made on another tab, expired, or the decisions changed): press Finish again",
                        },
                    ];
                }
                const record = { ...p.record, approval: body.approval };
                const why = verifyApproval(record, trusted, { origin });
                if (why) {
                    return [403, { error: `the approval was refused: ${why}` }];
                }
                approvals.delete(t.id);
                // The decisions the approved record was built from, not a fresh read of the state.
                work = p.work;
                legacy = p.legacy;
                approval = { record, pendingKeys: main.length > 0 ? [] : trusted, origin };
            }
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
                target: { pr: t.pr, branch: t.branch },
                projects: captures,
                decisions: list,
                undecided,
                unloaded: work.unloaded,
                config,
                ...(approval && { approval, legacy, now: new Date(approval.record.reviewedAt) }),
            });
            return [202, { job }];
        },
        "GET /api/finish-status": async () => [200, { job }],
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
        try {
            j.result = await finish({
                ...input,
                progress: (step) => {
                    j.step = step;
                    persist(j);
                },
            });
            try {
                clear(true);
            } catch (err) {
                // What was pushed and posted stands; the decisions it applied are still saved.
                j.warnings.push(`pushed and posted, but the decisions could not be cleared: ${err.message}`);
                console.error(`visual-review: Finish of ${finishLabel(t)}: ${j.warnings.at(-1)}`);
            }
            const r = j.result;
            const status = r.statusError ? `; status not posted: ${r.statusError}` : "";
            console.log(
                `visual-review: Finish of ${finishLabel(t)} done: commit ${r.commit ?? "none"}, ${r.rejects} rejects${status}`,
            );
        } catch (err) {
            if (err instanceof AcceptError && err.committed && !err.pullRequestMissing) {
                // The accepts are on the branch; keep only the rejects, so Finish again only comments.
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

    const finishLabel = (t) => (t.pr === null ? "the master seed" : `#${t.pr}`);

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

    return async (req, res) => {
        try {
            const url = new URL(req.url, origin);
            if (!url.pathname.startsWith("/api/")) {
                const entry = req.method === "GET" && Object.hasOwn(STATIC, url.pathname) ? STATIC[url.pathname] : null;
                return entry
                    ? send(res, 200, await readFile(join(HERE, entry[0])), entry[1])
                    : send(res, 404, { error: "not found" });
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
}
