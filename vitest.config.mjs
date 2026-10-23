import { defineConfig } from "vitest/config";
import { ciReporters } from "../vitest.ci-junit.mjs";
import { workerShare } from "../tools/test-slots.mjs";
import { withTestGuards } from "../tools/test-wait-guard.mjs";

const config = defineConfig({
    test: {
        reporters: ["default", ...ciReporters()],
        environment: "node",
        include: ["test/**/*.test.mjs"],
        // No test runs git with the developer's own config (signing, hooks) or a hook's GIT_DIR,
        // none reaches the network, and the temporary directories a test file made (tempDir,
        // helpers.mjs) go when it finishes.
        setupFiles: ["test/isolate-git.setup.mjs", "test/no-network.setup.mjs"],
        // The repository every test's makeRepo copies.
        globalSetup: ["test/repo-template.setup.mjs", "../tools/test-slots.mjs"],
        // At most this run's share of the cores (tools/test-slots.mjs).
        maxWorkers: workerShare(),
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
