/*
 * The review page's WebAuthn code: registering the owner's passkey, and approving a Finish with
 * it (Face ID or Touch ID). The server builds every challenge and checks every answer; this file
 * only hands bytes between it and the browser.
 *
 * Safari needs a user gesture for both calls, so no network request may sit between the press and
 * the WebAuthn call: the challenge is always fetched before the button that uses it is shown, and
 * each call below reaches `navigator.credentials` before its first `await`.
 */

// Own helpers: Uint8Array.fromBase64 is missing from the Safari versions still in use.
const toB64u = (buffer) => {
    let s = "";
    for (const b of new Uint8Array(buffer)) {
        s += String.fromCharCode(b);
    }
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s) => {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const credential = (id) => ({ type: "public-key", id: fromB64u(id) });

/**
 * Fetches a registration challenge. Call it before showing the button that registers.
 * @param {(path: string, body?: object) => Promise<any>} api the page's API call
 * @returns {Promise<{ challenge: string, userId: string, rpId: string, known: string[] }>} what
 *     registerPasskey needs
 */
export const prepareRegistration = (api) => api("/api/passkey-challenge", {});

/**
 * Creates a passkey for this page's host and asks the server to register it, which opens a pull
 * request adding it. Call it straight from the button's click.
 * @param {(path: string, body?: object) => Promise<any>} api the page's API call
 * @param {{ challenge: string, userId: string, rpId: string, known: string[] }} prepared from
 *     prepareRegistration
 * @param {string | ((made: PublicKeyCredential) => string)} label what passkeys.json calls the key,
 *     or a function naming it from the credential made (a platform passkey or a security key)
 * @returns {Promise<{ entry: object, branch: string, pullRequest: string, gated: boolean }>} the
 *     server's answer
 */
export async function registerPasskey(api, prepared, label) {
    const created = navigator.credentials.create({
        publicKey: {
            rp: { id: prepared.rpId, name: "Visual review" },
            user: { id: fromB64u(prepared.userId), name: "visual-review", displayName: "Visual review owner" },
            challenge: fromB64u(prepared.challenge),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
            attestation: "none",
            excludeCredentials: prepared.known.map(credential),
        },
    });
    const made = await created;
    const r = made.response;
    return api("/api/register", {
        challenge: prepared.challenge,
        credentialId: toB64u(made.rawId),
        publicKey: toB64u(r.getPublicKey()),
        algorithm: r.getPublicKeyAlgorithm(),
        authenticatorData: toB64u(r.getAuthenticatorData()),
        clientDataJSON: toB64u(r.clientDataJSON),
        label: typeof label === "function" ? label(made) : label,
    });
}

/**
 * Signs a prepared Finish's record with the passkey. Call it straight from the press that answers
 * yes. A cancelled or refused prompt rejects with a NotAllowedError.
 * @param {{ challenge: string, rpId: string, allowCredentials: string[] }} prepared from
 *     POST /api/finish-prepare
 * @returns {Promise<{ credentialId: string, authenticatorData: string, clientDataJSON: string,
 *     signature: string }>} the approval POST /api/finish takes
 */
export async function approve(prepared) {
    const got = await navigator.credentials.get({
        publicKey: {
            challenge: fromB64u(prepared.challenge),
            rpId: prepared.rpId,
            allowCredentials: prepared.allowCredentials.map(credential),
            userVerification: "required",
            timeout: 120000,
        },
    });
    const r = got.response;
    return {
        credentialId: toB64u(got.rawId),
        authenticatorData: toB64u(r.authenticatorData),
        clientDataJSON: toB64u(r.clientDataJSON),
        signature: toB64u(r.signature),
    };
}
