// Service-worker side of the SVG → PNG converter.
//
// An MV3 service worker has no DOM and createImageBitmap() refuses
// image/svg+xml blobs, so an SVG can't be rasterized here. This module
// spins up offscreen/svgRaster.html on demand, hands it the SVG source,
// and gets PNG bytes back (alpha preserved — see that file).
//
// The offscreen document is closed once the last in-flight rasterization
// finishes: an open offscreen document keeps the service worker alive, and
// image extraction is a rare, bursty operation.

const OFFSCREEN_PATH = "offscreen/svgRaster.html";

let creating  = null;  // in-flight createDocument(), shared by concurrent callers
let inFlight  = 0;     // active rasterize calls, so we only close when idle

async function ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) return;
    if (!creating) {
        creating = chrome.offscreen
            .createDocument({
                url: OFFSCREEN_PATH,
                reasons: ["DOM_PARSER"],
                justification:
                    "Rasterize extracted SVG images to PNG using an <img> element and canvas, "
                    + "which are unavailable in a service worker.",
            })
            .catch(async (error) => {
                // Lost a race with another caller — a document now exists, which
                // is exactly what we wanted. Anything else is a real failure.
                if (await chrome.offscreen.hasDocument()) return;
                throw error;
            })
            .finally(() => { creating = null; });
    }
    await creating;
}

async function closeOffscreenDocument() {
    try {
        if (await chrome.offscreen.hasDocument()) {
            await chrome.offscreen.closeDocument();
        }
    } catch { /* already gone */ }
}

// Returns base64 PNG (no data: prefix). Throws if the markup isn't a
// renderable SVG, so callers can fall back to the original asset.
export async function rasterizeSvgToPngBase64(svgText) {
    inFlight += 1;
    try {
        await ensureOffscreenDocument();
        const response = await chrome.runtime.sendMessage({
            action: "offscreenRasterizeSvg",
            svgText,
        });
        if (!response?.ok) {
            throw new Error(response?.error || "SVG rasterization failed");
        }
        return response.base64;
    } finally {
        inFlight -= 1;
        if (inFlight === 0) await closeOffscreenDocument();
    }
}
