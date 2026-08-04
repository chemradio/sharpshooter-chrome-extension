// Handles a committed element selection from the picker.
//
// The heavy lifting — locating the element, emulating, settling, measuring,
// expanding the viewport to fit, screenshotting and cropping — lives in
// elementSession.js, shared with Extract Design's capture path.
//
// Only Element Capture arrives here. Design mode commits *into the page*
// instead: the picker hands the element to the live spec card, which stays on
// screen until the user presses its own Capture button, and that goes to the
// background as `designCapture` rather than `elementClicked`.

import { withElementSession } from "./elementSession.js";
import { downloadScreenshot } from "../capture/downloadScreenshot.js";

// ─── Feedback to popup ───────────────────────────────────────────────────────

function broadcastResult(payload) {
    // Popup may be closed — drop the failure silently in that case.
    chrome.runtime.sendMessage({
        action: "elementCaptureResult",
        ...payload,
    }).catch(() => {});
}


// Screenshot path: capture the element and hand it to the downloader (or the
// crop editor, which downloadScreenshot decides from `manualCrop`).
export async function captureElement({
    tabId,
    xpath,
    marker,
    deviceMetrics,
    screenshotSuffix,
    manualCrop = false,
}) {
    return withElementSession(
        { tabId, xpath, marker, deviceMetrics },
        async ({ captureCropped }) => {
            const cropped = await captureCropped();
            await downloadScreenshot(cropped, `element-${screenshotSuffix}`, {
                manualCrop,
            });
        }
    );
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
            broadcastResult({ mode: "capture", ...payload });
        };

        captureElement({
            tabId: sender.tab.id,
            xpath: request.xpath,
            marker: request.marker,
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
