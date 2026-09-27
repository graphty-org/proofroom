/**
 * The review page's server: the static page and a small JSON API over the downloaded captures.
 *
 * Every /api request carries the session token in `x-review-token`; the page reads it from the
 * URL fragment `serve` prints. State-changing requests are POST only and must come from the
 * served origin. Images are served only when their file is named by results.json and its bytes
 * hash to the hash results.json gives, so the page shows exactly what CI compared. Decisions
 * live in memory until Finish.
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
const REVIEWABLE = new Set(["changed", "new", "removed", "unstable", "failed"]);

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
 * @param {string} [options.results] a local directory of `<project>/results.json` instead of CI
 * @param {string} [options.branch] with `results`, the branch Finish pushes to
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 *     the handler, for node:https in the CLI and node:http in the tests
 */
export function createApp({ repo, gh, projects, tmp, token, origin, masterRun, results, branch }) {
    const names = Object.keys(projects);
    /** @type {Map<string, object>} targets by id: a pull request number, or "master" */
    let targets = new Map();
    /** @type {Map<string, Map<string, { decision: string, reason: string | null }>>} */
    const decisions = new Map();
    let finishing = false;

    const decisionsOf = (t) => {
        const key = `${t.id}@${t.runId}`;
        if (!decisions.has(key)) {
            decisions.set(key, new Map());
        }
        return decisions.get(key);
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
                const id = r.pr === null ? "master" : String(r.pr);
                next.set(id, {
                    id,
                    pr: r.pr,
                    title: `local results in ${results}`,
                    url: null,
                    branch: branch ?? null,
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
            t.mergeMasterFirst = false;
            for (const p of t.projects) {
                if (p.results && base && (await behindMaster(repo, base, p.project).catch(() => true))) {
                    t.mergeMasterFirst = true;
                }
            }
        }
        targets = next;
    }

    const summary = (t) => {
        const decided = decisionsOf(t);
        return {
            id: t.id,
            pr: t.pr,
            title: t.title,
            url: t.url,
            branch: t.branch,
            runId: t.runId,
            runAttempt: t.runAttempt,
            runUrl: t.runUrl,
            commit: t.commit,
            headSha: t.headSha,
            mergeMasterFirst: t.mergeMasterFirst,
            projects: t.projects.map((p) => {
                const counts = {};
                for (const item of p.results?.items ?? []) {
                    counts[item.status] = (counts[item.status] ?? 0) + 1;
                }
                const reviewable = (p.results?.items ?? []).filter((i) => REVIEWABLE.has(i.status)).length;
                const prefix = `${p.project}/`;
                return {
                    project: p.project,
                    problem: p.problem,
                    logUrl: p.logUrl,
                    counts,
                    reviewable,
                    decided: [...decided.keys()].filter((k) => k.startsWith(prefix)).length,
                    acceptable: acceptable(t, p.project),
                    local: p.results?.local ?? null,
                };
            }),
        };
    };

    const acceptable = (t, name) => t.pr !== null || projects[name].seedFromMaster === true;

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
                    items,
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
            if (body.decision === null) {
                decisionsOf(t).delete(key);
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
            decisionsOf(t).set(key, { decision: body.decision, reason });
            return [200, { ok: true }];
        },
        "POST /api/finish": async (_, body) => {
            const t = await targetOf(String(body.id));
            if (!t) {
                return [404, { error: "no such target" }];
            }
            if (finishing) {
                return [409, { error: "a Finish is already running" }];
            }
            const mine = decisionsOf(t);
            const list = [...mine].map(([k, v]) => {
                const at = k.indexOf("/");
                return { project: k.slice(0, at), file: k.slice(at + 1), ...v };
            });
            const captures = Object.fromEntries(
                t.projects.filter((p) => p.results).map((p) => [p.project, { dir: p.dir, results: p.results }]),
            );
            finishing = true;
            try {
                const out = await finish({
                    repo,
                    gh,
                    target: { pr: t.pr, branch: t.branch },
                    projects: captures,
                    decisions: list,
                });
                mine.clear();
                return [200, out];
            } catch (err) {
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
            const writes = route === "decide" || route === "finish";
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
