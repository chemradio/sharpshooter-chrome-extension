// Diagnostic breadcrumb trail for Legal Capture.
//
// Legal Capture is the one flow where a failure can leave no trace anywhere:
// the popup that would show the error is closed (or its message port died with
// the service worker), and chrome://extensions' Errors panel only lists
// *uncaught* exceptions — a rejection the popup already caught, or an MV3
// service-worker termination mid-capture, produces exactly the reported
// symptom: no download, no error, nothing in the panel.
//
// So each step writes a timestamped line straight into chrome.storage.local as
// it happens. Storage survives both the popup closing and the worker being
// killed, so the last line in the trace names the step the capture died in.
// Read it from the service-worker console:
//
//   chrome.storage.local.get("legalCaptureTrace")
//       .then(r => console.table(r.legalCaptureTrace))
//
// A trace whose last entry is a step (not "done" / "failed") means the worker
// died there — nothing threw, execution simply stopped.

const KEY = "legalCaptureTrace";
const MAX_ENTRIES = 200;

let entries = [];
let t0 = 0;

export function traceStart(meta) {
    t0 = Date.now();
    entries = [];
    return traceStep("start", meta);
}

export async function traceStep(step, detail) {
    const entry = {
        step,
        at: new Date().toISOString(),
        // Elapsed matters more than wall-clock here: it's what identifies a
        // step that ran long enough for the worker's idle timer to fire.
        ms: t0 ? Date.now() - t0 : 0,
        ...(detail === undefined ? {} : { detail }),
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    console.log(`[legal-capture] +${entry.ms}ms ${step}`, detail ?? "");
    // Written per step rather than batched at the end — a batched write is
    // exactly the thing that never happens when the worker is killed.
    try {
        await chrome.storage.local.set({ [KEY]: entries });
    } catch {
        // A failed diagnostic write must never be what breaks a capture.
    }
}

export function traceError(step, error) {
    console.error(`[legal-capture] failed at ${step}:`, error);
    return traceStep("failed", {
        step,
        message: error?.message ?? String(error),
        name: error?.name ?? null,
        stack: error?.stack ?? null,
    });
}
