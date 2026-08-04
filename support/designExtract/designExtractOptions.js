// Single source of truth for which pieces of an Extract Design package are
// produced and how the collector behaves. Shared between popup.js (renders
// the Design Settings subpage) and the extraction pipeline (designSession.js)
// so the two can't drift on what a key means.
//
// Unlike Legal Capture, nothing here needs a new Chrome permission —
// downloads, scripting, debugger and <all_urls> are all already held. That's
// a deliberate constraint: it keeps this feature out of Web Store permission
// review entirely. Do not add an option that requires one without weighing
// that cost.
export const DESIGN_OPTION_DEFAULTS = {
    // ─── Artifacts ───────────────────────────────────────────────────────
    screenshot: true,       // screenshot.png — the element as rendered
    card: true,             // card.png — the shareable spec sheet image
    specSheet: true,        // design.md — pastes into Notion/Linear/GitHub
    designJson: true,       // design.json — machine-readable, source of truth
    elementHtml: false,     // element.html — standalone rebuild (v2, see below)

    // ─── Collection depth ────────────────────────────────────────────────
    // Sampling hover/focus/active means re-forcing pseudo-state and
    // re-reading the subtree three extra times. It roughly triples the
    // in-page collection cost (still well under a second on typical
    // components) and is the single most useful thing here for a web
    // designer, so it defaults on.
    sampleStates: true,
    customProperties: true, // resolve var() tokens in scope on the element
    contrastRatios: true,   // WCAG AA/AAA for each text-on-background pair

    // ─── Output ──────────────────────────────────────────────────────────
    // Light card by default: these end up in decks, docs and print far more
    // often than in a dark IDE.
    cardTheme: "light",
};

// Hard ceilings on subtree traversal. A component is tens of nodes; anything
// in the thousands means the user grabbed a page section, where a per-node
// dump stops being useful anyway and the aggregates carry the value.
export const DESIGN_LIMITS = {
    maxNodes: 2000,
    maxDepth: 12,
};

export function resolveDesignOptions(stored) {
    return { ...DESIGN_OPTION_DEFAULTS, ...(stored ?? {}) };
}
