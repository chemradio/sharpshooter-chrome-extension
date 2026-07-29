// Shared binary helpers used across the screenshot/crop/legal-capture
// pipelines. Chunked base64 encode/decode and CRC32 (needed by the WACZ
// zip writer) live here instead of being copy-pasted per call site.

const CHUNK = 0x8000;

// Chunked btoa — large byte arrays overflow String.fromCharCode(...bytes)
// (argument-count limit) otherwise.
export function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

// Base64 (optionally already a data: URL) → Blob, via fetch() rather than
// atob() — atob chokes on multi-MB strings on some Chromium builds.
export async function base64ToBlob(base64, mime = "image/png") {
    const dataUrl = base64.startsWith("data:")
        ? base64
        : `data:${mime};base64,${base64}`;
    const res = await fetch(dataUrl);
    return res.blob();
}

// Base64 → Uint8Array via atob's char-code loop (no spread operator, so no
// call-stack/argument-count overflow the way bytesToBase64's inverse would
// have) — safe for the multi-MB response bodies WARC recording can produce.
export function base64ToBytes(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// Concatenate a list of Uint8Array/string chunks (strings are UTF-8 encoded)
// into one Uint8Array. Used by the WARC record writer and the ZIP writer,
// both of which build up a file from many small pieces.
export function concatBytes(chunks) {
    const encoder = new TextEncoder();
    const parts = chunks.map((c) => (typeof c === "string" ? encoder.encode(c) : c));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export async function sha256Bytes(bytes) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(bytes) {
    const digest = await sha256Bytes(bytes);
    return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let crcTable = null;
function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        crcTable[n] = c >>> 0;
    }
    return crcTable;
}

// Standard CRC-32 (ZIP/PNG polynomial) over a byte array. Needed for ZIP
// local-file-header / central-directory entries in support/legalCapture/zipWriter.js.
export function crc32(bytes) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
