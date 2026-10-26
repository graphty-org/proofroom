/*
 * The work one compareSnapshot() call does: what every call shares (which baselines exist, the
 * renames, the reference images, the repository root and its config) is read once, not once per
 * call, so a call costs what one item of compare costs however many baselines there are.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CONFIG_FILE } from "../trusted/lib/config.mjs";

import { git, tempDir } from "./helpers.mjs";
import { png } from "./story-test-fakes.mjs";

const work = vi.hoisted(() => ({ readdir: [], readFile: [], git: [] }));

vi.mock("node:fs/promises", async (original) => {
    const fs = await original();
    return {
        ...fs,
        readdir: (path, ...rest) => {
            work.readdir.push(String(path));
            return fs.readdir(path, ...rest);
        },
        readFile: (path, ...rest) => {
            work.readFile.push(String(path));
            return fs.readFile(path, ...rest);
        },
    };
});
vi.mock("node:child_process", async (original) => {
    const cp = await original();
    return {
        ...cp,
        execFileSync: (file, args, ...rest) => {
            if (file === "git") {
                work.git.push(args.join(" "));
            }
            return cp.execFileSync(file, args, ...rest);
        },
    };
});

describe("compareSnapshot's work", () => {
    it("reads the baselines directory, the renames and the reference once across many calls", async () => {
        // The setup files loaded compare.mjs before the mocks: load it again, through them.
        vi.resetModules();
        const { compareSnapshot } = await import("../trusted/lib/compare.mjs");
        const root = tempDir("vr-work-repo-");
        git(root, "init", "-q");
        writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ projects: { web: { storybook: "sb" } } }));
        const baselines = join(root, "visual-baselines", "web");
        mkdirSync(baselines, { recursive: true });
        for (let i = 0; i < 50; i++) {
            writeFileSync(join(baselines, `a--s${i}.png`), png(10));
        }
        const reference = tempDir("vr-work-ref-");
        writeFileSync(join(reference, "results.json"), "{}");
        const cwd = process.cwd();
        process.chdir(root);
        try {
            for (const k of Object.keys(work)) {
                work[k].length = 0;
            }
            for (let i = 0; i < 20; i++) {
                const line = await compareSnapshot({ project: "web", id: `a--s${i}`, image: png(10), reference });
                expect(line.status).toBe("unchanged");
            }
        } finally {
            process.chdir(cwd);
        }
        expect(work.readdir.filter((p) => p === baselines)).toHaveLength(1);
        expect(work.readFile.filter((p) => p === join(baselines, "renames.json"))).toHaveLength(1);
        expect(work.readFile.filter((p) => p === join(reference, "results.json"))).toHaveLength(1);
        expect(work.git.filter((a) => a.includes("rev-parse"))).toHaveLength(1);
        // Each call still reads its own baseline and settings file: one of each.
        expect(work.readFile.filter((p) => p.startsWith(baselines) && p.endsWith(".png"))).toHaveLength(20);

        // A new baseline changes the directory, so the next call sees it.
        writeFileSync(join(baselines, "a--late.png"), png(10));
        const late = await compareSnapshot({ project: "web", root, id: "a--late", image: png(10), reference });
        expect(late.status).toBe("unchanged");
        expect(work.readdir.filter((p) => p === baselines)).toHaveLength(2);
    });
});
