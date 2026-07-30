// Requesting geolocation permission from inside the toolbar action popup
// closes it — the native permission prompt steals focus, and Chrome
// auto-dismisses action popups on blur. That made the "Operator geolocation"
// checkbox in Legal Capture Settings uncheckable: the popup (and the JS
// awaiting getCurrentPosition inside it) was torn down before an answer ever
// came back.
//
// The fix hands the actual navigator.geolocation.getCurrentPosition() call
// off to geoPermission.html, opened as an ordinary browser window via
// chrome.windows.create — a real window isn't subject to the action popup's
// close-on-blur behavior. That page reports the outcome back here so it can
// be persisted even though the settings popup that started the request is
// already gone by the time the user answers the prompt.
//
// Dedicated listener (not part of backgroundScript.js's owned action Set) —
// mirrors tabState.js's convention so it coexists with the main handler
// without channel conflicts.
export function registerGeoPermissionRelay() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.action === "openGeolocationPermissionWindow") {
            chrome.windows
                .create({
                    url: chrome.runtime.getURL("support/legalCapture/geoPermission.html"),
                    type: "popup",
                    width: 420,
                    height: 240,
                    focused: true,
                })
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) })
                );
            return true; // async response
        }

        if (request?.action === "legalGeolocationPermissionResult") {
            chrome.storage.local
                .get(["legalCaptureOptions"])
                .then(({ legalCaptureOptions }) =>
                    chrome.storage.local.set({
                        legalCaptureOptions: {
                            ...(legalCaptureOptions || {}),
                            geolocation: !!request.granted,
                        },
                    })
                )
                .then(() => sendResponse({ ok: true }))
                .catch((error) =>
                    sendResponse({ ok: false, error: error?.message ?? String(error) })
                );
            return true;
        }

        return false;
    });
}
