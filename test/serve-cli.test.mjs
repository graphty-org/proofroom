/*
 * `visual-review serve` prints the URL to open: an IPv6 host goes in brackets, a name as it is.
 */

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONFIG_FILE } from "../trusted/lib/config.mjs";
import { git, ROOT, tempDir } from "./helpers.mjs";

const CLI = new URL("../trusted/cli.mjs", import.meta.url).pathname;

/**
 * A repository with the monorepo's config and git-lfs set up, and an empty local results directory.
 * @returns {{ repo: string, results: string }} the paths
 */
function setup() {
    const repo = tempDir("vr-serve-cli-");
    git(repo, "init", "-q", "-b", "master");
    git(repo, "lfs", "install", "--local");
    copyFileSync(join(ROOT, CONFIG_FILE), join(repo, CONFIG_FILE));
    writeFileSync(join(repo, "README.md"), "test\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=Owner", "-c", "user.email=owner@example.com", "commit", "-q", "-m", "init");
    const results = join(repo, "results");
    mkdirSync(results);
    return { repo, results };
}

/**
 * Starts serve on a free port of the given host and returns the URL line it prints, then stops it.
 * @param {string} host the HOST to bind
 * @returns {Promise<string>} the "open" line
 */
function openLine(host) {
    const { repo, results } = setup();
    const child = spawn(process.execPath, [CLI, "serve", "--results", results], {
        cwd: repo,
        env: { ...process.env, PORT: "0", HOST: host, HTTPS_CERT_PATH: "", HTTPS_KEY_PATH: "" },
    });
    return new Promise((resolve, reject) => {
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
            out += chunk;
            const line = out.split("\n").find((l) => l.startsWith("visual-review: open "));
            if (line) {
                child.kill();
                resolve(line);
            }
        });
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("exit", (code) => reject(new Error(`serve exited ${code}: ${err}`)));
    });
}

describe("visual-review serve", () => {
    it("brackets an IPv6 host in the URL it prints", async () => {
        expect(await openLine("::1")).toMatch(/^visual-review: open http:\/\/\[::1\]:0\/#token=\S+$/);
    });

    it("prints a host name as it is", async () => {
        expect(await openLine("localhost")).toMatch(/^visual-review: open http:\/\/localhost:0\/#token=\S+$/);
    });
});
