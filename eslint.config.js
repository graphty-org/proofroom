// ESLint for proofroom: error prevention and JSDoc on the public functions; formatting is
// Prettier's (.prettierrc). The package is plain JavaScript with no build, so a JSDoc type is the
// only type annotation it has: it is allowed, and read as a TypeScript type.

import eslint from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import globals from "globals";

import noTestTiming from "./eslint-rules/no-test-timing.mjs";

export default [
    { ignores: ["node_modules/**", "coverage/**", "tmp/**", "tmp-review/**", "trusted/vendor/**"] },
    eslint.configs.recommended,
    jsdoc.configs["flat/recommended-typescript-error"],
    {
        settings: { jsdoc: { mode: "typescript" } },
        rules: {
            "jsdoc/no-types": "off",
            "jsdoc/require-description": "error",
            "jsdoc/require-param-description": "error",
            "jsdoc/require-returns-description": "error",
            "jsdoc/check-tag-names": [
                "error",
                { definedTags: ["since", "internal", "remarks", "category", "defaultValue"] },
            ],
            "jsdoc/require-jsdoc": [
                "error",
                {
                    publicOnly: true,
                    require: { FunctionDeclaration: true, MethodDefinition: true, ClassDeclaration: true },
                },
            ],
        },
    },
    // Only trusted/page/ runs in a browser; everything else runs in Node.
    {
        files: ["**/*.{js,mjs}"],
        ignores: ["trusted/page/**"],
        languageOptions: { globals: { ...globals.node } },
    },
    {
        files: ["trusted/page/**/*.js"],
        languageOptions: { globals: { ...globals.browser } },
    },
    // The acceptance test runs in Node and hands functions to the page it drives.
    {
        files: ["scripts/uat.mjs"],
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
    },
    // Tests wait on conditions and assert on counted work, never on the clock
    // (eslint-rules/no-test-timing.mjs has the rule and its reasons).
    // test/fixtures/ holds copies of earlier versions' own code, which waits as the product does.
    {
        files: ["test/**/*.mjs"],
        ignores: ["test/fixtures/**"],
        plugins: { local: { rules: { "no-test-timing": noTestTiming } } },
        rules: { "local/no-test-timing": "error" },
    },
];
