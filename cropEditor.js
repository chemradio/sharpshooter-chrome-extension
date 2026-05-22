// Manual crop editor. Loaded as a regular extension page tab opened by
// downloadScreenshot.js when the user chose a "with crop" capture. Reads
// the just-captured PNG blob out of IndexedDB (one-shot — delete on read),
// draws it into a fitted canvas, lets the user adjust an 8-handle crop
// rectangle, then crops + downloads on Save.
//
// We render the source PNG at its NATIVE pixel size into the canvas, then
// scale the canvas element via CSS to fit the viewport. All crop math
// lives in display coordinates while the user drags; we convert back to
// image-pixel coords once at save time so the output is pixel-perfect.

(function () {
    const DB_NAME    = "sharpshooter-crop";
    const STORE_NAME = "blobs";
    const DB_VERSION = 1;

    const MIN_BOX = 8;   // minimum crop dimension in display pixels

    function closeTab() {
        chrome.tabs?.getCurrent?.((tab) => {
            if (tab?.id != null) chrome.tabs.remove(tab.id);
            else window.close();
        });
    }

    // ─── IndexedDB ────────────────────────────────────────────────────────

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    async function takeBlob(token) {
        const db = await openDb();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, "readwrite");
                const store = tx.objectStore(STORE_NAME);
                const getReq = store.get(token);
                let value;
                getReq.onsuccess = () => {
                    value = getReq.result;
                    if (value !== undefined) store.delete(token);
                };
                tx.oncomplete = () => resolve(value);
                tx.onerror    = () => reject(tx.error);
                tx.onabort    = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    }

    // ─── DOM ──────────────────────────────────────────────────────────────

    const canvas       = document.getElementById("image");
    const ctx          = canvas.getContext("2d");
    const wrap         = document.getElementById("canvasWrap");
    const overlay      = document.getElementById("overlay");
    const cropBox      = document.getElementById("cropBox");
    const readout      = document.getElementById("readout");
    const hint         = document.getElementById("hint");
    const stage        = document.getElementById("stage");
    const btnConfirm   = document.getElementById("confirm");
    const btnCancel    = document.getElementById("cancel");
    const btnReset     = document.getElementById("reset");
    const handles      = cropBox.querySelectorAll(".handle");

    // ─── State ────────────────────────────────────────────────────────────

    let bitmap      = null;     // decoded source image (full resolution)
    let filename    = "crop.png";
    let fitScale    = 1;        // scale that fits the source into the stage
    let userZoom    = 1;        // wheel-driven extra zoom on top of fitScale
    let displayScale = 1;       // displayPx / imagePx  (fitScale * userZoom)

    const MIN_USER_ZOOM = 0.1;
    const MAX_USER_ZOOM = 16;

    // Crop rect in DISPLAY coordinates, relative to canvas top-left.
    let box = { x: 0, y: 0, w: 0, h: 0 };

    function updateReadout() {
        const wImg = Math.round(box.w / displayScale);
        const hImg = Math.round(box.h / displayScale);
        readout.textContent =
            `${wImg} × ${hImg} px   (source ${bitmap.width} × ${bitmap.height})`;
    }

    function applyBoxToDom() {
        cropBox.style.left   = `${box.x}px`;
        cropBox.style.top    = `${box.y}px`;
        cropBox.style.width  = `${box.w}px`;
        cropBox.style.height = `${box.h}px`;
        updateReadout();
    }

    function resetBox() {
        box = { x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight };
        applyBoxToDom();
    }

    // ─── Fit canvas to viewport ───────────────────────────────────────────
    //
    // Render at native resolution (so the crop downloads pixel-perfect)
    // but scale the canvas element via CSS so the whole image fits the
    // visible stage. Recompute on window resize.

    function applyDisplayScale() {
        displayScale = fitScale * userZoom;
        const dispW = Math.max(1, Math.floor(bitmap.width  * displayScale));
        const dispH = Math.max(1, Math.floor(bitmap.height * displayScale));
        canvas.style.width  = `${dispW}px`;
        canvas.style.height = `${dispH}px`;
        // Overlay sizes to the canvas via inset:0 on .overlay (parent is wrap).
    }

    function fitCanvas() {
        const padding = 48;
        const availW = stage.clientWidth  - padding;
        const availH = stage.clientHeight - padding;
        const scaleX = availW / bitmap.width;
        const scaleY = availH / bitmap.height;
        // Don't upscale past 1× — sharper to scroll a 1:1 image than blur it.
        fitScale = Math.min(1, scaleX, scaleY);
        applyDisplayScale();
    }

    // Center the canvas-wrap in the visible stage viewport. The .canvas-area
    // sibling is oversized (see CSS) so middle-click pan can carry the image
    // past the viewport edges; without recentering, the initial scroll
    // position would land the user in the empty slack area.
    function centerView() {
        const sr = stage.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        stage.scrollLeft += (wr.left + wr.width  / 2) - (sr.left + sr.width  / 2);
        stage.scrollTop  += (wr.top  + wr.height / 2) - (sr.top  + sr.height / 2);
    }

    // Scroll the stage so the crop box is centered in the visible viewport.
    function centerViewOnBox() {
        const boxCenterX = wrap.offsetLeft + box.x + box.w / 2;
        const boxCenterY = wrap.offsetTop  + box.y + box.h / 2;
        stage.scrollLeft = boxCenterX - stage.clientWidth  / 2;
        stage.scrollTop  = boxCenterY - stage.clientHeight / 2;
    }

    // Animate userZoom → targetUserZoom over a short ease, keeping the crop
    // box centered in the viewport throughout. cancelZoomAnim() stops any
    // in-flight animation so a fresh gesture (wheel, drag) takes over cleanly.
    let zoomAnim = null;

    function cancelZoomAnim() {
        if (zoomAnim != null) {
            cancelAnimationFrame(zoomAnim);
            zoomAnim = null;
        }
    }

    function animateZoomTo(targetUserZoom) {
        cancelZoomAnim();
        const startZoom = userZoom;
        const startTime = performance.now();
        const DURATION  = 220;   // ms
        function frame(now) {
            const t = Math.min(1, (now - startTime) / DURATION);
            // easeInOutQuad
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            const oldScale = displayScale;
            userZoom = startZoom + (targetUserZoom - startZoom) * e;
            applyDisplayScale();
            rescaleBoxAfterFit(oldScale, displayScale);
            centerViewOnBox();
            zoomAnim = t < 1 ? requestAnimationFrame(frame) : null;
        }
        zoomAnim = requestAnimationFrame(frame);
    }

    // Auto-zoom so the crop box fills ~75% of the stage (≈12% slack on each
    // side), leaving room for the user to keep resizing comfortably. Called
    // after a resize drag finishes — a tiny crop on a huge page is awkward
    // to fine-tune at fit scale.
    function zoomToFitBox() {
        if (!bitmap || box.w < MIN_BOX || box.h < MIN_BOX) return;
        const imgW = box.w / displayScale;
        const imgH = box.h / displayScale;
        if (imgW < 1 || imgH < 1) return;

        const FILL = 0.75;   // crop box target fraction of the stage
        const target = Math.min(
            (stage.clientWidth  * FILL) / imgW,
            (stage.clientHeight * FILL) / imgH
        );
        const newUserZoom = Math.max(
            MIN_USER_ZOOM, Math.min(MAX_USER_ZOOM, target / fitScale)
        );
        // Only zoom IN. If the user is already zoomed in past what the fit
        // would set, they're finessing crop points — leave their zoom and
        // scroll position untouched.
        if (newUserZoom <= userZoom + 1e-3) return;

        animateZoomTo(newUserZoom);
    }

    function rescaleBoxAfterFit(oldScale, newScale) {
        if (!oldScale || oldScale === newScale) return;
        const k = newScale / oldScale;
        box.x = box.x * k;
        box.y = box.y * k;
        box.w = box.w * k;
        box.h = box.h * k;
        clampBox();
        applyBoxToDom();
    }

    function clampBox() {
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        if (box.w < MIN_BOX) box.w = MIN_BOX;
        if (box.h < MIN_BOX) box.h = MIN_BOX;
        if (box.w > W) box.w = W;
        if (box.h > H) box.h = H;
        if (box.x < 0) box.x = 0;
        if (box.y < 0) box.y = 0;
        if (box.x + box.w > W) box.x = W - box.w;
        if (box.y + box.h > H) box.y = H - box.h;
    }

    // ─── Drag interactions ────────────────────────────────────────────────

    let drag = null;
    // drag.kind: "move" | "resize"
    // drag.handle: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
    // drag.startPointer: {x,y} in wrap-relative coords
    // drag.startBox: snapshot of box at drag start

    function wrapCoords(ev) {
        const rect = wrap.getBoundingClientRect();
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function startDrag(kind, handle, ev) {
        ev.preventDefault();
        ev.stopPropagation();
        cancelZoomAnim();
        drag = {
            kind,
            handle,
            startPointer: wrapCoords(ev),
            startBox: { ...box },
        };
        document.body.style.userSelect = "none";
    }

    function onPointerMove(ev) {
        if (!drag) return;
        const p = wrapCoords(ev);
        const dx = p.x - drag.startPointer.x;
        const dy = p.y - drag.startPointer.y;

        if (drag.kind === "move") {
            box.x = drag.startBox.x + dx;
            box.y = drag.startBox.y + dy;
        } else {
            // resize — adjust the edges named by the handle. Hold Alt to
            // resize symmetrically around the box center: dragging one
            // edge by dx moves the opposite edge by -dx so the center
            // stays fixed.
            const s = drag.startBox;
            const sym = ev.altKey;
            let x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
            if (drag.handle.includes("w")) {
                x1 = s.x + dx;
                if (sym) x2 = s.x + s.w - dx;
            }
            if (drag.handle.includes("e")) {
                x2 = s.x + s.w + dx;
                if (sym) x1 = s.x - dx;
            }
            if (drag.handle.includes("n")) {
                y1 = s.y + dy;
                if (sym) y2 = s.y + s.h - dy;
            }
            if (drag.handle.includes("s")) {
                y2 = s.y + s.h + dy;
                if (sym) y1 = s.y - dy;
            }
            // Allow inversion: if user drags past the opposite edge, swap.
            box.x = Math.min(x1, x2);
            box.y = Math.min(y1, y2);
            box.w = Math.abs(x2 - x1);
            box.h = Math.abs(y2 - y1);
        }
        clampBox();
        applyBoxToDom();
    }

    function endDrag() {
        if (!drag) return;
        const wasResize = drag.kind === "resize";
        drag = null;
        document.body.style.userSelect = "";
        if (wasResize) zoomToFitBox();
    }

    cropBox.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        if (ev.target !== cropBox) return;
        startDrag("move", null, ev);
    });

    handles.forEach((h) => {
        h.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            startDrag("resize", h.dataset.handle, ev);
        });
    });

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup",   endDrag);
    window.addEventListener("pointercancel", endDrag);

    // ─── Wheel zoom (anchored at the cursor) ──────────────────────────────
    //
    // Convert the cursor's stage-space position to an image-pixel anchor
    // BEFORE rescaling, then after rescaling adjust scrollLeft/scrollTop so
    // the same image pixel ends up under the cursor again. Ctrl+wheel is the
    // browser's page-zoom gesture, so leave it alone when Ctrl is held —
    // plain wheel = our zoom, Ctrl+wheel = browser zoom.

    stage.addEventListener("wheel", (ev) => {
        if (ev.ctrlKey) return;
        ev.preventDefault();
        cancelZoomAnim();

        const stageRect = stage.getBoundingClientRect();
        const cursorStageX = ev.clientX - stageRect.left + stage.scrollLeft;
        const cursorStageY = ev.clientY - stageRect.top  + stage.scrollTop;

        // The image lives at some offset inside the stage because the wrap
        // is centered horizontally and top-aligned via stage's flex layout
        // (justify-content: center; align-items: flex-start). Use the
        // wrap's offsetLeft/offsetTop relative to the stage to find that.
        const wrapOffsetX = wrap.offsetLeft;
        const wrapOffsetY = wrap.offsetTop;

        // Cursor position in canvas/display coords.
        const cursorDispX = cursorStageX - wrapOffsetX;
        const cursorDispY = cursorStageY - wrapOffsetY;

        // Image-pixel anchor (the pixel the user wants to keep under the cursor).
        const anchorImgX = cursorDispX / displayScale;
        const anchorImgY = cursorDispY / displayScale;

        const oldScale = displayScale;
        const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
        const targetZoom = userZoom * factor;
        userZoom = Math.max(MIN_USER_ZOOM, Math.min(MAX_USER_ZOOM, targetZoom));

        applyDisplayScale();
        rescaleBoxAfterFit(oldScale, displayScale);

        // After resize, the wrap may have moved (still centered, but the
        // canvas is a different size). Recompute its offset and set scroll
        // so the anchor pixel lands at the cursor's stage position.
        const newWrapOffsetX = wrap.offsetLeft;
        const newWrapOffsetY = wrap.offsetTop;
        const newDispAnchorX = anchorImgX * displayScale;
        const newDispAnchorY = anchorImgY * displayScale;
        stage.scrollLeft = newWrapOffsetX + newDispAnchorX - (ev.clientX - stageRect.left);
        stage.scrollTop  = newWrapOffsetY + newDispAnchorY - (ev.clientY - stageRect.top);
    }, { passive: false });

    // ─── Middle-click pan ─────────────────────────────────────────────────
    //
    // Photoshop-style: hold middle mouse + drag to pan the whole stage,
    // including the crop frame (the frame sits on the canvas so it pans
    // along for free — we only move scroll position, not box coords).
    // We must preventDefault on the mousedown to suppress Chrome's
    // built-in middle-click autoscroll (the scrolling-circle cursor).

    let pan = null;

    stage.addEventListener("mousedown", (ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        pan = {
            startX: ev.clientX,
            startY: ev.clientY,
            startScrollLeft: stage.scrollLeft,
            startScrollTop:  stage.scrollTop,
        };
        stage.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (ev) => {
        if (!pan) return;
        stage.scrollLeft = pan.startScrollLeft - (ev.clientX - pan.startX);
        stage.scrollTop  = pan.startScrollTop  - (ev.clientY - pan.startY);
    });

    window.addEventListener("mouseup", (ev) => {
        if (!pan || ev.button !== 1) return;
        pan = null;
        stage.style.cursor = "";
    });

    // Suppress the middle-click context-menu / paste behavior inside the stage.
    stage.addEventListener("auxclick", (ev) => {
        if (ev.button === 1) ev.preventDefault();
    });

    // ─── Save / cancel ────────────────────────────────────────────────────

    async function doSave() {
        // Convert display-coord box → image-pixel box.
        const sx = Math.round(box.x / displayScale);
        const sy = Math.round(box.y / displayScale);
        const sw = Math.round(box.w / displayScale);
        const sh = Math.round(box.h / displayScale);

        const out = new OffscreenCanvas(sw, sh);
        const octx = out.getContext("2d");
        octx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
        const blob = await out.convertToBlob({ type: "image/png" });
        const url = URL.createObjectURL(blob);
        try {
            await new Promise((resolve, reject) => {
                chrome.downloads.download(
                    { url, filename, saveAs: true },
                    (id) => {
                        const err = chrome.runtime.lastError;
                        if (err) return reject(new Error(err.message));
                        if (id == null) return reject(new Error("Download did not start"));
                        resolve(id);
                    }
                );
            });
        } finally {
            // Give the download a moment to read the blob before revoking.
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
        }
        closeTab();
    }

    btnConfirm.addEventListener("click", () => {
        doSave().catch((e) => {
            console.error("Crop save failed:", e);
            hint.textContent = `Save failed: ${e.message ?? e}`;
            hint.style.color = "var(--danger)";
        });
    });

    btnCancel.addEventListener("click", () => closeTab());
    btnReset.addEventListener("click", () => {
        const oldScale = displayScale;
        userZoom = 1;
        applyDisplayScale();
        rescaleBoxAfterFit(oldScale, displayScale);
        resetBox();
    });

    window.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") closeTab();
        else if (ev.key === "Enter") doSave().catch(() => {});
    });

    // ─── Init ─────────────────────────────────────────────────────────────

    async function init() {
        const params = new URLSearchParams(location.search);
        const token = params.get("token");
        if (!token) {
            hint.textContent = "No crop token in URL.";
            hint.style.color = "var(--danger)";
            return;
        }

        let payload;
        try {
            payload = await takeBlob(token);
        } catch (e) {
            hint.textContent = `Could not load image: ${e.message ?? e}`;
            hint.style.color = "var(--danger)";
            return;
        }
        if (!payload || !payload.blob) {
            hint.textContent = "Image not found (already opened or expired).";
            hint.style.color = "var(--danger)";
            return;
        }

        filename = payload.filename ?? filename;
        // Insert "-crop" before the extension so cropped output is
        // distinguishable from the un-cropped original.
        filename = filename.replace(/(\.png)?$/i, "-crop.png");

        bitmap = await createImageBitmap(payload.blob);
        canvas.width  = bitmap.width;
        canvas.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);

        fitCanvas();
        resetBox();
        centerView();

        window.addEventListener("resize", () => {
            const old = displayScale;
            fitCanvas();
            rescaleBoxAfterFit(old, displayScale);
            centerView();
        });
    }

    init();
})();
