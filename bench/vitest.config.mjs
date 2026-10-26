import { defineConfig } from "vitest/config";

// The benchmarks that need the test suite's fixture repository (makeRepo): its setup, their files.
export default defineConfig({
    test: {
        environment: "node",
        include: ["bench/*.bench.mjs"],
        testTimeout: 600_000,
        setupFiles: ["test/isolate-git.setup.mjs", "test/no-network.setup.mjs"],
        globalSetup: ["test/repo-template.setup.mjs"],
    },
});
