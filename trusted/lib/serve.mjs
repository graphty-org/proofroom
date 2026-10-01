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
 *
 * Once the default branch lists passkeys (`visual-review.passkeys.json`), a Finish that commits
 * needs the owner's approval: the Finish preview builds the record Finish would commit and gives
 * its hash, the page has the passkey sign it, and POST /api/finish checks the assertion before it
 * starts (design.md section 8). POST /api/passkey opens the pull request that registers one.
 *
 * The list of targets is cached: `GET /api/prs?cached=1` answers at once with the cache, its age
 * and the progress of a refresh, and `?refresh=1` starts one in the background, so the page never
 * waits on GitHub to change screens. A target whose captures are still downloading is listed with
 * `downloading: true` and rebuilt in the cache when they land. Grid tiles load thumbnails
 * (`GET /api/thumb/...`) that the server scales down once and keeps on disk.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

import {
    AcceptError,
    behindMaster,
    cleanReason,
    commitStatus,
    decisionProblem,
    finish,
    prepareFinish,
    registerPasskey,
} from "./accept.mjs";
import { approvalProblem, passkeysAt } from "./approval.mjs";
import { downloadCaptures, exec, getRun, newestCiRun, openPullRequests, visualJobs } from "./github.mjs";
import { CONFIG_FILE } from "./config.mjs";
import { validateResults } from "./results.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = {
    "/": ["../page/index.html", "text/html; charset=utf-8"],
    "/review.js": ["../page/review.js", "text/javascript; charset=utf-8"],
    "/review.css": ["../page/review.css", "text/css; charset=utf-8"],
    "/pixelmatch.mjs": ["../vendor/pixelmatch.mjs", "text/javascript; charset=utf-8"],
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
const WRITES = new Set(["decide", "accept-all", "finish", "passkey"]);
// How long a page load waits for a run's captures to download before it lists the target as
// downloading; the download goes on, and a reload picks it up.
const PATIENCE = 1000;
// An unknown target id refreshes from GitHub at most this often: a closed pull request's open
// grid asks for dozens of images at once.
const UNKNOWN_REFRESH = 60000;
// A grid tile is about 190 CSS pixels wide: 400 image pixels keep it sharp on a 2x screen, at
// about a thirtieth of a 2400 x 1800 capture's memory once decoded.
const THUMB_WIDTH = 400;

/**
 * A PNG scaled down to `width` pixels across (never up), each output pixel the average of the
 * source pixels under it. For display in the grid only: comparisons use the full images.
 * @param {Buffer} bytes the PNG
 * @param {number} width the widest the result may be
 * @returns {Buffer} the smaller PNG
 */
export function thumbnail(bytes, width = THUMB_WIDTH) {
    const src = PNG.sync.read(bytes);
    const w = Math.min(width, src.width);
    const h = Math.max(1, Math.round((src.height * w) / src.width));
    const out = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        const [y0, y1] = [
            Math.floor((y * src.height) / h),
            Math.max(Math.floor(((y + 1) * src.height) / h), 1 + Math.floor((y * src.height) / h)),
        ];
        for (let x = 0; x < w; x++) {
            const [x0, x1] = [
                Math.floor((x * src.width) / w),
                Math.max(Math.floor(((x + 1) * src.width) / w), 1 + Math.floor((x * src.width) / w)),
            ];
            const sum = [0, 0, 0, 0];
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const i = (sy * src.width + sx) * 4;
                    for (let c = 0; c < 4; c++) {
                        sum[c] += src.data[i + c];
                    }
                }
            }
            const n = (y1 - y0) * (x1 - x0);
            const o = (y * w + x) * 4;
            for (let c = 0; c < 4; c++) {
                out.data[o + c] = Math.round(sum[c] / n);
            }
        }
    }
    return PNG.sync.write(out);
}

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
 * Writes a JSON file through a sibling renamed into place, so a kill or a full disk mid-write
 * never leaves half a file.
 * @param {string} file the file
 * @param {unknown} value what to write
 */
function writeJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const part = `${file}.tmp`;
    writeFileSync(part, JSON.stringify(value, null, 2));
    renameSync(part, file);
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
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 *     the handler, for node:https in the CLI and node:http in the tests
 */
export function createApp({ repo, gh, config, tmp, token, origin, masterRun, results, startCommand = null, warm }) {
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
     * The newest Finish, kept after it ends so a reload still shows its result.
     * @type {{ id: number, target: string, pr: number | null, branch: string | null, running: boolean,
     *     step: string | null, result: object | null, error: string | null, warnings: string[],
     *     interrupted?: true } | null}
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
    /** The passkeys on the default branch (null: none registered, approvals not required yet). */
    let passkeys = null;
    /** An open pull request that registers a passkey, waiting for the owner to merge it. */
    let passkeyPr = null;
    /** The passkey pull request this server opened: listed until GitHub's list or the file has it. */
    let passkeyOpened = null;
    const readPasskeys = () => {
        passkeys = results ? null : passkeysAt(`refs/remotes/origin/${defaultBranch}`, repo);
    };
    readPasskeys();
    /** The record each target's Finish sheet showed, by target id, for its passkey to sign. */
    const prepared = new Map();
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
     * taken on; `bulk` marks an accept from Accept all that was never opened one by one, `posted`
     * a reject an earlier Finish already commented. A file that is not a decisions file is moved
     * aside, never overwritten, so the owner can still recover what it held.
     * @param {object} t the target
     * @returns {Record<string, { decision: string, reason: string | null, hash: string | null,
     *     bulk?: true, posted?: true }>} the decisions
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
     * was taken on, and still decidable that way. The others stay in the file.
     * @param {object} t the target
     * @returns {Map<string, { decision: string, reason: string | null, bulk?: true, posted?: true }>}
     *     by `<project>/<file>`
     */
    const decisionsOf = (t) => {
        const mine = new Map();
        for (const [k, { hash, ...d }] of Object.entries(readState(t))) {
            const item = itemOf(t, k);
            const project = k.slice(0, k.indexOf("/"));
            if (
                item &&
                imageHash(item) === hash &&
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
        return { project: name, dir, results: loaded.results, problem: problem ?? loaded.problem, logUrl: null };
    }

    async function build(info, run) {
        const jobs = await visualJobs(gh, run, run.attempt, names);
        const others = [];
        // Each project's capture as its download lands; `partial` is the target listed while the
        // rest are still downloading, whose rows fill in one by one.
        const landed = new Map();
        let partial = null;
        const fill = async (name) => {
            const p = await project(name, landed.get(name)?.dir, problemOf(name, landed.get(name), run, jobs));
            p.logUrl = jobs[name]?.url ?? run.url;
            partial.projects[names.indexOf(name)] = p;
            partial.downloaded = landed.size;
            await decorate(partial);
        };
        const downloads = downloadCaptures(gh, run, names, tmp, others, (name, got) => {
            landed.set(name, got);
            if (partial) {
                fill(name).catch((err) => console.error(`visual-review: ${name} of ${info.id}: ${err.message}`));
            }
        });
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
                        }
                    }
                })
                .catch((err) => console.error(`visual-review: rebuilding ${info.id} failed: ${err.message}`));
            partial = blank(info, null, run);
            partial.downloading = true;
            partial.downloadStartedAt = Date.now() - PATIENCE;
            partial.downloaded = 0;
            for (const p of partial.projects) {
                p.downloading = true;
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
        return { ...info, runId: run.id, runAttempt: run.attempt, runUrl: run.url, projects: list, warnings };
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
                listWarnings.push(`git fetch of ${what} failed, so "merge master first" may be wrong: ${err.message}`);
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
                    };
                    try {
                        const run = await newestCiRun(gh, pr.headSha, config);
                        return run
                            ? await build(info, run)
                            : blank(info, `waiting for CI on ${pr.headSha.slice(0, 10)}`);
                    } catch (err) {
                        return keptOr(info, err);
                    } finally {
                        step("finding CI runs", ++found, prs.length);
                    }
                }),
            );
            step("fetching branches");
            await fetched;
            readPasskeys();
            // GitHub's list can lag a pull request just opened: keep it a while, until its key is merged.
            const opened =
                passkeyOpened &&
                Date.now() - passkeyOpened.at < 5 * 60000 &&
                !(passkeys?.keys ?? []).some((k) => k.id === passkeyOpened.id)
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
        prune();
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
            if (!t.local && p.results && base) {
                const behind = known ? await behindMaster(repo, base, p.project, config).catch(() => null) : null;
                if (behind !== false && t.mergeMasterFirst !== true) {
                    t.mergeMasterFirst = behind;
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
            // While downloading: how many projects have landed, and since when (server time).
            download: t.downloading
                ? { done: t.downloaded ?? 0, total: names.length, startedAt: t.downloadStartedAt ?? null }
                : null,
            defaultBranch,
            // Decisions the next Finish would publish (a reject an earlier Finish posted is not).
            unpublished: [...decided.values()].filter((d) => !d.posted).length,
            warnings,
            signer,
            startCommand,
            passkey: {
                required: passkeys !== null,
                keys: (passkeys?.keys ?? []).map(({ id, label, rpId }) => ({ id, label, rpId })),
                problem: passkeys?.problem ?? null,
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
                    logUrl: p.logUrl,
                    counts,
                    reviewable,
                    decided: mine.length,
                    undecided: reviewable - mine.length,
                    // Accepts and exclusions an earlier Finish pushed, waiting for a new CI run.
                    finished: mine.filter(([, d]) => d.posted && d.decision !== "reject").length,
                    notOpened: mine.filter(([, d]) => d.bulk).length,
                    acceptable: acceptable(t, p.project),
                    local: p.results?.local ?? null,
                };
            }),
        };
    };

    // A local preview (--results, or any capture not made by CI) is only looked at: no decision is
    // taken on it and it has no Finish, since Finish accepts only CI captures.
    const isLocal = (t, name) =>
        t.local === true || Boolean(t.projects.find((x) => x.project === name)?.results?.local);
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
        return { list, digest: createHash("sha256").update(JSON.stringify(list)).digest("hex") };
    };
    const CHANGED_SINCE = "Decisions changed since this sheet opened: check the summary again.";

    // What Finish's sheet states before it runs: what it commits and posts, the status it sets, and
    // when a passkey must approve it, the hash of the record it would commit.
    const finishPreview = async (t) => {
        const { list, digest } = finishList(t);
        let signing = null;
        if (passkeys?.keys.length > 0 && list.some((x) => x.decision !== "reject") && !t.local) {
            try {
                const ready = await prepareFinish({
                    repo,
                    target: { pr: t.pr, branch: t.branch },
                    projects: capturesOf(t),
                    decisions: list,
                    now: new Date(),
                    config,
                });
                prepared.set(t.id, { digest, ...ready });
                signing = { hash: ready.hash };
            } catch (err) {
                signing = { error: err.message };
            }
        }
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
            status: commitStatus({
                accepted: count("accept"),
                rejected: count("reject"),
                excluded: count("exclude"),
                undecided,
                unloaded,
            }),
            digest,
            signing,
        };
    };

    const capturesOf = (t) =>
        Object.fromEntries(
            t.projects.filter((p) => p.results).map((p) => [p.project, { dir: p.dir, results: p.results }]),
        );

    /** Thumbnails being made, by the file they are kept in. */
    const making = new Map();

    // The unpublished count after a write, so the page's Finish button stays current.
    const unpublishedOf = (t) => finishList(t).list.length;

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
        const hash = item && { capture: item.capture, baseline: item.baseline }[kind];
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
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== hash) {
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
            // also starts a refresh. Neither waits for GitHub.
            const cachedOnly = query?.get("cached") === "1" || query?.get("refresh") === "1";
            if (cachedOnly) {
                if (query.get("refresh") === "1" || !loadedOnce) {
                    refresh().catch((err) => console.error(`visual-review: refresh failed: ${err.message}`));
                }
            } else {
                await refresh();
            }
            return [
                200,
                {
                    targets: loadedOnce || !cachedOnly ? [...targets.values()].map(summary) : null,
                    warning: listWarnings.join("\n") || null,
                    defaultBranch,
                    updatedAt: refreshedAt || null,
                    now: Date.now(),
                    refreshing: progress,
                },
            ];
        },
        // One target's counts without refetching from GitHub; with ?finish=1, what Finish would do.
        "GET /api/target": async ([id], _, query) => {
            const t = await targetOf(id);
            if (!t) {
                return gone(id);
            }
            return [200, query?.get("finish") === "1" ? { ...summary(t), finish: await finishPreview(t) } : summary(t)];
        },
        "GET /api/pr": async ([id, name]) => {
            const { t, p } = await projectOf(id, name);
            if (!t) {
                return gone(id);
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
            const kept = join(tmp, "thumbs", `${where.hash}.png`);
            const cached = await readFile(kept).catch(() => null);
            if (cached) {
                return [200, cached, "image/png"];
            }
            // Tiles showing the same image at once share one scaling.
            if (!making.has(kept)) {
                making.set(
                    kept,
                    (async () => {
                        const full = await readImage(where);
                        if (full[0] !== 200) {
                            return full;
                        }
                        const small = thumbnail(full[1]);
                        try {
                            mkdirSync(dirname(kept), { recursive: true });
                            writeFileSync(`${kept}.tmp`, small);
                            renameSync(`${kept}.tmp`, kept);
                        } catch (err) {
                            warnOnce(`could not keep thumbnails in ${dirname(kept)}: ${err.message}`);
                        }
                        return [200, small, "image/png"];
                    })().finally(() => making.delete(kept)),
                );
            }
            return making.get(kept);
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
                saved[key] = { decision: body.decision, reason, hash: imageHash(item) };
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
            // With `component`, only that component's stories: the story id before "--".
            const inScope = (item) => typeof body.component !== "string" || componentOf(item.id) === body.component;
            const mine = decisionsOf(t);
            let accepted = 0;
            update(t, (saved) => {
                for (const item of p.results.items) {
                    const key = `${body.project}/${item.file}`;
                    if (inScope(item) && !mine.has(key) && !decisionProblem(item, "accept", null)) {
                        saved[key] = { decision: "accept", reason: null, bulk: true, hash: imageHash(item) };
                        accepted++;
                    }
                }
            });
            return [200, { accepted, unpublished: unpublishedOf(t) }];
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
            // A reject already posted by an earlier Finish stays shown as rejected, not posted again.
            const { list, digest } = finishList(t);
            // The page's sheet stated what Finish would do; a decision changed since (in another
            // tab, say) would make that statement wrong.
            if (body.digest !== undefined && body.digest !== digest) {
                return [409, { error: CHANGED_SINCE }];
            }
            // A Finish that commits needs the owner's passkey once one is registered: the approval
            // must sign the record the sheet showed, for exactly these decisions.
            let signed = {};
            if (passkeys !== null && list.some((x) => x.decision !== "reject")) {
                const ready = prepared.get(t.id);
                if (!body.approval || !ready) {
                    return [400, { error: "this Finish needs your passkey: open the Finish sheet again" }];
                }
                if (ready.digest !== digest) {
                    return [409, { error: CHANGED_SINCE }];
                }
                const problem = approvalProblem({ ...ready.record, approval: body.approval }, passkeys.keys);
                if (problem) {
                    return [400, { error: `your passkey's approval was refused: ${problem}` }];
                }
                signed = {
                    now: new Date(ready.record.reviewedAt),
                    approval: body.approval,
                    passkeys: passkeys.keys,
                };
                prepared.delete(t.id);
            }
            const captures = capturesOf(t);
            const undecided = summary(t).projects.reduce((n, p) => n + p.undecided, 0);
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
                unloaded: t.projects.filter((p) => !p.results).map((p) => p.project),
                config,
                ...signed,
            });
            return [202, { job }];
        },
        // Register passkey: a pull request adding the page's new passkey to the default branch's
        // passkeys file. It counts once the owner merges it.
        "POST /api/passkey": async (_, body) => {
            if (results) {
                return [403, { error: "a local preview registers no passkey" }];
            }
            try {
                const pullRequest = await registerPasskey({ repo, gh, config, entry: body.entry ?? {} });
                passkeyPr = Number(pullRequest.split("/").pop()) || passkeyPr;
                passkeyOpened = { number: passkeyPr, id: body.entry?.id, at: Date.now() };
                return [200, { pullRequest }];
            } catch (err) {
                if (err instanceof AcceptError) {
                    return [409, { error: err.message }];
                }
                throw err;
            }
        },
        "GET /api/finish-status": async () => [200, { job }],
    };

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

    if (warm) {
        // Download the captures now, so they are on disk before the page first asks.
        refresh().catch((err) => console.error(`visual-review: startup refresh failed: ${err.message}`));
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
