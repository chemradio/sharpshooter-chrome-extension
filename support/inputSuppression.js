// Suppress user input to a tab for the duration of a capture, via CDP
// `Input.setIgnoreInputEvents`. The browser process drops mouse, wheel,
// keyboard and touch events destined for that renderer — unlike the DOM
// overlay in captureOverlay.js, which only intercepts what bubbles through
// the page's own event path (it eats clicks, but wheel still chain-scrolls
// the document underneath and keystrokes reach whatever has focus).
//
// Used by Legal Capture, where the page must not change between the forced
// reload and the screenshot/DOM/MHTML snapshots. The overlay stays too — it
// is the *visible* explanation for why the page has gone inert; this is the
// actual enforcement.
//
// Scope, deliberately narrow: this only covers input to the page. Browser
// chrome (tab switching, Back, closing the tab) is untouchable from an
// extension, and the page's own JS keeps running. It prevents the operator
// from disturbing the page mid-capture; it is not a defence against an
// operator who does not want an honest capture.
//
// Lifetime: the flag is owned by the debugger session, so it survives the
// in-tab navigation that destroys the DOM overlay, and Chrome clears it
// automatically when the debugger detaches. A capture that throws — or a
// service worker that gets killed mid-flight — therefore cannot strand the
// tab in an unresponsive state.

const setIgnoreInputEvents = (tabId, ignore) =>
    new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, "Input.setIgnoreInputEvents", { ignore }, () => {
            // Best-effort: an older Chrome without the command, or a debugger
            // that has already gone away, must not fail the capture.
            const err = chrome.runtime.lastError;
            resolve(!err);
        });
    });

// Returns true if the browser accepted the command, so callers can disclose
// truthfully whether input was actually suppressed rather than assuming it.
export const suppressPageInput = (tabId) => setIgnoreInputEvents(tabId, true);

export const restorePageInput = (tabId) => setIgnoreInputEvents(tabId, false);
