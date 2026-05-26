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

// Strip every ancillary chunk from a PNG byte stream, keeping only the
// critical ones (IHDR, PLTE, IDAT, IEND). Adobe's ScriptUI Direct2D drawbot
// rejects PNGs that carry sRGB / gAMA / pHYs / iCCP / cHRM with HRESULT
// 0x80070057 (E_INVALIDARG), and Chromium's canvas PNG encoder emits some of
// those by default. CRCs on the kept chunks stay valid because we don't
// modify their bytes.
function stripPngAncillaryChunks(bytes) {
    const KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== sig[i]) return bytes; // not a PNG, leave it
    }
    const out = [bytes.subarray(0, 8)];
    let p = 8;
    while (p < bytes.length) {
        const len =
            (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
        const type = String.fromCharCode(
            bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]
        );
        const end = p + 12 + len;
        if (KEEP.has(type)) out.push(bytes.subarray(p, end));
        p = end;
        if (type === "IEND") break;
    }
    let total = 0;
    for (const part of out) total += part.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const part of out) { merged.set(part, off); off += part.length; }
    return merged;
}

// Re-encode a captured PNG through OffscreenCanvas onto an opaque white
// background. This drops the alpha channel and (after the chunk-strip pass
// below) the color-profile / ancillary chunks (iCCP, gAMA, cHRM, sRGB, pHYs)
// that Chrome's Page.captureScreenshot and the canvas encoder both emit.
// Adobe's ScriptUI Direct2D drawbot rejects such files with HRESULT
// 0x80070057 (E_INVALIDARG), even though full apps like After Effects import
// them fine.
//
// The same canvas pass also produces JPEG output when requested — JPEG has no
// alpha channel, so it is inherently opaque.
async function reencode(base64, { type = "image/png", quality } = {}) {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const opts = quality != null ? { type, quality } : { type };
    const outBlob = await canvas.convertToBlob(opts);
    let outBytes = new Uint8Array(await outBlob.arrayBuffer());
    if (type === "image/png") outBytes = stripPngAncillaryChunks(outBytes);
    return base64FromBytes(outBytes);
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
