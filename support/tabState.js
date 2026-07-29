// Per-tab flags needed by Legal Capture's "was the HTML disturbed before
// this capture?" gate. chrome.storage.session (not an in-memory Map) because
// the service worker can be torn down and restarted between the user's
// Remove Elements click and their later Legal Capture click — an in-memory
// flag would silently reset to "safe" and defeat the whole point of the gate.

const keyFor = (tabId) => `domKillerUsed:${tabId}`;

export async function markDomKillerUsed(tabId) {
    await chrome.storage.session.set({ [keyFor(tabId)]: true });
}

export async function wasDomKillerUsed(tabId) {
    const stored = await chrome.storage.session.get(keyFor(tabId));
    return !!stored[keyFor(tabId)];
}

export async function clearDomKillerUsed(tabId) {
    await chrome.storage.session.remove(keyFor(tabId));
}

// A fresh navigation restores pristine server HTML, so any earlier Remove
// Elements use on that tab stops being relevant — clear the flag the moment
// a new load starts, not when it finishes (loading/committed is early enough
// that no capture can race in in-between with stale removed-DOM state).
export function registerTabResetListener() {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.status === "loading") {
            clearDomKillerUsed(tabId).catch(() => {});
        }
    });
}

// Dedicated listener (not part of backgroundScript.js's owned action Set) for
// the domKiller.js broadcast — mirrors the elementClicked listener's
// "own one action, return false otherwise" convention so it coexists with
// the main handler without channel conflicts.
export function registerDomKillerUsedListener() {
    chrome.runtime.onMessage.addListener((request, sender) => {
        if (request?.action !== "domKillerUsed") return false;
        if (sender?.tab?.id != null) markDomKillerUsed(sender.tab.id).catch(() => {});
        return false;
    });
}
