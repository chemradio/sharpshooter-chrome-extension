// Offscreen-document half of the SVG → PNG converter.
//
// Why this file exists at all: the service worker cannot rasterize SVG.
// createImageBitmap() rejects image/svg+xml blobs outside a document, and
// there is no <img> element in a worker. So the background asks this page
// (created on demand by support/svgRaster.js) to do the drawing.
//
// Transparency is preserved: the canvas starts fully transparent and is
// never filled, so anything the SVG leaves uncovered stays alpha 0 in the
// resulting PNG.

const SVG_NS = "http://www.w3.org/2000/svg";

// SVG is resolution-independent, so the intrinsic size is only a hint —
// a 24×24 icon would produce a useless 24×24 PNG. Scale up so the long
// edge lands near TARGET_LONG_EDGE, never downscale below intrinsic, and
// never exceed MAX_LONG_EDGE (canvas memory + download size sanity).
const TARGET_LONG_EDGE = 2048;
const MAX_LONG_EDGE    = 8192;

// Chrome's default replaced-element size, used when the markup declares
// neither usable width/height nor a viewBox.
const FALLBACK_W = 300;
const FALLBACK_H = 150;

// Only absolute, unitless-or-px lengths are usable as an intrinsic size.
// "100%" tells us nothing without a containing block, so it's rejected and
// the viewBox is used instead.
function parseLength(value) {
    if (!value) return 0;
    const trimmed = String(value).trim();
    if (!/^-?[\d.]+(px)?$/i.test(trimmed)) return 0;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// Rewrite the markup with explicit pixel width/height (and a viewBox if it
// was missing) rather than scaling at drawImage() time — this makes Chrome
// rasterize the vector *at* the output size instead of rasterizing at the
// intrinsic size and then bitmap-scaling it up.
function prepareMarkup(svgText) {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.localName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
        throw new Error("Not a parseable SVG document");
    }
    if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", SVG_NS);

    let w = parseLength(svg.getAttribute("width"));
    let h = parseLength(svg.getAttribute("height"));

    const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const hasViewBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;

    if ((!w || !h) && hasViewBox) { w = vb[2]; h = vb[3]; }
    if (!w || !h)                 { w = FALLBACK_W; h = FALLBACK_H; }
    if (!hasViewBox)              svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    const longEdge = Math.max(w, h);
    let scale = Math.max(1, TARGET_LONG_EDGE / longEdge);
    if (longEdge * scale > MAX_LONG_EDGE) scale = MAX_LONG_EDGE / longEdge;

    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    svg.setAttribute("width",  String(outW));
    svg.setAttribute("height", String(outH));

    return { markup: new XMLSerializer().serializeToString(svg), outW, outH };
}

async function rasterize(svgText) {
    const { markup, outW, outH } = prepareMarkup(svgText);

    // Blob URL, not a data: URL — same-origin to this page, so the canvas
    // stays untainted and toDataURL() is allowed.
    const blobUrl = URL.createObjectURL(
        new Blob([markup], { type: "image/svg+xml;charset=utf-8" })
    );
    try {
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload  = resolve;
            img.onerror = () => reject(new Error("SVG failed to load as an image"));
            img.src = blobUrl;
        });

        const canvas = document.createElement("canvas");
        canvas.width  = outW;
        canvas.height = outH;
        const ctx = canvas.getContext("2d", { alpha: true });
        ctx.clearRect(0, 0, outW, outH);
        ctx.drawImage(img, 0, 0, outW, outH);

        return canvas.toDataURL("image/png").split(",")[1];
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== "offscreenRasterizeSvg") return false;
    rasterize(message.svgText)
        .then((base64) => sendResponse({ ok: true, base64 }))
        .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
    return true; // async response
});
