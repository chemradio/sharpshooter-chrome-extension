// RFC 3161 timestamp client. Hand-rolled minimal DER encoder for a
// fixed-shape TimeStampReq — no ASN.1/crypto library dependency exists in
// this repo (no build step to pull one in), and the request shape needed
// here is small and fixed, so a general-purpose ASN.1 library isn't needed
// to *build* the request.
//
// We deliberately do NOT attempt to validate the TSA's signature ourselves —
// that would require a full CMS SignedData parser and an X.509 chain
// validator, which is a large undertaking to hand-roll and, worse, would
// mean the report is only as trustworthy as our own from-scratch validator.
// Instead the raw response token is saved untouched (capture.tsr) so anyone
// can independently verify it with a standard tool:
//   openssl ts -reply -in capture.tsr -text
// A best-effort scan for the embedded GeneralizedTime is done purely to show
// a human-readable date in the report — if that scan fails, the report says
// so explicitly rather than showing a fabricated value.

import { concatBytes } from "../binary.js";

const TSA_URL = "https://freetsa.org/tsr";
const SHA256_OID = "2.16.840.1.101.3.4.2.1";

// ─── Minimal DER encoder ────────────────────────────────────────────────────

function derLength(len) {
    if (len < 0x80) return new Uint8Array([len]);
    const bytes = [];
    let n = len;
    while (n > 0) {
        bytes.unshift(n & 0xff);
        n = Math.floor(n / 256);
    }
    return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derTLV(tag, content) {
    return concatBytes([new Uint8Array([tag]), derLength(content.length), content]);
}

function derInteger(magnitudeBytes) {
    let b = magnitudeBytes;
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && (b[i + 1] & 0x80) === 0) i++;
    b = b.slice(i);
    if (b[0] & 0x80) b = concatBytes([new Uint8Array([0]), b]);
    return derTLV(0x02, b);
}

function derSmallInt(n) {
    const bytes = [];
    let v = n;
    if (v === 0) bytes.push(0);
    while (v > 0) {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
    }
    return derInteger(new Uint8Array(bytes));
}

function derOid(dotted) {
    const parts = dotted.split(".").map(Number);
    const bytesArr = [parts[0] * 40 + parts[1]];
    for (const part of parts.slice(2)) {
        if (part === 0) {
            bytesArr.push(0);
            continue;
        }
        const chunks = [];
        let v = part;
        while (v > 0) {
            chunks.unshift(v & 0x7f);
            v = Math.floor(v / 128);
        }
        for (let i = 0; i < chunks.length - 1; i++) chunks[i] |= 0x80;
        bytesArr.push(...chunks);
    }
    return derTLV(0x06, new Uint8Array(bytesArr));
}

const derNull = () => derTLV(0x05, new Uint8Array(0));
const derOctetString = (bytes) => derTLV(0x04, bytes);
const derSequence = (children) => derTLV(0x30, concatBytes(children));
const derBoolean = (value) => derTLV(0x01, new Uint8Array([value ? 0xff : 0x00]));

// TimeStampReq ::= SEQUENCE { version, messageImprint, nonce OPTIONAL,
//                             certReq DEFAULT FALSE }
// (reqPolicy is omitted — OPTIONAL fields with distinct universal tags from
// what follows don't need explicit tagging to be unambiguous.)
function buildTimeStampReq(hashBytes) {
    const hashAlgorithm = derSequence([derOid(SHA256_OID), derNull()]);
    const messageImprint = derSequence([hashAlgorithm, derOctetString(hashBytes)]);
    const nonce = derInteger(crypto.getRandomValues(new Uint8Array(8)));
    return derSequence([derSmallInt(1), messageImprint, nonce, derBoolean(true)]);
}

// ─── Minimal generic DER walker (best-effort genTime extraction only) ─────

function parseLength(bytes, pos) {
    const first = bytes[pos];
    if ((first & 0x80) === 0) return { length: first, next: pos + 1 };
    const numBytes = first & 0x7f;
    let length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | bytes[pos + 1 + i];
    return { length, next: pos + 1 + numBytes };
}

// Recursively scans every TLV (descending into constructed types) looking
// for the first primitive value tagged `targetTag`. Used only to find the
// GeneralizedTime (0x18) TSTInfo embeds — not a general CMS/ASN.1 parser.
//
// Also descends into OCTET STRING (0x04) content, even though it's a
// primitive type: CMS's SignedData wraps the actual TSTInfo (which is what
// carries genTime) inside encapContentInfo's `eContent`, itself an OCTET
// STRING — so the DER we actually want is "opaque" bytes from a generic
// BER/DER point of view. We only follow that path if the content plausibly
// looks like another TLV (starts with a SEQUENCE tag); a real opaque binary
// blob (e.g. a hash or signature) essentially never happens to do that.
function findFirstTag(bytes, targetTag, start = 0, end = bytes.length) {
    let pos = start;
    while (pos < end) {
        const tag = bytes[pos];
        const { length, next } = parseLength(bytes, pos + 1);
        const contentStart = next;
        const contentEnd = contentStart + length;
        if (contentEnd > end || length < 0) break; // malformed / truncated, stop
        if (tag === targetTag) return bytes.slice(contentStart, contentEnd);
        const looksLikeNestedSequence = tag === 0x04 && bytes[contentStart] === 0x30;
        if ((tag & 0x20) || looksLikeNestedSequence) {
            const found = findFirstTag(bytes, targetTag, contentStart, contentEnd);
            if (found) return found;
        }
        pos = contentEnd;
    }
    return null;
}

// GeneralizedTime is "YYYYMMDDHHMMSSZ" ASCII.
function decodeGeneralizedTime(bytes) {
    const s = new TextDecoder().decode(bytes);
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/.exec(s);
    if (!m) return null;
    const [, y, mo, d, h, mi, se] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Requests an RFC 3161 timestamp over `hashBytes` (expected: SHA-256 digest
// of the WACZ archive) from the public FreeTSA authority. Returns the raw
// response bytes (to be saved as capture.tsr) plus a best-effort human-
// readable time, which may be null if the embedded GeneralizedTime couldn't
// be located.
export async function requestTimestamp(hashBytes) {
    const reqBytes = buildTimeStampReq(hashBytes);

    const res = await fetch(TSA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query" },
        body: reqBytes,
    });
    if (!res.ok) {
        throw new Error(`Timestamp authority returned HTTP ${res.status}`);
    }
    const respBytes = new Uint8Array(await res.arrayBuffer());

    let genTime = null;
    try {
        const genTimeBytes = findFirstTag(respBytes, 0x18);
        if (genTimeBytes) genTime = decodeGeneralizedTime(genTimeBytes);
    } catch {
        genTime = null; // best-effort only — never fail the capture over this
    }

    return { tsrBytes: respBytes, genTime, tsaUrl: TSA_URL };
}
