// Reset the tab's browser zoom to 1 for the duration of `fn`, then restore.
//
// Why this exists: Chrome's per-tab browser zoom is applied as a display
// transform on top of layout. With zoom != 1, `window.innerWidth` is in
// zoom-adjusted CSS pixels and `Emulation.setDeviceMetricsOverride` interacts
// with the zoom in ways that produce wrong layouts and crop offsets:
//
//   * Element capture: Page.captureScreenshot renders at emulatedDPR ×
//     browserZoom pixels, but getBoundingClientRect only accounts for
//     emulatedDPR. At 110% zoom the screenshot is 10% wider/taller than
//     expected and the crop misses.
//
//   * Page capture: emulating a 1920-wide viewport while the user is at
//     175% zoom forces the page into a narrow layout (sidebar collapses,
//     post column widens) because the renderer sees the requested width
//     interact with the zoom transform.
//
// Resetting zoom to 1 makes the renderer honest: emulate the literal width
// we want, capture, restore the user's zoom afterwards.

const getZoom = (tabId) =>
    new Promise((resolve, reject) =>
        chrome.tabs.getZoom(tabId, (z) => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            resolve(z);
        })
    );

const setZoom = (tabId, zoom) =>
    new Promise((resolve, reject) =>
        chrome.tabs.setZoom(tabId, zoom, () => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            resolve();
        })
    );

export async function withZoomReset(tabId, fn) {
    const originalZoom = await getZoom(tabId);
    const needsReset = Math.abs(originalZoom - 1) > 0.001;
    if (needsReset) {
        await setZoom(tabId, 1);
    }
    try {
        return await fn();
    } finally {
        if (needsReset) {
            await setZoom(tabId, originalZoom).catch(() => {});
        }
    }
}
