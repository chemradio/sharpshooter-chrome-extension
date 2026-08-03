(function () {
    // Tear down any previous instance from an earlier injection on this page.
    // Without this, a leaked observer can fire MUTATIONS_FINISHED later and
    // resolve the *next* capture's wait prematurely.
    if (window.__MutationCleanup) {
        try { window.__MutationCleanup(); } catch {}
    }

    // Behaviour-tiered timing, measured on this page rather than guessed from
    // its hostname. Heavy SPAs re-render in multiple chunks on resize and need
    // a long debounce so we don't capture mid-rerender; static pages, blogs and
    // docs settle almost immediately. We start in the fast tier and escalate to
    // the slow one once the observed mutation volume shows the page is churning.
    const DEBOUNCE_FAST_MS = 500;
    const DEBOUNCE_SLOW_MS = 1200;
    const MAX_WAIT_FAST_MS = 2500;
    const MAX_WAIT_SLOW_MS = 5000;
    // If no mutation arrives within this window after the watcher attaches,
    // the page is already settled — resolve immediately. Cancelled by the
    // first mutation, so a churning page never takes this exit.
    const EARLY_QUIET_MS   = 300;
    // Mutation records seen before we call the page heavy. A settling static
    // page produces a handful; a re-rendering SPA blows past this at once.
    const HEAVY_MUTATIONS  = 150;

    let debounceMs = DEBOUNCE_FAST_MS;
    let heavy = false;

    let debounceTimer = null;
    let maxWaitTimer = null;
    let earlyQuietTimer = null;
    let mutationCount = 0;
    let alive = true;
    const startedAt = Date.now();

    function cleanup() {
        alive = false;
        clearTimeout(debounceTimer);
        clearTimeout(maxWaitTimer);
        clearTimeout(earlyQuietTimer);
        observer.disconnect();
        if (window.__MutationCleanup === cleanup) {
            delete window.__MutationCleanup;
        }
    }

    function done() {
        if (!alive) return;
        cleanup();
        chrome.runtime.sendMessage({ type: "MUTATIONS_FINISHED" });
    }

    const observer = new MutationObserver((records) => {
        if (!alive) return;
        mutationCount += records.length;
        if (!heavy && mutationCount >= HEAVY_MUTATIONS) {
            // Escalate once: longer debounce, and extend the hard ceiling from
            // whenever the watcher attached.
            heavy = true;
            debounceMs = DEBOUNCE_SLOW_MS;
            clearTimeout(maxWaitTimer);
            maxWaitTimer = setTimeout(
                done,
                Math.max(0, MAX_WAIT_SLOW_MS - (Date.now() - startedAt))
            );
        }
        clearTimeout(earlyQuietTimer);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(done, debounceMs);
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false, // too noisy
    });

    earlyQuietTimer = setTimeout(() => {
        if (mutationCount === 0) done();
    }, EARLY_QUIET_MS);
    maxWaitTimer = setTimeout(done, MAX_WAIT_FAST_MS);
    window.__MutationCleanup = cleanup;
})();
