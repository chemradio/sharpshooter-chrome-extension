// Routes a committed element selection to whichever feature opened the picker.
//
// The heavy lifting — locating the element, emulating, settling, measuring,
// expanding the viewport to fit, screenshotting and cropping — lives in
// elementSession.js, which both consumers share. This file is just the
// message listener plus the screenshot consumer.

import { withElementSession } from "./elementSession.js";
import { downloadScreenshot } from "../capture/downloadScreenshot.js";
import { extractDesignFromElement } from "../../support/designExtract/designSession.js";

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

        // The picker is shared; `mode` (set at injection time, echoed back on
        // click) decides which feature consumes the selection.
        const design = request.mode === "design";
        const run = design ? extractDesignFromElement : captureElement;

        const finish = (payload) => {
            chrome.storage.session.remove("elementCaptureInProgress");
            // Carry the mode back so the popup can report the right thing —
            // "Design extracted" rather than the screenshot wording.
            broadcastResult({ mode: design ? "design" : "capture", ...payload });
        };

        run({
            tabId: sender.tab.id,
            xpath: request.xpath,
            marker: request.marker,
            deviceMetrics: request.deviceMetrics,
            screenshotSuffix: request.screenshotSuffix,
            manualCrop: !!request.manualCrop,
        })
            .then(() => finish({ ok: true }))
            .catch((error) => {
                console.error(
                    design ? "Design extraction failed:" : "Element capture failed:",
                    error
                );
                finish({ ok: false, error: error?.message ?? String(error) });
            });

        return false;
    });
};
