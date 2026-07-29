// Minimal ZIP writer (compression method 0 = STORE, no DEFLATE needed) plus
// the WACZ-specific pieces (CDXJ index, pages.jsonl, datapackage.json) built
// on top of it. Hand-rolled — no npm/bundler in this repo, and STORE-method
// ZIP is simple enough to write directly from the format spec without a
// library. The result opens in any standard zip tool and in ReplayWeb.page.

import { concatBytes, crc32 } from "../binary.js";

const LOCAL_FILE_SIG = 0x04034b50;
const CENTRAL_FILE_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;

function u16(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
function u32(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function dosDateTime(date) {
    const year = Math.max(0, date.getFullYear() - 1980);
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, dosDate };
}

// entries: [{ name: string, data: Uint8Array }]
export function buildZip(entries) {
    const now = dosDateTime(new Date());
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBytes = new TextEncoder().encode(name);
        const crc = crc32(data);

        const localHeader = concatBytes([
            u32(LOCAL_FILE_SIG),
            u16(20),          // version needed
            u16(0),           // general purpose flag
            u16(0),           // compression method: store
            u16(now.time),
            u16(now.dosDate),
            u32(crc),
            u32(data.length),  // compressed size
            u32(data.length),  // uncompressed size
            u16(nameBytes.length),
            u16(0),            // extra field length
            nameBytes,
        ]);
        const localEntry = concatBytes([localHeader, data]);
        localParts.push(localEntry);

        const centralHeader = concatBytes([
            u32(CENTRAL_FILE_SIG),
            u16(20),           // version made by
            u16(20),           // version needed
            u16(0),            // flags
            u16(0),            // compression method
            u16(now.time),
            u16(now.dosDate),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(nameBytes.length),
            u16(0),            // extra field length
            u16(0),            // comment length
            u16(0),            // disk number start
            u16(0),            // internal attrs
            u32(0),            // external attrs
            u32(offset),       // offset of local header
            nameBytes,
        ]);
        centralParts.push(centralHeader);

        offset += localEntry.length;
    }

    const centralDirectory = concatBytes(centralParts);
    const centralStart = offset;

    const endRecord = concatBytes([
        u32(END_OF_CENTRAL_SIG),
        u16(0), u16(0),                  // disk numbers
        u16(entries.length),             // entries on this disk
        u16(entries.length),             // total entries
        u32(centralDirectory.length),
        u32(centralStart),
        u16(0),                          // comment length
    ]);

    return concatBytes([...localParts, centralDirectory, endRecord]);
}

// ─── WACZ-specific pieces ───────────────────────────────────────────────────

// Simplified SURT (Sort-friendly URI Reordering Transform): reverses the
// hostname's labels so entries for the same site sort together. Not a full
// implementation of the SURT spec (no scheme/port canonicalization edge
// cases) — sufficient for a single-page-capture index of a handful of URLs.
function surt(urlStr) {
    try {
        const u = new URL(urlStr);
        const host = u.hostname.split(".").reverse().join(",");
        return `${host})${u.pathname}${u.search}`;
    } catch {
        return urlStr;
    }
}

function timestamp14(seconds) {
    const d = seconds ? new Date(seconds * 1000) : new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
        d.getUTCFullYear().toString() +
        pad(d.getUTCMonth() + 1) +
        pad(d.getUTCDate()) +
        pad(d.getUTCHours()) +
        pad(d.getUTCMinutes()) +
        pad(d.getUTCSeconds())
    );
}

// One CDXJ line per WARC response record: `<surt> <ts14> {json}`.
export function buildCdxj(index, warcFilename) {
    const lines = index.map((entry) => {
        const ts = timestamp14(entry.timestampSeconds);
        const json = JSON.stringify({
            url: entry.url,
            mime: entry.mime,
            status: String(entry.status),
            digest: entry.digest,
            length: String(entry.length),
            offset: String(entry.offset),
            filename: warcFilename,
        });
        return `${surt(entry.url)} ${ts} ${json}`;
    });
    return lines.join("\n") + (lines.length ? "\n" : "");
}

export function buildPagesJsonl(url, startedAt) {
    const header = JSON.stringify({ format: "json-pages-1.0", id: "pages", title: "Pages" });
    const page = JSON.stringify({
        id: crypto.randomUUID(),
        url,
        ts: startedAt,
        title: url,
    });
    return `${header}\n${page}\n`;
}

export function buildDatapackage({ url, startedAt, warcFilename, sha256 }) {
    return JSON.stringify(
        {
            profile: "data-package",
            wacz_version: "1.1.1",
            software: "Sharpshooter Legal Capture",
            created: startedAt,
            title: url,
            resources: [
                {
                    name: warcFilename,
                    path: `archive/${warcFilename}`,
                    hash: `sha256:${sha256}`,
                },
            ],
        },
        null,
        2
    );
}

// Assembles the full .wacz (itself a ZIP) from the WARC bytes + its CDXJ
// index, following the standard archive/ + indexes/ + pages/ + datapackage.json
// layout ReplayWeb.page expects.
export async function buildWacz({ warcBytes, index, url, startedAt, warcSha256 }) {
    const warcFilename = "data.warc";
    const encoder = new TextEncoder();

    const entries = [
        { name: `archive/${warcFilename}`, data: warcBytes },
        { name: "indexes/index.cdxj", data: encoder.encode(buildCdxj(index, warcFilename)) },
        { name: "pages/pages.jsonl", data: encoder.encode(buildPagesJsonl(url, startedAt)) },
        {
            name: "datapackage.json",
            data: encoder.encode(buildDatapackage({ url, startedAt, warcFilename, sha256: warcSha256 })),
        },
    ];

    return buildZip(entries);
}
