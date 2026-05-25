import { handoffToCropEditor } from "./cropHandoff.js";

const CHUNK = 0x8000;

// Chunked btoa — large canvases overflow String.fromCharCode otherwise.
function base64FromBytes(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

// CRC-32 (IEEE 802.3) — required for PNG chunk CRC fields.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function u32be(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function pngChunk(type, data) {
    const typeBytes = new Uint8Array([
        type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3),
    ]);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    out.set(u32be(data.length), 0);
    out.set(typeBytes, 4);
    out.set(data, 8);
    out.set(u32be(crc32(crcInput)), 8 + data.length);
    return out;
}

// Build a minimal PNG from raw RGBA pixels: color type 2 (RGB, no alpha),
// 8-bit, no interlace, filter type 0 on every scanline, no ancillary chunks.
// This is the most defensive shape we can produce for Adobe's ScriptUI
// Direct2D drawbot, which rejects almost everything else (sRGB/gAMA/pHYs
// chunks, RGBA color type, mixed filter types) with HRESULT 0x80070057.
async function encodeMinimalPng(rgba, width, height) {
    // Drop alpha + prepend filter byte 0 per scanline.
    const stride = width * 3;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const dst = y * (stride + 1);
        raw[dst] = 0; // filter: None
        const srcRow = y * width * 4;
        for (let x = 0; x < width; x++) {
            const s = srcRow + x * 4;
            const d = dst + 1 + x * 3;
            raw[d] = rgba[s];
            raw[d + 1] = rgba[s + 1];
            raw[d + 2] = rgba[s + 2];
        }
    }

    const cs = new CompressionStream("deflate");
    const compressedBlob = await new Response(new Blob([raw]).stream().pipeThrough(cs)).blob();
    const idatData = new Uint8Array(await compressedBlob.arrayBuffer());

    const ihdr = new Uint8Array(13);
    ihdr.set(u32be(width), 0);
    ihdr.set(u32be(height), 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // color type: RGB
    ihdr[10] = 0;  // compression
    ihdr[11] = 0;  // filter
    ihdr[12] = 0;  // interlace

    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrChunk = pngChunk("IHDR", ihdr);
    const idatChunk = pngChunk("IDAT", idatData);
    const iendChunk = pngChunk("IEND", new Uint8Array(0));

    const out = new Uint8Array(
        sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length
    );
    let off = 0;
    for (const part of [sig, ihdrChunk, idatChunk, iendChunk]) {
        out.set(part, off);
        off += part.length;
    }
    return out;
}

// Re-encode a captured PNG through OffscreenCanvas onto an opaque white
// background. For PNG output, the canvas pixels are then hand-encoded into a
// minimal RGB PNG (see encodeMinimalPng) so Adobe's ScriptUI Direct2D drawbot
// will accept the file. For JPEG, canvas convertToBlob is fine — JPEG has no
// alpha and no ancillary-chunk problems.
async function reencode(base64, { type = "image/png", quality } = {}) {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    if (type === "image/png") {
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pngBytes = await encodeMinimalPng(data, width, height);
        return base64FromBytes(pngBytes);
    }

    const opts = quality != null ? { type, quality } : { type };
    const outBlob = await canvas.convertToBlob(opts);
    return base64FromBytes(new Uint8Array(await outBlob.arrayBuffer()));
}

export const downloadScreenshot = async (base64Data, screenshotName, options = {}) => {
    if (!base64Data) {
        throw new Error("Empty screenshot data");
    }

    // Settings (all from the popup's Settings panel). Defaults match a fresh
    // install: opaque re-encode ON, PNG output, save dialog shown, no prefix.
    const {
        reencodeOpaquePng,
        filenamePrefix,
        outputFormat,
        jpegQuality,
        skipSaveDialog,
    } = await chrome.storage.local.get([
        "reencodeOpaquePng",
        "filenamePrefix",
        "outputFormat",
        "jpegQuality",
        "skipSaveDialog",
    ]);

    const prefix = (filenamePrefix || "").trim();
    const baseName = prefix ? `${prefix}-${screenshotName}` : screenshotName;

    // Manual-crop branch: hand the encoded PNG to the crop editor instead of
    // triggering a download. The editor runs its own download on confirm and
    // applies output format / quality / save-dialog settings itself; on cancel,
    // nothing leaves the browser. Opaque re-encode is applied here so the
    // editor's source bitmap is already flattened.
    if (options.manualCrop) {
        let data = base64Data;
        try {
            if (reencodeOpaquePng !== false) data = await reencode(base64Data);
        } catch (e) {
            console.warn("opaque PNG re-encode failed, using original:", e);
        }
        await handoffToCropEditor(data, `${baseName}.png`);
        return null;
    }

    const jpeg = outputFormat === "jpeg";
    let data = base64Data;
    let mime = "image/png";
    let ext = "png";
    try {
        if (jpeg) {
            data = await reencode(base64Data, {
                type: "image/jpeg",
                quality: typeof jpegQuality === "number" ? jpegQuality : 0.92,
            });
            mime = "image/jpeg";
            ext = "jpg";
        } else if (reencodeOpaquePng !== false) {
            data = await reencode(base64Data);
        }
    } catch (e) {
        // Re-encode is a compatibility nicety — never fail the download over it.
        console.warn("output re-encode failed, using original PNG:", e);
        data = base64Data;
        mime = "image/png";
        ext = "png";
    }

    return new Promise((resolve, reject) => {
        chrome.downloads.download(
            {
                url: `data:${mime};base64,` + data,
                filename: `${baseName}.${ext}`,
                saveAs: skipSaveDialog !== true,
            },
            (downloadId) => {
                const err = chrome.runtime.lastError;
                if (err) return reject(new Error(err.message));
                if (downloadId == null) {
                    return reject(new Error("Download did not start"));
                }
                resolve(downloadId);
            }
        );
    });
};
