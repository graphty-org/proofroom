import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { CONFIG_FILE, loadConfig, loadConfigAt, normalizeConfig } from "../trusted/lib/config.mjs";
import { CONFIG, git, isolateGit, tempDir } from "./helpers.mjs";

beforeAll(isolateGit);

const CI = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

// The `visual` job's matrix: "- project: <name>" followed by "artifact: <name>" and, for a Storybook that is not
// at <name>/storybook-static, "storybook: <directory>".
function visualMatrix() {
    const job = CI.slice(CI.indexOf("\n    visual:\n"));
    const include = job.slice(job.indexOf("include:"), job.indexOf("steps:"));
    return Object.fromEntries(
        [...include.matchAll(/- project: (\S+)\s+artifact: (\S+)(?:\s+storybook: (\S+))?/g)].map((m) => [
            m[1],
            { artifact: m[2], storybook: m[3] ?? `${m[1]}/storybook-static` },
        ]),
    );
}

// The `build` job alone, so a matching download step in a later job cannot stand in for its upload.
function buildJob() {
    const start = CI.indexOf("\n    build:\n");
    return CI.slice(start, CI.indexOf("\n    test:\n", start));
}

describe("the monorepo's visual-review.config.json", () => {
    it("lists exactly the projects the CI visual job captures", () => {
        expect(Object.keys(visualMatrix()).sort()).toEqual(Object.keys(CONFIG.projects).sort());
    });

    it("points each project at the Storybook the build job uploads, where the visual job puts it", () => {
        // The download step puts the artifact at the row's storybook, else at <name>/storybook-static.
        expect(CI.slice(CI.indexOf("\n    visual:\n"))).toContain(
            "path: ${{ matrix.storybook || format('{0}/storybook-static', matrix.project) }}/",
        );
        for (const [name, { artifact, storybook }] of Object.entries(visualMatrix())) {
            const dir = CONFIG.projects[name].storybook;
            expect(dir).toBe(storybook);
            expect(buildJob()).toMatch(
                new RegExp(`uses: actions/upload-artifact@v7\\s+with:\\s+name: ${artifact}\\s+path: ${dir}/`),
            );
        }
    });

    // layout's stories import @graphty/layout, which resolves to layout/dist.
    it("builds layout before its Storybook, which imports the built package", () => {
        const layout = JSON.parse(readFileSync(new URL("../../layout/project.json", import.meta.url), "utf8"));
        expect(layout.targets["build-storybook"]?.dependsOn).toContain("build");
    });
});

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
            usage: false,
            ignoreBranches: [],
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

    it("keeps a waitFor and its console marker", () => {
        const c = normalizeConfig({
            projects: { g: { storybook: "s", waitFor: { selector: "my-el", method: "ready" } } },
        });
        expect(c.projects.g.waitFor).toEqual({ selector: "my-el", method: "ready", failOnConsole: null });
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
        expect(() => loadConfig(dir)).toThrow(/visual-review init/);
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
        expect(err.stderr.toString()).toMatch(/^visual-review reference: visual-review\.config\.json: baselines must/);
    });
});
