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
    // Which feature opened the picker. Travels back with elementClicked so the
    // background routes the same selection to screenshot capture or to design
    // extraction. Drives the accent colour and frame treatment below.
    let mode = "capture";

    const STYLE_ID   = "__hl-style";
    const OVERLAY_ID = "__hl-overlay";
    // Default accent (Element Capture). Overridden per-mode via the
    // --hl-accent custom property when sendDeviceMetrics arrives — every
    // colour in the stylesheet derives from it through color-mix(), so one
    // property assignment re-themes the whole overlay.
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
            mode = message.mode || "capture";
            applyAccent(message.accent);
            applyTipStrings(message.strings);
            overlay.classList.toggle("__hl-mode-design", mode === "design");

            // Design mode pairs the picker with the live spec card
            // (designInspector.js), injected just before this script. It owns
            // the card; this file still owns targeting, so the two meet at the
            // small hook set below rather than by forking the picker.
            if (mode === "design" && window.__DesignInspector) {
                window.__DesignInspector.setSession({
                    deviceMetrics,
                    screenshotSuffix,
                });
                window.__DesignInspector.setStrings(message.cardStrings);
                if (currentElement) {
                    window.__DesignInspector.onTarget(
                        currentElement,
                        currentElement.getBoundingClientRect()
                    );
                }
            }
        }
    };
    chrome.runtime.onMessage.addListener(metricsListener);

    // The stylesheet is injected before this message can arrive (executeScript
    // then sendMessage are two round-trips), so the accent is applied after the
    // fact rather than baked into the CSS text. Setting it on documentElement
    // rather than the overlay lets the cursor rule inherit it too.
    function applyAccent(accent) {
        if (!accent) return;
        document.documentElement.style.setProperty("--hl-accent", accent);
    }

    // Tooltip copy is localized by the popup (which owns the language-override
    // table) and passed through, rather than resolved here — a content script
    // sees only chrome.i18n's browser-UI locale and would ignore the override.
    function applyTipStrings(strings) {
        if (!strings) return;
        const nav = strings.nav || "";
        const commit = strings.commit || "";
        if (!nav && !commit) return;
        tipEl.innerHTML = `${nav}<br>${commit}`;
        if (currentElement) paintOverlay(currentElement.getBoundingClientRect());
    }

    // ─── Highlight styles ─────────────────────────────────────────────────────

    // Every colour below resolves through --hl-accent so a single property
    // assignment (applyAccent) re-themes the overlay. color-mix() replaces the
    // literal rgba() tints that used to hardcode the cyan channel values —
    // supported since Chrome 111, well under this extension's 127 floor.
    const A = `var(--hl-accent, ${COLOR})`;
    const tint = (pct) => `color-mix(in srgb, ${A} ${pct}%, transparent)`;

    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            :root { --hl-accent: ${COLOR}; }
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
                0%, 100% { box-shadow: 0 0 6px ${A},  inset 0 0 6px  ${tint(12)}; }
                50%      { box-shadow: 0 0 18px ${A}, inset 0 0 12px ${tint(28)}; }
            }
            @keyframes __hlPulseGlow {
                0%, 100% { box-shadow: 0 0 4px  ${A}; }
                50%      { box-shadow: 0 0 12px ${A}; }
            }
            @keyframes __hlPulseLabel {
                0%, 100% { box-shadow: 0 0 4px  ${tint(50)}; }
                50%      { box-shadow: 0 0 12px ${tint(90)}; }
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
                border: 1px solid ${A} !important;
                background-image:
                    repeating-linear-gradient(45deg,
                        transparent 0 7px,
                        ${tint(10)} 7px 9px),
                    linear-gradient(90deg, ${A} 50%, transparent 50%),
                    linear-gradient(90deg, ${A} 50%, transparent 50%),
                    linear-gradient(0deg,  ${A} 50%, transparent 50%),
                    linear-gradient(0deg,  ${A} 50%, transparent 50%) !important;
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
                border: 2px solid ${A} !important;
                background: ${tint(18)} !important;
                animation: __hlPulseGlow 1.6s ease-in-out infinite !important;
            }
            .__hl-c-tl { top: -2px;    left: -2px;    border-right: 0 !important; border-bottom: 0 !important; }
            .__hl-c-tr { top: -2px;    right: -2px;   border-left:  0 !important; border-bottom: 0 !important; }
            .__hl-c-bl { bottom: -2px; left: -2px;    border-right: 0 !important; border-top:    0 !important; }
            .__hl-c-br { bottom: -2px; right: -2px;   border-left:  0 !important; border-top:    0 !important; }
            .__hl-handle {
                position: absolute !important;
                background: ${A} !important;
                animation: __hlPulseGlow 1.6s ease-in-out infinite !important;
                transition: left 240ms ease-out, top 240ms ease-out,
                            width 240ms ease-out, height 240ms ease-out !important;
            }
            .__hl-label {
                position: absolute !important;
                font: 700 10px/1 "Courier New", ui-monospace, monospace !important;
                color: ${A} !important;
                text-shadow: 0 0 4px ${A} !important;
                background: rgba(0, 0, 0, 0.7) !important;
                padding: 3px 6px !important;
                letter-spacing: 0.12em !important;
                white-space: nowrap !important;
                border: 1px solid ${A} !important;
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
                border: 1px solid ${A} !important;
                border-radius: 5px !important;
                padding: 7px 10px !important;
                box-shadow: 0 0 12px ${tint(65)} !important;
                white-space: normal !important;
                transition: left 240ms ease-out, top 240ms ease-out !important;
            }
            .__hl-tip.__hl-tip-on { display: block; }
            .__hl-tip b { color: ${A} !important; font-weight: 700 !important; }
            html.__hl-cursor, html.__hl-cursor * { cursor: crosshair !important; }

            /* Design-extract mode reads as a measuring tool rather than a
               capture reticle: solid rule, no marching ants, no diagonal
               hatch — the element's own colours stay legible through it,
               which matters when the frame's whole job is to sit around
               something you're about to sample colours from. */
            #${OVERLAY_ID}.__hl-mode-design .__hl-frame {
                background-image: none !important;
                animation: __hlPulseFrame 1.6s ease-in-out infinite !important;
                border-width: 2px !important;
            }
            #${OVERLAY_ID}.__hl-mode-design .__hl-dim {
                background: rgba(0, 0, 0, 0.55) !important;
            }
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
            <b>Wheel</b> / <b>↑ ↓</b> = parent / child · <b>← →</b> = previous / next sibling.<br>
            <b>Click</b> or <b>Enter</b> to capture the highlighted element · <b>Esc</b> to cancel.
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
        const rect = el ? el.getBoundingClientRect() : null;
        paintOverlay(rect);
        if (mode === "design" && el && window.__DesignInspector) {
            window.__DesignInspector.onTarget(el, rect);
        }
    }

    // True while the design card is frozen around a committed element. The
    // picker goes inert so the user can work the card without the highlight
    // chasing their pointer across it.
    function inspectorFrozen() {
        return mode === "design"
            && !!window.__DesignInspector
            && window.__DesignInspector.isFrozen();
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

        if (isScrollLocked || inspectorFrozen()) return;

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

    // Freeze hover tracking briefly after a tree-navigation step (wheel or
    // arrow key) so the user doesn't have to hold the mouse perfectly still.
    function lockHover() {
        isScrollLocked = true;
        clearTimeout(scrollLockTimer);
        scrollLockTimer = setTimeout(() => {
            isScrollLocked = false;
            // Anchor threshold to current mouse position so a small drift to
            // click doesn't overwrite the navigated element.
            lastCommittedX = pendingX;
            lastCommittedY = pendingY;
        }, SCROLL_LOCK_MS);
    }

    // Up → parent element, normalized to the topmost ancestor sharing its
    // rect. Remember which child we came from so a later descend returns to it.
    function navigateToParent() {
        const parent = currentElement.parentElement;
        if (parent && parent !== document.documentElement) {
            const target = topmostSameRect(parent);
            descentMemory.set(target, currentElement);
            highlight(target);
        }
    }

    // Down → descend, skipping same-rect children so the frame visibly shrinks
    // rather than appearing stuck.
    function navigateToChild() {
        const target = descendDifferent(currentElement);
        if (target) highlight(target);
    }

    // The highlighter's own injected nodes must never become navigation
    // targets when walking siblings near the top of the tree.
    function isOwnNode(el) {
        return el.id === OVERLAY_ID || el.id === STYLE_ID;
    }

    // Right/Left → next/previous sibling at the same level. When the current
    // element has no sibling in that direction, climb to the nearest ancestor
    // that does and use its sibling — so navigation continues in document
    // order up the tree instead of dead-ending.
    function navigateToSibling(forward) {
        let el = currentElement;
        while (el && el !== document.body && el !== document.documentElement) {
            let sib = forward ? el.nextElementSibling : el.previousElementSibling;
            while (sib && isOwnNode(sib)) {
                sib = forward ? sib.nextElementSibling : sib.previousElementSibling;
            }
            if (sib) {
                highlight(sib);
                return;
            }
            el = el.parentElement;
        }
    }

    function onWheel(e) {
        // A frozen card can overflow its own box; let the wheel scroll it
        // rather than walking the DOM behind it.
        if (inspectorFrozen()) return;
        e.preventDefault();
        e.stopPropagation();
        if (!currentElement) return;

        lockHover();
        if (e.deltaY < 0) navigateToParent();
        else              navigateToChild();
    }

    function onKeyDown(e) {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            // A frozen card is a state the user chose, so the first Esc undoes
            // that choice and returns to picking; only the second ends the
            // session.
            if (mode === "design" && window.__DesignInspector?.onRelease()) {
                return;
            }
            destroy();
            return;
        }

        if (inspectorFrozen()) return;

        // Enter commits the highlighted element, same as a click.
        if (e.key === "Enter") {
            if (!currentElement) return;
            e.preventDefault();
            e.stopPropagation();
            commitSelection();
            return;
        }

        // Arrow keys walk the DOM: up/down = parent/child (like the wheel),
        // left/right = previous/next sibling (climbing when exhausted).
        if (e.key === "ArrowUp"   || e.key === "ArrowDown"
         || e.key === "ArrowLeft" || e.key === "ArrowRight") {
            if (!currentElement) return;
            e.preventDefault();
            e.stopPropagation();
            lockHover();
            if      (e.key === "ArrowUp")    navigateToParent();
            else if (e.key === "ArrowDown")  navigateToChild();
            else if (e.key === "ArrowLeft")  navigateToSibling(false);
            else                             navigateToSibling(true);
        }
    }

    // Commit the highlighted element for capture. Shared by click and Enter.
    function commitSelection() {
        if (!currentElement) return;

        const element = currentElement;

        // Design mode commits *into the page*, not to the background: the card
        // freezes around the element so the user can copy from it. Nothing is
        // captured until they press the card's own Capture button, so the
        // picker stays alive and no marker is set yet.
        if (mode === "design" && window.__DesignInspector) {
            window.__DesignInspector.onCommit(element, {
                deviceMetrics,
                screenshotSuffix,
            });
            return;
        }

        const xpath = getXPath(element);

        // Positional XPath breaks when emulation crosses a responsive
        // breakpoint and the page rebuilds its subtree (sibling indices and
        // generated ids both shift). Tag the node with a one-shot marker
        // attribute — the capture side locates it by this attribute first
        // and only falls back to the XPath. The capture side removes it when
        // the session ends.
        const marker = Date.now().toString(36)
            + Math.random().toString(36).slice(2);
        element.setAttribute("data-sharpshooter-target", marker);

        destroy();

        chrome.runtime.sendMessage({
            action: "elementClicked",
            xpath,
            marker,
            deviceMetrics,
            screenshotSuffix,
            manualCrop,
            mode,
        });
    }

    function onClick(e) {
        // This listener is on document in the CAPTURE phase, so it sees clicks
        // before their target does — including clicks on the design card. The
        // card lives in a shadow root, so the event is retargeted to its host
        // and identifiable by id; without this check, stopPropagation below
        // would swallow every click on the card's own swatches and buttons
        // before they ever reached it.
        if (e.target && e.target.id === "__ds-inspector") return;

        if (inspectorFrozen()) {
            // Clicks anywhere else are swallowed so the page underneath can't
            // navigate out from under a card the user is still reading.
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        commitSelection();
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
        // Drop the inline accent too — it's set on documentElement, so leaving
        // it behind would leak a custom property into the page's own cascade.
        document.documentElement.style.removeProperty("--hl-accent");
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(STYLE_ID)?.remove();
        window.removeEventListener("resize", onViewportChange, true);
        window.removeEventListener("scroll", onViewportChange, true);
        // Drop the global before tearing the card down: the inspector's own
        // destroy() calls back here, and this is what stops that recursing.
        delete window.__HighlighterDestroy;
        window.__DesignInspectorDestroy?.();
    }

    function onViewportChange() {
        if (currentElement) paintOverlay(currentElement.getBoundingClientRect());
        if (mode === "design") window.__DesignInspector?.onReposition();
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
