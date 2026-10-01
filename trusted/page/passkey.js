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
const prepareRegistration = (api) => api("/api/passkey-challenge", {});

/**
 * Creates a passkey for this page's host and asks the server to register it, which opens a pull
 * request adding it. Call it straight from the button's click.
 * @param {(path: string, body?: object) => Promise<any>} api the page's API call
 * @param {{ challenge: string, userId: string, rpId: string, known: string[] }} prepared from
 *     prepareRegistration
 * @param {string} label what passkeys.json calls the key
 * @returns {Promise<{ entry: object, branch: string, pullRequest: string }>} the server's answer
 */
async function registerPasskey(api, prepared, label) {
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
        label,
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

/**
 * The "Register passkey" card of the targets screen. It says which keys are registered; the first
 * press fetches the challenge, the second creates the passkey (no request between a press and Face
 * ID), and the server opens a pull request adding it; merging that pull request makes the gate
 * require approvals.
 * @param {(path: string, body?: object) => Promise<any>} api the page's API call
 * @param {Function} el the page's element builder
 * @returns {HTMLElement} the card
 */
export function registerBlock(api, el) {
    const out = el("p", { class: "passkey-result" });
    const status = el(
        "p",
        {},
        "Finish asks for your passkey (Face ID or Touch ID) once one is registered for this host.",
    );
    const create = (prepared) =>
        el(
            "button",
            {
                type: "button",
                class: "primary",
                onclick: (e) => {
                    const button = e.currentTarget;
                    button.disabled = true;
                    // iPadOS and Apple Silicon Safari both report "MacIntel"; the passkey is in iCloud Keychain.
                    registerPasskey(api, prepared, "iCloud Keychain").then(
                        (r) =>
                            out.replaceChildren(
                                `Registered ${r.entry.label}, credential id ${r.entry.id}. Check that `,
                                el("a", { href: r.pullRequest, target: "_blank", rel: "noreferrer" }, r.pullRequest),
                                r.gated
                                    ? " names this id. A key is already registered, so the gate fails that pull request: it takes an administrator's merge."
                                    : " names this id, then merge it to make the gate require your approval.",
                            ),
                        (err) => {
                            out.replaceChildren(`Not registered: ${err.message}`);
                            button.disabled = false;
                        },
                    );
                },
            },
            "Create the passkey (Face ID or Touch ID)",
        );
    const start = el(
        "button",
        {
            type: "button",
            onclick: () => {
                start.disabled = true;
                prepareRegistration(api).then(
                    (prepared) => start.replaceWith(create(prepared)),
                    (err) => {
                        out.replaceChildren(`Not registered: ${err.message}`);
                        start.disabled = false;
                    },
                );
            },
        },
        "Register passkey",
    );
    api("/api/passkeys").then(
        ({ keys }) => {
            if (keys.length === 0) {
                return;
            }
            const names = keys.map(
                (k) => `${k.label ?? "passkey"} (${k.id}${k.pending ? ", its pull request not merged yet" : ""})`,
            );
            status.textContent = `Finish asks for your passkey (Face ID or Touch ID). Registered: ${names.join("; ")}.`;
            start.textContent = "Register another passkey";
        },
        () => {},
    );
    return el("section", { class: "card passkey" }, status, el("p", {}, start), out);
}
