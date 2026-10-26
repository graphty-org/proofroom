// graphty-monorepo's commitlint configuration, the rules the commit messages Finish writes there must pass.
export default {
    extends: ["@commitlint/config-conventional"],
    // The merge commits tools/land.mjs makes on the golden branch ("land: <branch>") and its reapply of a
    // reverted landing; the commits they bring in are checked on their own.
    ignores: [(message) => /^(land: \S+|Reapply "land: \S+")\s*$/m.test(message.split("\n")[0])],
    rules: {
        "scope-enum": [
            2,
            "always",
            [
                "graph-format",
                "graph-io",
                "graph-samples",
                "webgpu-graph-algorithms",
                "algorithms",
                "layout",
                "cytoscape-extensions",
                "graphty-element",
                "compact-mantine",
                "remote-logger",
                "graphty",
                "visual-review",
                "githerd",
                "gpu-3d-force-layout",
                "deps",
                "release",
                "ci",
                "docs",
                "tools",
                "workspace",
            ],
        ],
    },
};
