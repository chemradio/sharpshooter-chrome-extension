// Phase timing for the capture pipeline. Logs a single console.table per
// capture to the service worker console (chrome://extensions → "service
// worker"), so a slow capture can be attributed to a specific phase instead
// of guessed at.
//
// One trace is active at a time. Nested starts (downloadScreenshot runs
// inside withEmulatedCapture's body) join the outer trace via a depth
// counter, so every phase lands in one table.

let active = null;
let depth = 0;

export function startTrace(label) {
    if (!active) {
        active = { label, t0: performance.now(), marks: [] };
    }
    depth++;
    return active;
}

// Time `fn` and record it under `name`. Duration is recorded even when `fn`
// throws, so a failed capture still explains where the time went.
export async function step(name, fn) {
    if (!active) return fn();
    const s = performance.now();
    try {
        return await fn();
    } finally {
        active.marks.push({ phase: name, ms: Math.round(performance.now() - s) });
    }
}

// Record a value alongside the phases (image dimensions, byte counts) —
// context that explains why a phase cost what it did.
export function note(name, value) {
    if (active) active.marks.push({ phase: name, ms: value });
}

export function endTrace() {
    if (!active) return;
    depth--;
    if (depth > 0) return;
    const total = Math.round(performance.now() - active.t0);
    console.log(`[perf] ${active.label}: ${total} ms total`);
    console.table(active.marks);
    active = null;
}
