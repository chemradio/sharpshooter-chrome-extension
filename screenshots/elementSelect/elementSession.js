import { withEmulatedCapture } from "../captureSession.js";
import { enableEmulation } from "../emulation/emulationEnabler.js";
import {
    injectMutationWatcher,
    waitForMutationSettle,
} from "../../support/mutationObserver.js";
import { withZoomReset } from "../../support/zoomReset.js";
import { takeScreenshotClip } from "../capture/captureScreenshot.js";
import { bytesToBase64 } from "../../support/binary.js";
import { step } from "../../support/perfTrace.js";

// ─── Approach ────────────────────────────────────────────────────────────────
//
// Element capture is a viewport screenshot + canvas crop. CDP page-absolute
// clip is unreliable on pages with custom scroll containers, CSS zoom, or
// CSS transforms — viewport-relative getBoundingClientRect always matches
// what's on screen, so we measure in the viewport and crop in JS.
//
// Two non-obvious choices below:
//
//   1. Measure via CDP Runtime.evaluate (not chrome.scripting.executeScript).
//      Same debugger channel as the screenshot → no content-script round-trip
//      → the measure→capture gap shrinks to the minimum possible. Pages that
//      run scroll-restoration on rAF get less chance to undo our
//      scrollIntoView between the two calls.
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

const measureExpression = (xpath, marker) => `
    (function () {
        try {
            // Marker attribute first: it survives the reflow/re-render that
            // emulation triggers on responsive pages, where the positional
            // XPath (recorded pre-emulation) frequently goes stale.
            let el = null;
            const marker = ${JSON.stringify(marker || "")};
            if (marker) {
                el = document.querySelector(
                    '[data-sharpshooter-target="' + marker + '"]'
                );
            }
            if (!el && ${JSON.stringify(xpath || "")}) {
                el = document.evaluate(
                    ${JSON.stringify(xpath || "")},
                    document, null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;
            }
            if (!el) return { ok: false, reason: "marker+xpath-miss" };

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

async function measureAndScroll(tabId, xpath, marker) {
    const result = await cdpSend(tabId, "Runtime.evaluate", {
        expression: measureExpression(xpath, marker),
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
            `Could not re-locate the selected element after emulation ` +
                `(${rect.reason}). The page likely rebuilt its layout at ` +
                `the emulated resolution — try the User preset, or ` +
                `re-select the element.`
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
    return bytesToBase64(bytes);
}

// ─── Capture ─────────────────────────────────────────────────────────────────

// Runs `body` inside a fully prepared element session: zoom reset, debugger
// attached, scrollbars hidden, emulation applied and settled, the element
// located and scrolled into view, and the viewport expanded if the element
// didn't fit. Everything up to this point is identical for a screenshot and
// for a design extraction — the two differ only in what they do with the
// prepared page, so they share this and diverge in the callback.
//
// `body` receives:
//   rect            the viewport-relative measurement (see header comment on
//                   why viewport-relative and not CDP page-absolute)
//   metrics         the device metrics actually in force (post-expansion)
//   cdp(cmd, params) raw CDP on the same channel the screenshot uses
//   captureCropped() viewport screenshot cropped to the element, base64 PNG
export async function withElementSession(
    { tabId, xpath, marker, deviceMetrics },
    body
) {
    const dpr = deviceMetrics?.deviceScaleFactor ?? 1;

    try {
        return await withZoomReset(tabId, () => withEmulatedCapture(tabId, deviceMetrics, async () => {
            let metrics = deviceMetrics;
            let rect = await step("measure", () =>
                measureAndScroll(tabId, xpath, marker)
            );
            ensureUsable(rect);

            if (elementExceedsViewport(rect)) {
                const expanded = expandedMetricsToFit(deviceMetrics, rect);
                console.log(
                    `element ${rect.width}×${rect.height} exceeds viewport ` +
                        `${rect.viewportWidth}×${rect.viewportHeight} — ` +
                        `expanding emulation to ${expanded.width}×${expanded.height}`
                );

                await step("reEmulate", () => reEmulate(tabId, expanded));
                metrics = expanded;
                rect = await step("re-measure", () =>
                    measureAndScroll(tabId, xpath, marker)
                );
                ensureUsable(rect);

                if (elementExceedsViewport(rect)) {
                    console.warn(
                        "element still exceeds viewport after expansion; " +
                            "capture will be clipped"
                    );
                }
            }

            const captureCropped = async () => {
                const { cx, cy, cw, ch } = cropRectInPixels(rect, dpr);

                // Tight measure → capture sequence. No await on anything else
                // between these two CDP calls so the page can't scroll-restore
                // in the gap.
                const fullshot = await step("captureScreenshot", () =>
                    takeScreenshotClip(tabId)
                );

                console.log(
                    `element ${rect.width}×${rect.height} ` +
                        `@ (${rect.left},${rect.top}); ` +
                        `crop ${cw}×${ch} @ (${cx},${cy}) dpr=${dpr}`
                );

                return step("crop", () =>
                    cropBase64Png(fullshot, cx, cy, cw, ch)
                );
            };

            return body({
                rect,
                metrics,
                dpr,
                cdp: (cmd, params) => cdpSend(tabId, cmd, params),
                captureCropped,
            });
        }));
    } finally {
        // Strip the marker attribute the highlighter set at click time —
        // it must not leak into the page's DOM (or a later Legal Capture
        // page.html) after the session ends. Best-effort: the tab may have
        // navigated away.
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                document
                    .querySelectorAll("[data-sharpshooter-target]")
                    .forEach((el) =>
                        el.removeAttribute("data-sharpshooter-target")
                    );
            },
        }).catch(() => {});
    }
}
