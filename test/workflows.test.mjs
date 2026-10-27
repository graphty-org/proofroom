/*
 * The monorepo runs the package's own workflow templates: visual-seed.yml is exactly what
 * `visual-review init` writes, and ci.yml's story tests and gate step use the template's artifact and commands.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderTemplate } from "../trusted/lib/init.mjs";
import { CONFIG, tempDir } from "./helpers.mjs";

const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
// A Dependabot bump of an action's version is not drift: compare workflows with every
// `uses: owner/action@ref` reduced to `uses: owner/action`.
const unpinned = (text) => text.replace(/^(\s*(?:- )?uses: [^@\s]+)@\S+/gm, "$1");
const values = { branch: CONFIG.defaultBranch, manager: "pnpm", version: "0.0.0" };
const job = (text, name, next) => {
    const start = text.indexOf(`\n    ${name}:\n`);
    const end = next ? text.indexOf(`\n    ${next}:\n`, start) : -1;
    return text.slice(start, end === -1 ? undefined : end);
};

describe("the monorepo's workflows", () => {
    it("visual-seed.yml is the template as init writes it", () => {
        expect(unpinned(workflow("visual-seed.yml"))).toBe(unpinned(renderTemplate("visual-seed.yml", values)));
    });

    it("ignores an action version bump but not any other difference", () => {
        const a = "steps:\n  - uses: actions/setup-node@v4\n    with:\n      x: 1\n";
        expect(unpinned(a)).toBe(unpinned(a.replace("@v4", "@v7")));
        expect(unpinned(a)).not.toBe(unpinned(a.replace("x: 1", "x: 2")));
        expect(unpinned(a)).not.toBe(unpinned(a.replace("actions/setup-node", "actions/cache")));
    });

    it("ci.yml's story tests upload their capture under the template's artifact name", () => {
        // The review page and the gate find a project's capture by this name, whichever job wrote it.
        const name = /name: visual-\$.*$/m.exec(renderTemplate("visual-review.yml", values))[0];
        expect(job(workflow("ci.yml"), "story-tests", "story-tests-merge")).toContain(name);
        expect(job(workflow("ci.yml"), "story-tests-merge", "all-checks")).toContain(name);
    });

    it("ci.yml's gate step runs the base branch's gate with the template's arguments", () => {
        const args = /gate (--captures .*)$/m.exec(renderTemplate("visual-review.yml", values))[1];
        const ci = workflow("ci.yml");
        expect(ci).toContain('git archive HEAD^1 visual-review/trusted | tar -x -C "$gate"');
        const pr = '--pr "${{ github.event.pull_request.number }}"';
        expect(args).toContain(pr);
        expect(ci).toContain(`node "$gate/visual-review/trusted/cli.mjs" gate ${args.replace(pr, '"${pr[@]}"')}`);
        // The step passes --pr when the base's gate says it takes it, which this one does.
        const grep = /grep -q -- "(.+?)" "\$gate\/visual-review\/trusted\/gate.mjs"/.exec(ci)[1];
        expect(readFileSync(new URL("../trusted/gate.mjs", import.meta.url), "utf8")).toContain(grep);
    });
});

describe("visual-seed.yml", () => {
    const seed = renderTemplate("visual-seed.yml", values);
    const ROOT = new URL("../..", import.meta.url).pathname;

    // The plan step's shell script, run against this repository's config as Actions runs it.
    const plan = (want) => {
        const body = seed.slice(seed.indexOf("- name: List the projects"));
        const lines = body.slice(body.indexOf("run: |\n") + 7).split("\n");
        const end = lines.findIndex((l) => l.trim() !== "" && !l.startsWith(" ".repeat(18)));
        const script = lines
            .slice(0, end)
            .map((l) => l.slice(18))
            .join("\n");
        const output = join(tempDir("vr-seed-"), "out");
        const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
            cwd: ROOT,
            env: { ...process.env, WANT: want, GITHUB_OUTPUT: output },
            encoding: "utf8",
        });
        const text = r.status === 0 ? readFileSync(output, "utf8") : "";
        const projects = text ? JSON.parse(text.replace(/^projects=/, "")).map((p) => p.project) : null;
        return { status: r.status, stderr: r.stderr, projects };
    };
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
