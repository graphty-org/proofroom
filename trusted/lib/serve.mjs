/**
 * The review page's server: the static page and a small JSON API over the downloaded captures.
 *
 * Every /api request carries the session token in `x-review-token`; the page reads it from the
 * URL fragment `serve` prints. State-changing requests are POST only and must come from the
 * served origin. Images are served only when their file is named by results.json and its bytes
 * hash to the hash results.json gives, so the page shows exactly what CI compared. Decisions
 * are kept in `<tmp>/state/<target>.json` until Finish, each with the hash of the image it was
 * taken on, so a restart resumes them and a new CI run keeps only those whose image is unchanged.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AcceptError, behindMaster, cleanReason, decisionProblem, finish } from "./accept.mjs";
import { downloadCaptures, exec, getRun, newestCiRun, openPullRequests, visualJobs } from "./github.mjs";
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

const REVIEWABLE = new Set(["changed", "new", "removed", "unstable", "failed"]);
const WRITES = new Set(["decide", "accept-all", "finish"]);

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
 * @returns {Promise<Map<string, string | null>>} `to` by baseline path
 */
async function earlierAccepts(repo, head, pr) {
    const out = new Map();
    if (pr === null || !head) {
        return out;
    }
    const git = (args) => exec("git", args, { cwd: repo });
    const names = await git(["ls-tree", "--name-only", head, "visual-baselines/reviews/"]).catch(() => "");
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
    if (!existsSync(file)) {
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
 * @param {Record<string, { seedFromMaster: boolean }>} options.projects projects.json
 * @param {string} options.tmp where artifacts are downloaded
 * @param {string} options.token the session token
 * @param {string} options.origin the origin the page is served from
 * @param {number} [options.masterRun] the master CI run to seed from
 * @param {string} [options.results] a local directory of `<project>/results.json` instead of CI:
 *     a preview to look at, with no decisions and no Finish
 * @param {string} [options.startCommand] the shell command that starts this server, shown so the
 *     owner can restart it from their own shell and sign Finish with their own key
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 *     the handler, for node:https in the CLI and node:http in the tests
 */
export function createApp({ repo, gh, projects, tmp, token, origin, masterRun, results, startCommand = null }) {
    const stateDir = join(tmp, "state");
    const names = Object.keys(projects);
    /** @type {Map<string, object>} targets by id: a pull request number, or "master" */
    let targets = new Map();
    /**
     * By target and run, then by `<project>/<file>`; `bulk` marks an accept from Accept all that
     * was never opened one by one, `posted` a reject an earlier Finish already commented.
     * @type {Map<string, Map<string, { decision: string, reason: string | null, bulk?: true,
     *     posted?: true }>>}
     */
    const decisions = new Map();
    let finishing = false;
    let signer = null;

    const itemOf = (t, key) => {
        const at = key.indexOf("/");
        const p = t.projects.find((x) => x.project === key.slice(0, at));
        return p?.results?.items.find((i) => i.file === key.slice(at + 1));
    };
    const stateFile = (t) => join(stateDir, `${t.id}.json`);

    const decisionsOf = (t) => {
        const key = `${t.id}@${t.runId}`;
        if (!decisions.has(key)) {
            let saved = {};
            try {
                saved = JSON.parse(readFileSync(stateFile(t), "utf8"));
            } catch {
                // No state yet, or a broken file: start empty.
            }
            const mine = new Map();
            for (const [k, { hash, ...d }] of Object.entries(saved)) {
                const item = itemOf(t, k);
                if (item && imageHash(item) === hash) {
                    mine.set(k, d);
                }
            }
            decisions.set(key, mine);
        }
        return decisions.get(key);
    };

    const save = (t) => {
        const out = {};
        for (const [k, d] of decisionsOf(t)) {
            out[k] = { ...d, hash: imageHash(itemOf(t, k)) };
        }
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(stateFile(t), JSON.stringify(out, null, 2));
    };

    // `problem` is what CI said (the job failed, or no artifact); results.json can add its own.
    async function project(name, dir, problem) {
        const loaded = dir ? await loadResults(dir) : { results: null, problem: null };
        return { project: name, dir, results: loaded.results, problem: problem ?? loaded.problem, logUrl: null };
    }

    async function build(info, run) {
        const jobs = await visualJobs(gh, run, run.attempt, names);
        const downloaded = await downloadCaptures(gh, run, names, tmp);
        const list = [];
        for (const name of names) {
            const job = jobs[name];
            const failed = !downloaded[name] || job?.conclusion === "failure";
            const p = await project(
                name,
                downloaded[name]?.dir,
                failed ? (job ? "capture failed" : "no capture") : null,
            );
            p.logUrl = job?.url ?? run.url;
            list.push(p);
        }
        return { ...info, runId: run.id, runAttempt: run.attempt, runUrl: run.url, projects: list };
    }

    async function refresh() {
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
            const prs = await openPullRequests(gh);
            // Best effort: master and the branches, so the badge below sees what accept will see.
            // A fork's branch is not on origin and fails its fetch, so master is fetched alone first.
            const fetch = (refs) => exec("git", ["fetch", "-q", "origin", ...refs], { cwd: repo }).catch(() => {});
            await fetch(["+refs/heads/master:refs/remotes/origin/master"]);
            await fetch(prs.map((p) => `+refs/heads/${p.branch}:refs/remotes/origin/${p.branch}`));
            for (const pr of prs) {
                const run = await newestCiRun(gh, pr.headSha);
                if (run) {
                    const id = String(pr.number);
                    next.set(
                        id,
                        await build({ id, pr: pr.number, title: pr.title, url: pr.url, branch: pr.branch }, run),
                    );
                }
            }
            if (masterRun) {
                const run = await getRun(gh, masterRun);
                next.set(
                    "master",
                    await build({ id: "master", pr: null, title: "master", url: null, branch: null }, run),
                );
            }
        }
        for (const t of next.values()) {
            const first = t.projects.find((p) => p.results)?.results;
            t.commit = first?.commit ?? null;
            t.headSha = first?.headSha ?? null;
            const base = t.pr === null ? t.commit : t.headSha;
            t.earlier = await earlierAccepts(repo, t.headSha, t.pr);
            t.mergeMasterFirst = false;
            for (const p of t.projects) {
                if (!t.local && p.results && base && (await behindMaster(repo, base, p.project).catch(() => true))) {
                    t.mergeMasterFirst = true;
                }
            }
        }
        signer = await signingIdentity(repo);
        targets = next;
    }

    const summary = (t) => {
        const decided = decisionsOf(t);
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
            signer,
            startCommand,
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
                    logUrl: p.logUrl,
                    counts,
                    reviewable,
                    decided: mine.length,
                    undecided: reviewable - mine.length,
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
    const acceptable = (t, name) => !isLocal(t, name) && (t.pr !== null || projects[name].seedFromMaster === true);
    const LOCAL = "is a local preview: nothing is decided on it; only CI captures of a pushed commit are";

    async function targetOf(id) {
        if (!targets.has(id)) {
            await refresh();
        }
        return targets.get(id);
    }

    async function projectOf(id, name) {
        const t = await targetOf(id);
        const p = t?.projects.find((x) => x.project === name);
        return p?.results ? { t, p } : {};
    }

    const routes = {
        "GET /api/prs": async () => {
            await refresh();
            return [200, { targets: [...targets.values()].map(summary) }];
        },
        // One target's counts without refetching from GitHub, for Finish's confirmation.
        "GET /api/target": async ([id]) => {
            const t = await targetOf(id);
            return t ? [200, summary(t)] : [404, { error: "no such target" }];
        },
        "GET /api/pr": async ([id, name]) => {
            const { t, p } = await projectOf(id, name);
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
                        const to = t.earlier.get(`visual-baselines/${name}/${i.file}`);
                        return to !== undefined && to !== i.baseline ? { ...i, reReview: true } : i;
                    }),
                    decisions: Object.fromEntries(mine.map(([k, v]) => [k.slice(prefix.length), v])),
                },
            ];
        },
        "GET /api/img": async ([id, name, kind, file]) => {
            const { p } = await projectOf(id, name);
            const item = p?.results.items.find((i) => i.file === file);
            const hash = item && { capture: item.capture, baseline: item.baseline }[kind];
            if (!hash) {
                return [404, { error: "no such image" }];
            }
            const bytes = await readFile(kind === "capture" ? join(p.dir, file) : join(p.dir, "baselines", file)).catch(
                () => null,
            );
            if (!bytes || createHash("sha256").update(bytes).digest("hex") !== hash) {
                return [409, { error: `${file} does not match results.json` }];
            }
            return [200, bytes, "image/png"];
        },
        "POST /api/decide": async (_, body) => {
            const { p, t } = await projectOf(String(body.id), body.project);
            const item = p?.results.items.find((i) => i.file === body.file);
            if (!item) {
                return [404, { error: "no such item" }];
            }
            const key = `${body.project}/${body.file}`;
            if (isLocal(t, body.project)) {
                return [403, { error: `${body.project} ${LOCAL}` }];
            }
            if (body.decision === null) {
                decisionsOf(t).delete(key);
                save(t);
                return [200, { ok: true }];
            }
            if (body.decision !== "reject" && !acceptable(t, body.project)) {
                return [
                    403,
                    { error: `${body.project} is not seeded from master; its first review is on a pull request` },
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
            decisionsOf(t).set(key, { decision: body.decision, reason });
            save(t);
            return [200, { ok: true }];
        },
        "POST /api/accept-all": async (_, body) => {
            const { p, t } = await projectOf(String(body.id), body.project);
            if (!p) {
                return [404, { error: "no such capture" }];
            }
            if (!acceptable(t, body.project)) {
                return [
                    403,
                    { error: `${body.project} cannot be accepted here (a local preview, or not seeded from master)` },
                ];
            }
            // With `component`, only that component's stories: the story id before "--".
            const inScope = (item) => typeof body.component !== "string" || componentOf(item.id) === body.component;
            const mine = decisionsOf(t);
            let accepted = 0;
            for (const item of p.results.items) {
                const key = `${body.project}/${item.file}`;
                if (inScope(item) && !mine.has(key) && !decisionProblem(item, "accept", null)) {
                    mine.set(key, { decision: "accept", reason: null, bulk: true });
                    accepted++;
                }
            }
            save(t);
            return [200, { accepted }];
        },
        "POST /api/finish": async (_, body) => {
            const t = await targetOf(String(body.id));
            if (!t) {
                return [404, { error: "no such target" }];
            }
            if (t.local) {
                return [403, { error: "a local preview has no Finish" }];
            }
            if (finishing) {
                return [409, { error: "a Finish is already running" }];
            }
            const mine = decisionsOf(t);
            // A reject already posted by an earlier Finish stays shown as rejected, not posted again.
            const list = [...mine]
                .filter(([, v]) => !v.posted)
                .map(([k, v]) => {
                    const at = k.indexOf("/");
                    return { project: k.slice(0, at), file: k.slice(at + 1), decision: v.decision, reason: v.reason };
                });
            const captures = Object.fromEntries(
                t.projects.filter((p) => p.results).map((p) => [p.project, { dir: p.dir, results: p.results }]),
            );
            const undecided = summary(t).projects.reduce((n, p) => n + p.undecided, 0);
            finishing = true;
            try {
                const out = await finish({
                    repo,
                    gh,
                    target: { pr: t.pr, branch: t.branch },
                    projects: captures,
                    decisions: list,
                    undecided,
                });
                // Rejects stay, keyed by image hash, so an unchanged rejected capture on the next
                // CI run still reads as rejected rather than undecided.
                for (const [k, v] of mine) {
                    if (v.decision === "reject") {
                        v.posted = true;
                    } else {
                        mine.delete(k);
                    }
                }
                save(t);
                return [200, out];
            } catch (err) {
                if (err instanceof AcceptError && err.committed) {
                    // The accepts are on the branch; keep only the rejects, so Finish again only comments.
                    for (const [k, v] of mine) {
                        if (v.decision !== "reject") {
                            mine.delete(k);
                        }
                    }
                    save(t);
                }
                return [err instanceof AcceptError ? 409 : 500, { error: err.message }];
            } finally {
                finishing = false;
            }
        },
    };

    const tokenOk = (given) => {
        const a = Buffer.from(String(given ?? ""));
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
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
            const [status, body, type] = await handler(args, writes ? await readBody(req) : undefined);
            return send(res, status, body, type);
        } catch (err) {
            // A malformed request (bad JSON, bad escape, oversized body) is the client's; the rest,
            // gh and git failures included, is ours.
            const client = err instanceof SyntaxError || err instanceof URIError || err.message.startsWith("body ");
            return send(res, client ? 400 : 500, { error: err.message });
        }
    };
}
