// RFC 3161 timestamp client. Hand-rolled minimal DER encoder for a
// fixed-shape TimeStampReq — no ASN.1/crypto library dependency exists in
// this repo (no build step to pull one in), and the request shape needed
// here is small and fixed, so a general-purpose ASN.1 library isn't needed
// to *build* the request.
//
// We deliberately do NOT attempt to validate the TSA's *signature* ourselves
// — that would require a full CMS SignedData parser and an X.509 chain
// validator, which is a large undertaking to hand-roll and, worse, would
// mean the report is only as trustworthy as our own from-scratch validator.
// Instead the raw response token is saved untouched (capture.tsr) so anyone
// can independently verify it with a standard tool:
//   openssl ts -reply -in capture.tsr -text
//
// We DO, however, verify the unsigned parts we can check cheaply and that
// matter most for not silently trusting a broken/wrong response: that the
// response's messageImprint hash equals the hash we actually sent, and that
// its nonce echoes ours. Skipping this would mean a truncated, corrupted, or
// mismatched TSA response gets saved and reported as a successful timestamp
// with no indication anything was wrong.
//
// Queried against two independent public authorities (see TSA_PROVIDERS)
// rather than one, so the capture isn't sealed by a single third party's
// availability or trustworthiness — an evidentiary "second witness".
// A best-effort scan for the embedded GeneralizedTime is done purely to show
// a human-readable date in the report — if that scan fails, the report says
// so explicitly rather than showing a fabricated value.

import { concatBytes } from "../binary.js";

// All three over HTTPS: RFC 3161 responses are signed so transport-level
// tampering can't forge a token, but HTTPS still stops a network attacker
// from *observing or corrupting* the exchange before signature verification,
// and avoids "was this even the real request/response" questions in court
// that a plain-HTTP transcript would invite. Three independent authorities
// (rather than two) means the capture survives any single authority being
// unavailable, compromised, or later distrusted, and gives a stronger
// evidentiary "multiple witness" story.
export const TSA_PROVIDERS = [
    { name: "FreeTSA", url: "https://freetsa.org/tsr" },
    { name: "DigiCert", url: "https://timestamp.digicert.com" },
    { name: "Sectigo", url: "https://timestamp.sectigo.com" },
];
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
// Returns both the request bytes and the raw nonce we embedded, so the
// caller can check the response actually echoes it back.
function buildTimeStampReq(hashBytes) {
    const hashAlgorithm = derSequence([derOid(SHA256_OID), derNull()]);
    const messageImprint = derSequence([hashAlgorithm, derOctetString(hashBytes)]);
    const nonceBytes = crypto.getRandomValues(new Uint8Array(8));
    const nonce = derInteger(nonceBytes);
    const reqBytes = derSequence([derSmallInt(1), messageImprint, nonce, derBoolean(true)]);
    return { reqBytes, nonceBytes };
}

// ─── Minimal generic DER walker ────────────────────────────────────────────
// Not a general CMS/ASN.1 parser/validator — just enough structural reading
// to (a) locate the TSTInfo the TSA's SignedData wraps, and (b) pull out its
// messageImprint hash + nonce so we can check the response actually answers
// *our* request before trusting it, without hand-rolling a CMS SignedData
// parser or X.509 chain validator (see file header).

function parseLength(bytes, pos) {
    const first = bytes[pos];
    if ((first & 0x80) === 0) return { length: first, next: pos + 1 };
    const numBytes = first & 0x7f;
    let length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | bytes[pos + 1 + i];
    return { length, next: pos + 1 + numBytes };
}

function readTLV(bytes, pos, end) {
    const tag = bytes[pos];
    const { length, next } = parseLength(bytes, pos + 1);
    const contentStart = next;
    const contentEnd = contentStart + length;
    if (length < 0 || contentEnd > end) throw new Error("malformed/truncated DER TLV");
    return { tag, contentStart, contentEnd, next: contentEnd };
}

// Collects every OCTET STRING's content anywhere in the tree, descending
// into constructed types (SEQUENCE, SET, and EXPLICIT context tags like the
// [0] wrapper CMS uses for SignedData/eContent) so nested OCTET STRINGs
// (e.g. eContent, which itself contains the DER-encoded TSTInfo) are found.
function collectOctetStrings(bytes, start, end, acc) {
    let pos = start;
    while (pos < end) {
        let tlv;
        try {
            tlv = readTLV(bytes, pos, end);
        } catch {
            break;
        }
        if (tlv.tag === 0x04) acc.push(bytes.slice(tlv.contentStart, tlv.contentEnd));
        if (tlv.tag & 0x20) collectOctetStrings(bytes, tlv.contentStart, tlv.contentEnd, acc);
        pos = tlv.next;
    }
    return acc;
}

// GeneralizedTime is "YYYYMMDDHHMMSSZ" ASCII.
function decodeGeneralizedTime(bytes) {
    const s = new TextDecoder().decode(bytes);
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/.exec(s);
    if (!m) return null;
    const [, y, mo, d, h, mi, se] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
}

// Attempts to parse `bytes` as a TSTInfo SEQUENCE's raw content:
//   TSTInfo ::= SEQUENCE { version INTEGER, policy OBJECT IDENTIFIER,
//     messageImprint MessageImprint, serialNumber INTEGER,
//     genTime GeneralizedTime, accuracy/ordering/nonce/tsa/extensions OPTIONAL }
//   MessageImprint ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING }
// Returns null (rather than throwing) if `bytes` doesn't match this exact
// tag sequence — used to distinguish the real TSTInfo from the other OCTET
// STRINGs (signatures, certificate fields, etc.) also present in the CMS
// SignedData wrapper.
function tryParseTstInfo(bytes) {
    if (bytes.length === 0 || bytes[0] !== 0x30) return null;
    try {
        const outer = readTLV(bytes, 0, bytes.length);
        const end = outer.contentEnd;
        let pos = outer.contentStart;

        const version = readTLV(bytes, pos, end);
        if (version.tag !== 0x02) return null;
        pos = version.next;

        const policy = readTLV(bytes, pos, end);
        if (policy.tag !== 0x06) return null;
        pos = policy.next;

        const messageImprint = readTLV(bytes, pos, end);
        if (messageImprint.tag !== 0x30) return null;
        pos = messageImprint.next;

        const algId = readTLV(bytes, messageImprint.contentStart, messageImprint.contentEnd);
        if (algId.tag !== 0x30) return null;
        const hashedMessageTlv = readTLV(bytes, algId.next, messageImprint.contentEnd);
        if (hashedMessageTlv.tag !== 0x04) return null;
        const hashedMessage = bytes.slice(hashedMessageTlv.contentStart, hashedMessageTlv.contentEnd);

        const serialNumber = readTLV(bytes, pos, end);
        if (serialNumber.tag !== 0x02) return null;
        pos = serialNumber.next;

        const genTimeTlv = readTLV(bytes, pos, end);
        if (genTimeTlv.tag !== 0x18) return null;
        const genTime = decodeGeneralizedTime(bytes.slice(genTimeTlv.contentStart, genTimeTlv.contentEnd));
        pos = genTimeTlv.next;

        // Remaining optional fields: accuracy (SEQUENCE), ordering (BOOLEAN),
        // nonce (INTEGER), tsa ([0]), extensions ([1]) — in that relative
        // order but each independently optional. The nonce is the only plain
        // top-level INTEGER left, so the first INTEGER tag found here is it.
        let nonce = null;
        while (pos < end) {
            const tlv = readTLV(bytes, pos, end);
            if (tlv.tag === 0x02) {
                nonce = bytes.slice(tlv.contentStart, tlv.contentEnd);
                break;
            }
            pos = tlv.next;
        }

        return { hashedMessage, nonce, genTime };
    } catch {
        return null;
    }
}

// Finds and parses the TSTInfo embedded in a TimeStampResp by trying every
// OCTET STRING in the response as a candidate — the real one is the only
// one whose content happens to decode as a well-formed TSTInfo.
function findTstInfo(respBytes) {
    for (const candidate of collectOctetStrings(respBytes, 0, respBytes.length, [])) {
        const parsed = tryParseTstInfo(candidate);
        if (parsed) return parsed;
    }
    return null;
}

function bytesToBigInt(bytes) {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n;
}

function stripLeadingZero(bytes) {
    return bytes.length > 1 && bytes[0] === 0 ? bytes.slice(1) : bytes;
}

function hex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Requests an RFC 3161 timestamp over `hashBytes` (expected: SHA-256 digest)
// from `provider` (default: the first of TSA_PROVIDERS). Verifies — not just
// parses — that the response's messageImprint hash matches what we sent and
// (when the TSA echoes one back) that the nonce matches, throwing if either
// check fails rather than silently saving/trusting an unrelated or corrupted
// token. Returns the raw response bytes (to be saved as e.g. capture.tsr)
// plus a best-effort human-readable time and which checks passed.
export async function requestTimestamp(hashBytes, provider = TSA_PROVIDERS[0]) {
    const { reqBytes, nonceBytes } = buildTimeStampReq(hashBytes);
    const localTimeBeforeSend = new Date();

    const res = await fetch(provider.url, {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query" },
        body: reqBytes,
    });
    if (!res.ok) {
        throw new Error(`${provider.name} returned HTTP ${res.status}`);
    }
    const respBytes = new Uint8Array(await res.arrayBuffer());

    const tstInfo = findTstInfo(respBytes);
    if (!tstInfo) {
        throw new Error(
            `${provider.name}: could not locate a well-formed TSTInfo in the response — refusing to trust an unverifiable token`
        );
    }

    const expectedHash = hex(hashBytes);
    const gotHash = hex(tstInfo.hashedMessage);
    if (gotHash !== expectedHash) {
        throw new Error(
            `${provider.name}: response messageImprint (${gotHash.slice(0, 16)}…) does not match the hash we sent (${expectedHash.slice(0, 16)}…) — this response does not correspond to our request`
        );
    }

    let nonceVerified = false;
    if (tstInfo.nonce) {
        const sent = bytesToBigInt(stripLeadingZero(nonceBytes));
        const got = bytesToBigInt(stripLeadingZero(tstInfo.nonce));
        if (sent !== got) {
            throw new Error(`${provider.name}: response nonce does not match the nonce we sent — possible replay or mismatched response`);
        }
        nonceVerified = true;
    }
    // RFC 3161 nonce echo is a SHOULD, not a MUST — a TSA that omits it
    // isn't necessarily invalid, but the hash check above still applies.

    // Clock-skew check: how far this machine's own clock was from an
    // independent authority's clock at capture time. This isn't a
    // correctness check on the token itself (the token is valid regardless),
    // but recording it preempts a "the local clock was manipulated" dispute
    // — three independent authorities' skew readings can be cross-compared
    // against each other and against the local clock.
    let clockSkewSeconds = null;
    if (tstInfo.genTime) {
        const genTimeMs = Date.parse(tstInfo.genTime);
        if (!Number.isNaN(genTimeMs)) {
            clockSkewSeconds = (localTimeBeforeSend.getTime() - genTimeMs) / 1000;
        }
    }

    return {
        tsrBytes: respBytes,
        genTime: tstInfo.genTime,
        tsaUrl: provider.url,
        tsaName: provider.name,
        hashVerified: true,
        nonceVerified,
        clockSkewSeconds,
    };
}
