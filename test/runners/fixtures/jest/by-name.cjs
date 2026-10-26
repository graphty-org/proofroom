// Runs the files in name order, so the later file runs after the snapshots.
const Sequencer = require("@jest/test-sequencer").default;

module.exports = class ByName extends Sequencer {
    /**
     * The test files in name order.
     * @param {{ path: string }[]} tests the files
     * @returns {{ path: string }[]} sorted by path
     */
    sort(tests) {
        return [...tests].sort((a, b) => a.path.localeCompare(b.path));
    }
};
