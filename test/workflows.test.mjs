/*
 * The monorepo runs the package's own workflow templates: visual-seed.yml is exactly what
 * `visual-review init` writes, and ci.yml's visual job and gate step run the template's commands.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderTemplate } from "../trusted/lib/init.mjs";
import { CONFIG } from "./helpers.mjs";

const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
const values = { branch: CONFIG.defaultBranch, manager: "pnpm", version: "0.0.0" };
const job = (text, name, next) => {
    const start = text.indexOf(`\n    ${name}:\n`);
    const end = next ? text.indexOf(`\n    ${next}:\n`, start) : -1;
    return text.slice(start, end === -1 ? undefined : end);
};

describe("the monorepo's workflows", () => {
    it("visual-seed.yml is the template as init writes it", () => {
        expect(workflow("visual-seed.yml")).toBe(renderTemplate("visual-seed.yml", values));
    });

    it("ci.yml's visual job runs the template's commands and uploads the same artifact", () => {
        const template = job(renderTemplate("visual-review.yml", values), "visual", "visual-gate");
        const ci = job(workflow("ci.yml"), "visual", "all-checks");
        const lines = template
            .split("\n")
            .filter((l) => /visual-review (install-browser|reference|capture)|name: visual-\$/.test(l))
            .map((l) => l.trim());
        expect(lines).toHaveLength(4);
        for (const line of lines) {
            // install-browser's apt step comes from the monorepo's cached playwright-system-deps action.
            if (line.includes("install-browser")) continue;
            expect(ci).toContain(line);
        }
        expect(ci).toContain("uses: ./.github/actions/playwright-system-deps");
        expect(ci).toContain("run: pnpm exec playwright install chromium\n");
        expect(ci).toContain("name: visual (${{ matrix.project }})");
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

    it("ci.yml's visual job runs the base branch's capture code before any of the tool's commands", () => {
        const ci = job(workflow("ci.yml"), "visual", "all-checks");
        const swap = ci.indexOf("git archive HEAD^1 visual-review/capture visual-review/trusted | tar -x");
        expect(swap).toBeGreaterThan(0);
        expect(ci.indexOf("playwright-system-deps")).toBeGreaterThan(swap);
        expect(ci).toContain("fetch-depth: 2");
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
        const output = join(mkdtempSync(join(tmpdir(), "vr-seed-")), "out");
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
        const steps = [...visual.matchAll(/^ {12}- (?:name: (.+)|uses: (.+))$/gm)].map((m) => m[1] ?? m[2]);
        expect(steps.slice(0, 2)).toEqual(["actions/checkout@v4", "Download Storybook build"]);
    });
});
