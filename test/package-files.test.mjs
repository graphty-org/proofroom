/*
 * What `npm publish` would ship: exactly the tool's code, its templates, README.md, LICENSE and
 * package.json, every file of the code directories that git tracks, and nothing else (no tests, no
 * fixtures, no scripts, no repository config).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISHED_DIRS = ["capture", "templates", "trusted"];

describe("the published files", () => {
    it("are the code directories, README.md, LICENSE and package.json", () => {
        const [pack] = JSON.parse(
            execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" }),
        );
        const packed = pack.files.map((f) => f.path).sort();
        const tracked = execFileSync("git", ["ls-files", "--", ...PUBLISHED_DIRS], { cwd: ROOT, encoding: "utf8" })
            .split("\n")
            .filter(Boolean);
        expect(packed).toEqual([...tracked, "LICENSE", "README.md", "package.json"].sort());
    });
});
