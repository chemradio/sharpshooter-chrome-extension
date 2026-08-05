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
    startTimestamp: true,
    tsaFreeTSA: true,
    tsaDigiCert: true,
    tsaSectigo: true,
    sha256Sums: true,
    machineInfo: false,
    browserPageInfo: true,
    geolocation: false,
    accountEmail: false,
    // Not a toggle: seconds to keep waiting after the forced reload reports
    // "complete", before anything is measured or captured. See
    // MAX_POST_LOAD_WAIT_SECONDS below for why it's bounded.
    postLoadWaitSeconds: 0,
};

// The load event fires when the document and its subresources have loaded —
// which on a client-rendered page is often *before* the content exists.
// Framework hydration, lazy images, and post-load XHR all land after it, and
// the mutation-settle pass that follows can legitimately conclude a page is
// quiet while it is merely waiting on a request that hasn't returned yet.
// This wait is the operator's manual override for that: it costs nothing on a
// server-rendered page (default 0) and is the difference between capturing a
// skeleton and capturing the page on an app that hydrates slowly.
//
// Bounded at two minutes. Chrome caps a single service-worker task at five
// minutes no matter what keeps the worker alive (see workerKeepalive.js), and
// the wait is only one phase of the capture — the reload, snapshots, TSA
// requests and packaging all have to fit in the same budget.
export const MAX_POST_LOAD_WAIT_SECONDS = 120;

export function resolvePostLoadWaitSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n), MAX_POST_LOAD_WAIT_SECONDS);
}

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
    const merged = { ...LEGAL_CAPTURE_OPTION_DEFAULTS, ...(stored ?? {}) };
    // Normalized here rather than at the call site: this object is written
    // verbatim into manifest.json's captureOptions, so the sealed record has
    // to show the value the capture actually used, not what was typed.
    merged.postLoadWaitSeconds = resolvePostLoadWaitSeconds(merged.postLoadWaitSeconds);
    return merged;
}
