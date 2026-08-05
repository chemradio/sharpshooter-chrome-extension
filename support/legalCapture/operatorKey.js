// A signing key belonging to this installation, used to sign every Legal
// Capture manifest.
//
// WHAT THIS PROVES, EXACTLY: that the same installation produced this capture
// and some other capture. It is *continuity*, not identity. Nobody vouched for
// this key — it was generated locally by this extension and is bound to no
// person, organisation or certificate authority. `operator.name` remains what
// it always was: text somebody typed.
//
// That is still worth having. Before it, two packages from the same
// investigator had nothing linking them beyond a self-typed name that anyone
// could copy. With it, forty captures over eight months carry one verifiable
// thread, and a package claiming to belong to that series but signed by a
// different key is visibly not part of it. Combined with captureChain.js it is
// also what makes a rebuilt package detectable: forging one capture now means
// forging a position in a signed sequence.
//
// The private key is generated non-extractable, so it cannot be read out of
// the browser by this extension or any other — copying it requires copying the
// profile off the machine. Do not "fix" that by making it extractable to back
// it up: a key that can be exported is a key that can be handed to someone
// else, and the continuity claim dies with it. Losing the key on profile loss
// is the intended trade — a new key starts a new chain, visibly.
//
// Signatures are emitted in DER, not WebCrypto's raw r‖s, so a verifier can
// use stock tooling with no conversion step:
//   openssl dgst -sha256 -verify operator-key.pem -signature manifest.sig manifest.json

const DB_NAME = "sharpshooter-legal";
const STORE = "keys";
const KEY_ID = "operator-signing-key";

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGet(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const req = tx.objectStore(STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// CryptoKey objects are structured-cloneable, so the non-extractable private
// key can be persisted in IndexedDB without ever existing as bytes anywhere.
async function loadOrCreateKeyPair() {
    const db = await openDb();
    const existing = await idbGet(db, KEY_ID);
    if (existing?.privateKey && existing?.publicKey) return existing;

    const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false, // non-extractable — see file header
        ["sign", "verify"]
    );
    await idbPut(db, KEY_ID, pair);
    return pair;
}

// ─── DER encoding for the signature and public key ──────────────────────────

// WebCrypto returns ECDSA signatures as raw r‖s (P1363, 64 bytes for P-256).
// openssl expects SEQUENCE { INTEGER r, INTEGER s }. Without this conversion
// every verification attempt with standard tooling fails, which — given how
// much of this feature's value rests on being checkable by someone else — is
// indistinguishable from having no signature at all.
function rawSignatureToDer(raw) {
    const derInt = (bytes) => {
        let i = 0;
        while (i < bytes.length - 1 && bytes[i] === 0) i++; // strip leading zeros
        let v = bytes.slice(i);
        // A leading high bit would read as a negative integer in DER.
        if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
        return new Uint8Array([0x02, v.length, ...v]);
    };
    const r = derInt(raw.slice(0, raw.length / 2));
    const s = derInt(raw.slice(raw.length / 2));
    const body = new Uint8Array([...r, ...s]);
    // P-256 bodies are ~70 bytes, always under the 128-byte short-form limit.
    return new Uint8Array([0x30, body.length, ...body]);
}

function toPem(spkiBytes) {
    let b64 = "";
    const chunk = 0x8000;
    for (let i = 0; i < spkiBytes.length; i += chunk) {
        b64 += String.fromCharCode(...spkiBytes.subarray(i, i + chunk));
    }
    b64 = btoa(b64);
    const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
    return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Returns the installation's public key material, or null if the platform
// refused (private browsing, blocked IndexedDB). Best-effort throughout: a
// capture must never fail because it could not be signed.
export async function getOperatorKeyInfo() {
    try {
        const pair = await loadOrCreateKeyPair();
        const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
        const fp = await crypto.subtle.digest("SHA-256", spki);
        return {
            publicKeyPem: toPem(spki),
            fingerprint: [...new Uint8Array(fp)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        };
    } catch {
        return null;
    }
}

// Signs `bytes` (the frozen manifest.json) and returns a DER signature.
export async function signBytes(bytes) {
    try {
        const pair = await loadOrCreateKeyPair();
        const raw = new Uint8Array(
            await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes)
        );
        return rawSignatureToDer(raw);
    } catch {
        return null;
    }
}
