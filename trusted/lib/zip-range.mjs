/**
 * Reads chosen files out of a remote zip with HTTP range requests, without downloading the rest: a
 * Stories bin needs results.json and a handful of images from a project's capture, which for a large
 * project is hundreds of megabytes.
 * ponytail: plain zips only (no zip64, no encryption, stored or deflated); anything else answers
 * null and the caller downloads the whole artifact, as before.
 */
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX = 0xffffffff;

/**
 * The central directory of a zip of `size` bytes, read through `read(start, end)` (end exclusive).
 * @param {(start: number, end: number) => Promise<Buffer>} read the range reader
 * @param {number} size the zip's size in bytes
 * @returns {Promise<Map<string, { offset: number, end: number, method: number, compressed: number, flags: number }> | null>}
 *     the entries by name, with `end` (where the next entry or the directory starts) set on each, or null
 */
export async function zipEntries(read, size) {
    const tailStart = Math.max(0, size - (22 + 65535));
    const tail = await read(tailStart, size);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD) {
            at = i;
            break;
        }
    }
    if (at < 0) {
        return null;
    }
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOffset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || cdSize === MAX || cdOffset === MAX) {
        return null; // zip64
    }
    const cd = await read(cdOffset, cdOffset + cdSize);
    const entries = new Map();
    let p = 0;
    for (let n = 0; n < count; n++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) {
            return null;
        }
        const flags = cd.readUInt16LE(p + 8);
        const method = cd.readUInt16LE(p + 10);
        const compressed = cd.readUInt32LE(p + 20);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const offset = cd.readUInt32LE(p + 42);
        if (compressed === MAX || offset === MAX) {
            return null;
        }
        entries.set(cd.toString("utf8", p + 46, p + 46 + nameLen), { offset, end: 0, method, compressed, flags });
        p += 46 + nameLen + extraLen + commentLen;
    }
    // An entry's local header, data and data descriptor lie between its offset and the next one's.
    const starts = [...entries.values()].map((e) => e.offset).sort((a, b) => a - b);
    for (const e of entries.values()) {
        e.end = starts.find((s) => s > e.offset) ?? cdOffset;
    }
    return entries;
}

/**
 * One entry's bytes.
 * @param {(start: number, end: number) => Promise<Buffer>} read the range reader
 * @param {{ offset: number, end: number, method: number, compressed: number, flags: number }} entry from zipEntries()
 * @returns {Promise<Buffer | null>} the file, or null for an encrypted entry or an unknown method
 */
export async function zipEntry(read, entry) {
    if (entry.flags & 1 || (entry.method !== 0 && entry.method !== 8)) {
        return null;
    }
    const raw = await read(entry.offset, entry.end);
    if (raw.readUInt32LE(0) !== LOCAL) {
        return null;
    }
    const start = 30 + raw.readUInt16LE(26) + raw.readUInt16LE(28);
    const data = raw.subarray(start, start + entry.compressed);
    return entry.method === 0 ? Buffer.from(data) : inflateRawSync(data);
}

/**
 * A range reader for a GitHub Actions artifact: its archive URL answers with a redirect to a
 * short-lived blob URL that serves byte ranges.
 * @param {string} archiveUrl the artifact's `archive_download_url`
 * @param {string} token a token that can read the repository's artifacts
 * @param {typeof fetch} [fetchImpl] fetch
 * @returns {Promise<{ read: (start: number, end: number) => Promise<Buffer>, size: number } | null>} null
 *     when the blob does not serve ranges
 */
export async function artifactReader(archiveUrl, token, fetchImpl = fetch) {
    const res = await fetchImpl(archiveUrl, { redirect: "manual", headers: { authorization: `Bearer ${token}` } });
    const url = res.headers.get("location");
    if (!url) {
        return null;
    }
    const read = async (start, end) => {
        const r = await fetchImpl(url, { headers: { range: `bytes=${start}-${end - 1}` } });
        if (r.status !== 206) {
            throw new Error(`range ${start}-${end - 1} answered ${r.status}`);
        }
        return Buffer.from(await r.arrayBuffer());
    };
    const head = await fetchImpl(url, { headers: { range: "bytes=0-0" } });
    const size = Number(/\/(\d+)$/.exec(head.headers.get("content-range") ?? "")?.[1]);
    await head.arrayBuffer().catch(() => {});
    return head.status === 206 && size > 0 ? { read, size } : null;
}
