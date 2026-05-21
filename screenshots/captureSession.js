import {
    attachDebugger,
    detachDebugger,
} from "../support/debugerAttachment.js";
import { enableEmulation, clearEmulation } from "./emulation/emulationEnabler.js";
import {
    injectMutationWatcher,
    waitForMutationSettle,
} from "../support/mutationObserver.js";

const SCROLLBAR_STYLE_ID = "__no-scroll";

const hideScrollbars = (tabId) =>
    chrome.scripting.executeScript({
        target: { tabId },
        func: (id) => {
            if (document.getElementById(id)) return;
            const s = document.createElement("style");
            s.id = id;
            s.textContent =
                "*::-webkit-scrollbar { display: none !important; }";
            document.head.appendChild(s);
        },
        args: [SCROLLBAR_STYLE_ID],
    });

const restoreScrollbars = (tabId) =>
    chrome.scripting
        .executeScript({
            target: { tabId },
            func: (id) => document.getElementById(id)?.remove(),
            args: [SCROLLBAR_STYLE_ID],
        })
        .catch(() => {});

// Pause after emulation before arming the mutation watcher. CDP resolves
// setDeviceMetricsOverride as soon as the override is accepted, NOT after
// the renderer has relayouted and dispatched `resize`. Give the page two
// animation frames + a short delay so resize handlers can queue their work
// before we start counting "quiet" time.
const POST_EMULATION_BREATHER_MS = 150;
const postEmulationBreather = (tabId) =>
    chrome.scripting.executeScript({
        target: { tabId },
        func: (ms) =>
            new Promise((resolve) => {
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => setTimeout(resolve, ms))
                );
            }),
        args: [POST_EMULATION_BREATHER_MS],
    });

// Run `body` inside an emulated-viewport debugger session. Handles attach,
// scrollbar hide, emulation, post-emulation breather, mutation watcher
// injection, settle wait, then teardown. Errors propagate.
//
// The watcher is injected AFTER emulation (not before) so its debounce/max-wait
// timers start from a known zero point. Injecting earlier let pre-existing
// page activity (lazy-loading feeds, etc.) trigger the watcher's debounce and
// resolve it before the resize-driven reflow had actually started.
export const withEmulatedCapture = async (tabId, deviceMetrics, body) => {
    await attachDebugger(tabId);
    try {
        await hideScrollbars(tabId);
        await enableEmulation(tabId, deviceMetrics);
        await postEmulationBreather(tabId);
        await injectMutationWatcher(tabId);
        await waitForMutationSettle(tabId);
        return await body();
    } finally {
        // restoreScrollbars and clearEmulation are independent — run in
        // parallel to shave a round-trip. detachDebugger must come last
        // because clearEmulation needs the debugger still attached.
        await Promise.all([restoreScrollbars(tabId), clearEmulation(tabId)]);
        await detachDebugger(tabId);
    }
};
