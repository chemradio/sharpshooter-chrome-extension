// Threads (threads.com) Auto Mode module.
//
// Post pages target the post pagelet inside the column body. Other pages
// (profile, feed) get no prompt and fall through to Auto/Page Capture.

(() => {
    const COLUMN_BODY_SELECTOR = '[aria-label="Column body"]';
    // The pagelet id is `threads_post_page_<n>`; the first one ("_0") holds
    // the focused post, the rest are replies. Match by prefix so a Threads
    // rename of the suffix scheme doesn't break detection.
    const POST_PAGELET_SELECTOR = '[data-pagelet^="threads_post_page"]';

    // Inner chrome to strip for framing — a top "Pinned"/follow strip and a
    // bottom action row that don't belong in the screenshot.
    const INNER_CLEANUP_SELECTORS = [
        "div.x78zum5.x49hn82.xcrlgei.x7a106z.xz6dhga.x13fuv20.xt8cgyo.x1rlzn12.xt7dq6l.x1hmvnq2.x1svr5r5.x1py1tus.x1tr5nd9.x3su7b9",
        'div[role="none"].x49hn82.xcrlgei.x1tmp44o.xjkvuk6.x1yrsyyn.x1svr5r5.x1py1tus.x1tr5nd9.x3su7b9',
    ];

    const PRESSABLE_SELECTOR = 'div[data-pressable-container="true"][data-interactive-id]';

    let detectorHit = null;

    const getPageType = () => {
        const column = document.querySelector(COLUMN_BODY_SELECTOR);
        if (!column) return "unknown";
        const post = column.querySelector(POST_PAGELET_SELECTOR);
        if (post) {
            detectorHit = `${COLUMN_BODY_SELECTOR} ${POST_PAGELET_SELECTOR}`;
            return "post";
        }
        return "unknown";
    };

    const getPostElement = () => {
        const column = document.querySelector(COLUMN_BODY_SELECTOR);
        if (!column) return null;
        return column.querySelector(POST_PAGELET_SELECTOR);
    };

    const cleanupInside = (root) => {
        let removed = 0;
        for (const sel of INNER_CLEANUP_SELECTORS) {
            try {
                for (const el of root.querySelectorAll(sel)) {
                    el.remove();
                    removed += 1;
                }
            } catch {}
        }
        return removed;
    };

    // Threads renders the focused post with asymmetric padding — left/right
    // get the card gutter but the top is flush against the now-removed
    // chrome. Mirror the side padding on the top so the framed card breathes.
    const equalizePressablePadding = (root) => {
        let touched = 0;
        for (const el of root.querySelectorAll(PRESSABLE_SELECTOR)) {
            const cs = getComputedStyle(el);
            const left = cs.paddingLeft;
            const right = cs.paddingRight;
            // Use whichever side reads non-zero; both should match in practice.
            const target = parseFloat(left) > 0 ? left : right;
            if (!target || target === "0px") continue;
            el.style.paddingTop = target;
            touched += 1;
        }
        return touched;
    };

    window.__AutoCapturePending = (async () => {
        try {
            const pageType = getPageType();
            if (window.__SiteOptions?.detectOnly) {
                console.log(
                    `[Auto/threads] detect: page=${pageType} via=${detectorHit ?? "none"}`,
                );
                return { mode: "detect", pageType };
            }
            console.log(
                `[Auto/threads] page=${pageType} via=${detectorHit ?? "none"}`,
            );

            if (pageType === "post") {
                const el = getPostElement();
                if (!el) {
                    console.log("[Auto/threads] target=MISS");
                    return { mode: "page" };
                }
                const removed = cleanupInside(el);
                const padded = equalizePressablePadding(el);
                console.log(
                    `[Auto/threads] cleanup: INNER=${removed} PADDED=${padded}`,
                );
                return { mode: "element", xpath: window.__BuildXPath(el) };
            }
            return { mode: "page" };
        } catch (e) {
            console.warn("[Auto/threads]", e);
            return { mode: "page" };
        }
    })();
})();
