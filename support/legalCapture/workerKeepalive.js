// Keeps the MV3 service worker alive across a long stretch of work that makes
// no extension API calls of its own.
//
// Chrome terminates an extension service worker after ~30s without events or
// chrome.* API calls. A pending fetch does not count — so a slow or
// unreachable TSA, followed by WARC/WACZ assembly and base64-encoding the
// package, can age the worker out mid-capture. That failure is completely
// silent: nothing throws, execution simply stops, so there is no rejection for
// the popup to show and no uncaught error for chrome://extensions to list. The
// user sees a capture that produced no download and no message.
//
// The fix is the documented one: make a trivial extension API call on a timer.
// getPlatformInfo needs no permission and does no I/O.
//
// This is a mitigation, not a licence for unbounded waits — every network call
// inside the guarded region should still have its own timeout (see
// tsaClient.js). Chrome also enforces a hard 5-minute ceiling on a single
// request's processing, which no keepalive can extend.

const INTERVAL_MS = 20000;

export async function withWorkerKeepalive(body) {
    const timer = setInterval(() => {
        chrome.runtime.getPlatformInfo().catch(() => {});
    }, INTERVAL_MS);
    try {
        return await body();
    } finally {
        clearInterval(timer);
    }
}
