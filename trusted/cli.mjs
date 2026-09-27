#!/usr/bin/env node
/**
 * visual-review: capture Storybook stories, compare them with the baselines in git, and serve
 * the page where the owner accepts or rejects the differences.
 *
 * Usage: visual-review <capture|compare|serve> [options]
 */

const SUBCOMMANDS = {
    capture: () => notYet("capture"),
    compare: () => notYet("compare"),
    serve: () => notYet("serve"),
};

function notYet(name) {
    console.error(`visual-review ${name}: not implemented yet`);
    return 1;
}

const [name] = process.argv.slice(2);
const run = Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : undefined;
if (run === undefined) {
    console.error(`usage: visual-review <${Object.keys(SUBCOMMANDS).join("|")}> [options]`);
    process.exit(2);
}
process.exitCode = await run();
