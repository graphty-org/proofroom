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

describe("visual-seed.yml", () => {
    const seed = renderTemplate("visual-seed.yml", values);

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
