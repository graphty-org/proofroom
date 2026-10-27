/*
 * The workflow templates `init` writes: visual-seed.yml's plan step, run against a repository's
 * config as GitHub Actions runs it, and the capture job's steps.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderTemplate } from "../trusted/lib/init.mjs";
import { CONFIG, ROOT, tempDir } from "./helpers.mjs";

const values = { branch: CONFIG.defaultBranch, manager: "pnpm", version: "0.0.0" };
const job = (text, name, next) => {
    const start = text.indexOf(`\n    ${name}:\n`);
    const end = next ? text.indexOf(`\n    ${next}:\n`, start) : -1;
    return text.slice(start, end === -1 ? undefined : end);
};

/**
 * A workflow's plan step's shell script, run against this repository's config as Actions runs it.
 * @param {string} workflow the rendered workflow
 * @param {string} want the projects input
 * @returns {{ status: number | null, stderr: string, projects: string[] | null }} how it ended, and
 *     the projects it listed
 */
const runPlan = (workflow, want) => {
    const r = runStep(workflow, "List the projects", { cwd: ROOT, env: { WANT: want } });
    const text = r.status === 0 ? readFileSync(r.output, "utf8") : "";
    const projects = text ? JSON.parse(text.replace(/^projects=/, "")).map((p) => p.project) : null;
    return { status: r.status, stderr: r.stderr, projects };
};

/**
 * A workflow step's shell script, run as Actions runs it.
 * @param {string} workflow the rendered workflow
 * @param {string} name the step's name
 * @param {{ cwd: string, env: Record<string, string> }} at where, and its environment
 * @returns {{ status: number | null, stdout: string, stderr: string, output: string }} how it ended,
 *     and the file it was given as GITHUB_OUTPUT
 */
const runStep = (workflow, name, { cwd, env }) => {
    const body = workflow.slice(workflow.indexOf(`- name: ${name}`));
    const lines = body.slice(body.indexOf("run: |\n") + 7).split("\n");
    const end = lines.findIndex((l) => l.trim() !== "" && !l.startsWith(" ".repeat(18)));
    const script = lines
        .slice(0, end)
        .map((l) => l.slice(18))
        .join("\n");
    const output = join(tempDir("vr-step-"), "out");
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        cwd,
        env: { ...process.env, ...env, GITHUB_OUTPUT: output },
        encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, output };
};

describe("visual-seed.yml", () => {
    const seed = renderTemplate("visual-seed.yml", values);
    const plan = (want) => runPlan(seed, want);
    const seedable = Object.entries(CONFIG.projects)
        .filter(([, p]) => p.seedFromDefaultBranch)
        .map(([id]) => id);

    it("captures every project seeded from the default branch when none is named", () => {
        expect(plan("").projects).toEqual(seedable);
    });

    it("captures only the projects named, separated by spaces or commas", () => {
        const two = seedable.slice(0, 2);
        expect(plan(two.join(" ")).projects).toEqual(two);
        expect(plan(` ${two.join(",")}, `).projects).toEqual(two);
    });

    it("stops on a name that is not a project seeded from the default branch", () => {
        const r = plan(`${seedable[0]} nope`);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/not a project seeded from the default branch: nope/);
    });

    it("captures each project whose Storybook built, whatever another project's build did", () => {
        const visual = job(seed, "visual");
        expect(visual).toContain("if: ${{ !cancelled() && needs.plan.result == 'success' }}");
        // The download comes first, so a project whose own build failed stops before installing.
        const steps = [...visual.matchAll(/^ {12}- (?:name: (.+)|uses: (.+))$/gm)].map(
            (m) => m[1] ?? m[2]?.replace(/@\S+$/, ""),
        );
        expect(steps.slice(0, 2)).toEqual(["actions/checkout", "Download Storybook build"]);
    });
});

describe("visual-review.yml takes capture requests", () => {
    const review = renderTemplate("visual-review.yml", values);
    const plan = (want) => runPlan(review, want);
    const all = Object.keys(CONFIG.projects);

    it("is dispatched with the commit to capture, the projects, the stories and the request id, none required", () => {
        const on = review.slice(review.indexOf("\non:\n"), review.indexOf("\npermissions:"));
        const inputs = on.slice(on.indexOf("    workflow_dispatch:\n"));
        for (const name of ["ref", "pr", "projects", "stories", "request"]) {
            const input = inputs
                .slice(inputs.indexOf(`            ${name}:\n`))
                .split("\n")
                .slice(1, 5)
                .join("\n");
            expect(input, name).toMatch(/required: false\n\s+type: string\n\s+default: ""/);
        }
        // Still on every pull request and every push to the default branch.
        expect(on).toContain("    pull_request:\n    push:\n");
        // The run's name carries the request id, which is how the review server finds the run it started.
        expect(review).toContain(
            "run-name: ${{ inputs.request && format('Visual review, capture request {0}', inputs.request) || '' }}",
        );
    });

    it("captures every project when none is named, or only the projects named", () => {
        expect(plan("").projects).toEqual(all);
        const two = all.slice(0, 2);
        expect(plan(two.join(",")).projects).toEqual(two);
        expect(plan(` ${two.join(" ")}, `).projects).toEqual(two);
        const r = plan(`${all[0]},nope`);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/not a project: nope/);
    });

    it("checks out the requested commit, or a pull request's merge, compares it with a reference, and passes the story prefixes", () => {
        const visual = job(review, "visual", "visual-gate");
        expect(visual).toContain(
            "            - uses: actions/checkout@v7\n              with:\n                  ref: ${{ inputs.pr && format('refs/pull/{0}/merge', inputs.pr) || inputs.ref }}\n",
        );
        expect(visual).toContain(
            "- name: Check the pull request is at the head asked for\n              if: inputs.pr\n",
        );
        // A requested capture gets the reference a pull request's does; a push gets none.
        expect(visual).toContain("if: github.event_name != 'push'");
        expect(visual).toContain("env:\n                  STORIES: ${{ inputs.stories }}\n");
        expect(visual).toContain('${STORIES:+--stories "$STORIES"}');
        // The inputs reach a shell only through the environment, never pasted into a script.
        const runs = [...review.matchAll(/ run: (.*)$/gm)].map((m) => m[1]).join("\n");
        expect(runs).not.toContain("inputs.");
        const blocks = review
            .split("run: |")
            .slice(1)
            .map((b) => b.split("\n\n")[0])
            .join("\n");
        expect(blocks).not.toContain("inputs.");
    });

    it("captures a requested pull request only at the head asked for: its merge's second parent", () => {
        // A shallow checkout of a merge, as actions/checkout makes of refs/pull/<n>/merge.
        const repo = tempDir("vr-merge-");
        const sh = (cmd) =>
            spawnSync("bash", ["-e", "-c", cmd], { cwd: repo, encoding: "utf8", env: process.env }).stdout.trim();
        sh(
            [
                "git init -q -b main .",
                "git commit -q --allow-empty -m base",
                "git checkout -q -b pr",
                "git commit -q --allow-empty -m head",
                "git checkout -q main",
                "git commit -q --allow-empty -m moved",
                "git merge -q --no-ff -m merge pr",
            ].join(" && "),
        );
        const head = sh("git rev-parse pr");
        const shallow = tempDir("vr-shallow-");
        spawnSync("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow]);
        const check = (want) =>
            runStep(review, "Check the pull request is at the head asked for", {
                cwd: shallow,
                env: { PR: "7", WANT: want },
            });
        expect(check(head).status).toBe(0);
        const moved = check("0".repeat(40));
        expect(moved.status).toBe(1);
        expect(moved.stdout).toContain(`::error::pull request 7 is at ${head}, not ${"0".repeat(40)}`);
    });

    it("leaves the gate to pull requests: a requested capture is reviewed, not gated", () => {
        expect(job(review, "visual-gate")).toContain("if: always() && github.event_name == 'pull_request'");
    });
});
