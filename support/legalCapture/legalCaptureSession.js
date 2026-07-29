// Orchestrates a full Legal Capture: forced clean reload → recorded network
// exchange (WARC/WACZ) → screenshot → hash → independent RFC 3161 timestamp
// → a single downloaded zip containing all of it.
//
// Unlike Page/Element capture, this can't just call
// screenshots/captureSession.js's withEmulatedCapture as a black box: Network
// recording has to be enabled *before* the forced reload so the reload's own
// request/response traffic (i.e. the actual page load we're trying to prove
// is unaltered) ends up in the WARC — not just whatever happens after. So
// this module attaches the debugger itself and composes the same
// attach → hide scrollbars → emulate → settle steps captureSession.js
// exports, in a different order.

import {
    attachDebugger,
    detachDebugger,
} from "../debugerAttachment.js";
import { withZoomReset } from "../zoomReset.js";
import { showCaptureOverlay, hideCaptureOverlay } from "../captureOverlay.js";
import {
    hideScrollbars,
    restoreScrollbars,
    postEmulationBreather,
} from "../../screenshots/captureSession.js";
import { enableEmulation, clearEmulation } from "../../screenshots/emulation/emulationEnabler.js";
import { injectMutationWatcher, waitForMutationSettle } from "../mutationObserver.js";
import { takeScreenshotClip } from "../../screenshots/capture/captureScreenshot.js";
import { measurePageHeight, measureViewportSize } from "../pageMeasure.js";
import { startRecording, stopRecording } from "./networkRecorder.js";
import { buildWarc } from "./warcWriter.js";
import { buildWacz, buildZip } from "./zipWriter.js";
import { requestTimestamp } from "./tsaClient.js";
import { sha256Bytes, sha256Hex, bytesToBase64, base64ToBytes } from "../binary.js";

const RELOAD_TIMEOUT_MS = 20000;

function reloadAndWaitForComplete(tabId) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        };
        const timeout = setTimeout(finish, RELOAD_TIMEOUT_MS);
        function listener(id, changeInfo) {
            if (id === tabId && changeInfo.status === "complete") finish();
        }
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.reload(tabId, { bypassCache: true }, () => {
            const err = chrome.runtime.lastError;
            if (err && !settled) {
                settled = true;
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error(err.message));
            }
        });
    });
}

// "User" and "Full Page" presets are measured from the live page by
// popup.js *before* the click — but Legal Capture forces a fresh reload
// afterward, and a fresh load can genuinely have less content on screen
// (lazy-loaded images/feeds, etc.) than whatever was already on screen when
// the popup measured it. Re-measure against the post-reload page instead of
// trusting those stale numbers, so "the currently active preset" means what
// the user expects instead of a snapshot from before the reload.
async function reMeasureForPreset(tabId, deviceMetrics, presetType, fullPageHeightCap) {
    if (presetType === "viewport") {
        const size = await measureViewportSize(tabId).catch(() => null);
        return size ? { ...deviceMetrics, width: size.width, height: size.height } : deviceMetrics;
    }
    if (presetType === "fullpage") {
        const [size, height] = await Promise.all([
            measureViewportSize(tabId).catch(() => null),
            measurePageHeight(tabId).catch(() => null),
        ]);
        const cap = fullPageHeightCap > 0 ? fullPageHeightCap : Infinity;
        return {
            ...deviceMetrics,
            width: size?.width ?? deviceMetrics.width,
            height: height != null ? Math.min(height, cap) : deviceMetrics.height,
        };
    }
    // "fixed" / custom presets are literal, user-chosen dimensions — not
    // derived from the page, so there's nothing to re-measure.
    return deviceMetrics;
}

function tlsSummaryFrom(exchanges, url) {
    const main = exchanges.find((ex) => ex.url === url) ?? exchanges[0];
    const sec = main?.response?.securityDetails;
    if (!sec) return null;
    return {
        protocol: sec.protocol ?? null,
        issuer: sec.issuer ?? null,
        subjectName: sec.subjectName ?? null,
        validFrom: sec.validFrom ? new Date(sec.validFrom * 1000).toISOString() : null,
        validTo: sec.validTo ? new Date(sec.validTo * 1000).toISOString() : null,
    };
}

function buildReport({ url, startedAt, warcSha256, waczSha256, tsaResult, tsaError, tlsSummary, exchangeCount }) {
    const lines = [
        "SHARPSHOOTER LEGAL CAPTURE — CAPTURE REPORT",
        "",
        `Captured URL:          ${url}`,
        `Capture started (UTC): ${startedAt}`,
        `Network exchanges:     ${exchangeCount}`,
        `capture.wacz SHA-256:  ${waczSha256}`,
        `data.warc SHA-256:     ${warcSha256}`,
        "",
    ];

    if (tlsSummary) {
        lines.push(
            "TLS connection (reported by the browser for the main document response):",
            `  Protocol:  ${tlsSummary.protocol ?? "unknown"}`,
            `  Issuer:    ${tlsSummary.issuer ?? "unknown"}`,
            `  Subject:   ${tlsSummary.subjectName ?? "unknown"}`,
            `  Valid:     ${tlsSummary.validFrom ?? "?"} to ${tlsSummary.validTo ?? "?"}`,
            ""
        );
    } else {
        lines.push(
            "TLS connection details were not available (e.g. a plain HTTP page, or the",
            "main document response wasn't recorded).",
            ""
        );
    }

    if (tsaResult) {
        lines.push(
            "Independent timestamp (RFC 3161, requested automatically from FreeTSA):",
            `  Authority:   ${tsaResult.tsaUrl}`,
            `  Token time:  ${tsaResult.genTime ?? "could not auto-read — verify capture.tsr directly (see below)"}`,
            "  Verify independently with standard tools, without trusting this report:",
            "    openssl ts -reply -in capture.tsr -text",
            ""
        );
    } else {
        lines.push(
            "Independent timestamp: FAILED to obtain.",
            `  Reason: ${tsaError}`,
            "  The capture is still hash-sealed (see capture.wacz SHA-256 above), but",
            "  has no independent third-party proof of capture time beyond this",
            "  computer's own clock.",
            ""
        );
    }

    lines.push(
        "WHAT THIS PROVES:",
        "  - capture.wacz is a byte-exact recording of the actual HTTP exchange",
        "    between this browser and the server for the URL above, including",
        "    response headers and bodies. Open it at https://replayweb.page to",
        "    replay the page exactly as captured, independent of this tool.",
        "  - screenshot.png is a visual capture taken during the same session.",
        "  - manifest.json's hash lets anyone confirm capture.wacz has not been",
        "    altered since this report was generated.",
        "  - capture.tsr (when present) is independent proof of when the hash",
        "    existed, from a third party, not just this tool's own clock.",
        "",
        "WHAT THIS DOES NOT PROVE:",
        "  - It does not independently re-verify the TLS certificate chain against",
        "    Certificate Transparency logs — the TLS summary above is only what",
        "    the browser itself reported for this connection.",
        "  - It cannot rule out tampering upstream of the browser (compromised DNS,",
        "    a malicious network path, etc.) beyond what a valid TLS handshake for",
        "    the target domain already implies.",
        "  - This is supporting technical evidence, not a legal determination —",
        "    consult counsel on how to present it."
    );

    return lines.join("\n");
}

export async function startLegalCapture({ tabId, url, deviceMetrics, presetType, fullPageHeightCap }) {
    const startedAt = new Date();

    return withZoomReset(tabId, async () => {
        await showCaptureOverlay(tabId);
        await attachDebugger(tabId); // throws DevToolsAttachedError if native DevTools holds the tab

        let exchanges = [];
        let screenshotBase64;
        try {
            await startRecording(tabId);
            // The reload's own traffic IS the evidence — recording must
            // already be active before it starts, not after.
            await reloadAndWaitForComplete(tabId);

            const effectiveMetrics = await reMeasureForPreset(
                tabId,
                deviceMetrics,
                presetType,
                fullPageHeightCap
            );

            await hideScrollbars(tabId);
            await enableEmulation(tabId, effectiveMetrics);
            await postEmulationBreather(tabId);
            await injectMutationWatcher(tabId);
            await waitForMutationSettle(tabId);

            screenshotBase64 = await takeScreenshotClip(tabId);
        } finally {
            exchanges = await stopRecording(tabId).catch(() => []);
            await Promise.all([restoreScrollbars(tabId), clearEmulation(tabId)]);
            await detachDebugger(tabId);
            await hideCaptureOverlay(tabId);
        }

        const startedAtIso = startedAt.toISOString();
        const { bytes: warcBytes, index } = await buildWarc(exchanges, {
            url,
            startedAt: startedAtIso,
            startedAtSeconds: Math.floor(startedAt.getTime() / 1000),
        });
        const warcSha256 = await sha256Hex(warcBytes);
        const waczBytes = await buildWacz({ warcBytes, index, url, startedAt: startedAtIso, warcSha256 });
        const waczSha256 = await sha256Hex(waczBytes);

        let tsaResult = null;
        let tsaError = null;
        try {
            tsaResult = await requestTimestamp(await sha256Bytes(waczBytes));
        } catch (e) {
            tsaError = e?.message ?? String(e);
        }

        const tlsSummary = tlsSummaryFrom(exchanges, url);

        const manifest = {
            url,
            startedAt: startedAtIso,
            tool: "Sharpshooter Legal Capture",
            wacz: { filename: "capture.wacz", sha256: waczSha256 },
            tls: tlsSummary,
            timestamp: tsaResult
                ? { authority: tsaResult.tsaUrl, genTime: tsaResult.genTime }
                : { error: tsaError },
            exchangeCount: exchanges.length,
        };

        const report = buildReport({
            url,
            startedAt: startedAtIso,
            warcSha256,
            waczSha256,
            tsaResult,
            tsaError,
            tlsSummary,
            exchangeCount: exchanges.length,
        });

        const encoder = new TextEncoder();
        const packageEntries = [
            { name: "capture.wacz", data: waczBytes },
            { name: "manifest.json", data: encoder.encode(JSON.stringify(manifest, null, 2)) },
            { name: "report.txt", data: encoder.encode(report) },
        ];
        if (screenshotBase64) {
            packageEntries.push({ name: "screenshot.png", data: base64ToBytes(screenshotBase64) });
        }
        if (tsaResult) {
            packageEntries.push({ name: "capture.tsr", data: tsaResult.tsrBytes });
        }

        const zipBytes = buildZip(packageEntries);
        const suffix = startedAtIso.replace(/[:.]/g, "-");

        await new Promise((resolve, reject) => {
            chrome.downloads.download(
                {
                    url: `data:application/zip;base64,${bytesToBase64(zipBytes)}`,
                    filename: `legal-capture-${suffix}.zip`,
                    saveAs: true,
                },
                (downloadId) => {
                    const err = chrome.runtime.lastError;
                    if (err) return reject(new Error(err.message));
                    if (downloadId == null) return reject(new Error("Download did not start"));
                    resolve(downloadId);
                }
            );
        });

        return { exchangeCount: exchanges.length, waczSha256, timestamped: !!tsaResult };
    });
}
