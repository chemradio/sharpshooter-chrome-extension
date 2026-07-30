// Single source of truth for which pieces of a Legal Capture package are
// user-toggleable, their defaults, and which (if any) chrome optional
// permission a toggle needs before it can be turned on. Shared between
// popup.js (renders the Legal Capture Settings subpage and requests
// permissions on toggle) and the capture pipeline itself (legalCaptureSession.js,
// backgroundScript.js), so the two can never drift out of sync on what a
// given key means.
//
// Defaults: anything that only uses permissions the extension already has
// defaults ON (network recording, screenshot, DOM/MHTML snapshots,
// timestamps, hashes, page-environment info). Anything that requires a new
// optional permission — and therefore a new category of personal data the
// operator may not expect to be collected automatically — defaults OFF
// (machine info, geolocation, the signed-in Chrome account email).
export const LEGAL_CAPTURE_OPTION_DEFAULTS = {
    networkRecording: true,
    webSocketCapture: true,
    serviceWorkerCapture: true,
    screenshot: true,
    domSnapshot: true,
    mhtmlSnapshot: true,
    timestampsEnabled: true,
    tsaFreeTSA: true,
    tsaDigiCert: true,
    tsaSectigo: true,
    sha256Sums: true,
    machineInfo: false,
    browserPageInfo: true,
    geolocation: false,
    accountEmail: false,
};

// option key -> chrome optional_permissions entries it needs (see
// manifest.json). Requested via chrome.permissions.request() at the moment
// the operator turns the toggle on (popup.js), never declared as a
// standing/mandatory permission.
//
// geolocation is deliberately absent here: Chrome does not allow
// "geolocation" to be listed in optional_permissions at all (it's one of a
// handful of API permissions — alongside e.g. "debugger", "devtools" — that
// can only ever be a standing permission, never optional). Declaring it
// silently gets it dropped with a console warning at install. Instead,
// popup.js's geolocation toggle relies on the ordinary per-origin Geolocation
// API prompt Chrome shows the first time navigator.geolocation is actually
// called from the popup — no manifest permission needed either way.
export const LEGAL_CAPTURE_OPTION_PERMISSIONS = {
    machineInfo: ["system.cpu", "system.memory", "system.display"],
    accountEmail: ["identity"],
};

export function resolveLegalCaptureOptions(stored) {
    return { ...LEGAL_CAPTURE_OPTION_DEFAULTS, ...(stored ?? {}) };
}
