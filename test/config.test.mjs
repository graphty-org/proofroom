import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { CONFIG_FILE, loadConfig, loadConfigAt, normalizeConfig } from "../trusted/lib/config.mjs";
import { git, isolateGit, tempDir } from "./helpers.mjs";

beforeAll(isolateGit);

describe("normalizeConfig", () => {
    it("fills in the defaults", () => {
        expect(normalizeConfig({ projects: { web: { storybook: "storybook-static/" } } })).toEqual({
            defaultBranch: "main",
            workflow: "visual-review.yml",
            baselines: "visual-baselines",
            approvals: "visual-review-approvals",
            workDir: ".visual-review",
            commitPrefix: "test",
            issueLabels: ["bug"],
            fontconfig: null,
            updateCheck: null,
            candidates: null,
            captureCommand: null,
            rolling: null,
            usage: false,
            ignoreBranches: [],
            diskBudget: 10,
            projects: {
                web: {
                    storybook: "storybook-static",
                    build: null,
                    workers: 4,
                    seedFromDefaultBranch: true,
                    waitFor: null,
                },
            },
        });
    });

    it("takes a disk budget in GB and refuses one that is not above 0", () => {
        const web = { web: { storybook: "s" } };
        expect(normalizeConfig({ diskBudget: 2.5, projects: web }).diskBudget).toBe(2.5);
        for (const bad of [0, -1, "10", Infinity]) {
            expect(() => normalizeConfig({ diskBudget: bad, projects: web })).toThrow(/diskBudget must be/);
        }
    });

    it("keeps a waitFor and its console marker", () => {
        const c = normalizeConfig({
            projects: { g: { storybook: "s", waitFor: { selector: "my-el", method: "ready" } } },
        });
        expect(c.projects.g.waitFor).toEqual({ selector: "my-el", method: "ready", failOnConsole: null });
    });

    it("keeps the rolling command the master rolling target is listed with", () => {
        const c = normalizeConfig({ rolling: "node list.mjs", projects: { a: { storybook: "s" } } });
        expect(c.rolling).toBe("node list.mjs");
    });

    it("keeps the fontconfig file capture draws with", () => {
        const c = normalizeConfig({ fontconfig: "fonts/fonts.conf", projects: { a: { storybook: "s" } } });
        expect(c.fontconfig).toBe("fonts/fonts.conf");
    });

    it.each([
        [[], /JSON object/],
        [{ fontconfig: "../fonts.conf", projects: { a: { storybook: "s" } } }, /fontconfig must be/],
        [{ fontconfig: 1, projects: { a: { storybook: "s" } } }, /fontconfig must be/],
        [{ updateCheck: " ", projects: { a: { storybook: "s" } } }, /updateCheck must be/],
        [{ candidates: " ", projects: { a: { storybook: "s" } } }, /candidates must be a shell command/],
        [{ captureCommand: " ", projects: { a: { storybook: "s" } } }, /captureCommand must be a shell command/],
        [{ rolling: 1, projects: { a: { storybook: "s" } } }, /rolling must be a shell command/],
        [{}, /projects must name/],
        [{ projects: {} }, /projects must name/],
        [{ projects: { "a b": { storybook: "s" } } }, /project id/],
        [{ projects: { a: {} } }, /storybook must be/],
        [{ projects: { a: { storybook: "../elsewhere" } } }, /storybook must be/],
        [{ projects: { a: { storybook: "/abs" } } }, /storybook must be/],
        [{ baselines: "../up", projects: { a: { storybook: "s" } } }, /baselines must be a path/],
        [
            { approvals: "visual-baselines/approvals", projects: { a: { storybook: "s" } } },
            /approvals must be a directory outside/,
        ],
        [{ projects: { a: { storybook: "s", workers: 0 } } }, /workers/],
        [{ projects: { a: { storybook: "s", gate: false } } }, /gate is not a setting/],
        [{ projects: { a: { storybook: "s", waitFor: { selector: "x" } } } }, /waitFor needs/],
        [{ defaultBranch: "", projects: { a: { storybook: "s" } } }, /defaultBranch must be/],
        [{ issueLabels: "bug", projects: { a: { storybook: "s" } } }, /issueLabels/],
        [{ ignoreBranches: "dependabot/", projects: { a: { storybook: "s" } } }, /ignoreBranches/],
        [{ ignoreBranches: [""], projects: { a: { storybook: "s" } } }, /ignoreBranches/],
    ])("refuses %j", (raw, message) => {
        expect(() => normalizeConfig(raw)).toThrow(message);
    });
});

describe("loadConfig and loadConfigAt", () => {
    const repo = () => {
        const dir = tempDir("vr-config-");
        git(dir, "init", "-q", "-b", "main");
        git(dir, "config", "user.name", "T");
        git(dir, "config", "user.email", "t@example.com");
        return dir;
    };
    const write = (dir, baselines) =>
        writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ baselines, projects: { a: { storybook: "s" } } }));

    it("names init when the repository has no config, and the file when it is not JSON", () => {
        const dir = repo();
        expect(() => loadConfig(dir)).toThrow(/proofroom init/);
        writeFileSync(join(dir, CONFIG_FILE), "{");
        expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
    });

    it("reads the config at a ref, and the working tree's when the ref has none", () => {
        const dir = repo();
        writeFileSync(join(dir, "README.md"), "x\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "no config");
        write(dir, "shots");
        expect(loadConfigAt("HEAD", dir).baselines).toBe("shots");

        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "config");
        // A pull request that moves the baselines does not move them for the gate, which reads the base.
        write(dir, "elsewhere");
        expect(loadConfigAt("HEAD", dir).baselines).toBe("shots");
        expect(loadConfig(dir).baselines).toBe("elsewhere");
    });

    it("is what the CLI reads: a bad config is one line, not a stack", () => {
        const dir = repo();
        write(dir, "../x");
        const cli = new URL("../trusted/cli.mjs", import.meta.url).pathname;
        let err;
        try {
            execFileSync(process.execPath, [cli, "reference", "--project", "a", "--out", "o"], {
                cwd: dir,
                stdio: "pipe",
            });
        } catch (e) {
            err = e;
        }
        expect(err.status).toBe(2);
        expect(err.stderr.toString()).toMatch(/^proofroom reference: visual-review\.config\.json: baselines must/);
    });
});
