import { defineConfig } from "@playwright/test";

// One worker: the files run one after the other, in name order.
export default defineConfig({ testDir: ".", testMatch: "*.spec.mjs", workers: 1, reporter: "json" });
