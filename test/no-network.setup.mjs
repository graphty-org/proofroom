/*
 * No test reaches the network. GitHub is a fake gh and local git remotes, and the pages are served
 * from this machine. A test that asks anything else fails: fetch from this process to another host
 * is refused, and gh, git and Chromium started by a test go through a proxy that answers nothing
 * and only notes what was asked (a real github.com call once cost a shard minutes of waiting).
 */

import { createServer } from "node:http";

import { afterEach } from "vitest";

const reached = [];

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOCAL.has(url.hostname)) {
        reached.push(url.href);
        return Promise.reject(new Error(`a test reached the network: ${url.href}`));
    }
    return realFetch(input, init);
};

const proxy = createServer((req, res) => {
    reached.push(req.url);
    res.destroy();
});
proxy.on("connect", (req, socket) => {
    reached.push(req.url);
    socket.destroy();
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
proxy.unref();
const via = `http://127.0.0.1:${proxy.address().port}`;
const local = "127.0.0.1,localhost,::1";
Object.assign(process.env, {
    HTTPS_PROXY: via,
    https_proxy: via,
    HTTP_PROXY: via,
    http_proxy: via,
    ALL_PROXY: via,
    all_proxy: via,
    NO_PROXY: local,
    no_proxy: local,
});

afterEach(() => {
    if (reached.length > 0) {
        throw new Error(`a test reached the network: ${reached.splice(0).join(", ")}`);
    }
});
