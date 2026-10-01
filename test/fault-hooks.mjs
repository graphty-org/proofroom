/**
 * Where the fault tests' module mocks send the calls they intercept: `exec` (every git command the
 * server and Finish run) and a few node:fs functions. Both pass straight through until an
 * injector (faults.mjs) installs itself. This file imports nothing, so a vi.mock factory can load
 * it without loading the module it mocks.
 */
export const hooks = {
    exec: (real, cmd, args, options) => real(cmd, args, options),
    fs: (name, real, args) => real(...args),
};

/**
 * What the vi.mock of node:fs returns: node:fs with the reads, writes and renames routed through
 * the hooks (the injector fails only state files).
 * @param {object} real node:fs
 * @returns {object} the module
 */
export const faultyFs = (real) => ({
    ...real,
    default: real,
    readFileSync: (...args) => hooks.fs("readFileSync", real.readFileSync, args),
    writeFileSync: (...args) => hooks.fs("writeFileSync", real.writeFileSync, args),
    renameSync: (...args) => hooks.fs("renameSync", real.renameSync, args),
});

/**
 * What the vi.mock of github.mjs returns: github.mjs with `exec` routed through the hooks.
 * @param {object} real github.mjs
 * @returns {object} the module
 */
export const faultyGithub = (real) => ({
    ...real,
    exec: (cmd, args, options) => hooks.exec(real.exec, cmd, args, options),
});
