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

// Re-encode a PNG through OffscreenCanvas onto an opaque white background.
// This drops the alpha channel and the color-profile / ancillary chunks
// (iCCP, gAMA, cHRM, sRGB) that Chrome's Page.captureScreenshot emits.
// Adobe's ScriptUI Direct2D drawbot rejects such files with
// HRESULT 0x80070057 (E_INVALIDARG), even though full apps like After
// Effects import them fine. Off by default — opt in from the expert menu.
async function reencodeOpaque(base64) {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return base64FromBytes(new Uint8Array(await outBlob.arrayBuffer()));
}

export const downloadScreenshot = async (base64Data, screenshotName, options = {}) => {
    if (!base64Data) {
        throw new Error("Empty screenshot data");
    }

    let data = base64Data;
    try {
        const { reencodeOpaquePng } =
            await chrome.storage.local.get("reencodeOpaquePng");
        if (reencodeOpaquePng) data = await reencodeOpaque(base64Data);
    } catch (e) {
        // Re-encode is a compatibility nicety — never fail the download over it.
        console.warn("opaque PNG re-encode failed, using original:", e);
    }

    // Manual-crop branch: hand the encoded bytes to the crop editor instead
    // of triggering a download. The editor will run its own download on
    // confirm; on cancel, nothing leaves the browser.
    if (options.manualCrop) {
        await handoffToCropEditor(data, `${screenshotName}.png`);
        return null;
    }

    return new Promise((resolve, reject) => {
        chrome.downloads.download(
            {
                url: "data:image/png;base64," + data,
                filename: screenshotName + ".png",
                saveAs: true,
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
