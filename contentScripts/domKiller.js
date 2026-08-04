// Two helpers share this picker: Remove Elements (mode "remove") detaches the
// targeted node, Blur Elements (mode "blur") leaves the DOM intact and paints a
// CSS blur over it. Everything else — the DOM walk, same-rect collapsing,
// descent memory, sibling climbing, the undo stack, the event blocking — is
// identical, so the two modes are one file rather than a fork.
//
// The file only *registers* the starter; backgroundScript.js calls
// __DomKillerStart({mode}) in a second injection. Mode decides the accent
// colour, the banner and the commit action, all of which are built up front,
// so it has to arrive before anything runs — not over a later message.
window.__DomKillerStart = function (options) {
    if (window.__DomKillerDestroy) {
        window.__DomKillerDestroy();
    }

    // ─── State ────────────────────────────────────────────────────────────────

    let currentElement = null;

    const BLUR = options?.mode === "blur";

    const STYLE_ID   = "__dk-style";
    const BANNER_ID  = "__dk-banner";
    const OVERLAY_ID = "__dk-overlay";
    // Both modes wear the targeting red, matching the one red button they are
    // launched from. Blur used to frame in blue; it read as a different tool
    // rather than the other half of the same one. The banner names the mode.
    const COLOR      = "#FF0055";
    const Z          = 2147483646;

    // Every tint in the stylesheet below is derived from COLOR rather than
    // written as a literal rgba(), so one constant repaints the whole picker.
    const tint = (pct) => `color-mix(in srgb, ${COLOR} ${pct}%, transparent)`;

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
    let firstPaint         = true;

    // Remembers, per parent element, which child the user ascended from — so a
    // later wheel-down returns to that child instead of always firstElementChild.
    // Lets the user overshoot upward and walk back down the same branch.
    const descentMemory = new WeakMap();

    // Undo stack. In remove mode each entry keeps enough to splice the node back
    // into its original position ({node, parent, nextSibling}); in blur mode it
    // keeps the inline `filter` the node had before ({node, filter, priority}),
    // which is usually the empty string. Ctrl+Z / Cmd+Z pops the last commit.
    const commitHistory = [];

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
                0%, 100% { box-shadow: 0 0 6px  ${COLOR}, inset 0 0 6px  ${tint(18)}; }
                50%      { box-shadow: 0 0 18px ${COLOR}, inset 0 0 12px ${tint(35)}; }
            }
            @keyframes __dkPulseGlow {
                0%, 100% { box-shadow: 0 0 4px  ${COLOR}; }
                50%      { box-shadow: 0 0 12px ${COLOR}; }
            }
            @keyframes __dkPulseLabel {
                0%, 100% { box-shadow: 0 0 4px  ${tint(50)}; }
                50%      { box-shadow: 0 0 12px ${tint(90)}; }
            }
            @keyframes __dkPulseTint {
                0%, 100% { background: ${tint(16)}; }
                50%      { background: ${tint(30)}; }
            }
            @keyframes __dkMarch {
                to {
                    background-position:
                        12.728px 0,
                        14px 0, -14px 100%,
                        0 -14px, 100% 14px;
                }
            }
            @keyframes __dkKillFill {
                0%   { height: 0%;   }
                100% { height: 100%; }
            }
            @keyframes __dkScanline {
                0%   { top: 0%;   opacity: 1; }
                100% { top: 100%; opacity: 1; }
            }
            @keyframes __dkKillFade {
                0%   { opacity: 1; }
                100% { opacity: 0; }
            }
            .__dk-killframe.__dk-fading {
                animation: __dkKillFade 180ms ease-out forwards !important;
            }
            .__dk-killframe {
                position: fixed !important;
                z-index: ${Z} !important;
                pointer-events: none !important;
                border: 1px solid ${COLOR} !important;
                box-shadow: 0 0 12px ${COLOR}, inset 0 0 12px ${tint(40)} !important;
                overflow: hidden !important;
            }
            /* Remove sweeps a solid fill down over the doomed element; blur uses
               the same sweep at low opacity, because the element stays on screen
               underneath and an opaque wipe would read as a removal. */
            .__dk-killfill {
                position: absolute !important;
                left: 0 !important;
                top: 0 !important;
                width: 100% !important;
                height: 0%;
                background: linear-gradient(to bottom,
                    ${BLUR ? tint(38) : "rgba(255, 0, 85, 0.85)"},
                    ${BLUR ? tint(12) : "rgba(180, 0, 40, 0.85)"}) !important;
                animation: __dkKillFill 320ms ease-in forwards !important;
            }
            .__dk-scanline {
                position: absolute !important;
                left: 0 !important;
                top: 0%;
                width: 100% !important;
                height: 3px !important;
                margin-top: -1px !important;
                background: #fff !important;
                box-shadow: 0 0 10px #fff, 0 0 18px ${COLOR} !important;
                opacity: ${BLUR ? "0.75" : "1"} !important;
                animation: __dkScanline 320ms ease-in forwards !important;
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
                background-image:
                    repeating-linear-gradient(45deg,
                        transparent 0 7px,
                        ${tint(12)} 7px 9px),
                    linear-gradient(90deg, ${COLOR} 50%, transparent 50%),
                    linear-gradient(90deg, ${COLOR} 50%, transparent 50%),
                    linear-gradient(0deg,  ${COLOR} 50%, transparent 50%),
                    linear-gradient(0deg,  ${COLOR} 50%, transparent 50%) !important;
                background-position: 0 0, 0 0, 0 100%, 0 0, 100% 0;
                background-repeat: repeat, repeat-x, repeat-x, repeat-y, repeat-y !important;
                background-size: auto, 14px 1px, 14px 1px, 1px 14px, 1px 14px !important;
                animation:
                    __dkPulseFrame 1.6s ease-in-out infinite,
                    __dkMarch 700ms linear infinite !important;
                transition: left 140ms ease-out, top 140ms ease-out,
                            width 140ms ease-out, height 140ms ease-out !important;
            }
            .__dk-corner {
                position: absolute !important;
                width: 14px !important;
                height: 14px !important;
                border: 2px solid ${COLOR} !important;
                background: ${tint(20)} !important;
                animation: __dkPulseGlow 1.6s ease-in-out infinite !important;
            }
            .__dk-c-tl { top: -2px;    left: -2px;    border-right: 0 !important; border-bottom: 0 !important; }
            .__dk-c-tr { top: -2px;    right: -2px;   border-left:  0 !important; border-bottom: 0 !important; }
            .__dk-c-bl { bottom: -2px; left: -2px;    border-right: 0 !important; border-top:    0 !important; }
            .__dk-c-br { bottom: -2px; right: -2px;   border-left:  0 !important; border-top:    0 !important; }
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
            .__dk-tip {
                position: absolute !important;
                display: none;
                max-width: 300px !important;
                font: 600 11.5px/1.45 -apple-system, "Segoe UI", Arial, sans-serif !important;
                color: #fff !important;
                background: rgba(0, 0, 0, 0.86) !important;
                border: 1px solid ${COLOR} !important;
                border-radius: 5px !important;
                padding: 7px 10px !important;
                box-shadow: 0 0 12px ${tint(65)} !important;
                white-space: normal !important;
                transition: left 140ms ease-out, top 140ms ease-out !important;
            }
            .__dk-tip.__dk-tip-on { display: block; }
            .__dk-tip b { color: ${COLOR} !important; font-weight: 700 !important; }
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
        <div class="__dk-tip" data-tip>
            <b>Wheel</b> / <b>↑ ↓</b> = parent / child · <b>← →</b> = previous / next sibling.<br>
            <b>Click</b> or <b>Enter</b> to ${BLUR ? "blur" : "remove"} the highlighted element · <b>Ctrl/Cmd+Z</b> to undo.
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
    const tipEl   = overlay.querySelector("[data-tip]");

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
            tipEl.classList.remove("__dk-tip-on");
            return;
        }
        tipEl.classList.add("__dk-tip-on");

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

    function setRect(el, x, y, w, h) {
        el.style.left   = `${x}px`;
        el.style.top    = `${y}px`;
        el.style.width  = `${w}px`;
        el.style.height = `${h}px`;
    }

    function paintOverlay(rect) {
        if (!rect) {
            overlay.classList.remove("__dk-on");
            tipEl.classList.remove("__dk-tip-on");
            firstPaint = true;
            return;
        }
        overlay.classList.add("__dk-on");

        // First-detect intro: snap frame + tint to viewport (tint at opacity 0)
        // with no transition, flush layout, then enable a 320ms transition so
        // the next rect assignment shrinks them inward — and the tint fades in.
        if (firstPaint) {
            firstPaint = false;
            const vw0 = window.innerWidth;
            const vh0 = window.innerHeight;
            const intro = "left 560ms cubic-bezier(.2,.7,.2,1),"
                + " top 560ms cubic-bezier(.2,.7,.2,1),"
                + " width 560ms cubic-bezier(.2,.7,.2,1),"
                + " height 560ms cubic-bezier(.2,.7,.2,1)";
            frameEl.style.transition = "none";
            tintEl.style.transition  = "none";
            tintEl.style.opacity     = "0";
            setRect(frameEl, 0, 0, vw0, vh0);
            setRect(tintEl,  0, 0, vw0, vh0);
            void frameEl.offsetWidth;
            frameEl.style.transition = intro;
            tintEl.style.transition  = `${intro}, opacity 560ms ease-out`;
            tintEl.style.opacity     = "1";
            setTimeout(() => {
                frameEl.style.transition = "";
                tintEl.style.transition  = "";
                tintEl.style.opacity     = "";
            }, 620);
        }

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

        placeTooltip(rect);
    }

    // ─── In-page instruction banner ───────────────────────────────────────────

    if (!document.getElementById(BANNER_ID)) {
        const banner = document.createElement("div");
        banner.id = BANNER_ID;
        banner.textContent = BLUR
            ? "Manual element blurring — Hover to target · Click or Enter to blur · Wheel/↑↓ = depth, ←→ = siblings · Ctrl/Cmd+Z to undo · ESC to stop"
            : "Manual element removal — Hover to target · Click or Enter to remove · Wheel/↑↓ = depth, ←→ = siblings · Ctrl/Cmd+Z to undo · ESC to stop";
        document.documentElement.appendChild(banner);
    }

    // ─── Blur helpers ─────────────────────────────────────────────────────────
    //
    // Blur strength scales with the target: a fixed radius that hides a
    // full-width comment thread also erases a small avatar into a smudge, and
    // one that suits the avatar leaves body text legible. Tied to the shorter
    // side (text lines are wide and short) and clamped at both ends.
    function blurRadiusFor(rect) {
        const shortest = Math.min(rect.width, rect.height);
        return Math.max(6, Math.min(28, Math.round(shortest / 10)));
    }

    // Stack on top of any filter the page itself applies, read from the
    // computed value so a stylesheet-declared filter (not just an inline one)
    // survives. !important because plenty of pages declare their own with it.
    function applyBlur(el, rect) {
        const own  = getComputedStyle(el).filter;
        const base = own && own !== "none" ? `${own} ` : "";
        el.style.setProperty(
            "filter",
            `${base}blur(${blurRadiusFor(rect)}px)`,
            "important",
        );
    }

    // Blur is applied on commit only — never as a hover preview. A preview was
    // tried and reverted: `filter` makes the element a containing block for
    // fixed-position descendants, so blurring whatever is under the pointer
    // shifts the page, which re-targets the hover, which un-blurs and shifts it
    // back. The frame oscillated between elements and the mode was unusable.
    // Any future preview has to break that loop (freeze targeting while a
    // preview is up, or paint into an overlay instead of onto the page).

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

    // Freeze hover tracking briefly after a tree-navigation step (wheel or
    // arrow key) so the user doesn't have to hold the mouse perfectly still.
    function lockHover() {
        isScrollLocked = true;
        clearTimeout(scrollLockTimer);
        scrollLockTimer = setTimeout(() => {
            isScrollLocked = false;
            lastCommittedX = pendingX;
            lastCommittedY = pendingY;
        }, SCROLL_LOCK_MS);
    }

    // Up → parent (topmost ancestor sharing its rect), remembering the child
    // we came from so a later descend can return to it.
    function navigateToParent() {
        const parent = currentElement.parentElement;
        if (parent && parent !== document.documentElement) {
            const target = topmostSameRect(parent);
            descentMemory.set(target, currentElement);
            highlight(target);
        }
    }

    // Down → descend, skipping same-rect children so the frame visibly shrinks.
    function navigateToChild() {
        const target = descendDifferent(currentElement);
        if (target) highlight(target);
    }

    // The killer's own injected nodes (overlay, style, banner, kill-frames)
    // must never become navigation targets when walking siblings.
    function isOwnNode(el) {
        return el.id === OVERLAY_ID || el.id === STYLE_ID || el.id === BANNER_ID
            || el.classList.contains("__dk-killframe");
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
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (!currentElement) return;

        lockHover();
        if (e.deltaY < 0) navigateToParent();
        else              navigateToChild();
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

    // Commit the highlighted element — remove it, or keep its blur. Shared by
    // click and Enter.
    function killCurrent() {
        if (!currentElement) return;

        const element = currentElement;
        currentElement = null;
        paintOverlay(null);

        // Remove mode walks up to the nearest ancestor <a> so the whole link
        // block disappears rather than just the inner node the cursor hit.
        // Blur mode does not: the element stays in the layout, so widening the
        // target only smears more of the page than the user pointed at.
        const target = BLUR ? element : (element.closest("a") ?? element);

        // Record the pre-commit state so Ctrl/Cmd+Z can restore it.
        commitHistory.push(BLUR
            ? {
                  node: target,
                  filter: target.style.getPropertyValue("filter"),
                  priority: target.style.getPropertyPriority("filter"),
              }
            : {
                  node: target,
                  parent: target.parentNode,
                  nextSibling: target.nextSibling,
              });

        // Spawn a kill-frame over the target's rect that fills top-to-bottom,
        // then commit. The overlay is independent of the element so undo can
        // restore it without replaying anything.
        const rect = target.getBoundingClientRect();
        const killFrame = document.createElement("div");
        killFrame.className = "__dk-killframe";
        killFrame.style.left   = `${rect.left}px`;
        killFrame.style.top    = `${rect.top}px`;
        killFrame.style.width  = `${rect.width}px`;
        killFrame.style.height = `${rect.height}px`;
        killFrame.innerHTML = `
            <div class="__dk-killfill"></div>
            <div class="__dk-scanline"></div>
        `;
        document.documentElement.appendChild(killFrame);

        // Phase 1: scanline sweeps top→bottom over the still-visible element.
        // Phase 2 (after fill completes): commit and fade the frame.
        setTimeout(() => {
            if (BLUR) applyBlur(target, rect);
            else      target.style.visibility = "hidden";
            killFrame.classList.add("__dk-fading");
        }, 320);
        setTimeout(() => {
            if (!BLUR) {
                target.style.visibility = "";
                target.remove();
            }
            killFrame.remove();
        }, 520);
    }

    function onClick(e) {
        blockEvent(e);
        killCurrent();
    }

    // ─── Undo ─────────────────────────────────────────────────────────────────

    function undoRemoval() {
        const entry = commitHistory.pop();
        if (!entry) return;

        if (BLUR) {
            const { node, filter, priority } = entry;
            if (filter) node.style.setProperty("filter", filter, priority);
            else        node.style.removeProperty("filter");
            return;
        }

        const { node, parent, nextSibling } = entry;
        if (!parent) return;

        // The original nextSibling may itself have been removed since; if it's
        // no longer a child of parent, fall back to appending at the end.
        const ref = nextSibling && nextSibling.parentNode === parent
            ? nextSibling
            : null;
        parent.insertBefore(node, ref);
    }

    function onKeyDown(e) {
        if (e.key === "Escape") {
            destroy();
            chrome.runtime.sendMessage({ action: "domKillerEnded" });
            return;
        }

        // Enter removes the highlighted element, same as a click.
        if (e.key === "Enter") {
            if (!currentElement) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            killCurrent();
            return;
        }

        // Arrow keys walk the DOM: up/down = parent/child (like the wheel),
        // left/right = previous/next sibling (climbing when exhausted).
        if (e.key === "ArrowUp"   || e.key === "ArrowDown"
         || e.key === "ArrowLeft" || e.key === "ArrowRight") {
            if (!currentElement) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            lockHover();
            if      (e.key === "ArrowUp")    navigateToParent();
            else if (e.key === "ArrowDown")  navigateToChild();
            else if (e.key === "ArrowLeft")  navigateToSibling(false);
            else                             navigateToSibling(true);
            return;
        }

        // Ctrl+Z (Win/Linux) / Cmd+Z (Mac) — reinsert the last removed element.
        // Match on e.code (physical key) so it works on non-Latin layouts —
        // e.key would be "я" on a Russian layout and never match "z".
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
            e.code === "KeyZ") {
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
};
