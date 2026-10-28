import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { referenceSubset } from "../trusted/lib/github.mjs";
import { zipEntries, zipEntry } from "../trusted/lib/zip-range.mjs";
import { copyFixture, fakeGh, tempDir } from "./helpers.mjs";

// A plain zip of every file under dir, stored or deflated by turns, the way upload-artifact writes one.
function zipOf(dir) {
    const walk = (d) =>
        readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const locals = [];
    const central = [];
    let offset = 0;
    walk(dir).forEach((path, i) => {
        const name = Buffer.from(relative(dir, path));
        const data = readFileSync(path);
        const method = i % 2 ? 8 : 0;
        const body = method ? deflateRawSync(data) : data;
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(method, 8);
        head.writeUInt32LE(crc32(data), 14);
        head.writeUInt32LE(body.length, 18);
        head.writeUInt32LE(data.length, 22);
        head.writeUInt16LE(name.length, 26);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(crc32(data), 16);
        cd.writeUInt32LE(body.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(offset, 42);
        locals.push(head, name, body);
        central.push(cd, name);
        offset += 30 + name.length + body.length;
    });
    const cdBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length / 2, 8);
    end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(cdBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBytes, end]);
}

const readerOf = (zip, reads = []) => ({
    size: zip.length,
    read: async (start, end) => {
        reads.push([start, end]);
        return zip.subarray(start, end);
    },
});

describe("zip range reads", () => {
    it("reads one entry without reading the rest", async () => {
        const { dir } = copyFixture("compact-mantine", join(tempDir("zip-"), "c"));
        const zip = zipOf(dir);
        const reads = [];
        const z = readerOf(zip, reads);
        const entries = await zipEntries(z.read, z.size);
        const json = await zipEntry(z.read, entries.get("results.json"));
        expect(JSON.parse(json.toString("utf8")).project).toBe("compact-mantine");
        const png = await zipEntry(z.read, entries.get("button--primary.dark.png"));
        expect(png.equals(readFileSync(join(dir, "button--primary.dark.png")))).toBe(true);
        expect(reads.reduce((n, [s, e]) => n + e - s, 0)).toBeLessThan(zip.length + 65557);
    });

    it("answers null for a file that is not a zip", async () => {
        const z = readerOf(Buffer.alloc(100));
        expect(await zipEntries(z.read, z.size)).toBeNull();
    });
});

describe("referenceSubset", () => {
    it("downloads results.json and only the images of new and unseeded items", async () => {
        const { dir } = copyFixture("compact-mantine", join(tempDir("zip-"), "c"));
        const zip = zipOf(dir);
        const gh = fakeGh({ artifacts: { 7: ["visual-compact-mantine-1"] } });
        const out = await referenceSubset(gh, { id: 7 }, "compact-mantine", tempDir("ref-"), async () => readerOf(zip));
        expect(readdirSync(out).sort()).toEqual(["badge--default.light.png", "results.json"]);
        expect(
            readFileSync(join(out, "badge--default.light.png")).equals(
                readFileSync(join(dir, "badge--default.light.png")),
            ),
        ).toBe(true);
    });

    it("answers null when the run has no capture of the project or the reader cannot open it", async () => {
        const gh = fakeGh({ artifacts: { 7: ["visual-compact-mantine-1"] } });
        expect(await referenceSubset(gh, { id: 7 }, "graphty-element", tempDir("ref-"), async () => null)).toBeNull();
        expect(await referenceSubset(gh, { id: 7 }, "compact-mantine", tempDir("ref-"), async () => null)).toBeNull();
    });
});
