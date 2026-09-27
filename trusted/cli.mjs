#!/usr/bin/env node
/**
 * visual-review: capture Storybook stories, compare them with the baselines in git, and serve
 * the page where the owner accepts or rejects the differences.
 *
 * Usage: visual-review <capture|compare|serve> [options]
 *
 *   compare --baselines <dir> --captures <dir> [--threshold <0..1>] [--include-aa]
 *     Compares every PNG in the two directories by name and prints one JSON line per file that
 *     is not unchanged, then a summary. Exits 1 when anything differs. For local use: one
 *     capture per story, and the default threshold for every story.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { classify, DEFAULT_THRESHOLD } from "./lib/compare.mjs";

const SUBCOMMANDS = {
    capture: () => notYet("capture"),
    compare,
    serve: () => notYet("serve"),
};

function notYet(name) {
    console.error(`visual-review ${name}: not implemented yet`);
    return 1;
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
    const read = (dir, file, present) => (present.includes(file) ? readFile(join(dir, file)) : null);
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
