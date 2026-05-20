(function () {
    if (window.__DomKillerDestroy) {
        window.__DomKillerDestroy();
    }

    // ─── State ────────────────────────────────────────────────────────────────

    let currentElement = null;

    const STYLE_ID   = "__dk-style";
    const BANNER_ID  = "__dk-banner";
    const OVERLAY_ID = "__dk-overlay";
    const COLOR      = "#FF0055";
    const Z          = 2147483646;

    const MOVEMENT_THRESHOLD = 4;
    const SCROLL_LOCK_MS     = 400;

    let lastCommittedX    = -9999;
    let lastCommittedY    = -9999;
    let pendingX          = 0;
    let pendingY          = 0;
    let hoverRafId        = null;
    let scrollLockTimer    = null;
    let isScrollLocked     = false;
    let originalWindowOpen = null;

    // Remembers, per parent element, which child the user ascended from — so a
    // later wheel-down returns to that child instead of always firstElementChild.
    // Lets the user overshoot upward and walk back down the same branch.
    const descentMemory = new WeakMap();

    // Undo stack of removed nodes. Each entry keeps enough to splice the node
    // back into its original position: {node, parent, nextSibling}. Ctrl+Z /
    // Cmd+Z pops the last removal and reinserts it.
    const removalHistory = [];

    // ─── Styles ───────────────────────────────────────────────────────────────

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
            #${OVERLAY_ID}.__dk-on { display: block; }
            @keyframes __dkPulseFrame {
                0%, 100% { box-shadow: 0 0 6px  ${COLOR}, inset 0 0 6px  rgba(255, 0, 85, 0.18); }
                50%      { box-shadow: 0 0 18px ${COLOR}, inset 0 0 12px rgba(255, 0, 85, 0.35); }
            }
            @keyframes __dkPulseGlow {
                0%, 100% { box-shadow: 0 0 4px  ${COLOR}; }
                50%      { box-shadow: 0 0 12px ${COLOR}; }
            }
            @keyframes __dkPulseLabel {
                0%, 100% { box-shadow: 0 0 4px  rgba(255, 0, 85, 0.5); }
                50%      { box-shadow: 0 0 12px rgba(255, 0, 85, 0.9); }
            }
            @keyframes __dkPulseTint {
                0%, 100% { background: rgba(255, 0, 85, 0.16); }
                50%      { background: rgba(255, 0, 85, 0.30); }
            }
            @keyframes __dkGlitchOut {
                0%   { filter: none;                                       transform: translate(0, 0);                  opacity: 1; }
                8%   { filter: hue-rotate(120deg) saturate(2);             transform: translate(-4px, 1px) skewX(-2deg); opacity: 1; }
                16%  { filter: hue-rotate(-120deg) contrast(1.6);          transform: translate(5px, -2px) skewX(3deg);  opacity: 1; }
                24%  { filter: invert(0.6) saturate(2) hue-rotate(45deg);  transform: translate(-3px, 2px);              opacity: 1; }
                32%  { filter: contrast(1.8) brightness(1.3);              transform: translate(2px, 0);                 opacity: 1; }
                40%  { filter: none;                                       transform: translate(-1px, 0);                opacity: 1; }
                55%  { filter: brightness(1.4) contrast(1.2);              transform: scaleY(1.02) scaleX(1.01);         opacity: 1; }
                72%  { filter: brightness(2) blur(0.5px);                  transform: scaleY(0.05) scaleX(1.04);         opacity: 1; }
                88%  { filter: brightness(3) blur(1px);                    transform: scaleY(0.01) scaleX(1.15);         opacity: 0.7; }
                100% { filter: brightness(3) blur(1px);                    transform: scaleY(0) scaleX(0);               opacity: 0; }
            }
            .__dk-killing {
                animation: __dkGlitchOut 360ms linear forwards !important;
                pointer-events: none !important;
                transform-origin: center center !important;
                will-change: transform, filter, opacity !important;
            }
            .__dk-tint {
                position: absolute !important;
                animation: __dkPulseTint 1.6s ease-in-out infinite !important;
                transition: left 140ms ease-out, top 140ms ease-out,
                            width 140ms ease-out, height 140ms ease-out !important;
            }
            .__dk-frame {
                position: absolute !important;
                border: 1px solid ${COLOR} !important;
                animation: __dkPulseFrame 1.6s ease-in-out infinite !important;
                transition: left 140ms ease-out, top 140ms ease-out,
                            width 140ms ease-out, height 140ms ease-out !important;
            }
            .__dk-corner {
                position: absolute !important;
                width: 10px !important;
                height: 10px !important;
                border: 1px solid ${COLOR} !important;
                background: rgba(255, 0, 85, 0.15) !important;
                animation: __dkPulseGlow 1.6s ease-in-out infinite !important;
            }
            .__dk-c-tl { top: -1px;    left: -1px;    border-right: 0 !important; border-bottom: 0 !important; }
            .__dk-c-tr { top: -1px;    right: -1px;   border-left:  0 !important; border-bottom: 0 !important; }
            .__dk-c-bl { bottom: -1px; left: -1px;    border-right: 0 !important; border-top:    0 !important; }
            .__dk-c-br { bottom: -1px; right: -1px;   border-left:  0 !important; border-top:    0 !important; }
            .__dk-handle {
                position: absolute !important;
                background: ${COLOR} !important;
                animation: __dkPulseGlow 1.6s ease-in-out infinite !important;
                transition: left 140ms ease-out, top 140ms ease-out,
                            width 140ms ease-out, height 140ms ease-out !important;
            }
            .__dk-label {
                position: absolute !important;
                font: 700 10px/1 "Courier New", ui-monospace, monospace !important;
                color: ${COLOR} !important;
                text-shadow: 0 0 4px ${COLOR} !important;
                background: rgba(0, 0, 0, 0.7) !important;
                padding: 3px 6px !important;
                letter-spacing: 0.12em !important;
                white-space: nowrap !important;
                border: 1px solid ${COLOR} !important;
                animation: __dkPulseLabel 1.6s ease-in-out infinite !important;
            }
            .__dk-l-w { left: 50%; bottom: 100%; transform: translate(-50%, -18px); }
            .__dk-l-h { top: 50%;  right: 100%;  transform-origin: right center;
                        transform: translateY(-50%) translateX(-18px) rotate(-90deg); }
            html.__dk-cursor, html.__dk-cursor * { cursor: crosshair !important; }
            /* Disable iframe interaction so ad clicks bubble to our document
               handlers instead of navigating inside the frame. */
            iframe, frame, object, embed {
                pointer-events: none !important;
            }
            /* Kill anchor navigation defaults across the page. */
            a { -webkit-user-drag: none !important; }
            #${BANNER_ID} {
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                right: 0 !important;
                z-index: 2147483647 !important;
                background: ${COLOR} !important;
                color: #fff !important;
                font: 700 12px/1 "Arial Narrow", Arial, sans-serif !important;
                letter-spacing: 0.06em !important;
                text-align: center !important;
                padding: 6px 12px !important;
                pointer-events: none !important;
                text-transform: uppercase !important;
            }
        `;
        document.head.appendChild(style);
        document.documentElement.classList.add("__dk-cursor");
    }

    // ─── Overlay (frame + crosshair handles + dimension labels + red tint) ────

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
        <div class="__dk-tint" data-tint></div>
        <div class="__dk-handle" data-handle="top"></div>
        <div class="__dk-handle" data-handle="bottom"></div>
        <div class="__dk-handle" data-handle="left"></div>
        <div class="__dk-handle" data-handle="right"></div>
        <div class="__dk-frame" data-frame>
            <div class="__dk-corner __dk-c-tl"></div>
            <div class="__dk-corner __dk-c-tr"></div>
            <div class="__dk-corner __dk-c-bl"></div>
            <div class="__dk-corner __dk-c-br"></div>
            <div class="__dk-label __dk-l-w" data-label-w></div>
            <div class="__dk-label __dk-l-h" data-label-h></div>
        </div>
    `;
    document.documentElement.appendChild(overlay);

    const frameEl = overlay.querySelector("[data-frame]");
    const tintEl  = overlay.querySelector("[data-tint]");
    const labelW  = overlay.querySelector("[data-label-w]");
    const labelH  = overlay.querySelector("[data-label-h]");
    const hTop    = overlay.querySelector('[data-handle="top"]');
    const hBot    = overlay.querySelector('[data-handle="bottom"]');
    const hLeft   = overlay.querySelector('[data-handle="left"]');
    const hRight  = overlay.querySelector('[data-handle="right"]');

    function setRect(el, x, y, w, h) {
        el.style.left   = `${x}px`;
        el.style.top    = `${y}px`;
        el.style.width  = `${w}px`;
        el.style.height = `${h}px`;
    }

    function paintOverlay(rect) {
        if (!rect) {
            overlay.classList.remove("__dk-on");
            return;
        }
        overlay.classList.add("__dk-on");

        const vw = window.innerWidth;
        const vh = window.innerHeight;

        setRect(frameEl, rect.left, rect.top, rect.width, rect.height);
        setRect(tintEl,  rect.left, rect.top, rect.width, rect.height);

        labelW.textContent = `${Math.round(rect.width)} PX`;
        labelH.textContent = `${Math.round(rect.height)} PX`;

        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        setRect(hTop,   cx - 1, 0,           2, Math.max(0, rect.top));
        setRect(hBot,   cx - 1, rect.bottom, 2, Math.max(0, vh - rect.bottom));
        setRect(hLeft,  0,           cy - 1, Math.max(0, rect.left),     2);
        setRect(hRight, rect.right,  cy - 1, Math.max(0, vw - rect.right), 2);
    }

    // ─── In-page instruction banner ───────────────────────────────────────────

    if (!document.getElementById(BANNER_ID)) {
        const banner = document.createElement("div");
        banner.id = BANNER_ID;
        banner.textContent = "Manual element removal — Hover to target · Click to remove · Wheel to change depth · Ctrl/Cmd+Z to undo · ESC to stop";
        document.documentElement.appendChild(banner);
    }

    // ─── Highlight ────────────────────────────────────────────────────────────

    function highlight(el) {
        currentElement = el;
        paintOverlay(el ? el.getBoundingClientRect() : null);
    }

    // ─── Same-rect collapsing ─────────────────────────────────────────────────
    // Nested wrapper divs often share their child's exact bounds. Collapse
    // those chains so each navigation step yields a visible change and clicks
    // always commit the topmost element of an equivalent set.

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
        const remembered = descentMemory.get(parent);
        let target = (remembered && remembered.parentElement === parent)
            ? remembered
            : parent.firstElementChild;
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
            if (el && el !== document.documentElement && el !== document.body && el.id !== BANNER_ID) {
                highlight(topmostSameRect(el));
                lastCommittedX = pendingX;
                lastCommittedY = pendingY;
            }
        });
    }

    function onWheel(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (!currentElement) return;

        isScrollLocked = true;
        clearTimeout(scrollLockTimer);
        scrollLockTimer = setTimeout(() => {
            isScrollLocked = false;
            lastCommittedX = pendingX;
            lastCommittedY = pendingY;
        }, SCROLL_LOCK_MS);

        if (e.deltaY < 0) {
            const parent = currentElement.parentElement;
            if (parent && parent !== document.documentElement) {
                const target = topmostSameRect(parent);
                descentMemory.set(target, currentElement);
                highlight(target);
            }
        } else {
            const target = descendDifferent(currentElement);
            if (target) highlight(target);
        }
    }

    function blockEvent(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    function onPointerDown(e) {
        // Block mousedown/pointerdown so ad handlers that navigate on press
        // (before click fires) never run.
        blockEvent(e);
    }

    // Catch-all for events that can trigger navigation we don't otherwise
    // handle (middle-click, touch, drag, context menu, form submit).
    function onAuxOrTouch(e) {
        blockEvent(e);
    }

    function onClick(e) {
        blockEvent(e);

        if (!currentElement) return;

        const element = currentElement;
        currentElement = null;
        paintOverlay(null);

        // Walk up to the nearest ancestor <a> and remove that instead so the
        // whole link block disappears, not just the inner node the cursor hit.
        const link = element.closest("a");
        const target = link ?? element;

        // Persisting click-removed selectors to userFilters is disabled:
        // the generalized selector often matched different nodes on re-apply
        // than what the user removed by hand. Will be redesigned separately.

        // Record position before detaching so Ctrl/Cmd+Z can splice it back.
        removalHistory.push({
            node: target,
            parent: target.parentNode,
            nextSibling: target.nextSibling,
        });

        // CRT-glitch animation, then detach. The class stays attached until
        // undoRemoval() strips it so a re-attached node doesn't replay the
        // animation and vanish again.
        target.classList.add("__dk-killing");
        setTimeout(() => target.remove(), 360);
    }

    // ─── Undo ─────────────────────────────────────────────────────────────────

    function undoRemoval() {
        const entry = removalHistory.pop();
        if (!entry) return;

        const { node, parent, nextSibling } = entry;
        if (!parent) return;

        // Strip the glitch class before re-attachment so the browser doesn't
        // replay the animation (and vanish the node again).
        node.classList.remove("__dk-killing");

        // The original nextSibling may itself have been removed since; if it's
        // no longer a child of parent, fall back to appending at the end.
        const ref = nextSibling && nextSibling.parentNode === parent
            ? nextSibling
            : null;
        parent.insertBefore(node, ref);
    }

    // ─── Selector capture ─────────────────────────────────────────────────────

    // Short, generalizing selector. Prefers stable hooks (testid, aria-label,
    // id) and falls back to tag + first couple of classes. Goal: catch similar
    // ads on reload without being so specific it brittle-breaks on re-renders.
    function computeSelector(el) {
        if (!el || el.nodeType !== 1) return null;

        for (const a of [
            "data-testid",
            "data-test-id",
            "data-test",
            "data-qa",
            "data-cy",
        ]) {
            if (el.hasAttribute(a)) {
                const v = el.getAttribute(a);
                if (v) return `[${a}="${cssEscape(v)}"]`;
            }
        }

        if (el.hasAttribute("aria-label")) {
            const v = el.getAttribute("aria-label");
            if (v && v.length < 60) {
                return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(v)}"]`;
            }
        }

        // Skip ids that look auto-generated (long digit runs / uuid-ish).
        if (el.id && !/\d{4,}/.test(el.id) && !/^[a-f0-9-]{16,}$/i.test(el.id)) {
            return `#${cssEscape(el.id)}`;
        }

        if (el.classList.length) {
            const classes = Array.from(el.classList)
                .slice(0, 2)
                .map((c) => `.${cssEscape(c)}`)
                .join("");
            return `${el.tagName.toLowerCase()}${classes}`;
        }

        return el.tagName.toLowerCase();
    }

    function cssEscape(s) {
        return typeof CSS !== "undefined" && CSS.escape
            ? CSS.escape(s)
            : String(s).replace(/(["\\\]])/g, "\\$1");
    }

    async function persistUserFilter(selector) {
        try {
            const host = location.hostname.toLowerCase();
            const { userFilters } = await chrome.storage.local.get("userFilters");
            const map = userFilters ?? {};
            const list = map[host] ?? [];
            if (!list.includes(selector)) {
                list.push(selector);
                map[host] = list;
                await chrome.storage.local.set({ userFilters: map });
                console.log(`DOM-killer saved: ${host} → ${selector}`);
            }
        } catch (e) {
            console.warn("DOM-killer persist failed:", e);
        }
    }

    function onKeyDown(e) {
        if (e.key === "Escape") {
            destroy();
            chrome.runtime.sendMessage({ action: "domKillerEnded" });
            return;
        }

        // Ctrl+Z (Win/Linux) / Cmd+Z (Mac) — reinsert the last removed element.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
            (e.key === "z" || e.key === "Z")) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            undoRemoval();
        }
    }

    // ─── Cleanup ──────────────────────────────────────────────────────────────

    function destroy() {
        if (hoverRafId !== null) cancelAnimationFrame(hoverRafId);
        clearTimeout(scrollLockTimer);
        document.removeEventListener("mousemove",   onMouseMove,   true);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("mousedown",   onPointerDown, true);
        document.removeEventListener("mouseup",     onAuxOrTouch,  true);
        document.removeEventListener("click",       onClick,       true);
        document.removeEventListener("auxclick",    onAuxOrTouch,  true);
        document.removeEventListener("dblclick",    onAuxOrTouch,  true);
        document.removeEventListener("contextmenu", onAuxOrTouch,  true);
        document.removeEventListener("touchstart",  onAuxOrTouch,  true);
        document.removeEventListener("touchend",    onAuxOrTouch,  true);
        document.removeEventListener("dragstart",   onAuxOrTouch,  true);
        document.removeEventListener("submit",      onAuxOrTouch,  true);
        document.removeEventListener("wheel",       onWheel,       true);
        document.removeEventListener("keydown",     onKeyDown,     true);

        if (originalWindowOpen) {
            window.open = originalWindowOpen;
            originalWindowOpen = null;
        }

        currentElement = null;
        document.documentElement.classList.remove("__dk-cursor");
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(BANNER_ID)?.remove();
        window.removeEventListener("resize", onViewportChange, true);
        window.removeEventListener("scroll", onViewportChange, true);
        delete window.__DomKillerDestroy;
    }

    function onViewportChange() {
        if (currentElement) paintOverlay(currentElement.getBoundingClientRect());
    }

    window.__DomKillerDestroy = destroy;

    // ─── Attach ───────────────────────────────────────────────────────────────

    document.addEventListener("mousemove",   onMouseMove,   { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("mousedown",   onPointerDown, { capture: true });
    document.addEventListener("mouseup",     onAuxOrTouch,  { capture: true });
    document.addEventListener("click",       onClick,       { capture: true });
    document.addEventListener("auxclick",    onAuxOrTouch,  { capture: true });
    document.addEventListener("dblclick",    onAuxOrTouch,  { capture: true });
    document.addEventListener("contextmenu", onAuxOrTouch,  { capture: true });
    document.addEventListener("touchstart",  onAuxOrTouch,  { capture: true, passive: false });
    document.addEventListener("touchend",    onAuxOrTouch,  { capture: true, passive: false });
    document.addEventListener("dragstart",   onAuxOrTouch,  { capture: true });
    document.addEventListener("submit",      onAuxOrTouch,  { capture: true });
    document.addEventListener("wheel",       onWheel,       { capture: true, passive: false });
    document.addEventListener("keydown",     onKeyDown,     { capture: true });
    window.addEventListener("resize", onViewportChange, true);
    window.addEventListener("scroll", onViewportChange, true);

    // Stub window.open so any handler that beats us (script registered a
    // capture listener earlier than us) still can't pop a new tab.
    originalWindowOpen = window.open;
    window.open = function () { return null; };
})();
