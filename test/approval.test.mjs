import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
    canonical,
    parsePasskeys,
    recordHash,
    verifyApproval,
    verifyRecord,
    verifyRegistration,
} from "../trusted/lib/approval.mjs";
import { approve, makeKey, passkeysJson, register } from "./passkey-vectors.mjs";

const KEY = makeKey();
const KEYS = [KEY.entry];

const record = (to = "b".repeat(64), pr = 5) => ({
    version: 2,
    pr,
    subject: { builtMerge: "1".repeat(40), head: "2".repeat(40), runId: 9, runAttempt: 1, scale: 2 },
    items: [{ path: "visual-baselines/p/a.png", from: "a".repeat(64), to, reason: null }],
    rejects: [{ path: "visual-baselines/p/b.png", capture: "c".repeat(64), reason: "tall" }],
    reviewedAt: "2026-09-28T12:00:00.000Z",
});
const approved = (r = record(), key = KEY, o) => ({ ...r, approval: approve(r, key, o) });
const b64u = (s) => Buffer.from(s).toString("base64url");

describe("verifyApproval", () => {
    it("passes a valid approval", () => {
        expect(verifyApproval(approved(), KEYS)).toBeNull();
        expect(verifyRecord(approved(), KEYS, { pr: 5 })).toBeNull();
    });

    it("fails an edited record and an approval moved onto another record", () => {
        const r = approved();
        r.items[0].to = "d".repeat(64);
        expect(verifyApproval(r, KEYS)).toMatch(/challenge does not match/);
        const moved = { ...record("e".repeat(64)), approval: approved().approval };
        expect(verifyApproval(moved, KEYS)).toMatch(/challenge does not match/);
    });

    it("fails a wrong rpId", () => {
        expect(
            verifyApproval(approved(record(), KEY, { rpId: "evil.example", origin: "https://dev.ato.ms" }), KEYS),
        ).toMatch(/not for the rpId dev\.ato\.ms/);
    });

    it.each(["https://evil.example", "http://dev.ato.ms:9443", "https://notdev.ato.ms", "not a url"])(
        "fails the origin %s",
        (origin) => {
            expect(verifyApproval(approved(record(), KEY, { origin }), KEYS)).toMatch(
                /not on the review page's origin/,
            );
        },
    );

    // Every server on the rpId's host can ask for the passkey; a subdomain is never the review page.
    it.each(["https://a.dev.ato.ms", "https://x@dev.ato.ms", "https://dev.ato.ms/", "https://DEV.ato.ms"])(
        "fails the origin %s, which is not exactly the rpId's host",
        (origin) => {
            expect(verifyApproval(approved(record(), KEY, { origin }), KEYS)).toMatch(
                /not on the review page's origin/,
            );
        },
    );

    it("accepts the rpId's host on any port, and with an exact origin only that origin", () => {
        expect(verifyApproval(approved(record(), KEY, { origin: "https://dev.ato.ms" }), KEYS)).toBeNull();
        expect(verifyApproval(approved(record(), KEY, { origin: "https://dev.ato.ms:9999" }), KEYS)).toBeNull();
        const r = approved(record(), KEY, { origin: "https://dev.ato.ms:9443" });
        expect(verifyApproval(r, KEYS, { origin: "https://dev.ato.ms:9443" })).toBeNull();
        expect(verifyApproval(r, KEYS, { origin: "https://dev.ato.ms:9444" })).toMatch(/origin/);
    });

    it("fails without user verification or without user presence", () => {
        expect(verifyApproval(approved(record(), KEY, { flags: 0x01 }), KEYS)).toMatch(/did not verify the user/);
        expect(verifyApproval(approved(record(), KEY, { flags: 0x04 }), KEYS)).toMatch(/user presence/);
    });

    it("fails an unknown key, a flipped signature byte, and a valid signature by another key", () => {
        expect(verifyApproval(approved(), [makeKey().entry])).toBe(
            "approval is from a key not in passkeys.json on the base branch",
        );
        const r = approved();
        const sig = Buffer.from(r.approval.signature, "base64url");
        sig[sig.length - 1] ^= 1;
        r.approval.signature = sig.toString("base64url");
        expect(verifyApproval(r, KEYS)).toMatch(/signature does not verify/);
        const other = makeKey();
        const forged = approved(record(), other);
        forged.approval.credentialId = KEY.entry.id;
        expect(verifyApproval(forged, KEYS)).toMatch(/signature does not verify/);
    });

    it("returns a reason, never throws, for malformed approvals", () => {
        expect(verifyApproval(approved(record(), KEY, { type: "webauthn.create" }), KEYS)).toMatch(/type/);
        const cross = approved();
        const cd = JSON.parse(Buffer.from(cross.approval.clientDataJSON, "base64url").toString());
        cross.approval.clientDataJSON = b64u(JSON.stringify({ ...cd, crossOrigin: true }));
        expect(verifyApproval(cross, KEYS)).toMatch(/cross-origin/);
        const short = approved();
        short.approval.authenticatorData = b64u("x".repeat(36));
        expect(verifyApproval(short, KEYS)).toMatch(/too short/);
        const bad = approved();
        bad.approval.signature = "abc+/=";
        expect(verifyApproval(bad, KEYS)).toBe("approval.signature is not base64url");
        const notJson = approved();
        notJson.approval.clientDataJSON = b64u("{nope");
        expect(verifyApproval(notJson, KEYS)).toMatch(/not JSON/);
        expect(verifyApproval(record(), KEYS)).toBe("the record has no passkey approval");
        expect(verifyApproval(null, KEYS)).toBe("the record has no passkey approval");
        const garbage = approved();
        garbage.approval.signature = "AAAA";
        expect(verifyApproval(garbage, KEYS)).toMatch(/signature does not verify/);
    });
});

describe("verifyRecord", () => {
    it("fails old-format records, missing approvals and another pull request's record", () => {
        expect(verifyRecord({ ...record(), version: 1, unproven: true }, KEYS, { pr: 5 })).toMatch(/version 1/);
        expect(verifyRecord(record(), KEYS, { pr: 5 })).toBe("the record has no passkey approval");
        expect(verifyRecord(approved(), KEYS, { pr: 6 })).toMatch(/pull request #5, not #6/);
        expect(verifyRecord(approved(record(undefined, null)), KEYS, { pr: 6 })).toBeNull();
        expect(verifyRecord({ ...approved(), rejects: undefined }, KEYS, { pr: 5 })).toMatch(/arrays/);
        expect(verifyRecord([], KEYS, { pr: 5 })).toBe("not a review record");
    });
    it("accepts a record for any pull request of a merge-queue batch, and no other", () => {
        expect(verifyRecord(approved(), KEYS, { pr: [4, 5, 6] })).toBeNull();
        expect(verifyRecord(approved(), KEYS, { pr: [6, 7] })).toMatch(/pull request #5, not #6, #7/);
        expect(verifyRecord(approved(), KEYS, { pr: [] })).toMatch(/pull request #5, not #$/);
    });
});

describe("canonical and recordHash", () => {
    it("refuses numbers JSON cannot write back as read, so no edit keeps a signature", () => {
        expect(() => canonical({ runId: Infinity })).toThrow(/no canonical JSON form/);
        expect(() => canonical([-0])).toThrow(/no canonical JSON form/);
        expect(canonical({ a: 0, b: null })).toBe('{"a":0,"b":null}');
        const r = approved(record());
        const edited = JSON.parse(JSON.stringify(r).replace('"runId":9', '"runId":1e999'));
        expect(verifyApproval(edited, KEYS)).toMatch(/^the record cannot be hashed/);
    });

    it("ignores key order, whitespace and the approval, and changes with any nested value", () => {
        expect(canonical({ b: [1, { d: null, c: "x" }], a: true, u: undefined })).toBe(
            '{"a":true,"b":[1,{"c":"x","d":null}]}',
        );
        const r = record();
        const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(r).reverse()), null, 4));
        expect(recordHash(shuffled)).toEqual(recordHash(r));
        expect(recordHash(approved(r))).toEqual(recordHash(r));
        const changed = record();
        changed.subject.runAttempt = 2;
        expect(recordHash(changed)).not.toEqual(recordHash(r));
    });
});

describe("parsePasskeys", () => {
    it("reads valid keys and refuses bad files", () => {
        expect(parsePasskeys(passkeysJson(KEY))).toEqual(KEYS);
        expect(parsePasskeys('{ "version": 1, "keys": [] }')).toEqual([]);
        expect(() => parsePasskeys("{")).toThrow();
        expect(() => parsePasskeys('{ "version": 2, "keys": [] }')).toThrow(/version/);
        expect(() => parsePasskeys('{ "version": 1 }')).toThrow(/array/);
        const dup = JSON.stringify({ version: 1, keys: [KEY.entry, KEY.entry] });
        expect(() => parsePasskeys(dup)).toThrow(/duplicate/);
        const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
        const rsaEntry = { ...KEY.entry, publicKey: rsa.export({ format: "der", type: "spki" }).toString("base64url") };
        expect(() => parsePasskeys(JSON.stringify({ version: 1, keys: [rsaEntry] }))).toThrow(/P-256/);
        const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey;
        const p384Entry = {
            ...KEY.entry,
            publicKey: p384.export({ format: "der", type: "spki" }).toString("base64url"),
        };
        expect(() => parsePasskeys(JSON.stringify({ version: 1, keys: [p384Entry] }))).toThrow(/P-256/);
        expect(() => parsePasskeys(JSON.stringify({ version: 1, keys: [{ ...KEY.entry, rpId: "a b" }] }))).toThrow(
            /rpId/,
        );
        expect(() => parsePasskeys(JSON.stringify({ version: 1, keys: [{ ...KEY.entry, id: "" }] }))).toThrow(/id/);
    });
});

describe("verifyRegistration", () => {
    const origin = "https://dev.ato.ms:9443";
    const expected = { challenge: b64u("c".repeat(32)), origin, rpId: "dev.ato.ms" };
    const reg = (o = {}) => register(KEY, { challenge: expected.challenge, origin, ...o });

    it("passes a valid registration", () => {
        expect(verifyRegistration(reg(), expected)).toBeNull();
    });

    it("refuses a wrong challenge, origin, algorithm, a missing UV and another credential id", () => {
        expect(verifyRegistration(reg({ challenge: b64u("x") }), expected)).toMatch(/challenge/);
        expect(verifyRegistration(reg({ origin: "https://dev.ato.ms:9444" }), expected)).toMatch(/origin/);
        expect(verifyRegistration(reg({ algorithm: -257 }), expected)).toMatch(/-257 is not ES256/);
        expect(verifyRegistration(reg({ flags: 0x41 }), expected)).toMatch(/verify the user/);
        expect(verifyRegistration(reg({ type: "webauthn.get" }), expected)).toMatch(/type/);
        expect(verifyRegistration({ ...reg(), credentialId: makeKey().entry.id }, expected)).toMatch(/credential id/);
        expect(verifyRegistration({ ...reg(), publicKey: "AAAA" }, expected)).toBeTruthy();
        expect(verifyRegistration({ ...reg(), clientDataJSON: b64u("{") }, expected)).toMatch(/not JSON/);
        expect(verifyRegistration({}, expected)).toMatch(/base64url/);
    });
});
