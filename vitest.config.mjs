import { defineConfig } from "vitest/config";
import { ciJunitReporter } from "../vitest.ci-junit.mjs";

export default defineConfig({
    test: {
        reporters: ["default", ...ciJunitReporter()],
        environment: "node",
        include: ["test/**/*.test.mjs"],
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
