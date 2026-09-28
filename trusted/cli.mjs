#!/usr/bin/env node
/**
 * visual-review: capture Storybook stories, compare them with the baselines in git, and serve
 * the page where the owner accepts or rejects the differences.
 *
 * Usage: visual-review <capture|reference|compare|serve> [options]
 *
 *   capture --project <id> --out <dir> [--storybook <dir>] [--baselines <dir>] [--workers <n>]
 *           [--reference <dir>] [--stories <prefix,...>]
 *     Captures every story of one built Storybook and writes results.json and the PNGs to review
 *     into <dir>. --storybook defaults to <package>/storybook-static, --baselines to
 *     visual-baselines/<id>, and --workers to the project's entry in projects.json. --reference
 *     is master's capture (from `reference`): a story with no baseline that looks as it does there
 *     is `unseeded`, not `new`. --stories captures only the story ids starting with a prefix, for
 *     a quick local preview. Exits 0 whatever it finds; non-zero only when the tool itself fails,
 *     including a baseline that is an LFS pointer (run `git lfs pull`).
 *
 *   reference --project <id> --out <dir>
 *     Downloads master's newest complete capture of the project with gh into <dir> and prints
 *     its directory, or prints nothing when there is none.
 *
 *   serve [--master-run <id>] [--results <dir> [--branch <name>]]
 *     Serves the review page over HTTPS on $PORT (bound to $HOST), with the certificate at
 *     $HTTPS_CERT_PATH and $HTTPS_KEY_PATH; start it through servherd (see CLAUDE.md, "Visual
 *     review"). Lists open pull requests with a CI run and downloads their captures with gh.
 *     --master-run adds master, pinned to that CI run, for seeding. --results serves a local
 *     directory of <project>/results.json instead, offline: gh is never run, and what it would
 *     have posted is printed; Finish pushes to --branch. Refuses to start without git-lfs,
 *     because an accept would then commit raw PNGs.
 *
 *   compare --baselines <dir> --captures <dir> [--threshold <0..1>] [--include-aa]
 *     Compares every PNG in the two directories by name and prints one JSON line per file that
 *     is not unchanged, then a summary. Exits 1 when anything differs. For local use: one
 *     capture per story, and the default threshold for every story.
 */

import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { lfsProblem } from "./lib/accept.mjs";
import { classify, DEFAULT_THRESHOLD, readBaseline } from "./lib/compare.mjs";
import { ghRunner, newestMasterCapture } from "./lib/github.mjs";
import { createApp, sessionToken } from "./lib/serve.mjs";

const SUBCOMMANDS = {
    capture,
    reference,
    compare,
    serve,
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function capture(args) {
    const { values } = parseArgs({
        args,
        options: {
            project: { type: "string" },
            out: { type: "string" },
            storybook: { type: "string" },
            baselines: { type: "string" },
            workers: { type: "string" },
            reference: { type: "string" },
            stories: { type: "string" },
        },
    });
    const projects = JSON.parse(await readFile(join(ROOT, "visual-review/projects.json"), "utf8"));
    const project = Object.hasOwn(projects, values.project ?? "") ? projects[values.project] : undefined;
    const workers = Number(values.workers ?? project?.workers);
    if (!project || !values.out || !(Number.isInteger(workers) && workers > 0)) {
        console.error(
            `usage: visual-review capture --project <${Object.keys(projects).join("|")}> --out <dir> ` +
                "[--storybook <dir>] [--baselines <dir>] [--workers <n>] [--reference <dir>] [--stories <prefix,...>]",
        );
        return 2;
    }
    // Playwright is capture's only dependency, so it loads only for this subcommand.
    const { capture: run } = await import("../capture/capture.mjs");
    await run({
        project: values.project,
        storybook: resolve(values.storybook ?? join(ROOT, project.dir, "storybook-static")),
        baselines: resolve(values.baselines ?? join(ROOT, "visual-baselines", values.project)),
        out: resolve(values.out),
        workers,
        stableFrame: project.stableFrame,
        reference: values.reference ? resolve(values.reference) : null,
        stories: values.stories ? values.stories.split(",").filter(Boolean) : null,
    });
    return 0;
}

async function reference(args) {
    const { values } = parseArgs({ args, options: { project: { type: "string" }, out: { type: "string" } } });
    if (!values.project || !values.out) {
        console.error("usage: visual-review reference --project <id> --out <dir>");
        return 2;
    }
    console.log((await newestMasterCapture(ghRunner(ROOT), values.project, resolve(values.out))) ?? "");
    return 0;
}

async function serve(args) {
    const { values } = parseArgs({
        args,
        options: {
            "master-run": { type: "string" },
            results: { type: "string" },
            branch: { type: "string" },
        },
    });
    const { PORT, HOST = "localhost", HTTPS_CERT_PATH, HTTPS_KEY_PATH } = process.env;
    const masterRun = values["master-run"] === undefined ? undefined : Number(values["master-run"]);
    if (!PORT || !HTTPS_CERT_PATH || !HTTPS_KEY_PATH || (masterRun !== undefined && !Number.isInteger(masterRun))) {
        console.error(
            "usage: PORT=<n> HTTPS_CERT_PATH=<pem> HTTPS_KEY_PATH=<pem> visual-review serve " +
                "[--master-run <id>] [--results <dir> [--branch <name>]]\n" +
                'start it through servherd, which sets PORT and the certificate (CLAUDE.md, "Visual review")',
        );
        return 2;
    }
    const lfs = await lfsProblem(ROOT);
    if (lfs) {
        console.error(`visual-review serve: ${lfs}`);
        return 1;
    }
    const tmp = join(ROOT, "tmp/visual-review");
    const token = sessionToken(join(tmp, "state"));
    const origin = `https://${HOST}:${PORT}`;
    // Offline: a local results directory is a preview, so nothing is posted to GitHub.
    const offline = async (ghArgs, input) => {
        console.log(`gh (offline, not run): ${ghArgs.join(" ")}\n${input ?? ""}`);
        return JSON.stringify({ html_url: null });
    };
    const app = createApp({
        repo: ROOT,
        gh: values.results ? offline : ghRunner(ROOT),
        projects: JSON.parse(await readFile(join(ROOT, "visual-review/projects.json"), "utf8")),
        tmp,
        token,
        origin,
        masterRun,
        results: values.results && resolve(values.results),
        branch: values.branch,
    });
    const server = createServer({ cert: readFileSync(HTTPS_CERT_PATH), key: readFileSync(HTTPS_KEY_PATH) }, app);
    await new Promise((done) => server.listen({ port: Number(PORT), host: HOST }, () => done(null)));
    console.log(`visual-review: open ${origin}/#token=${token}`);
    // Keep running until servherd stops the process.
    await new Promise(() => {});
    return 0;
}

async function compare(args) {
    const { values } = parseArgs({
        args,
        options: {
            baselines: { type: "string" },
            captures: { type: "string" },
            threshold: { type: "string", default: String(DEFAULT_THRESHOLD) },
            "include-aa": { type: "boolean", default: false },
        },
    });
    const threshold = Number(values.threshold);
    if (!values.baselines || !values.captures || !(threshold >= 0 && threshold <= 1)) {
        console.error("usage: visual-review compare --baselines <dir> --captures <dir> [--threshold <0..1>]");
        return 2;
    }
    const pngs = async (dir) => (await readdir(dir)).filter((f) => f.endsWith(".png"));
    const read = (dir, file, present) =>
        present.includes(file) ? (dir === values.baselines ? readBaseline : readFile)(join(dir, file)) : null;
    const [baselines, captures] = await Promise.all([pngs(values.baselines), pngs(values.captures)]);
    const counts = {};
    for (const file of [...new Set([...baselines, ...captures])].sort()) {
        const item = classify({
            baseline: await read(values.baselines, file, baselines),
            first: await read(values.captures, file, captures),
            threshold,
            includeAA: values["include-aa"],
        });
        counts[item.status] = (counts[item.status] ?? 0) + 1;
        if (item.status !== "unchanged") {
            console.log(JSON.stringify({ file, ...item }));
        }
    }
    console.log(JSON.stringify({ summary: counts }));
    return Object.keys(counts).some((status) => status !== "unchanged") ? 1 : 0;
}

const [name, ...rest] = process.argv.slice(2);
const run = Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : undefined;
if (run === undefined) {
    console.error(`usage: visual-review <${Object.keys(SUBCOMMANDS).join("|")}> [options]`);
    process.exit(2);
}
process.exitCode = await run(rest);
