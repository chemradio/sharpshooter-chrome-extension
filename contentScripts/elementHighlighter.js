(function () {
    // Guard against double-injection: if a previous instance is running, clean it up first.
    // window is the shared isolated-world window, so this persists across executeScript calls.
    if (window.__HighlighterDestroy) {
        window.__HighlighterDestroy();
    }

    // ─── State ────────────────────────────────────────────────────────────────

    let deviceMetrics = null;
    let screenshotSuffix = null;
    let manualCrop = false;
    let currentElement = null;

    const STYLE_ID   = "__hl-style";
    const OVERLAY_ID = "__hl-overlay";
    const COLOR      = "#0ECAE3";
    const Z          = 2147483646;

    // Hover updates run on a requestAnimationFrame throttle so wide mouse
    // moves snap the highlight live instead of waiting for the pointer to
    // settle. MOVEMENT_THRESHOLD is the only filter against sub-pixel tremor.
    const MOVEMENT_THRESHOLD = 4;
    // After a wheel event, hover updates are frozen for this long so the user
    // doesn't need to hold the mouse perfectly still while scrolling the tree.
    const SCROLL_LOCK_MS     = 400;

    // Remembers, per parent element, which child the user ascended from — so a
    // later wheel-down returns to that child instead of always firstElementChild.
    // Lets the user overshoot upward and walk back down the same branch.
    const descentMemory = new WeakMap();

    let lastCommittedX   = -9999;
    let lastCommittedY   = -9999;
    let pendingX         = 0;
    let pendingY         = 0;
    let hoverRafId       = null;
    let scrollLockTimer    = null;
    let isScrollLocked     = false;
    let firstPaint         = true;

    // ─── Receive device metrics sent by background after injection ────────────

    const metricsListener = (message) => {
        if (message.action === "sendDeviceMetrics") {
            deviceMetrics = message.deviceMetrics;
            screenshotSuffix = message.screenshotSuffix;
            manualCrop = !!message.manualCrop;
        }
    };
    chrome.runtime.onMessage.addListener(metricsListener);

    // ─── Highlight styles ─────────────────────────────────────────────────────

    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            #${OVERLAY_ID}, #${OVERLAY_ID} * {
                pointer-events: none !important;
                box-sizing: border-box !important;
            }
            #${OVERLAY_ID} {
                position: fixed !important;
                inset: 0 !important;
                z-index: ${Z} !important;
                display: none;
            }
            #${OVERLAY_ID}.__hl-on { display: block; }
            @keyframes __hlPulseFrame {
                0%, 100% { box-shadow: 0 0 6px ${COLOR},  inset 0 0 6px  rgba(14, 202, 227, 0.12); }
                50%      { box-shadow: 0 0 18px ${COLOR}, inset 0 0 12px rgba(14, 202, 227, 0.28); }
            }
            @keyframes __hlPulseGlow {
                0%, 100% { box-shadow: 0 0 4px  ${COLOR}; }
                50%      { box-shadow: 0 0 12px ${COLOR}; }
            }
            @keyframes __hlPulseLabel {
                0%, 100% { box-shadow: 0 0 4px  rgba(14, 202, 227, 0.5); }
                50%      { box-shadow: 0 0 12px rgba(14, 202, 227, 0.9); }
            }
            @keyframes __hlMarch {
                to {
                    background-position:
                        12.728px 0,
                        14px 0, -14px 100%,
                        0 -14px, 100% 14px;
                }
            }
            .__hl-dim {
                position: absolute !important;
                background: rgba(0, 0, 0, 0.45) !important;
                transition: left 240ms ease-out, top 240ms ease-out,
                            width 240ms ease-out, height 240ms ease-out !important;
            }
            .__hl-frame {
                position: absolute !important;
                border: 1px solid ${COLOR} !important;
                background-image:
                    repeating-linear-gradient(45deg,
                        transparent 0 7px,
                        rgba(14, 202, 227, 0.10) 7px 9px),
                    linear-gradient(90deg, ${COLOR} 50%, transparent 50%),
                    linear-gradient(90deg, ${COLOR} 50%, transparent 50%),
                    linear-gradient(0deg,  ${COLOR} 50%, transparent 50%),
                    linear-gradient(0deg,  ${COLOR} 50%, transparent 50%) !important;
                background-position: 0 0, 0 0, 0 100%, 0 0, 100% 0;
                background-repeat: repeat, repeat-x, repeat-x, repeat-y, repeat-y !important;
                background-size: auto, 14px 1px, 14px 1px, 1px 14px, 1px 14px !important;
                animation:
                    __hlPulseFrame 1.6s ease-in-out infinite,
                    __hlMarch 700ms linear infinite !important;
                transition: left 240ms ease-out, top 240ms ease-out,
                            width 240ms ease-out, height 240ms ease-out !important;
            }
            .__hl-corner {
                position: absolute !important;
                width: 14px !important;
                height: 14px !important;
                border: 2px solid ${COLOR} !important;
                background: rgba(14, 202, 227, 0.18) !important;
                animation: __hlPulseGlow 1.6s ease-in-out infinite !important;
            }
            .__hl-c-tl { top: -2px;    left: -2px;    border-right: 0 !important; border-bottom: 0 !important; }
            .__hl-c-tr { top: -2px;    right: -2px;   border-left:  0 !important; border-bottom: 0 !important; }
            .__hl-c-bl { bottom: -2px; left: -2px;    border-right: 0 !important; border-top:    0 !important; }
            .__hl-c-br { bottom: -2px; right: -2px;   border-left:  0 !important; border-top:    0 !important; }
            .__hl-handle {
                position: absolute !important;
                background: ${COLOR} !important;
                animation: __hlPulseGlow 1.6s ease-in-out infinite !important;
                transition: left 240ms ease-out, top 240ms ease-out,
                            width 240ms ease-out, height 240ms ease-out !important;
            }
            .__hl-label {
                position: absolute !important;
                font: 700 10px/1 "Courier New", ui-monospace, monospace !important;
                color: ${COLOR} !important;
                text-shadow: 0 0 4px ${COLOR} !important;
                background: rgba(0, 0, 0, 0.7) !important;
                padding: 3px 6px !important;
                letter-spacing: 0.12em !important;
                white-space: nowrap !important;
                border: 1px solid ${COLOR} !important;
                animation: __hlPulseLabel 1.6s ease-in-out infinite !important;
            }
            .__hl-l-w { left: 50%; bottom: 100%; transform: translate(-50%, -18px); }
            .__hl-l-h { top: 50%;  right: 100%;  transform-origin: right center;
                        transform: translateY(-50%) translateX(-18px) rotate(-90deg); }
            .__hl-tip {
                position: absolute !important;
                display: none;
                max-width: 300px !important;
                font: 600 11.5px/1.45 -apple-system, "Segoe UI", Arial, sans-serif !important;
                color: #fff !important;
                background: rgba(0, 0, 0, 0.86) !important;
                border: 1px solid ${COLOR} !important;
                border-radius: 5px !important;
                padding: 7px 10px !important;
                box-shadow: 0 0 12px rgba(14, 202, 227, 0.65) !important;
                white-space: normal !important;
                transition: left 240ms ease-out, top 240ms ease-out !important;
            }
            .__hl-tip.__hl-tip-on { display: block; }
            .__hl-tip b { color: ${COLOR} !important; font-weight: 700 !important; }
            html.__hl-cursor, html.__hl-cursor * { cursor: crosshair !important; }
        `;
        document.head.appendChild(style);
        document.documentElement.classList.add("__hl-cursor");
    }

    // ─── Overlay (frame + crosshair handles + dimension labels + backdrop dim) ─

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
        <div class="__hl-dim" data-dim="top"></div>
        <div class="__hl-dim" data-dim="right"></div>
        <div class="__hl-dim" data-dim="bottom"></div>
        <div class="__hl-dim" data-dim="left"></div>
        <div class="__hl-handle" data-handle="top"></div>
        <div class="__hl-handle" data-handle="bottom"></div>
        <div class="__hl-handle" data-handle="left"></div>
        <div class="__hl-handle" data-handle="right"></div>
        <div class="__hl-frame" data-frame>
            <div class="__hl-corner __hl-c-tl"></div>
            <div class="__hl-corner __hl-c-tr"></div>
            <div class="__hl-corner __hl-c-bl"></div>
            <div class="__hl-corner __hl-c-br"></div>
            <div class="__hl-label __hl-l-w" data-label-w></div>
            <div class="__hl-label __hl-l-h" data-label-h></div>
        </div>
        <div class="__hl-tip" data-tip>
            <b>Scroll wheel</b> to walk the DOM — up = parent, down = child.<br>
            <b>Click</b> to capture the highlighted element · <b>Esc</b> to cancel.
        </div>
    `;
    document.documentElement.appendChild(overlay);

    const frameEl  = overlay.querySelector("[data-frame]");
    const labelW   = overlay.querySelector("[data-label-w]");
    const labelH   = overlay.querySelector("[data-label-h]");
    const dimTop   = overlay.querySelector('[data-dim="top"]');
    const dimRight = overlay.querySelector('[data-dim="right"]');
    const dimBot   = overlay.querySelector('[data-dim="bottom"]');
    const dimLeft  = overlay.querySelector('[data-dim="left"]');
    const hTop     = overlay.querySelector('[data-handle="top"]');
    const hBot     = overlay.querySelector('[data-handle="bottom"]');
    const hLeft    = overlay.querySelector('[data-handle="left"]');
    const hRight   = overlay.querySelector('[data-handle="right"]');
    const tipEl    = overlay.querySelector("[data-tip]");

    // The navigation hint is opt-out via Settings; default on. Read async —
    // until it resolves the tip stays hidden, then a repaint reveals it.
    let tooltipEnabled = false;
    chrome.storage.local.get("showNavTooltip").then((s) => {
        tooltipEnabled = s.showNavTooltip !== false;
        if (currentElement) paintOverlay(currentElement.getBoundingClientRect());
    });

    // Pin the hint to the frame without covering the targeted element: prefer
    // below the frame, flip above when there's no room, and clamp horizontally
    // so it stays fully on-screen.
    function placeTooltip(rect) {
        if (!tooltipEnabled) {
            tipEl.classList.remove("__hl-tip-on");
            return;
        }
        tipEl.classList.add("__hl-tip-on");

        const vw  = window.innerWidth;
        const vh  = window.innerHeight;
        const tw  = tipEl.offsetWidth;
        const th  = tipEl.offsetHeight;
        const GAP = 14;

        let top;
        if (rect.bottom + GAP + th <= vh)      top = rect.bottom + GAP;
        else if (rect.top - GAP - th >= 0)     top = rect.top - GAP - th;
        else                                   top = vh - th - GAP;

        let left = rect.left + rect.width / 2 - tw / 2;
        left = Math.max(GAP, Math.min(left, vw - tw - GAP));

        tipEl.style.top  = `${Math.max(GAP, top)}px`;
        tipEl.style.left = `${left}px`;
    }

    function paintOverlay(rect) {
        if (!rect) {
            overlay.classList.remove("__hl-on");
            tipEl.classList.remove("__hl-tip-on");
            firstPaint = true;
            return;
        }
        overlay.classList.add("__hl-on");

        // First-detect intro: snap frame to viewport with no transition,
        // flush layout, then enable a 320ms transition so the next rect
        // assignment shrinks the frame inward toward the target.
        if (firstPaint) {
            firstPaint = false;
            const vw0 = window.innerWidth;
            const vh0 = window.innerHeight;
            const intro = "left 560ms cubic-bezier(.2,.7,.2,1),"
                + " top 560ms cubic-bezier(.2,.7,.2,1),"
                + " width 560ms cubic-bezier(.2,.7,.2,1),"
                + " height 560ms cubic-bezier(.2,.7,.2,1)";
            frameEl.style.transition = "none";
            frameEl.style.left   = "0px";
            frameEl.style.top    = "0px";
            frameEl.style.width  = `${vw0}px`;
            frameEl.style.height = `${vh0}px`;
            void frameEl.offsetWidth;
            frameEl.style.transition = intro;
            setTimeout(() => { frameEl.style.transition = ""; }, 620);
        }

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const l = Math.max(0, rect.left);
        const t = Math.max(0, rect.top);
        const r = Math.min(vw, rect.right);
        const b = Math.min(vh, rect.bottom);

        frameEl.style.left   = `${rect.left}px`;
        frameEl.style.top    = `${rect.top}px`;
        frameEl.style.width  = `${rect.width}px`;
        frameEl.style.height = `${rect.height}px`;

        labelW.textContent = `${Math.round(rect.width)} PX`;
        labelH.textContent = `${Math.round(rect.height)} PX`;

        setRect(dimTop,   0, 0,  vw,            Math.max(0, t));
        setRect(dimBot,   0, b,  vw,            Math.max(0, vh - b));
        setRect(dimLeft,  0, t,  Math.max(0,l), Math.max(0, b - t));
        setRect(dimRight, r, t,  Math.max(0,vw-r), Math.max(0, b - t));

        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        setRect(hTop,   cx - 1, 0,           2, Math.max(0, rect.top));
        setRect(hBot,   cx - 1, rect.bottom, 2, Math.max(0, vh - rect.bottom));
        setRect(hLeft,  0,           cy - 1, Math.max(0, rect.left),     2);
        setRect(hRight, rect.right,  cy - 1, Math.max(0, vw - rect.right), 2);

        placeTooltip(rect);
    }

    function setRect(el, x, y, w, h) {
        el.style.left   = `${x}px`;
        el.style.top    = `${y}px`;
        el.style.width  = `${w}px`;
        el.style.height = `${h}px`;
    }

    // ─── XPath ────────────────────────────────────────────────────────────────

    function getXPath(element) {
        if (element.id) {
            const id = element.id;
            // XPath string literals can't contain both quote types — fall through
            // to positional XPath for exotic IDs that contain both.
            if (!id.includes('"')) return `//*[@id="${id}"]`;
            if (!id.includes("'")) return `//*[@id='${id}']`;
        }
        if (element === document.body) return "/html/body";
        if (element === document.documentElement) return "/html";
        if (!element.parentNode) return null;

        let ix = 0;
        const siblings = element.parentNode.childNodes;
        for (let i = 0; i < siblings.length; i++) {
            const sibling = siblings[i];
            if (sibling === element) {
                const parentPath = getXPath(element.parentNode);
                if (!parentPath) return null;
                return `${parentPath}/${element.tagName.toLowerCase()}[${ix + 1}]`;
            }
            if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
                ix++;
            }
        }
        return null;
    }

    // ─── Highlight ────────────────────────────────────────────────────────────

    function highlight(el) {
        currentElement = el;
        paintOverlay(el ? el.getBoundingClientRect() : null);
    }

    // ─── Same-rect collapsing ─────────────────────────────────────────────────
    // Nested wrapper divs frequently share their child's exact bounds. The user
    // sees the frame stop growing after one wheel tick and assumes they've
    // reached the visible block, but DOM-wise they're still on an inner
    // wrapper. Collapse those chains so each navigation step yields a visible
    // change and clicks always commit the topmost element of an equivalent set.

    function sameRect(a, b) {
        return Math.round(a.left)   === Math.round(b.left)
            && Math.round(a.top)    === Math.round(b.top)
            && Math.round(a.width)  === Math.round(b.width)
            && Math.round(a.height) === Math.round(b.height);
    }

    function topmostSameRect(el) {
        if (!el || !el.parentElement) return el;
        const r = el.getBoundingClientRect();
        let cur = el;
        while (cur.parentElement
               && cur.parentElement !== document.documentElement
               && cur.parentElement !== document.body
               && sameRect(cur.parentElement.getBoundingClientRect(), r)) {
            cur = cur.parentElement;
        }
        return cur;
    }

    function descendDifferent(parent) {
        // The remembered child may be an indirect descendant: wheel-up stores
        // the key at topmostSameRect(parent), which can be several wrappers
        // above the child's direct parentElement. `contains` recovers it;
        // strict parentElement equality would miss this and snap to firstChild.
        const remembered = descentMemory.get(parent);
        if (remembered && remembered !== parent && parent.contains(remembered)) {
            return remembered;
        }
        let target = parent.firstElementChild;
        if (!target) return null;
        const parentRect = parent.getBoundingClientRect();
        while (sameRect(target.getBoundingClientRect(), parentRect)) {
            const next = target.firstElementChild;
            if (!next) break;
            target = next;
        }
        return target;
    }

    // ─── Event handlers ───────────────────────────────────────────────────────

    function onMouseMove(e) {
        // Always track position so the post-lock threshold is relative to
        // where the mouse actually is when the lock expires.
        pendingX = e.clientX;
        pendingY = e.clientY;

        if (isScrollLocked) return;

        const dx = e.clientX - lastCommittedX;
        const dy = e.clientY - lastCommittedY;
        if (Math.sqrt(dx * dx + dy * dy) < MOVEMENT_THRESHOLD) return;

        if (hoverRafId !== null) return;
        hoverRafId = requestAnimationFrame(() => {
            hoverRafId = null;
            const el = document.elementFromPoint(pendingX, pendingY);
            if (el && el !== document.documentElement && el !== document.body) {
                highlight(topmostSameRect(el));
                lastCommittedX = pendingX;
                lastCommittedY = pendingY;
            }
        });
    }

    function onWheel(e) {
        e.preventDefault();
        e.stopPropagation();
        if (!currentElement) return;

        // Freeze hover tracking while the user scrolls the DOM tree.
        isScrollLocked = true;
        clearTimeout(scrollLockTimer);
        scrollLockTimer = setTimeout(() => {
            isScrollLocked = false;
            // Anchor threshold to current mouse position so a small drift to
            // click doesn't overwrite the scroll-navigated element.
            lastCommittedX = pendingX;
            lastCommittedY = pendingY;
        }, SCROLL_LOCK_MS);

        if (e.deltaY < 0) {
            // Scroll up → parent element, normalized to the topmost ancestor
            // sharing its rect. Remember which child we came from so a later
            // scroll-down can return to it.
            const parent = currentElement.parentElement;
            if (parent && parent !== document.documentElement) {
                const target = topmostSameRect(parent);
                descentMemory.set(target, currentElement);
                highlight(target);
            }
        } else {
            // Scroll down → descend, skipping same-rect children so the frame
            // visibly shrinks rather than appearing stuck.
            const target = descendDifferent(currentElement);
            if (target) highlight(target);
        }
    }

    function onKeyDown(e) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        destroy();
    }

    function onClick(e) {
        e.preventDefault();
        e.stopPropagation();

        if (!currentElement) return;

        const element = currentElement;
        const xpath = getXPath(element);

        destroy();

        chrome.runtime.sendMessage({
            action: "elementClicked",
            xpath,
            deviceMetrics,
            screenshotSuffix,
            manualCrop,
        });
    }


    // ─── Cleanup ──────────────────────────────────────────────────────────────

    function destroy() {
        if (hoverRafId !== null) cancelAnimationFrame(hoverRafId);
        clearTimeout(scrollLockTimer);
        document.removeEventListener("mousemove", onMouseMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("wheel", onWheel, true);
        document.removeEventListener("keydown", onKeyDown, true);
        chrome.runtime.onMessage.removeListener(metricsListener);

        currentElement = null;
        document.documentElement.classList.remove("__hl-cursor");
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(STYLE_ID)?.remove();
        window.removeEventListener("resize", onViewportChange, true);
        window.removeEventListener("scroll", onViewportChange, true);
        delete window.__HighlighterDestroy;
    }

    function onViewportChange() {
        if (currentElement) paintOverlay(currentElement.getBoundingClientRect());
    }

    window.__HighlighterDestroy = destroy;

    // ─── Attach (capture phase so we intercept before page handlers) ──────────

    document.addEventListener("mousemove", onMouseMove, { capture: true });
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("resize", onViewportChange, true);
    window.addEventListener("scroll", onViewportChange, true);
})();
