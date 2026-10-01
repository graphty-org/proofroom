/**
 * Passkey approval of a review record (design.md section 8): the record hash a Finish signs, and the
 * checks an approval must pass for the gate to count the record's accepts. Standard library only:
 * the gate runs this on CI from a checkout without an install.
 *
 * The owner's passkeys are listed in `visual-review.passkeys.json` at the repository root, as it is
 * on the default branch: a JSON array of `{ id, publicKey, rpId, label, registeredAt }`, where `id`
 * is the credential id and `publicKey` its SubjectPublicKeyInfo (DER), both base64url. While the
 * file does not exist, approvals are not required; once it exists, every new accept needs one.
 */

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";

export const PASSKEYS_FILE = "visual-review.passkeys.json";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
export const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64url = (s) => (typeof s === "string" && /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, "base64url") : null);

// JSON with every object's keys sorted and no whitespace; undefined fields left out, as JSON does.
function canonical(value) {
    if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
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
 * The record hash: SHA-256 of the record's canonical JSON with `approval` removed. It is the
 * WebAuthn challenge a Finish signs.
 * @param {object} record the review record
 * @returns {Buffer} the 32-byte hash
 */
export function recordHash(record) {
    const rest = { ...record };
    delete rest.approval;
    return sha256(canonical(rest));
}

/**
 * Checks a passkeys file's entries.
 * @param {unknown} list the parsed file
 * @returns {{ keys: { id: string, publicKey: string, rpId: string, label: string }[], problem: string | null }}
 *     the usable keys, and what was wrong with the file, if anything
 */
export function parsePasskeys(list) {
    if (!Array.isArray(list)) {
        return { keys: [], problem: `${PASSKEYS_FILE} must be a JSON array` };
    }
    const keys = list.filter(
        (k) =>
            typeof k?.id === "string" &&
            fromB64url(k.publicKey) !== null &&
            typeof k.rpId === "string" &&
            /^[a-z0-9.-]+$/i.test(k.rpId),
    );
    const problem =
        keys.length === list.length
            ? null
            : `${PASSKEYS_FILE}: ignoring ${list.length - keys.length} malformed entries`;
    return { keys: keys.map((k) => ({ ...k, label: typeof k.label === "string" ? k.label : "passkey" })), problem };
}

/**
 * The registered passkeys at a git ref.
 * @param {string} ref the default branch's tip (the base, in the gate)
 * @param {string} root the repository
 * @returns {{ keys: object[], problem: string | null } | null} null when the file does not exist
 *     there, so approvals are not required yet
 */
export function passkeysAt(ref, root) {
    let text;
    try {
        text = execFileSync("git", ["show", `${ref}:${PASSKEYS_FILE}`], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return null;
    }
    try {
        return parsePasskeys(JSON.parse(text));
    } catch {
        return { keys: [], problem: `${PASSKEYS_FILE} is not valid JSON` };
    }
}

/**
 * Why a record's approval does not count, if it does not: the checks of design.md section 8.
 * @param {object} record the record as committed, with its `approval`
 * @param {{ id: string, publicKey: string, rpId: string }[]} keys the registered passkeys
 * @returns {string | null} the problem, or null when the approval is valid
 */
export function approvalProblem(record, keys) {
    const a = record?.approval;
    if (!a || typeof a !== "object") {
        return "no passkey approval";
    }
    const key = keys.find((k) => k.id === a.credentialId);
    if (!key) {
        return "approved by a passkey that is not registered";
    }
    const authData = fromB64url(a.authenticatorData);
    const clientBytes = fromB64url(a.clientDataJSON);
    const signature = fromB64url(a.signature);
    if (!authData || !clientBytes || !signature || authData.length < 37) {
        return "the approval is malformed";
    }
    let client;
    try {
        client = JSON.parse(clientBytes.toString("utf8"));
    } catch {
        return "the approval's client data is not JSON";
    }
    if (client?.type !== "webauthn.get") {
        return "the approval is not a WebAuthn assertion";
    }
    if (client.challenge !== b64url(recordHash(record))) {
        return "the approval was given for different contents: the record was changed after it was signed";
    }
    let origin;
    try {
        origin = new URL(client.origin);
    } catch {
        return "the approval has no origin";
    }
    const onRp = origin.hostname === key.rpId || origin.hostname.endsWith(`.${key.rpId}`);
    const secure = origin.protocol === "https:" || (origin.protocol === "http:" && origin.hostname === "localhost");
    if (!onRp || !secure) {
        return `the approval came from ${client.origin}, not from an https page on ${key.rpId}`;
    }
    if (!authData.subarray(0, 32).equals(sha256(key.rpId))) {
        return `the approval is for another site than ${key.rpId}`;
    }
    // Flags: bit 0 user present, bit 2 user verified (Face ID, Touch ID or the device passcode).
    if ((authData[32] & 0x05) !== 0x05) {
        return "the approval was given without user verification (Face ID, Touch ID or a PIN)";
    }
    let ok = false;
    try {
        const publicKey = createPublicKey({ key: fromB64url(key.publicKey), format: "der", type: "spki" });
        ok = verify("sha256", Buffer.concat([authData, sha256(clientBytes)]), publicKey, signature);
    } catch {
        ok = false;
    }
    return ok ? null : "the approval's signature does not verify with the registered passkey";
}
