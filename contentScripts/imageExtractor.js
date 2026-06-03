(function () {
    if (window.__ImageExtractorDestroy) {
        window.__ImageExtractorDestroy();
    }

    // ─── Constants ────────────────────────────────────────────────────────────────

    const STYLE_ID    = "__ix-style";
    const OVERLAY_ID  = "__ix-overlay";
    const PICKER_ID   = "__ix-picker";
    const PROGRESS_ID = "__ix-progress";
    const COLOR       = "#F59E0B";
    const Z           = 2147483646;

    const MOVEMENT_THRESHOLD = 4;
    const SCROLL_LOCK_MS     = 400;

    // ─── State ────────────────────────────────────────────────────────────────────

    let currentElement  = null;
    let manualCrop      = false;
    let lastCommittedX  = -9999;
    let lastCommittedY  = -9999;
    let pendingX        = 0;
    let pendingY        = 0;
    let hoverRafId      = null;
    let scrollLockTimer = null;
    let isScrollLocked  = false;
    let firstPaint      = true;
    let progressTimer   = null;

    const descentMemory = new WeakMap();

    // ─── Receive crop mode sent by background after injection ───────────────────────
    //
    // The crop flag arrives via chrome.tabs.sendMessage (same reliable channel
    // elementHighlighter uses), NOT a cross-injection global. A previously set
    // window.__ImageExtractorOptions could go stale and route a plain extraction
    // to the crop editor; a per-injection message can't. The message lands well
    // before the user hovers + clicks, so manualCrop is always current at commit.
    const optionsListener = (message) => {
        if (message?.action === "imageExtractorOptions") {
            manualCrop = !!message.manualCrop;
        }
    };
    chrome.runtime.onMessage.addListener(optionsListener);

    // ─── Image utilities ──────────────────────────────────────────────────────────

    function isSvg(url) {
        if (!url) return false;
        if (url.startsWith("data:image/svg")) return true;
        const u = url.split("?")[0].split("#")[0].toLowerCase();
        return u.endsWith(".svg") || u.endsWith(".svgz");
    }

    function extractBgUrl(bgValue) {
        const m = bgValue.match(/url\(["']?([^"')]+)["']?\)/);
        return m ? m[1] : null;
    }

    function getLargestSrcsetEntry(srcsetStr) {
        if (!srcsetStr) return null;
        const entries = srcsetStr.split(",").map(s => s.trim()).filter(Boolean).map(part => {
            const tokens = part.trim().split(/\s+/);
            // descriptor is either "2x" (density) or "800w" (width) — treat both as numeric
            return { url: tokens[0], value: parseFloat(tokens[1]) || 1 };
        });
        if (!entries.length) return null;
        entries.sort((a, b) => b.value - a.value);
        return entries[0];
    }

    function getLargestSrcset(srcsetStr) {
        const e = getLargestSrcsetEntry(srcsetStr);
        return e ? e.url : null;
    }

    function resolveUrl(url) {
        try { return new URL(url, location.href).href; } catch { return url; }
    }

    function findImages(el) {
        const raster   = [];
        const canvases = [];
        const seenUrls = new Set();

        function add(c) {
            if (!c.url || seenUrls.has(c.url)) return;
            seenUrls.add(c.url);
            raster.push(c);
        }

        // <img> — largest srcset candidate, or src (skip fallback imgs inside <picture>)
        for (const img of el.querySelectorAll("img")) {
            if (img.closest("picture")) continue;
            const rect = img.getBoundingClientRect();
            if (rect.width < 50 && rect.height < 50) continue;
            const srcset = img.getAttribute("srcset");
            const raw    = getLargestSrcset(srcset) || img.getAttribute("src");
            if (!raw) continue;
            const url = resolveUrl(raw);
            if (isSvg(url)) continue;
            const w = img.naturalWidth  || Math.round(rect.width);
            const h = img.naturalHeight || Math.round(rect.height);
            add({ url, w, h, label: `${w} × ${h} px`, type: "img" });
        }

        // <picture> — one candidate per picture: the single highest-descriptor URL across
        // all <source> srcsets and the fallback <img>. Multiple sources = same image in
        // different formats or breakpoints; we only want the best raw asset.
        for (const picture of el.querySelectorAll("picture")) {
            let bestUrl   = null;
            let bestValue = -Infinity;

            for (const source of picture.querySelectorAll("source")) {
                const entry = getLargestSrcsetEntry(source.getAttribute("srcset"));
                if (!entry) continue;
                const url = resolveUrl(entry.url);
                if (!url || isSvg(url)) continue;
                if (entry.value > bestValue) { bestUrl = url; bestValue = entry.value; }
            }

            // also consider the fallback <img> srcset/src
            const imgFallback = picture.querySelector("img");
            if (imgFallback) {
                const entry = getLargestSrcsetEntry(imgFallback.getAttribute("srcset"));
                const raw   = entry?.url || imgFallback.getAttribute("src");
                if (raw) {
                    const url   = resolveUrl(raw);
                    const value = entry?.value ?? 0;
                    if (url && !isSvg(url) && value > bestValue) {
                        bestUrl = url; bestValue = value;
                    }
                }
            }

            if (!bestUrl) continue;
            const img = picture.querySelector("img");
            const w   = img?.naturalWidth  || 0;
            const h   = img?.naturalHeight || 0;
            add({ url: bestUrl, w, h, label: w && h ? `${w} × ${h} px` : "srcset source", type: "source" });
        }

        // CSS background-image on every descendant (and the element itself)
        for (const node of [el, ...el.querySelectorAll("*")]) {
            const bg = getComputedStyle(node).backgroundImage;
            if (!bg || bg === "none") continue;
            const raw = extractBgUrl(bg);
            if (!raw) continue;
            const url = resolveUrl(raw);
            if (isSvg(url)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width < 50 && rect.height < 50) continue;
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            add({ url, w, h, label: `bg ${w} × ${h} px`, type: "bg" });
        }

        // canvas — flagged for user guidance, not directly downloadable
        for (const canvas of el.querySelectorAll("canvas")) {
            const rect = canvas.getBoundingClientRect();
            if (rect.width < 50 && rect.height < 50) continue;
            canvases.push({ type: "canvas", url: null, w: canvas.width, h: canvas.height,
                label: `canvas ${canvas.width} × ${canvas.height} px` });
        }

        // highest-resolution candidate first
        raster.sort((a, b) => (b.w * b.h) - (a.w * a.h));

        return [...raster, ...canvases];
    }

    function walkUpForBg(el) {
        let node = el.parentElement;
        while (node && node !== document.documentElement) {
            const bg = getComputedStyle(node).backgroundImage;
            if (bg && bg !== "none") {
                const raw = extractBgUrl(bg);
                if (raw && !isSvg(raw)) return resolveUrl(raw);
            }
            node = node.parentElement;
        }
        return null;
    }

    // ─── Styles ───────────────────────────────────────────────────────────────────

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
            #${OVERLAY_ID}.__ix-on { display: block; }
            @keyframes __ixPulseFrame {
                0%, 100% { box-shadow: 0 0 6px ${COLOR},  inset 0 0 6px  rgba(245,158,11,0.12); }
                50%      { box-shadow: 0 0 18px ${COLOR}, inset 0 0 12px rgba(245,158,11,0.28); }
            }
            @keyframes __ixPulseGlow {
                0%, 100% { box-shadow: 0 0 4px  ${COLOR}; }
                50%      { box-shadow: 0 0 12px ${COLOR}; }
            }
            @keyframes __ixMarch {
                to {
                    background-position:
                        12.728px 0,
                        14px 0, -14px 100%,
                        0 -14px, 100% 14px;
                }
            }
            .__ix-dim {
                position: absolute !important;
                background: rgba(0, 0, 0, 0.45) !important;
                transition: left 240ms ease-out, top 240ms ease-out,
                            width 240ms ease-out, height 240ms ease-out !important;
            }
            .__ix-frame {
                position: absolute !important;
                border: 1px solid ${COLOR} !important;
                background-image:
                    repeating-linear-gradient(45deg,
                        transparent 0 7px,
                        rgba(245, 158, 11, 0.10) 7px 9px),
                    linear-gradient(90deg, ${COLOR} 50%, transparent 50%),
                    linear-gradient(90deg, ${COLOR} 50%, transparent 50%),
                    linear-gradient(0deg,  ${COLOR} 50%, transparent 50%),
                    linear-gradient(0deg,  ${COLOR} 50%, transparent 50%) !important;
                background-position: 0 0, 0 0, 0 100%, 0 0, 100% 0;
                background-repeat: repeat, repeat-x, repeat-x, repeat-y, repeat-y !important;
                background-size: auto, 14px 1px, 14px 1px, 1px 14px, 1px 14px !important;
                animation:
                    __ixPulseFrame 1.6s ease-in-out infinite,
                    __ixMarch 700ms linear infinite !important;
                transition: left 240ms ease-out, top 240ms ease-out,
                            width 240ms ease-out, height 240ms ease-out !important;
            }
            .__ix-corner {
                position: absolute !important;
                width: 14px !important;
                height: 14px !important;
                border: 2px solid ${COLOR} !important;
                background: rgba(245, 158, 11, 0.18) !important;
                animation: __ixPulseGlow 1.6s ease-in-out infinite !important;
            }
            .__ix-c-tl { top: -2px;    left: -2px;    border-right: 0 !important; border-bottom: 0 !important; }
            .__ix-c-tr { top: -2px;    right: -2px;   border-left:  0 !important; border-bottom: 0 !important; }
            .__ix-c-bl { bottom: -2px; left: -2px;    border-right: 0 !important; border-top:    0 !important; }
            .__ix-c-br { bottom: -2px; right: -2px;   border-left:  0 !important; border-top:    0 !important; }
            .__ix-handle {
                position: absolute !important;
                background: ${COLOR} !important;
                animation: __ixPulseGlow 1.6s ease-in-out infinite !important;
                transition: left 240ms ease-out, top 240ms ease-out,
                            width 240ms ease-out, height 240ms ease-out !important;
            }
            .__ix-label {
                position: absolute !important;
                font: 700 10px/1 "Courier New", ui-monospace, monospace !important;
                color: ${COLOR} !important;
                text-shadow: 0 0 4px ${COLOR} !important;
                background: rgba(0, 0, 0, 0.7) !important;
                padding: 3px 6px !important;
                letter-spacing: 0.12em !important;
                white-space: nowrap !important;
                border: 1px solid ${COLOR} !important;
            }
            .__ix-l-w { left: 50%; bottom: 100%; transform: translate(-50%, -18px); }
            .__ix-l-h { top: 50%;  right: 100%;  transform-origin: right center;
                        transform: translateY(-50%) translateX(-18px) rotate(-90deg); }
            .__ix-tip {
                position: absolute !important;
                display: none;
                max-width: 300px !important;
                font: 600 11.5px/1.45 -apple-system, "Segoe UI", Arial, sans-serif !important;
                color: #fff !important;
                background: rgba(0, 0, 0, 0.86) !important;
                border: 1px solid ${COLOR} !important;
                border-radius: 5px !important;
                padding: 7px 10px !important;
                box-shadow: 0 0 12px rgba(245, 158, 11, 0.65) !important;
                white-space: normal !important;
                transition: left 240ms ease-out, top 240ms ease-out !important;
            }
            .__ix-tip.__ix-tip-on { display: block; }
            .__ix-tip b { color: ${COLOR} !important; font-weight: 700 !important; }
            html.__ix-cursor, html.__ix-cursor * { cursor: crosshair !important; }

            /* ── Picker overlay ── */
            #${PICKER_ID} {
                position: fixed !important;
                inset: 0 !important;
                z-index: ${Z + 1} !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                background: rgba(0, 0, 0, 0.72) !important;
                font-family: -apple-system, "Segoe UI", Arial, sans-serif !important;
            }
            #${PICKER_ID} * { box-sizing: border-box !important; margin: 0 !important; padding: 0 !important; }
            .__ixp-card {
                background: #0d2236 !important;
                border: 1px solid #0ECAE3 !important;
                box-shadow: 0 0 40px rgba(14, 202, 227, 0.30) !important;
                width: 580px !important;
                max-width: calc(100vw - 32px) !important;
                max-height: calc(100vh - 48px) !important;
                display: flex !important;
                flex-direction: column !important;
                overflow: hidden !important;
            }
            .__ixp-header {
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                padding: 12px 16px !important;
                border-bottom: 1px solid #214a68 !important;
                background: #102C44 !important;
                flex-shrink: 0 !important;
            }
            .__ixp-title {
                font: 700 12px/1 "Courier New", ui-monospace, monospace !important;
                letter-spacing: 0.14em !important;
                color: #0ECAE3 !important;
                text-shadow: 0 0 6px #0ECAE3 !important;
                text-transform: uppercase !important;
            }
            .__ixp-close {
                background: none !important;
                border: 1px solid #214a68 !important;
                color: #5f8ba8 !important;
                font: 700 11px/1 "Courier New", monospace !important;
                cursor: pointer !important;
                padding: 4px 9px !important;
                transition: color 120ms, border-color 120ms !important;
            }
            .__ixp-close:hover { color: #fff !important; border-color: #0ECAE3 !important; }
            .__ixp-body { overflow-y: auto !important; padding: 12px !important; }
            .__ixp-grid {
                display: grid !important;
                grid-template-columns: repeat(2, 1fr) !important;
                gap: 10px !important;
            }
            .__ixp-item {
                border: 1px solid #214a68 !important;
                overflow: hidden !important;
                cursor: pointer !important;
                transition: border-color 120ms, box-shadow 120ms !important;
                background: #122f48 !important;
            }
            .__ixp-item:hover {
                border-color: #0ECAE3 !important;
                box-shadow: 0 0 10px rgba(14, 202, 227, 0.35) !important;
            }
            .__ixp-thumb {
                width: 100% !important;
                height: 140px !important;
                object-fit: contain !important;
                display: block !important;
                background: #0a1c2c !important;
            }
            .__ixp-canvas-thumb {
                width: 100% !important;
                height: 140px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                flex-direction: column !important;
                gap: 8px !important;
                background: #0a1c2c !important;
                color: #5f8ba8 !important;
                font: 600 11px/1.5 -apple-system, "Segoe UI", Arial, sans-serif !important;
                text-align: center !important;
                padding: 16px !important;
            }
            .__ixp-canvas-thumb em {
                color: #F59E0B !important;
                font-style: normal !important;
                font-size: 10px !important;
                display: block !important;
            }
            .__ixp-item-label {
                padding: 6px 8px !important;
                font: 600 10px/1 "Courier New", ui-monospace, monospace !important;
                letter-spacing: 0.08em !important;
                color: #5f8ba8 !important;
                border-top: 1px solid #214a68 !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                display: flex !important;
                align-items: center !important;
                gap: 6px !important;
            }
            .__ixp-item--best {
                border-color: #F59E0B !important;
                box-shadow: 0 0 14px rgba(245, 158, 11, 0.45) !important;
            }
            .__ixp-item--best .__ixp-item-label {
                color: #F59E0B !important;
                border-top-color: rgba(245, 158, 11, 0.4) !important;
            }
            .__ixp-best-badge {
                flex-shrink: 0 !important;
                font: 900 10px/1 "Courier New", ui-monospace, monospace !important;
                letter-spacing: 0.12em !important;
                color: #000 !important;
                background: #F59E0B !important;
                padding: 3px 6px !important;
                text-shadow: none !important;
            }

            /* ── Progress overlay — mirrors the popup's capture animation ── */
            #${PROGRESS_ID} {
                --ixpr-accent:     #0ECAE3;
                --ixpr-accent-rgb: 14, 202, 227;
                --ixpr-danger:     #FF3860;
                --ixpr-danger-rgb: 255, 56, 96;
                --ixpr-panel:      #102C44;
                position: fixed !important;
                inset: 0 !important;
                z-index: ${Z + 1} !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                background: rgba(0, 0, 0, 0.62) !important;
            }
            #${PROGRESS_ID}[data-ix-theme="light"] {
                --ixpr-accent:     #0bb4cd;
                --ixpr-accent-rgb: 11, 180, 205;
                --ixpr-danger:     #df0039;
                --ixpr-danger-rgb: 223, 0, 57;
                --ixpr-panel:      #f3f6f9;
                background: rgba(180, 200, 218, 0.72) !important;
            }
            .__ixpr-card {
                position: relative !important;
                background: var(--ixpr-panel) !important;
                border: 1px solid var(--ixpr-accent) !important;
                box-shadow: 0 0 40px rgba(var(--ixpr-accent-rgb), 0.30) !important;
                padding: 36px 52px !important;
                display: flex !important;
                flex-direction: column !important;
                align-items: center !important;
                gap: 20px !important;
                overflow: hidden !important;
            }
            .__ixpr-scan {
                position: absolute !important;
                left: 0 !important; right: 0 !important; top: -60px !important;
                height: 60px !important;
                pointer-events: none !important;
                background: linear-gradient(180deg,
                    transparent 0%,
                    rgba(var(--ixpr-accent-rgb), 0.015) 40%,
                    rgba(var(--ixpr-accent-rgb), 0.06)  75%,
                    rgba(var(--ixpr-accent-rgb), 0.20)  94%,
                    rgba(var(--ixpr-accent-rgb), 0.32) 100%
                ) !important;
                mix-blend-mode: screen !important;
                animation: __ixScan 2.6s linear infinite !important;
            }
            @keyframes __ixScan {
                0%   { transform: translate3d(0,   0px, 0); opacity: 0;    }
                4%   {                                       opacity: 0.85; }
                90%  { transform: translate3d(0, 280px, 0); opacity: 0.85; }
                100% { transform: translate3d(0, 320px, 0); opacity: 0;    }
            }
            .__ixpr-ring {
                width: 54px !important; height: 54px !important;
                border-radius: 50% !important;
                border: 2px solid var(--ixpr-accent) !important;
                box-shadow: 0 0 8px rgba(var(--ixpr-accent-rgb), 0.80), inset 0 0 12px rgba(var(--ixpr-accent-rgb), 0.35) !important;
                position: relative !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                animation: __ixRingPump 1.2s ease-in-out infinite !important;
            }
            .__ixpr-ring::before, .__ixpr-ring::after {
                content: "" !important;
                position: absolute !important; inset: 0 !important;
                border-radius: 50% !important;
                border: 2px solid var(--ixpr-accent) !important;
                animation: __ixRingExpand 1.8s ease-out infinite !important;
                opacity: 0 !important;
            }
            .__ixpr-ring::after { animation-delay: 0.9s !important; }
            @keyframes __ixRingPump {
                0%,100% { transform: scale(1);    box-shadow: 0 0 8px  rgba(var(--ixpr-accent-rgb), 0.80), inset 0 0 10px rgba(var(--ixpr-accent-rgb), 0.30); }
                50%     { transform: scale(1.12); box-shadow: 0 0 22px rgba(var(--ixpr-accent-rgb), 0.70), inset 0 0 18px rgba(var(--ixpr-accent-rgb), 0.55); }
            }
            @keyframes __ixRingExpand {
                0%   { transform: scale(1);   opacity: 0.7; }
                100% { transform: scale(2.4); opacity: 0;   }
            }
            .__ixpr-dot {
                display: block !important;
                width: 12px !important; height: 12px !important;
                border-radius: 50% !important;
                background: var(--ixpr-danger) !important;
                box-shadow: 0 0 8px rgba(var(--ixpr-danger-rgb), 0.80), 0 0 14px rgba(var(--ixpr-danger-rgb), 0.85), 0 0 28px rgba(var(--ixpr-danger-rgb), 0.45) !important;
                animation: __ixDotPulse 1.2s ease-in-out infinite !important;
            }
            @keyframes __ixDotPulse {
                0%,100% { transform: scale(1);   opacity: 1;    }
                50%     { transform: scale(0.7); opacity: 0.55; }
            }
            .__ixpr-label {
                font: 700 11px/1 "Courier New", ui-monospace, monospace !important;
                letter-spacing: 0.16em !important;
                color: var(--ixpr-accent) !important;
                text-shadow: 0 0 8px rgba(var(--ixpr-accent-rgb), 0.80) !important;
                text-transform: uppercase !important;
                white-space: nowrap !important;
            }
            .__ixpr-dots {
                display: inline-block !important;
                width: 2.2em !important;
                text-align: left !important;
            }
        `;
        document.head.appendChild(style);
        document.documentElement.classList.add("__ix-cursor");
    }

    // ─── Overlay DOM ──────────────────────────────────────────────────────────────

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
        <div class="__ix-dim" data-dim="top"></div>
        <div class="__ix-dim" data-dim="right"></div>
        <div class="__ix-dim" data-dim="bottom"></div>
        <div class="__ix-dim" data-dim="left"></div>
        <div class="__ix-handle" data-handle="top"></div>
        <div class="__ix-handle" data-handle="bottom"></div>
        <div class="__ix-handle" data-handle="left"></div>
        <div class="__ix-handle" data-handle="right"></div>
        <div class="__ix-frame" data-frame>
            <div class="__ix-corner __ix-c-tl"></div>
            <div class="__ix-corner __ix-c-tr"></div>
            <div class="__ix-corner __ix-c-bl"></div>
            <div class="__ix-corner __ix-c-br"></div>
            <div class="__ix-label __ix-l-w" data-label-w></div>
            <div class="__ix-label __ix-l-h" data-label-h></div>
        </div>
        <div class="__ix-tip" data-tip>
            <b>Wheel</b> / <b>↑ ↓</b> = parent / child &middot; <b>← →</b> = prev / next sibling.<br>
            <b>Click</b> or <b>Enter</b> to extract images &middot; <b>Esc</b> to cancel.
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

    let tooltipEnabled = false;
    chrome.storage.local.get("showNavTooltip").then((s) => {
        tooltipEnabled = s.showNavTooltip !== false;
        if (currentElement) paintOverlay(currentElement.getBoundingClientRect());
    });

    // ─── Overlay painting ─────────────────────────────────────────────────────────

    function placeTooltip(rect) {
        if (!tooltipEnabled) { tipEl.classList.remove("__ix-tip-on"); return; }
        tipEl.classList.add("__ix-tip-on");
        const vw  = window.innerWidth;
        const vh  = window.innerHeight;
        const tw  = tipEl.offsetWidth;
        const th  = tipEl.offsetHeight;
        const GAP = 14;
        let top = rect.bottom + GAP + th <= vh ? rect.bottom + GAP
                : rect.top   - GAP - th >= 0  ? rect.top - GAP - th
                : vh - th - GAP;
        let left = rect.left + rect.width / 2 - tw / 2;
        left = Math.max(GAP, Math.min(left, vw - tw - GAP));
        tipEl.style.top  = `${Math.max(GAP, top)}px`;
        tipEl.style.left = `${left}px`;
    }

    function paintOverlay(rect) {
        if (!rect) {
            overlay.classList.remove("__ix-on");
            tipEl.classList.remove("__ix-tip-on");
            firstPaint = true;
            return;
        }
        overlay.classList.add("__ix-on");

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

        setRect(dimTop,   0, 0,  vw,               Math.max(0, t));
        setRect(dimBot,   0, b,  vw,               Math.max(0, vh - b));
        setRect(dimLeft,  0, t,  Math.max(0, l),   Math.max(0, b - t));
        setRect(dimRight, r, t,  Math.max(0, vw-r), Math.max(0, b - t));

        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        setRect(hTop,   cx - 1, 0,           2, Math.max(0, rect.top));
        setRect(hBot,   cx - 1, rect.bottom, 2, Math.max(0, vh - rect.bottom));
        setRect(hLeft,  0,            cy - 1, Math.max(0, rect.left),      2);
        setRect(hRight, rect.right,   cy - 1, Math.max(0, vw - rect.right), 2);

        placeTooltip(rect);
    }

    function setRect(el, x, y, w, h) {
        el.style.left   = `${x}px`;
        el.style.top    = `${y}px`;
        el.style.width  = `${w}px`;
        el.style.height = `${h}px`;
    }

    // ─── DOM navigation ───────────────────────────────────────────────────────────

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

    function highlight(el) {
        currentElement = el;
        paintOverlay(el ? el.getBoundingClientRect() : null);
    }

    function isOwnNode(el) {
        return el.id === OVERLAY_ID || el.id === STYLE_ID || el.id === PICKER_ID;
    }

    function navigateToParent() {
        const parent = currentElement.parentElement;
        if (parent && parent !== document.documentElement) {
            const target = topmostSameRect(parent);
            descentMemory.set(target, currentElement);
            highlight(target);
        }
    }

    function navigateToChild() {
        const target = descendDifferent(currentElement);
        if (target) highlight(target);
    }

    function navigateToSibling(forward) {
        let el = currentElement;
        while (el && el !== document.body && el !== document.documentElement) {
            let sib = forward ? el.nextElementSibling : el.previousElementSibling;
            while (sib && isOwnNode(sib)) {
                sib = forward ? sib.nextElementSibling : sib.previousElementSibling;
            }
            if (sib) { highlight(sib); return; }
            el = el.parentElement;
        }
    }

    function lockHover() {
        isScrollLocked = true;
        clearTimeout(scrollLockTimer);
        scrollLockTimer = setTimeout(() => {
            isScrollLocked = false;
            lastCommittedX = pendingX;
            lastCommittedY = pendingY;
        }, SCROLL_LOCK_MS);
    }

    // ─── Event handlers ───────────────────────────────────────────────────────────

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
        lockHover();
        if (e.deltaY < 0) navigateToParent();
        else              navigateToChild();
    }

    function onKeyDown(e) {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            destroy();
            return;
        }
        if (e.key === "Enter") {
            if (!currentElement) return;
            e.preventDefault();
            e.stopPropagation();
            commitSelection();
            return;
        }
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

    function onClick(e) {
        e.preventDefault();
        e.stopPropagation();
        commitSelection();
    }

    // ─── Commit ───────────────────────────────────────────────────────────────────

    function commitSelection() {
        if (!currentElement) return;
        const el = currentElement;
        const cropMode = manualCrop;
        detachHighlighter();

        let candidates = findImages(el);

        if (candidates.length === 0) {
            const bgUrl = walkUpForBg(el);
            if (bgUrl) candidates = [{ url: bgUrl, label: "bg (ancestor)", type: "bg" }];
        }

        if (candidates.length === 0) {
            showToast("No raster images found. Try selecting a larger element, or use Capture Element.");
            return;
        }

        // Single non-canvas result → skip the picker
        if (candidates.length === 1 && candidates[0].type !== "canvas") {
            if (cropMode) sendCrop(candidates[0].url);
            else          sendDownload(candidates[0].url);
            return;
        }

        showPicker(candidates, cropMode);
    }

    // ─── Picker ───────────────────────────────────────────────────────────────────

    function esc(s) {
        return String(s || "").replace(/[&<>"]/g, c =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    }

    function showPicker(candidates, cropMode) {
        let gridHtml = "";
        let bestMarked = false;
        for (const c of candidates) {
            if (c.type === "canvas") {
                gridHtml += `
                    <div class="__ixp-item" data-canvas="1">
                        <div class="__ixp-canvas-thumb">
                            Canvas element<em>Use Capture Element for pixel-perfect results</em>
                        </div>
                        <div class="__ixp-item-label">CANVAS · ${esc(c.label)}</div>
                    </div>`;
            } else {
                const isBest  = !bestMarked;
                bestMarked    = true;
                const cls     = isBest ? "__ixp-item __ixp-item--best" : "__ixp-item";
                const badge   = isBest ? `<span class="__ixp-best-badge">BEST</span>` : "";
                gridHtml += `
                    <div class="${cls}" data-url="${esc(c.url)}">
                        <img class="__ixp-thumb" src="${esc(c.url)}" alt="" loading="lazy" />
                        <div class="__ixp-item-label">${badge}${esc(c.type.toUpperCase())} · ${esc(c.label)}</div>
                    </div>`;
            }
        }

        const picker = document.createElement("div");
        picker.id = PICKER_ID;
        picker.setAttribute("role", "dialog");
        picker.setAttribute("aria-modal", "true");
        picker.innerHTML = `
            <div class="__ixp-card">
                <div class="__ixp-header">
                    <div class="__ixp-title">Select Image · ${candidates.filter(c => c.type !== "canvas").length} found</div>
                    <button class="__ixp-close" type="button">ESC</button>
                </div>
                <div class="__ixp-body">
                    <div class="__ixp-grid">${gridHtml}</div>
                </div>
            </div>
        `;
        document.documentElement.appendChild(picker);

        function closePicker() {
            document.removeEventListener("keydown", onPickerKey, true);
            picker.remove();
        }

        function onPickerKey(e) {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePicker(); }
        }

        document.addEventListener("keydown", onPickerKey, true);

        picker.querySelector(".__ixp-close").addEventListener("click", closePicker);

        picker.addEventListener("click", (e) => {
            const item = e.target.closest(".__ixp-item");
            if (!item) return;
            if (item.dataset.canvas) {
                closePicker();
                showToast("Canvas detected — use Capture Element for pixel-perfect results.");
                return;
            }
            const url = item.dataset.url;
            if (!url) return;
            closePicker();
            if (cropMode) sendCrop(url);
            else          sendDownload(url);
        });
    }

    // ─── Download + progress + toast ─────────────────────────────────────────────

    async function sendCrop(url) {
        await showProgress();
        try {
            await chrome.runtime.sendMessage({ action: "imageExtractorCropUrl", url });
        } catch {
            showToast("Could not open crop editor — check extension permissions and try again.");
        } finally {
            hideProgress();
        }
    }

    async function sendDownload(url) {
        await showProgress();
        try {
            await chrome.runtime.sendMessage({ action: "imageExtractorDownload", url });
        } catch {
            showToast("Download failed — check extension permissions and try again.");
        } finally {
            hideProgress();
        }
    }

    async function showProgress() {
        hideProgress();

        // Resolve theme from storage — fast local read
        let theme = "dark";
        try {
            const { themeOverride } = await chrome.storage.local.get("themeOverride");
            const pref = themeOverride || "auto";
            theme = pref === "auto"
                ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
                : pref;
        } catch { /* keep dark */ }

        const el = document.createElement("div");
        el.id = PROGRESS_ID;
        el.dataset.ixTheme = theme;
        el.innerHTML = `
            <div class="__ixpr-card">
                <div class="__ixpr-scan"></div>
                <div class="__ixpr-ring"><span class="__ixpr-dot"></span></div>
                <div class="__ixpr-label">EXTRACTING<span class="__ixpr-dots" id="__ixpr-dots"></span></div>
            </div>`;
        document.documentElement.appendChild(el);

        let dots = 0;
        progressTimer = setInterval(() => {
            dots = (dots + 1) % 4;
            const span = document.getElementById("__ixpr-dots");
            if (span) span.textContent = ".".repeat(dots);
        }, 380);
    }

    function hideProgress() {
        clearInterval(progressTimer);
        progressTimer = null;
        document.getElementById(PROGRESS_ID)?.remove();
    }

    function showToast(text) {
        const TOAST_ID = "__ix-toast";
        document.getElementById(TOAST_ID)?.remove();
        const toast = document.createElement("div");
        toast.id = TOAST_ID;
        Object.assign(toast.style, {
            position:     "fixed",
            top:          "20px",
            left:         "50%",
            transform:    "translateX(-50%)",
            zIndex:       String(Z + 2),
            background:   "rgba(5, 18, 32, 0.97)",
            border:       `2px solid ${COLOR}`,
            padding:      "12px 22px",
            font:         '700 13px/1.45 -apple-system, "Segoe UI", Arial, sans-serif',
            color:        "#F0F4F8",
            boxShadow:    `0 0 28px rgba(245, 158, 11, 0.75), 0 4px 24px rgba(0,0,0,0.6)`,
            maxWidth:     "480px",
            textAlign:    "center",
            pointerEvents:"none",
            whiteSpace:   "normal",
        });
        toast.textContent = text;
        document.documentElement.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
    }

    // ─── Cleanup ──────────────────────────────────────────────────────────────────

    function detachHighlighter() {
        if (hoverRafId !== null) cancelAnimationFrame(hoverRafId);
        clearTimeout(scrollLockTimer);
        document.removeEventListener("mousemove", onMouseMove, true);
        document.removeEventListener("click",     onClick,     true);
        document.removeEventListener("wheel",     onWheel,     true);
        document.removeEventListener("keydown",   onKeyDown,   true);
        window.removeEventListener("resize", onViewportChange, true);
        window.removeEventListener("scroll", onViewportChange, true);
        chrome.runtime.onMessage.removeListener(optionsListener);
        currentElement = null;
        document.documentElement.classList.remove("__ix-cursor");
        overlay.remove();
    }

    function destroy() {
        detachHighlighter();
        hideProgress();
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(PICKER_ID)?.remove();
        delete window.__ImageExtractorDestroy;
    }

    function onViewportChange() {
        if (currentElement) paintOverlay(currentElement.getBoundingClientRect());
    }

    window.__ImageExtractorDestroy = destroy;

    document.addEventListener("mousemove", onMouseMove, { capture: true });
    document.addEventListener("click",     onClick,     { capture: true });
    document.addEventListener("wheel",     onWheel,     { capture: true, passive: false });
    document.addEventListener("keydown",   onKeyDown,   { capture: true });
    window.addEventListener("resize", onViewportChange, true);
    window.addEventListener("scroll", onViewportChange, true);
})();
