// Hand-rolled WARC/1.0 (ISO 28500) writer. No third-party library — this
// repo has no build step or npm dependency mechanism, so the record format
// is written directly from the spec.
//
// Each recorded network exchange (support/legalCapture/networkRecorder.js)
// becomes a `request` record and a `response` record, linked via
// WARC-Concurrent-To. A single `warcinfo` record leads the file.
//
// Alongside the WARC bytes, buildWarc() returns an `index` of the byte
// offset/length of each `response` record — support/legalCapture/zipWriter.js
// uses that to build the CDXJ index ReplayWeb.page needs to locate records
// inside the (uncompressed, STORE-method) WARC without re-parsing it.

import { base64ToBytes, concatBytes, sha256Hex } from "../binary.js";

const CRLF = "\r\n";

function warcDate(date = new Date()) {
    return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function uuid() {
    return `urn:uuid:${crypto.randomUUID()}`;
}

async function buildRecord(type, extraHeaders, block) {
    const digest = await sha256Hex(block);
    const headerLines = [
        "WARC/1.0",
        `WARC-Type: ${type}`,
        `WARC-Record-ID: ${uuid()}`,
        `WARC-Date: ${warcDate()}`,
        `Content-Length: ${block.length}`,
        `WARC-Payload-Digest: sha256:${digest}`,
        ...extraHeaders,
    ];
    const head = headerLines.join(CRLF) + CRLF + CRLF;
    const bytes = concatBytes([head, block, CRLF, CRLF]);
    return { bytes, digest };
}

function headerBlock(headers) {
    return Object.entries(headers ?? {})
        .map(([name, value]) => `${name}: ${value}`)
        .join(CRLF);
}

function requestLine(exchange) {
    let path = exchange.url;
    try {
        const u = new URL(exchange.url);
        path = u.pathname + u.search;
    } catch { /* keep full URL if it doesn't parse */ }
    return `${exchange.method} ${path} HTTP/1.1`;
}

function statusLine(response) {
    return `HTTP/1.1 ${response.status} ${response.statusText || ""}`.trimEnd();
}

async function buildWarcinfo(captureMeta) {
    const body = concatBytes([
        `software: Sharpshooter Legal Capture`, CRLF,
        `format: WARC File Format 1.0`, CRLF,
        `target-uri: ${captureMeta.url}`, CRLF,
        `capture-started: ${captureMeta.startedAt}`, CRLF,
    ]);
    return buildRecord("warcinfo", ["Content-Type: application/warc-fields"], body);
}

async function buildRequestRecord(exchange, concurrentId) {
    const block = concatBytes([
        requestLine(exchange) + CRLF,
        headerBlock(exchange.requestHeaders) + CRLF + CRLF,
        exchange.requestPostData ?? "",
    ]);
    return buildRecord(
        "request",
        [
            `WARC-Target-URI: ${exchange.url}`,
            `WARC-Concurrent-To: ${concurrentId}`,
            "Content-Type: application/http;msgtype=request",
        ],
        block
    );
}

async function buildResponseRecord(exchange, concurrentId) {
    const bodyBytes = exchange.body?.data
        ? exchange.body.base64Encoded
            ? base64ToBytes(exchange.body.data)
            : new TextEncoder().encode(exchange.body.data)
        : new Uint8Array(0);
    const block = concatBytes([
        statusLine(exchange.response) + CRLF,
        headerBlock(exchange.response.headers) + CRLF + CRLF,
        bodyBytes,
    ]);
    return buildRecord(
        "response",
        [
            `WARC-Target-URI: ${exchange.url}`,
            `WARC-Concurrent-To: ${concurrentId}`,
            "Content-Type: application/http;msgtype=response",
        ],
        block
    );
}

// Builds the full WARC file (as one Uint8Array) from the recorded exchanges,
// plus a CDXJ-ready index of each response record's location within it.
// `captureMeta` = {url, startedAt} (ISO string).
export async function buildWarc(exchanges, captureMeta) {
    const parts = [];
    const index = [];
    let offset = 0;

    const push = (bytes) => {
        parts.push(bytes);
        offset += bytes.length;
    };

    const { bytes: infoBytes } = await buildWarcinfo(captureMeta);
    push(infoBytes);

    for (const exchange of exchanges) {
        if (!exchange.url || !exchange.method) continue; // incomplete record, skip

        const pairId = uuid();
        const { bytes: reqBytes } = await buildRequestRecord(exchange, pairId);
        push(reqBytes);

        if (exchange.response) {
            const respOffset = offset;
            const { bytes: respBytes, digest } = await buildResponseRecord(exchange, pairId);
            push(respBytes);
            index.push({
                url: exchange.url,
                status: exchange.response.status,
                mime: exchange.response.mimeType || "application/octet-stream",
                digest: `sha256:${digest}`,
                timestampSeconds: exchange.wallTime ?? captureMeta.startedAtSeconds,
                offset: respOffset,
                length: respBytes.length,
            });
        }
    }

    return { bytes: concatBytes(parts), index };
}
