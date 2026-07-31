(function () {
    // Tear down any previous instance from an earlier injection on this page.
    // Without this, a leaked observer can fire MUTATIONS_FINISHED later and
    // resolve the *next* capture's wait prematurely.
    if (window.__MutationCleanup) {
        try { window.__MutationCleanup(); } catch {}
    }

    // Site-tiered timing. Heavy SPAs re-render in multiple chunks on resize
    // and need a long debounce so we don't capture mid-rerender. Everything
    // else — static pages, blogs, docs — gets a fast tier with an
    // early-quiet exit that resolves immediately when no mutations arrive
    // in the first window after inject.
    const SLOW_HOSTS = [
        "facebook.com",
        "instagram.com",
        "x.com",
        "twitter.com",
        "vk.com",
        "t.me",
    ];
    const host = location.hostname.toLowerCase();
    const isSlow = SLOW_HOSTS.some(
        (h) => host === h || host.endsWith("." + h)
    );

    const DEBOUNCE_MS     = isSlow ? 1200 : 500;
    const MAX_WAIT_MS     = isSlow ? 5000 : 2500;
    // If no mutation arrives within this window after the watcher attaches,
    // the page is already settled — resolve immediately. Disabled on slow
    // hosts because their reflows can lag past this window.
    const EARLY_QUIET_MS  = isSlow ? 0    : 300;

    let debounceTimer = null;
    let maxWaitTimer = null;
    let earlyQuietTimer = null;
    let mutationCount = 0;
    let alive = true;

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

    const observer = new MutationObserver(() => {
        if (!alive) return;
        mutationCount++;
        clearTimeout(earlyQuietTimer);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(done, DEBOUNCE_MS);
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false, // too noisy
    });

    if (EARLY_QUIET_MS > 0) {
        earlyQuietTimer = setTimeout(() => {
            if (mutationCount === 0) done();
        }, EARLY_QUIET_MS);
    }
    maxWaitTimer = setTimeout(done, MAX_WAIT_MS);
    window.__MutationCleanup = cleanup;
})();
