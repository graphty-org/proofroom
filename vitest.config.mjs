import { defineConfig } from "vitest/config";
import { baseTest } from "../vitest.base.mjs";
import { withTestGuards } from "../tools/test-wait-guard.mjs";

const config = defineConfig({
    test: {
        // test/repo-template.setup.mjs makes the repository every test's makeRepo copies.
        ...baseTest({ globalSetup: ["test/repo-template.setup.mjs"] }),
        environment: "node",
        include: ["test/**/*.test.mjs"],
        // No test runs git with the developer's own config (signing, hooks) or a hook's GIT_DIR,
        // none reaches the network, and the temporary directories a test file made (tempDir,
        // helpers.mjs) go when it finishes.
        setupFiles: ["test/isolate-git.setup.mjs", "test/no-network.setup.mjs"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json-summary", "json", "lcov", "html"],
            reportsDirectory: "coverage",
            // The library, the gate and capture. cli.mjs is argument parsing around them, run in CI
            // and by hand; the gate's own entry point is run as a subprocess, which v8 does not count.
            include: ["trusted/lib/*.mjs", "trusted/gate.mjs", "capture/*.mjs"],
            thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
        },
    },
});

// One hang guard for every test, hook and wait (tools/test-wait-guard.mjs).
export default withTestGuards(config);
