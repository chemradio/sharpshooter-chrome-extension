// Runs in its own top-level browser window (opened by
// geoPermissionRelay.js) instead of the toolbar action popup, because the
// native geolocation permission prompt steals focus and Chrome auto-closes
// action popups on blur. Reports the outcome back to the service worker,
// which persists it into legalCaptureOptions, then closes itself.

let settled = false;

function finish(granted) {
    if (settled) return;
    settled = true;
    chrome.runtime
        .sendMessage({ action: "legalGeolocationPermissionResult", granted })
        .catch(() => {})
        .finally(() => window.close());
}

if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
        () => finish(true),
        () => finish(false),
        { timeout: 20000, maximumAge: 0 }
    );
} else {
    finish(false);
}

// Safety net in case the prompt is left unanswered — don't leave the window
// (and an unresolved toggle state) hanging forever.
setTimeout(() => finish(false), 25000);
