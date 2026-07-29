const PROTOCOL_VERSION = "1.3";

// Thrown when a tab's debugger slot is held by something we don't own — in
// practice, native DevTools open on the same tab. Distinguishable from a
// generic attach failure so callers (Legal Capture) can show a specific
// "close DevTools and try again" message instead of a raw Chrome error.
export class DevToolsAttachedError extends Error {
    constructor(tabId) {
        super(`DevTools is already attached to tab ${tabId}`);
        this.name = "DevToolsAttachedError";
        this.tabId = tabId;
    }
}

// Track tabs this extension has the debugger attached to. The service worker
// can be terminated between captures, so we also reconcile with onDetach.
const attached = new Set();

chrome.debugger.onDetach.addListener(({ tabId }) => {
    if (tabId != null) attached.delete(tabId);
});

function rawAttach(tabId) {
    return new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            resolve();
        });
    });
}

function rawDetach(tabId) {
    return new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
            // Swallow lastError — "not attached" is fine, this is teardown.
            void chrome.runtime.lastError;
            resolve();
        });
    });
}

export async function attachDebugger(tabId) {
    if (attached.has(tabId)) return;
    try {
        await rawAttach(tabId);
        attached.add(tabId);
    } catch (err) {
        // Auto-recover from a leaked attach (prior session that never detached
        // cleanly — e.g. the service worker was killed mid-capture). Only ever
        // succeeds if WE owned the prior session; DevTools sessions are
        // untouchable from here so this can't hijack the user's debugger.
        if (/already attached/i.test(err.message)) {
            await rawDetach(tabId);
            try {
                await rawAttach(tabId);
                attached.add(tabId);
                return;
            } catch (retryErr) {
                // Our own detach didn't free the slot — something else (native
                // DevTools) genuinely holds it, not a leaked prior session of ours.
                if (/already attached/i.test(retryErr.message)) {
                    throw new DevToolsAttachedError(tabId);
                }
                throw retryErr;
            }
        }
        throw err;
    }
}

export async function detachDebugger(tabId) {
    if (!attached.has(tabId)) return;
    await rawDetach(tabId);
    attached.delete(tabId);
}
