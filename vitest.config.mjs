import { defineConfig } from "vitest/config";
import { ciJunitReporter } from "../vitest.ci-junit.mjs";

export default defineConfig({
    test: {
        reporters: ["default", ...ciJunitReporter()],
        environment: "node",
        include: ["test/**/*.test.mjs"],
        // The suite's own limit, as the other packages' browser suites have: a hang detector, not a
        // measure of speed. No test sets its own. Tests here start git, gh and Chromium work and
        // wait on its events, so their time follows the machine's load.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // No test runs git with the developer's own config (signing, hooks) or a hook's GIT_DIR.
        setupFiles: ["test/isolate-git.setup.mjs"],
        // The repository every test's makeRepo copies.
        globalSetup: ["test/repo-template.setup.mjs", "../tools/test-slots.mjs"],
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
