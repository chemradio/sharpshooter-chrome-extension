// Shared live-page measurement helpers. Used by backgroundScript.js's
// getPageHeight/getViewportSize actions (which feed the popup's "User" /
// "Full Page" smart presets) and by support/legalCapture/legalCaptureSession.js,
// which needs to re-measure AFTER its forced reload rather than trust the
// popup's pre-reload numbers — a fresh reload can genuinely have less
// lazy-loaded content than whatever was on screen when the popup measured it.

export function measurePageHeight(tabId) {
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
            {
                target: { tabId },
                func: () => {
                    document.body.style.zoom = "";
                    return Math.max(
                        document.body.scrollHeight,
                        document.documentElement.scrollHeight,
                        document.body.offsetHeight,
                        document.documentElement.offsetHeight,
                        document.body.clientHeight,
                        document.documentElement.clientHeight
                    );
                },
            },
            (results) => {
                if (chrome.runtime.lastError)
                    return reject(new Error(chrome.runtime.lastError.message));
                resolve(results?.[0]?.result);
            }
        );
    });
}

// Reports CSS-pixel viewport (window.innerWidth/Height) — the actual layout
// size the page is using at the current zoom, matching what "User" captures.
export async function measureViewportSize(tabId) {
    const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
            width: window.innerWidth,
            height: window.innerHeight,
        }),
    });
    return result?.width && result?.height ? result : null;
}
