import { BaseSequencer } from "vitest/node";
import { defineConfig } from "vitest/config";

/** Runs the files in name order, so the later file runs after the snapshots. */
class ByName extends BaseSequencer {
    async sort(files) {
        return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
    }
}

export default defineConfig({
    test: { include: ["*.spec.mjs"], fileParallelism: false, sequence: { sequencer: ByName } },
});
