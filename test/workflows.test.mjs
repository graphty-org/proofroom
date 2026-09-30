/*
 * The monorepo runs the package's own workflow templates: visual-seed.yml is exactly what
 * `visual-review init` writes, and ci.yml's visual job and gate step run the template's commands.
 */

import { readFileSync } from "node:fs";
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
            expect(ci).toContain(line);
        }
        expect(ci).toContain("name: visual (${{ matrix.project }})");
    });

    it("ci.yml's gate step runs the gate with the template's arguments", () => {
        const args = /gate (--captures .*)$/m.exec(renderTemplate("visual-review.yml", values))[1];
        expect(workflow("ci.yml")).toContain(`node visual-review/trusted/cli.mjs gate ${args}`);
    });
});
