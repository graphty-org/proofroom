/**
 * A software authenticator for the tests: the exact bytes a WebAuthn authenticator and browser
 * produce for an ES256 passkey, from a key pair generated per test run (nothing secret is checked
 * in). Flags 0x05 are user present and user verified.
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import { recordHash } from "../trusted/lib/approval.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");

/**
 * A new P-256 key and its passkeys.json entry.
 * @param {string} [rpId] the relying party
 * @returns {{ privateKey: import("node:crypto").KeyObject, entry: object }} the key
 */
export function makeKey(rpId = "dev.ato.ms") {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const entry = {
        id: randomBytes(16).toString("base64url"),
        publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        rpId,
        label: "test",
        registeredAt: "2026-09-28T12:00:00.000Z",
    };
    return { privateKey, entry };
}

/**
 * passkeys.json holding these keys.
 * @param {...{ entry: object }} keys the keys
 * @returns {string} the file
 */
export const passkeysJson = (...keys) => `${JSON.stringify({ version: 1, keys: keys.map((k) => k.entry) }, null, 4)}\n`;

/**
 * Signs authenticatorData and clientDataJSON as an authenticator does.
 * @param {{ privateKey: import("node:crypto").KeyObject }} key the key
 * @param {{ rpId: string, origin: string, flags: number, type: string, challenge: string,
 *     extra?: Buffer }} c what the browser and authenticator write
 * @returns {{ authenticatorData: Buffer, clientDataJSON: Buffer, signature: Buffer }} the bytes
 */
function ceremony(key, { rpId, origin, flags, type, challenge, extra = Buffer.alloc(0) }) {
    const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4), extra]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), key.privateKey);
    return { authenticatorData, clientDataJSON, signature };
}

/**
 * The approval a passkey gives a record (navigator.credentials.get).
 * @param {object} record the record
 * @param {{ privateKey: object, entry: object }} key the key
 * @param {{ rpId?: string, origin?: string, flags?: number, type?: string, challenge?: Buffer }} [o]
 *     what to change
 * @returns {{ credentialId: string, authenticatorData: string, clientDataJSON: string, signature: string }}
 *     the approval
 */
export function approve(
    record,
    key,
    {
        rpId = key.entry.rpId,
        origin = `https://${rpId}:9443`,
        flags = 0x05,
        type = "webauthn.get",
        challenge = recordHash(record),
    } = {},
) {
    const c = ceremony(key, { rpId, origin, flags, type, challenge: challenge.toString("base64url") });
    return {
        credentialId: key.entry.id,
        authenticatorData: b64u(c.authenticatorData),
        clientDataJSON: b64u(c.clientDataJSON),
        signature: b64u(c.signature),
    };
}

/**
 * The registration a passkey gives (navigator.credentials.create), as the page posts it.
 * @param {{ privateKey: object, entry: object }} key the key
 * @param {{ challenge: string, origin: string, rpId?: string, flags?: number, type?: string,
 *     algorithm?: number }} o the server's challenge (base64url) and origin, and what to change
 * @returns {object} the body of POST /api/register, without `label`
 */
export function register(
    key,
    { challenge, origin, rpId = key.entry.rpId, flags = 0x45, type = "webauthn.create", algorithm = -7 },
) {
    const id = Buffer.from(key.entry.id, "base64url");
    // Attested credential data: AAGUID, the id's length, the id (the COSE key is not read).
    const extra = Buffer.concat([Buffer.alloc(16), Buffer.from([id.length >> 8, id.length & 255]), id]);
    const c = ceremony(key, { rpId, origin, flags, type, challenge, extra });
    return {
        challenge,
        credentialId: key.entry.id,
        publicKey: key.entry.publicKey,
        algorithm,
        authenticatorData: b64u(c.authenticatorData),
        clientDataJSON: b64u(c.clientDataJSON),
    };
}
