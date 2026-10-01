/*
 * The passkey approval of a review record: the test vectors design.md section 8 asks for (an
 * edited record, a wrong rpId, user verification missing, an unknown key, a bad signature), and
 * the gate counting a record's accepts only with a valid approval once passkeys are registered.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { unrecordedChanges } from "../trusted/gate.mjs";
import { approvalProblem, b64url, parsePasskeys, passkeysAt, recordHash } from "../trusted/lib/approval.mjs";
import { git, isolateGit, makeRepo, registerOnMaster, testPasskey } from "./helpers.mjs";

beforeAll(isolateGit);

const RECORD = {
    version: 2,
    pr: 123,
    subject: { builtMerge: "a".repeat(40), head: "b".repeat(40), runId: 1, runAttempt: 1, scale: 2 },
    items: [{ path: "visual-baselines/p/x.png", from: null, to: "c".repeat(64), reason: null }],
    rejects: [],
    reviewedAt: "2026-10-01T00:00:00.000Z",
};

const signed = (key, record = RECORD, options) => ({
    ...record,
    approval: key.sign(b64url(recordHash(record)), options),
});

describe("approvalProblem", () => {
    const key = testPasskey("dev.example.com");
    const keys = [key.entry];

    it("accepts the owner's assertion over the record hash", () => {
        expect(approvalProblem(signed(key), keys)).toBeNull();
        // From a subdomain of the rpId too, and key order in the record does not matter.
        const reordered = Object.fromEntries(Object.entries(RECORD).reverse());
        const approval = signed(key, RECORD, { origin: "https://review.dev.example.com:9443" }).approval;
        expect(approvalProblem({ ...reordered, approval }, keys)).toBeNull();
    });

    it("refuses an edited record", () => {
        const record = signed(key);
        record.items = [{ ...record.items[0], to: "d".repeat(64) }];
        expect(approvalProblem(record, keys)).toMatch(/record was changed after it was signed/);
    });

    it("refuses a wrong rpId, a foreign origin and plain http", () => {
        expect(approvalProblem(signed(key, RECORD, { rpId: "evil.example" }), keys)).toMatch(/another site/);
        expect(approvalProblem(signed(key, RECORD, { origin: "https://evil.example" }), keys)).toMatch(
            /not from an https page on dev.example.com/,
        );
        expect(approvalProblem(signed(key, RECORD, { origin: "http://dev.example.com" }), keys)).toMatch(/https/);
    });

    it("refuses an approval without user verification", () => {
        expect(approvalProblem(signed(key, RECORD, { uv: false }), keys)).toMatch(/without user verification/);
    });

    it("refuses an unknown key, a missing approval and a bad signature", () => {
        const other = testPasskey("dev.example.com");
        expect(approvalProblem(signed(other), keys)).toMatch(/not registered/);
        expect(approvalProblem(RECORD, keys)).toBe("no passkey approval");
        // The right key id, signed by another key.
        const forged = signed(other);
        forged.approval.credentialId = key.entry.id;
        expect(approvalProblem(forged, keys)).toMatch(/signature does not verify/);
    });

    it("refuses an assertion that is not a WebAuthn get", () => {
        const record = signed(key);
        const client = JSON.parse(Buffer.from(record.approval.clientDataJSON, "base64url").toString());
        record.approval.clientDataJSON = b64url(JSON.stringify({ ...client, type: "webauthn.create" }));
        expect(approvalProblem(record, keys)).toMatch(/not a WebAuthn assertion/);
    });
});

describe("parsePasskeys and passkeysAt", () => {
    it("keeps the well-formed entries and says what it dropped", () => {
        const { entry } = testPasskey();
        expect(parsePasskeys([entry, { id: 1 }])).toMatchObject({ keys: [entry], problem: /1 malformed/ });
        expect(parsePasskeys({})).toMatchObject({ keys: [], problem: /JSON array/ });
    });

    it("reads the file at a ref, and null where it does not exist", () => {
        const r = makeRepo();
        expect(passkeysAt("master", r.repo)).toBeNull();
        const { entry } = testPasskey();
        registerOnMaster(r, [entry]);
        expect(passkeysAt("master", r.repo)).toEqual({ keys: [entry], problem: null });
    });
});

describe("the gate with passkeys registered", () => {
    it("counts a record's accepts only when its approval verifies", () => {
        const r = makeRepo();
        const key = testPasskey();
        registerOnMaster(r, [key.entry]);
        const passkeys = passkeysAt("master", r.repo);
        git(r.repo, "checkout", "-q", "feature");
        const path = "visual-baselines/compact-mantine/card--legacy.png";
        writeFileSync(join(r.repo, path), "new image");
        // The image's hash: the gate compares it with the LFS pointer's oid.
        const to = createHash("sha256").update("new image").digest("hex");
        const record = { ...RECORD, items: [{ path, from: null, to, reason: null }] };
        mkdirSync(join(r.repo, "visual-baselines/reviews"), { recursive: true });
        writeFileSync(join(r.repo, "visual-baselines/reviews/unsigned.json"), JSON.stringify(record));
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "accept without a passkey");
        expect(unrecordedChanges("master", "feature", r.repo, "visual-baselines", passkeys)).toEqual([
            `${path}: changed with no review record naming its new contents`,
            "visual-baselines/reviews/unsigned.json: not counted: no passkey approval",
        ]);
        // Without passkeys on the base, the same record still counts (approvals not required yet).
        expect(unrecordedChanges("master", "feature", r.repo, "visual-baselines", null)).toEqual([]);

        writeFileSync(join(r.repo, "visual-baselines/reviews/signed.json"), JSON.stringify(signed(key, record)));
        git(r.repo, "add", "-A");
        git(r.repo, "commit", "-q", "-m", "accept with the passkey");
        // The unsigned record stays (records are append-only) and no longer matters.
        expect(unrecordedChanges("master", "feature", r.repo, "visual-baselines", passkeys)).toEqual([]);
    });
});
