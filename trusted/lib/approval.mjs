/**
 * Passkey approvals of review records: the owner's device (Face ID or Touch ID, a passkey in
 * iCloud Keychain) signs the SHA-256 of a review record, and this module checks that signature.
 * The gate runs it on every record a pull request adds; the server runs it at Finish, immediately
 * before the record is committed.
 *
 * WebAuthn's ES256 signature is over `authenticatorData || SHA-256(clientDataJSON)`, and the
 * challenge inside clientDataJSON is the record's hash, so the signature covers the record. Only
 * `node:crypto`, so the gate still runs from a checkout without an install.
 */

import { createHash, createPublicKey, verify } from "node:crypto";

/** Where the registered public keys live, relative to the repository root. */
export const PASSKEYS_FILE = "visual-review/passkeys.json";

const B64U = /^[A-Za-z0-9_-]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const FIELDS = ["credentialId", "authenticatorData", "clientDataJSON", "signature"];
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const b64u = (s) => Buffer.from(s, "base64url");

/**
 * JSON with object keys sorted and no whitespace, so one record has exactly one byte form. A
 * number JSON cannot write back as it was read (1e999 is Infinity, -0 is 0) throws, so two
 * different records never hash the same.
 * @param {unknown} value a JSON value
 * @returns {string} its canonical text
 */
export function canonical(value) {
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
        throw new Error(`${value} has no canonical JSON form`);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonical(v ?? null)).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value)
            .filter((k) => value[k] !== undefined)
            .sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/**
 * The bytes an approval signs: SHA-256 of the canonical record without its `approval`.
 * @param {object} record the review record
 * @returns {Buffer} 32 bytes
 */
export function recordHash(record) {
    const rest = { ...record };
    delete rest.approval;
    return sha256(Buffer.from(canonical(rest), "utf8"));
}

/**
 * Loads a key's SubjectPublicKeyInfo; only P-256 (ES256) is accepted.
 * @param {string} spki base64url DER
 * @returns {import("node:crypto").KeyObject} the key
 */
function loadKey(spki) {
    const key = createPublicKey({ key: b64u(spki), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new Error("the public key is not a P-256 (ES256) key");
    }
    return key;
}

/**
 * Parses passkeys.json. One bad entry makes the whole file invalid, so the gate fails closed.
 * @param {string} text the file
 * @returns {{ id: string, publicKey: string, rpId: string, label?: string, registeredAt?: string }[]}
 *     the keys
 */
export function parsePasskeys(text) {
    const doc = JSON.parse(text);
    if (doc?.version !== 1) {
        throw new Error("version must be 1");
    }
    if (!Array.isArray(doc.keys)) {
        throw new Error("keys must be an array");
    }
    const seen = new Set();
    for (const [i, k] of doc.keys.entries()) {
        const where = `keys[${i}]`;
        if (typeof k?.id !== "string" || !B64U.test(k.id)) {
            throw new Error(`${where}.id must be a non-empty base64url string`);
        }
        if (seen.has(k.id)) {
            throw new Error(`${where}.id is a duplicate`);
        }
        seen.add(k.id);
        if (typeof k.rpId !== "string" || !HOST.test(k.rpId)) {
            throw new Error(`${where}.rpId must be a host name`);
        }
        if (typeof k.publicKey !== "string" || !B64U.test(k.publicKey)) {
            throw new Error(`${where}.publicKey must be base64url`);
        }
        try {
            loadKey(k.publicKey);
        } catch (err) {
            throw new Error(`${where}.publicKey: ${err.message}`);
        }
    }
    return doc.keys;
}

/**
 * Checks clientDataJSON and authenticatorData shared by registration and approval.
 * @param {object} c the ceremony
 * @param {any} c.clientData the parsed clientDataJSON
 * @param {Buffer} c.authData authenticatorData
 * @param {string} c.type webauthn.get or webauthn.create
 * @param {string} c.challenge the expected challenge, base64url
 * @param {string} c.rpId the relying party id
 * @param {(origin: unknown) => boolean} c.originOk whether the origin is acceptable
 * @returns {string | null} why not, or null
 */
function checkCeremony({ clientData, authData, type, challenge, rpId, originOk }) {
    if (clientData?.type !== type) {
        return `clientDataJSON.type is not ${type}`;
    }
    if (clientData.challenge !== challenge) {
        return "the challenge does not match: it was signed for other contents than these";
    }
    if (clientData.crossOrigin === true) {
        return "the approval was made in a cross-origin frame";
    }
    if (!originOk(clientData.origin)) {
        return `the approval was made on ${JSON.stringify(clientData.origin)}, not on the review page's origin`;
    }
    if (authData.length < 37) {
        return "authenticatorData is too short";
    }
    if (!authData.subarray(0, 32).equals(sha256(rpId))) {
        return `authenticatorData is not for the rpId ${rpId}`;
    }
    if (!(authData[32] & UP)) {
        return "the authenticator did not confirm user presence";
    }
    if (!(authData[32] & UV)) {
        return "the authenticator did not verify the user (no Face ID, Touch ID or PIN)";
    }
    return null;
}

const jsonOf = (s) => {
    try {
        return JSON.parse(b64u(s).toString("utf8"));
    } catch {
        return undefined;
    }
};

/**
 * Whether a record's approval is a valid passkey signature over that record. Never throws.
 * @param {object} record the review record, with `approval`
 * @param {{ id: string, publicKey: string, rpId: string }[]} keys the keys to accept
 * @param {{ origin?: string }} [options] the exact origin required (the server's); without it any
 *     https origin whose host is exactly the key's rpId, on any port (servherd assigns the review
 *     server's), never a subdomain
 * @returns {string | null} why it fails, or null when it verifies
 */
export function verifyApproval(record, keys, { origin } = {}) {
    const a = record?.approval;
    if (typeof a !== "object" || a === null) {
        return "the record has no passkey approval";
    }
    for (const f of FIELDS) {
        if (typeof a[f] !== "string" || !B64U.test(a[f])) {
            return `approval.${f} is not base64url`;
        }
    }
    const key = keys.find((k) => k.id === a.credentialId);
    if (!key) {
        return "approval is from a key not in passkeys.json on the base branch";
    }
    const clientDataBytes = b64u(a.clientDataJSON);
    const clientData = jsonOf(a.clientDataJSON);
    if (clientData === undefined) {
        return "approval.clientDataJSON is not JSON";
    }
    const authData = b64u(a.authenticatorData);
    let challenge;
    try {
        challenge = recordHash(record).toString("base64url");
    } catch (err) {
        return `the record cannot be hashed: ${err.message}`;
    }
    const why = checkCeremony({
        clientData,
        authData,
        type: "webauthn.get",
        challenge,
        rpId: key.rpId,
        originOk: (o) => {
            if (origin !== undefined) {
                return o === origin;
            }
            try {
                // u.origin === o refuses anything a browser never writes as an origin (a user, a path).
                const u = new URL(String(o));
                return u.origin === o && u.protocol === "https:" && u.hostname === key.rpId;
            } catch {
                return false;
            }
        },
    });
    if (why) {
        return why;
    }
    let ok = false;
    try {
        ok = verify(
            "sha256",
            Buffer.concat([authData, sha256(clientDataBytes)]),
            loadKey(key.publicKey),
            b64u(a.signature),
        );
    } catch {
        ok = false;
    }
    return ok ? null : "the approval's signature does not verify";
}

/**
 * The gate's check of one record a pull request adds, once approvals are enforced.
 * @param {object} record the parsed record
 * @param {{ id: string, publicKey: string, rpId: string }[]} keys the base branch's keys
 * @param {{ pr: number }} options the pull request the gate runs on
 * @returns {string | null} why it fails, or null
 */
export function verifyRecord(record, keys, { pr }) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
        return "not a review record";
    }
    if (record.version !== 2) {
        return `a version ${JSON.stringify(record.version)} record has no passkey approval; review it again with Face ID`;
    }
    if (!Array.isArray(record.items) || !Array.isArray(record.rejects)) {
        return "items and rejects must be arrays";
    }
    if (record.pr !== pr && record.pr !== null) {
        return `the record is for pull request #${record.pr}, not #${pr}`;
    }
    return verifyApproval(record, keys);
}

/**
 * The server's check of a `navigator.credentials.create` response. Attestation is not checked
 * (Apple passkeys give "none"): the owner merging the key's pull request is the trust step.
 * @param {{ credentialId: string, publicKey: string, algorithm: number, authenticatorData: string,
 *     clientDataJSON: string }} input what the page sent
 * @param {{ challenge: string, origin: string, rpId: string }} expected the server's challenge
 *     (base64url), its origin and rpId
 * @returns {string | null} why it fails, or null
 */
export function verifyRegistration(input, { challenge, origin, rpId }) {
    for (const f of ["credentialId", "publicKey", "authenticatorData", "clientDataJSON"]) {
        if (typeof input?.[f] !== "string" || !B64U.test(input[f])) {
            return `${f} is not base64url`;
        }
    }
    if (input.algorithm !== -7) {
        return `algorithm ${input.algorithm} is not ES256 (-7)`;
    }
    const clientData = jsonOf(input.clientDataJSON);
    if (clientData === undefined) {
        return "clientDataJSON is not JSON";
    }
    const authData = b64u(input.authenticatorData);
    const why = checkCeremony({
        clientData,
        authData,
        type: "webauthn.create",
        challenge,
        rpId,
        originOk: (o) => o === origin,
    });
    if (why) {
        return why;
    }
    // The attested credential data names the credential: it must be the id sent.
    const id = b64u(input.credentialId);
    const length = authData.length >= 55 ? authData.readUInt16BE(53) : -1;
    if (!(authData[32] & AT) || length !== id.length || !authData.subarray(55, 55 + length).equals(id)) {
        return "authenticatorData does not hold this credential id";
    }
    try {
        loadKey(input.publicKey);
    } catch (err) {
        return err.message;
    }
    return null;
}
