import { afterAll } from "vitest";

import { isolateGit } from "../../tools/isolated-git-env.mjs";
import { removeTempDirs } from "./helpers.mjs";

isolateGit();

// Registered before the test file's own hooks, so it runs after them: a server a file stops in
// its afterAll is gone before its directory is.
afterAll(removeTempDirs);
