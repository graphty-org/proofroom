import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../trusted/lib/config.mjs";
import { GENERATED, init, packageManager, renderTemplate } from "../trusted/lib/init.mjs";
import { git, isolateGit } from "./helpers.mjs";

beforeAll(isolateGit);

const CLI = new URL("../trusted/cli.mjs", import.meta.url).pathname;

function repo(lockfile = null) {
    const dir = mkdtempSync(join(tmpdir(), "vr-init-"));
    git(dir, "init", "-q", "-b", "trunk");
    if (lockfile) {
        writeFileSync(join(dir, lockfile), "");
    }
    return dir;
}
const read = (dir, path) => readFileSync(join(dir, path), "utf8");

describe("init", () => {
    it("writes a loadable config, the LFS rule, the ignore entry and both workflows", () => {
        const dir = repo();
        const out = execFileSync(process.execPath, [CLI, "init"], { cwd: dir, encoding: "utf8" });
        expect(out).toMatch(/wrote {4}visual-review\.config\.json/);

        const config = loadConfig(dir);
        expect(config.defaultBranch).toBe("trunk");
        expect(config.projects.storybook).toMatchObject({
            storybook: "storybook-static",
            build: "npm run build-storybook",
        });
        expect(read(dir, ".gitattributes")).toContain(
            "visual-baselines/**/*.png filter=lfs diff=lfs merge=lfs -text\n",
        );
        expect(read(dir, ".gitignore")).toBe("/.visual-review/\n");

        const review = read(dir, ".github/workflows/visual-review.yml");
        expect(review.startsWith(GENERATED)).toBe(true);
        expect(review).toContain("branches: [trunk]");
        expect(review).toContain("run: npx visual-review capture --project ${{ matrix.project }}");
        const version = JSON.parse(read(new URL("..", import.meta.url).pathname, "package.json")).version;
        expect(review).toContain(`npx --yes @graphty/visual-review@${version} gate`);
        expect(read(dir, ".github/workflows/visual-seed.yml")).toContain("--ref trunk -f ref=<sha>");
        for (const file of ["visual-review.yml", "visual-seed.yml"]) {
            expect(read(dir, `.github/workflows/${file}`)).not.toMatch(/__[A-Z]+__/);
        }
    });

    it("changes nothing the second time, and --force rewrites only its own workflows", () => {
        const dir = repo();
        init(dir);
        writeFileSync(
            join(dir, "visual-review.config.json"),
            JSON.stringify({ projects: { mine: { storybook: "sb" } } }),
        );
        writeFileSync(join(dir, ".github/workflows/visual-seed.yml"), "# mine\n");
        const before = ["visual-review.config.json", ".gitattributes", ".gitignore"].map((f) => read(dir, f));

        expect(init(dir).filter((l) => l.startsWith("wrote"))).toEqual([]);
        writeFileSync(join(dir, ".github/workflows/visual-review.yml"), `${GENERATED}\nSTALE-TEMPLATE\n`);
        const forced = init(dir, { force: true });
        expect(forced).toContain("wrote    .github/workflows/visual-review.yml");
        expect(forced).toContain("kept     .github/workflows/visual-seed.yml (not written by init, so never replaced)");
        expect(read(dir, ".github/workflows/visual-seed.yml")).toBe("# mine\n");
        expect(read(dir, ".github/workflows/visual-review.yml")).not.toContain("STALE-TEMPLATE");
        expect(["visual-review.config.json", ".gitattributes", ".gitignore"].map((f) => read(dir, f))).toEqual(before);
    });

    it("adds to an existing .gitattributes and .gitignore, and skips a work directory already ignored", () => {
        const dir = repo();
        writeFileSync(join(dir, ".gitattributes"), "* text=auto");
        writeFileSync(join(dir, ".gitignore"), "/.visual-review/*\n");
        init(dir);
        expect(read(dir, ".gitattributes")).toMatch(/^\* text=auto\n# Visual review baselines/);
        expect(read(dir, ".gitignore")).toBe("/.visual-review/*\n");
    });

    it("writes the workflow the config names, for the package manager the lockfile shows", () => {
        const dir = repo("pnpm-lock.yaml");
        writeFileSync(
            join(dir, "visual-review.config.json"),
            JSON.stringify({ workflow: "shots.yml", projects: { a: { storybook: "s" } } }),
        );
        init(dir);
        expect(existsSync(join(dir, ".github/workflows/visual-review.yml"))).toBe(false);
        const wf = read(dir, ".github/workflows/shots.yml");
        expect(wf).toContain("            - uses: pnpm/action-setup@v4\n");
        expect(wf).toContain("              run: pnpm install --frozen-lockfile\n");
        expect(wf).toContain("run: pnpm exec visual-review install-browser");
    });

    it("tells the package manager from the lockfile", () => {
        expect(packageManager(repo())).toBe("npm");
        expect(packageManager(repo("pnpm-lock.yaml"))).toBe("pnpm");
        expect(packageManager(repo("yarn.lock"))).toBe("yarn");
        expect(renderTemplate("visual-seed.yml", { branch: "b", manager: "yarn", version: "1" })).toContain(
            "run: yarn visual-review capture",
        );
    });
});

describe("the CLI", () => {
    it("has help for every command, and exits 2 on an unknown one", () => {
        const help = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
        for (const command of ["init", "capture", "reference", "gate", "serve", "compare", "install-browser"]) {
            expect(help).toContain(`  ${command} `);
            expect(execFileSync(process.execPath, [CLI, command, "--help"], { encoding: "utf8" })).toMatch(
                new RegExp(`^usage: (PORT=<n> )?visual-review ${command}`),
            );
        }
        let status = 0;
        try {
            execFileSync(process.execPath, [CLI, "nope"], { stdio: "pipe" });
        } catch (e) {
            status = e.status;
        }
        expect(status).toBe(2);
    });
});
