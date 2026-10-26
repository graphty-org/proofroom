/**
 * The repository's name the new page's top bar shows: origin's name, else the main checkout's
 * folder, also for a server run from a worktree.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryName } from "../trusted/lib/serve.mjs";
import { git, makeRepo } from "./helpers.mjs";

describe("repositoryName", () => {
    it("names the repository from origin's URL, in a worktree too", async () => {
        const r = makeRepo();
        const wt = join(r.dir, "some-worktree");
        git(r.repo, "worktree", "add", "-q", "--detach", wt);
        expect(await repositoryName(r.repo)).toBe("remote");
        expect(await repositoryName(wt)).toBe("remote");
        git(r.repo, "remote", "set-url", "origin", "git@github.com:graphty-org/graphty-monorepo.git");
        expect(await repositoryName(wt)).toBe("graphty-monorepo");
    });

    it("names it after the main checkout's folder when there is no origin", async () => {
        const r = makeRepo();
        const wt = join(r.dir, "some-worktree");
        git(r.repo, "worktree", "add", "-q", "--detach", wt);
        git(r.repo, "remote", "remove", "origin");
        expect(await repositoryName(wt)).toBe("repo");
    });
});
