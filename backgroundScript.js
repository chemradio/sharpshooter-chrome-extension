import { emulateCaptureViewport } from "./screenshots/emulatedViewportCapture.js";
import { addElementClickedListener } from "./screenshots/elementSelect/elementClickListener.js";
import { withZoomReset } from "./support/zoomReset.js";
import { handoffToCropEditor } from "./screenshots/capture/cropHandoff.js";
import {
    detectSite,
    captureSiteElement,
} from "./screenshots/autoCapture.js";
import { bytesToBase64 } from "./support/binary.js";
import { measurePageHeight, measureViewportSize } from "./support/pageMeasure.js";
import {
    wasDomKillerUsed,
    registerTabResetListener,
    registerDomKillerUsedListener,
} from "./support/tabState.js";
import { startLegalCapture } from "./support/legalCapture/legalCaptureSession.js";
import { registerGeoPermissionRelay } from "./support/legalCapture/geoPermissionRelay.js";
import { DevToolsAttachedError } from "./support/debugerAttachment.js";

registerTabResetListener();
registerDomKillerUsedListener();
registerGeoPermissionRelay();

addElementClickedListener();

async function getActiveTab() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            if (!tabs.length) return reject(new Error("No active tab found."));
            resolve(tabs[0]);
        });
    });
}

function buildTimestampSuffix(url) {
    const domain = new URL(url).hostname;
    const ts = new Date()
        .toISOString()
        .replace(/T/, "-")
        .replace(/:/g, "-")
        .split(".")[0];
    return `${domain}-${ts}`;
}

// chrome://, edge://, chrome-extension://, the Web Store, view-source:, file: (when
// "Allow access to file URLs" is off), etc. — chrome.scripting.executeScript fails
// on all of these. Detect upfront so we don't surface scary-looking errors for
// expected restrictions.
function isRestrictedUrl(url) {
    if (!url) return true;
    return /^(chrome|edge|about|chrome-extension|chrome-search|chrome-untrusted|devtools|view-source):/i.test(url)
        || /^https?:\/\/chromewebstore\.google\.com\//i.test(url)
        || /^https?:\/\/chrome\.google\.com\/webstore\//i.test(url);
}

// CDN image transformation suffixes baked into filenames before the extension.
// Stripping them often yields the original unprocessed asset.
// Order matters — first match wins. Fallback to original URL on fetch failure.
const CDN_STRIP_PATTERNS = [
    // Width-anchored transform chain: _w1597_n_r1_s_s  _w800_h600  _w1200
    /_w\d+(_[a-z0-9]+)*(?=\.[a-z]{2,5}(\?|$))/i,
    // Explicit WxH dimension suffix: _800x600  -800x600  _1920x1080
    /[_-]\d{2,5}x\d{2,5}(?=\.[a-z]{2,5}(\?|$))/i,
    // Named size variant: _large _xlarge _medium _small _thumb _thumbnail _preview _original _full
    /[_-](x{0,2}large|medium|x{0,2}small|thumb(?:nail)?|preview|original|full|big|tiny)(?=\.[a-z]{2,5}(\?|$))/i,
];

function stripCdnSuffix(urlStr) {
    try {
        const u    = new URL(urlStr);
        const path = u.pathname;
        for (const re of CDN_STRIP_PATTERNS) {
            const stripped = path.replace(re, "");
            if (stripped !== path) {
                u.pathname = stripped;
                return u.href;
            }
        }
    } catch { /* malformed URL */ }
    return null;
}

async function handleAction(request) {
    const tab = await getActiveTab();
    const settings = request.settings ?? {};

    const baseMetrics = {
        width: settings.width || 1920,
        height: settings.height || 1080,
        deviceScaleFactor: settings.deviceScaleFactor || 2,
        mobile: settings.mobile || false,
    };
    const screenshotSuffix = buildTimestampSuffix(tab.url);

    switch (request.action) {
        case "getPageHeight": {
            if (isRestrictedUrl(tab.url)) return { pageHeight: null };
            const pageHeight = await measurePageHeight(tab.id);
            return { pageHeight };
        }

        case "getViewportSize": {
            if (isRestrictedUrl(tab.url)) return { width: null, height: null };
            // Report CSS-pixel viewport (window.innerWidth/Height). This is
            // the actual layout width the page is using at the user's current
            // zoom — at 175% zoom on a 2560px monitor that's 1462. The User
            // preset captures this exact layout, so the popup number reflects
            // the layout pixels available. Output pixel size = this × the
            // quality multiplier.
            const result = await measureViewportSize(tab.id);
            return { width: result?.width ?? null, height: result?.height ?? null };
        }

        case "capturePage": {
            // Zoom is reset to 1 during capture (renderer otherwise fights
            // Chrome's browser-zoom transform and produces wrong layouts).
            // Emulate the literal requested CSS-px width — for the User /
            // Full Page / Vertical presets the popup sourced this from
            // innerWidth, so it matches the layout the user actually sees;
            // for FullHD / 4K / Custom the user picked a fixed CSS-px target
            // (desktop layout, regardless of their zoom). deviceScaleFactor
            // is the quality multiplier only — output size depends solely on
            // scale, not on the user's zoom.
            await withZoomReset(tab.id, () =>
                emulateCaptureViewport(
                    tab.id,
                    baseMetrics,
                    screenshotSuffix,
                    { manualCrop: !!settings.manualCrop }
                )
            );
            return {};
        }

        case "captureElement": {
            // Element capture handles zoom on its own (resets to 1 for
            // accurate crop coordinates, restores after), so pass the
            // un-adjusted device metrics through.
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["contentScripts/elementHighlighter.js"],
            });
            await chrome.tabs.sendMessage(tab.id, {
                action: "sendDeviceMetrics",
                deviceMetrics: baseMetrics,
                screenshotSuffix,
                manualCrop: !!settings.manualCrop,
            });
            return {};
        }

        case "detectSite": {
            if (isRestrictedUrl(tab.url)) return { module: null, pageType: null };
            return await detectSite({ tabId: tab.id, url: tab.url });
        }

        case "captureSiteElement": {
            const result = await captureSiteElement({
                tabId: tab.id,
                url: tab.url,
                settings,
                screenshotSuffix,
            });
            return result;
        }

        case "domKiller": {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["contentScripts/domKiller.js"],
            });
            return {};
        }

        case "imageExtractor": {
            // Inject the picker, then push the crop flag over the per-injection
            // message channel (same pattern as captureElement). A cross-injection
            // global (window.__ImageExtractorOptions) set via a separate
            // executeScript would not reliably reach the content script's scope,
            // leaving a prior crop-mode run's manualCrop=true stale and routing a
            // plain extraction to the crop editor.
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["contentScripts/imageExtractor.js"],
            });
            await chrome.tabs.sendMessage(tab.id, {
                action: "imageExtractorOptions",
                manualCrop: !!request.manualCrop,
            });
            return {};
        }

        case "imageExtractorDownload": {
            const { url } = request;
            const suffix = buildTimestampSuffix(tab.url);
            const { filenamePrefix } = await chrome.storage.local.get("filenamePrefix");
            const prefix   = (filenamePrefix || "").trim();
            const baseName = prefix ? `${prefix}-${suffix}` : suffix;

            // Try stripped URL (CDN suffix removal) first; fall back to original
            let fetchUrl = url;
            const stripped = stripCdnSuffix(url);
            if (stripped) {
                try {
                    const probe = await fetch(stripped, { method: "HEAD" });
                    if (probe.ok) fetchUrl = stripped;
                } catch { /* keep original */ }
            }

            try {
                const res = await fetch(fetchUrl);
                if (!res.ok) throw new Error(`fetch ${res.status}`);
                const blob   = await res.blob();
                const bitmap = await createImageBitmap(blob);
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                canvas.getContext("2d").drawImage(bitmap, 0, 0);
                bitmap.close();
                const pngBlob = await canvas.convertToBlob({ type: "image/png" });
                const bytes   = new Uint8Array(await pngBlob.arrayBuffer());
                await chrome.downloads.download({
                    url:      `data:image/png;base64,${bytesToBase64(bytes)}`,
                    filename: `${baseName}.png`,
                    saveAs:   true,
                });
            } catch {
                // Fallback: download the original format without conversion
                await chrome.downloads.download({ url, saveAs: true });
            }
            return {};
        }

        case "imageExtractorCropUrl": {
            const { url: cropUrl } = request;
            const cropSuffix = buildTimestampSuffix(tab.url);
            const { filenamePrefix: cropPrefix } = await chrome.storage.local.get("filenamePrefix");
            const cropBase = ((cropPrefix || "").trim())
                ? `${cropPrefix.trim()}-${cropSuffix}`
                : cropSuffix;

            let fetchUrl = cropUrl;
            const stripped = stripCdnSuffix(cropUrl);
            if (stripped) {
                try {
                    const probe = await fetch(stripped, { method: "HEAD" });
                    if (probe.ok) fetchUrl = stripped;
                } catch { /* keep original */ }
            }

            const res = await fetch(fetchUrl);
            if (!res.ok) throw new Error(`fetch ${res.status}`);
            const blob   = await res.blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            canvas.getContext("2d").drawImage(bitmap, 0, 0);
            bitmap.close();
            const pngBlob = await canvas.convertToBlob({ type: "image/png" });
            const bytes   = new Uint8Array(await pngBlob.arrayBuffer());
            await handoffToCropEditor(bytesToBase64(bytes), `${cropBase}.png`);
            return {};
        }

        case "getTabCaptureFlags": {
            if (isRestrictedUrl(tab.url)) return { domKillerUsed: false };
            return { domKillerUsed: await wasDomKillerUsed(tab.id) };
        }

        case "startLegalCapture": {
            try {
                const result = await startLegalCapture({
                    tabId: tab.id,
                    url: tab.url,
                    deviceMetrics: baseMetrics,
                    presetType: settings.presetType,
                    fullPageHeightCap: settings.fullPageHeightCap,
                    operatorName: request.operatorName || null,
                    caseReference: request.caseReference || null,
                    options: request.options,
                    geolocation: request.geolocation || null,
                });
                return result;
            } catch (error) {
                if (error instanceof DevToolsAttachedError) {
                    return {
                        ok: false,
                        error: "DevTools is open on this tab. Close it and try again.",
                        code: "devtools-attached",
                    };
                }
                throw error;
            }
        }

        case "stopDomKiller": {
            // Tear down any live Remove Elements session. Called when the popup
            // opens so a session the user left running (reopened the popup
            // instead of pressing ESC) is cleaned up. No-op if none is active.
            if (isRestrictedUrl(tab.url)) return {};
            await chrome.scripting
                .executeScript({
                    target: { tabId: tab.id },
                    func: () => window.__DomKillerDestroy?.(),
                })
                .catch(() => {});
            return {};
        }

        default:
            // elementClicked is handled by its own dedicated listener
            return null;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Only handle the action set this listener owns. Returning false leaves
    // other listeners (elementClickListener) free to handle their messages
    // without channel-conflict warnings.
    const owned = new Set([
        "getPageHeight",
        "getViewportSize",
        "capturePage",
        "captureElement",
        "detectSite",
        "captureSiteElement",
        "domKiller",
        "stopDomKiller",
        "imageExtractor",
        "imageExtractorDownload",
        "imageExtractorCropUrl",
        "getTabCaptureFlags",
        "startLegalCapture",
    ]);
    if (!owned.has(request?.action)) return false;

    handleAction(request)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
            console.error(
                `Background ${request.action} failed:`,
                error
            );
            sendResponse({
                ok: false,
                error: error?.message ?? String(error),
            });
        });

    return true; // async response
});
