#!/usr/bin/env node
/*
 * Checks that test/fixtures/old-gate/ still holds graphty-monorepo's copy of the gate.
 *
 *   node scripts/check-old-gate.mjs <graphty-monorepo checkout>
 *
 * Until graphty-monorepo moves to proofroom, its CI runs the gate from its own visual-review/
 * folder, the "old gate", and proofroom's tests check that what proofroom writes still passes it.
 * This compares the files of that gate in the checkout with the fixture and exits 1 naming each one
 * that differs, so a fix made there is ported here before it is relied on. Not published.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const OLD_GATE_FILES = [
    "trusted/gate.mjs",
    "trusted/lib/approval.mjs",
    "trusted/lib/config.mjs",
    "trusted/lib/results.mjs",
];

const FIXTURE = fileURLToPath(new URL("../test/fixtures/old-gate/", import.meta.url));

/**
 * The old gate's files whose copy in the checkout differs from the fixture, or is missing.
 * @param {string} checkout a graphty-monorepo checkout
 * @returns {string[]} their paths, relative to visual-review/
 */
export function oldGateDifferences(checkout) {
    const read = (path) => {
        try {
            return readFileSync(path);
        } catch {
            return null;
        }
    };
    return OLD_GATE_FILES.filter((file) => {
        const theirs = read(join(checkout, "visual-review", file));
        return theirs === null || !theirs.equals(readFileSync(join(FIXTURE, file)));
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const checkout = process.argv[2];
    if (!checkout) {
        console.error("usage: node scripts/check-old-gate.mjs <graphty-monorepo checkout>");
        process.exit(2);
    }
    const differ = oldGateDifferences(checkout);
    for (const file of differ) {
        console.error(`differs from test/fixtures/old-gate/: visual-review/${file}`);
    }
    if (differ.length === 0) {
        console.log("test/fixtures/old-gate/ matches the checkout's gate.");
    }
    process.exit(differ.length === 0 ? 0 : 1);
}
