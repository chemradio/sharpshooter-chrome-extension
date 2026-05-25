import { withEmulatedCapture } from "../captureSession.js";
import { enableEmulation } from "../emulation/emulationEnabler.js";
import {
    injectMutationWatcher,
    waitForMutationSettle,
} from "../../support/mutationObserver.js";
import { withZoomReset } from "../../support/zoomReset.js";
import { takeScreenshotClip } from "../capture/captureScreenshot.js";
import { downloadScreenshot } from "../capture/downloadScreenshot.js";

// ─── Approach ────────────────────────────────────────────────────────────────
//
// Element capture is a viewport screenshot + canvas crop. CDP page-absolute
// clip is unreliable on sites with custom scroll containers (Facebook), CSS
// zoom, or CSS transforms — viewport-relative getBoundingClientRect always
// matches what's on screen, so we measure in the viewport and crop in JS.
//
// Two non-obvious choices below:
//
//   1. Measure via CDP Runtime.evaluate (not chrome.scripting.executeScript).
//      Same debugger channel as the screenshot → no content-script round-trip
//      → the measure→capture gap shrinks to the minimum possible. Pages that
//      run scroll-restoration on rAF (e.g. Facebook) get less chance to undo
//      our scrollIntoView between the two calls.
//
//   2. NO requestAnimationFrame wait between measure and screenshot.
//      scrollIntoView({behavior:"instant"}) is synchronous and
//      getBoundingClientRect forces layout — we already have an accurate
//      measurement. Waiting rAFs lets the page's restoration handlers fire.
// ────────────────────────────────────────────────────────────────────────────

// CDP cap on emulated dimensions
const MAX_VIEWPORT_DIMENSION = 16384;
// Padding around an element when expanding the viewport to fit it
const VIEWPORT_PADDING = 64;

// ─── CDP helper ──────────────────────────────────────────────────────────────

const cdpSend = (tabId, command, params) =>
    new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, command, params, (result) => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            resolve(result);
        });
    });

// ─── Measure ─────────────────────────────────────────────────────────────────

const measureExpression = (xpath) => `
    (function () {
        try {
            const el = document.evaluate(
                ${JSON.stringify(xpath)},
                document, null,
                XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;
            if (!el) return { ok: false, reason: "xpath-miss" };

            el.scrollIntoView({
                block: "center",
                inline: "center",
                behavior: "instant",
            });

            const r = el.getBoundingClientRect();
            return {
                ok: true,
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
            };
        } catch (e) {
            return {
                ok: false,
                reason: "exception: " + (e && e.message || String(e)),
            };
        }
    })()
`;

async function measureAndScroll(tabId, xpath) {
    const result = await cdpSend(tabId, "Runtime.evaluate", {
        expression: measureExpression(xpath),
        returnByValue: true,
    });
    if (result?.exceptionDetails) {
        const msg =
            result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            "Runtime.evaluate failed";
        throw new Error(`Element measure failed: ${msg}`);
    }
    return result?.result?.value ?? null;
}

function ensureUsable(rect) {
    if (!rect) {
        throw new Error("Element measurement returned no result");
    }
    if (!rect.ok) {
        throw new Error(
            `Could not locate element after emulation: ${rect.reason}`
        );
    }
    if (rect.width <= 0 || rect.height <= 0) {
        throw new Error(
            `Element has zero size (${rect.width}×${rect.height})`
        );
    }
}

// ─── Viewport-fit ────────────────────────────────────────────────────────────
//
// If the element is bigger than the emulated viewport, scrollIntoView can
// only place an edge in view — the rest gets clipped on capture. Expand the
// viewport to fit, re-inject the watcher (it disconnects after firing once),
// re-emulate, wait for settle, re-measure.

function elementExceedsViewport(rect) {
    return (
        rect.width > rect.viewportWidth || rect.height > rect.viewportHeight
    );
}

function expandedMetricsToFit(metrics, rect) {
    return {
        ...metrics,
        width: Math.min(
            MAX_VIEWPORT_DIMENSION,
            Math.max(
                metrics.width,
                Math.ceil(rect.width + VIEWPORT_PADDING * 2)
            )
        ),
        height: Math.min(
            MAX_VIEWPORT_DIMENSION,
            Math.max(
                metrics.height,
                Math.ceil(rect.height + VIEWPORT_PADDING * 2)
            )
        ),
    };
}

// Match captureSession.js: emulate first, give the renderer two rAFs + a
// short delay to dispatch resize and queue handler work, THEN arm the
// watcher. Otherwise pre-existing page activity can resolve the watcher
// before the resize-driven reflow has actually started.
async function reEmulate(tabId, metrics) {
    await enableEmulation(tabId, metrics);
    await chrome.scripting.executeScript({
        target: { tabId },
        func: () =>
            new Promise((resolve) => {
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => setTimeout(resolve, 150))
                );
            }),
    });
    await injectMutationWatcher(tabId);
    await waitForMutationSettle(tabId);
}

// ─── Crop ────────────────────────────────────────────────────────────────────

function cropRectInPixels(rect, dpr) {
    const x = Math.round(rect.left * dpr);
    const y = Math.round(rect.top * dpr);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);

    const maxW = Math.round(rect.viewportWidth * dpr);
    const maxH = Math.round(rect.viewportHeight * dpr);

    const cx = Math.max(0, Math.min(x, maxW - 1));
    const cy = Math.max(0, Math.min(y, maxH - 1));
    const cw = Math.max(1, Math.min(w, maxW - cx));
    const ch = Math.max(1, Math.min(h, maxH - cy));
    return { cx, cy, cw, ch };
}

async function cropBase64Png(base64, sx, sy, sw, sh) {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob, sx, sy, sw, sh);

    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();

    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await outBlob.arrayBuffer());

    // Chunked btoa — large canvases overflow String.fromCharCode otherwise.
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

// ─── Feedback to popup ───────────────────────────────────────────────────────

function broadcastResult(payload) {
    // Popup may be closed — drop the failure silently in that case.
    chrome.runtime.sendMessage({
        action: "elementCaptureResult",
        ...payload,
    }).catch(() => {});
}

// ─── Capture ─────────────────────────────────────────────────────────────────

export async function captureElement({
    tabId,
    xpath,
    deviceMetrics,
    screenshotSuffix,
    manualCrop = false,
}) {
    const dpr = deviceMetrics?.deviceScaleFactor ?? 1;

    await withZoomReset(tabId, () => withEmulatedCapture(tabId, deviceMetrics, async () => {
        let rect = await measureAndScroll(tabId, xpath);
        ensureUsable(rect);

        if (elementExceedsViewport(rect)) {
            const expanded = expandedMetricsToFit(deviceMetrics, rect);
            console.log(
                `element ${rect.width}×${rect.height} exceeds viewport ` +
                    `${rect.viewportWidth}×${rect.viewportHeight} — ` +
                    `expanding emulation to ${expanded.width}×${expanded.height}`
            );

            await reEmulate(tabId, expanded);
            rect = await measureAndScroll(tabId, xpath);
            ensureUsable(rect);

            if (elementExceedsViewport(rect)) {
                console.warn(
                    "element still exceeds viewport after expansion; " +
                        "capture will be clipped"
                );
            }
        }

        const { cx, cy, cw, ch } = cropRectInPixels(rect, dpr);

        // Tight measure → capture sequence. No await on anything else between
        // these two CDP calls so the page can't scroll-restore in the gap.
        const fullshot = await takeScreenshotClip(tabId);

        console.log(
            `element ${rect.width}×${rect.height} ` +
                `@ (${rect.left},${rect.top}); ` +
                `crop ${cw}×${ch} @ (${cx},${cy}) dpr=${dpr}`
        );

        const cropped = await cropBase64Png(fullshot, cx, cy, cw, ch);
        await downloadScreenshot(cropped, `element-${screenshotSuffix}`, { manualCrop });
    }));
}

// ─── Listener ────────────────────────────────────────────────────────────────

export const addElementClickedListener = () => {
    chrome.runtime.onMessage.addListener((request, sender) => {
        if (request?.action !== "elementClicked") return false;

        // Re-open the popup so element capture has the same "Capturing…"
        // feedback as page capture. The popup was closed at click-handoff
        // time (see popup.js) to avoid the two-click trap. We persist a
        // session flag the popup checks on init; the flag is cleared when
        // capture finishes (success or failure).
        chrome.storage.session.set({ elementCaptureInProgress: true });
        chrome.action.openPopup().catch(() => {});

        const finish = (payload) => {
            chrome.storage.session.remove("elementCaptureInProgress");
            broadcastResult(payload);
        };

        captureElement({
            tabId: sender.tab.id,
            xpath: request.xpath,
            deviceMetrics: request.deviceMetrics,
            screenshotSuffix: request.screenshotSuffix,
            manualCrop: !!request.manualCrop,
        })
            .then(() => finish({ ok: true }))
            .catch((error) => {
                console.error("Element capture failed:", error);
                finish({ ok: false, error: error?.message ?? String(error) });
            });

        return false;
    });
};
