// Arcade — the mini-game hub behind the header brand mark.
//
// Entirely popup-local: no service worker, no permissions, no manifest
// changes. Clicking the animated logo swaps the popup to #view-arcade
// (same view-switching pattern as Settings / Help / Legal Capture
// Settings) and expands the mark into a hero position above the cabinet.
//
// This file owns everything that isn't a game: view switching, the game
// picker, the score readout, chrome.storage.local persistence, the
// pause/resume plumbing, and a shared rAF loop helper. The four games
// register themselves against it (see arcade/snake.js and friends) and
// only ever talk to the `ctx` object handed to their create().
//
// Game interface — each registered game's create(ctx) returns:
//   init(container, savedState)  build DOM/canvas, restore or start fresh
//   getState()                   resumable snapshot, or null when the run
//                                isn't worth restoring (game over / not
//                                started). Drives every persistence path.
//   pause()   -> state           freeze; returns the same snapshot
//   resume()                     unfreeze after a pause
//   destroy()                    tear down canvas + every input listener
//   onScore(cb)                  hub subscribes; cb(score) on every change
//   isOver?()                    optional; suppresses the resume overlay
//
// Storage lives in one `arcade` object in chrome.storage.local:
//   { lastGame, games: { <id>: { highscore, keepState, saved } } }
// Saved runs carry their game's own `v` (saveVersion); a mismatch is
// discarded in favour of a fresh game rather than crashing on stale shape.
(function () {
    // The cabinet screen. Fixed logical size — the popup is 360px wide and
    // the arcade view keeps the standard 14px side padding, leaving 330.
    const STAGE_W = 330;
    const STAGE_H = 270;

    const STORAGE_KEY       = "arcade";
    const SAVE_THROTTLE_MS  = 500;   // real-time games; turn-based save at once
    const CONFIRM_WINDOW_MS = 3000;  // "Reset highscore" -> "Sure?" window

    // Registered games, in registration order = picker order.
    const registry = [];

    // ─── Registration (called by the game files, before init below) ──────────

    window.__Arcade = {
        STAGE_W,
        STAGE_H,
        // def: { id, nameKey, realtime, saveVersion, create(ctx) }
        register(def) { registry.push(def); },
    };

    // ─── Localized-string helper ─────────────────────────────────────────────
    //
    // Mirrors popup.js's t(): resolves through window.__i18n so the Settings
    // language override applies here too.
    const t = (key, ...subs) =>
        window.__i18n.get(key, subs.length ? subs.map(String) : undefined);

    // ─── Persistent store ────────────────────────────────────────────────────

    let store = { lastGame: null, games: {} };
    let storeLoaded = false;

    function gameStore(id) {
        let gs = store.games[id];
        if (!gs) {
            // keepState defaults ON — the toggle's own position is always
            // persisted, so this only ever applies to a never-played game.
            gs = store.games[id] = { highscore: 0, keepState: true, saved: null };
        }
        return gs;
    }

    function persist() {
        chrome.storage.local.set({ [STORAGE_KEY]: store });
    }

    async function loadStore() {
        try {
            const s = await chrome.storage.local.get(STORAGE_KEY);
            const raw = s?.[STORAGE_KEY];
            if (raw && typeof raw === "object") {
                store = {
                    lastGame: typeof raw.lastGame === "string" ? raw.lastGame : null,
                    games: raw.games && typeof raw.games === "object" ? raw.games : {},
                };
            }
        } catch (e) {
            console.warn("arcade: store load failed, starting empty:", e);
        }
        storeLoaded = true;
    }

    // ─── DOM ─────────────────────────────────────────────────────────────────

    let popupEl, viewArcade, headerIcon, stageEl, overlayEl, overlayTextEl;
    let picker, scoreEl, highEl, keepCb, resetGameBtn, resetHighBtn, closeBtn;

    // ─── Active game ─────────────────────────────────────────────────────────

    let active = null;          // { def, inst }
    let awaitingResume = false; // hub owns the overlay while true
    let saveTimer = null;
    let confirmTimer = null;

    // ─── Shared helpers handed to each game ──────────────────────────────────

    // rAF loop with a clamped delta. Clamping matters because a popup that
    // loses focus stops receiving frames — without it the first frame back
    // would advance a real-time game by however long the popup was idle.
    function makeLoop(step) {
        let raf = 0;
        let last = 0;
        function frame(now) {
            const dt = last ? Math.min(now - last, 50) : 16;
            last = now;
            step(dt, now);
            raf = requestAnimationFrame(frame);
        }
        return {
            start() {
                if (raf) return;
                last = 0;
                raf = requestAnimationFrame(frame);
            },
            stop() {
                if (!raf) return;
                cancelAnimationFrame(raf);
                raf = 0;
            },
            get running() { return !!raf; },
        };
    }

    // Backing-store scaled canvas — drawn in logical STAGE_W×STAGE_H units,
    // rendered at device resolution so the phosphor glow stays crisp on HiDPI.
    function makeCanvas() {
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const el = document.createElement("canvas");
        el.className = "arcade-canvas";
        el.width  = Math.round(STAGE_W * dpr);
        el.height = Math.round(STAGE_H * dpr);
        el.style.width  = `${STAGE_W}px`;
        el.style.height = `${STAGE_H}px`;
        const g = el.getContext("2d");
        g.scale(dpr, dpr);
        return { el, g };
    }

    // Colors are read off the live stylesheet rather than hardcoded, so the
    // games repaint correctly under both popup.css and popup-light.css.
    function palette() {
        const cs = getComputedStyle(document.documentElement);
        const v = (name, fallback) =>
            (cs.getPropertyValue(name) || "").trim() || fallback;
        return {
            accent:    v("--accent", "#0ECAE3"),
            accentDim: v("--accent-dim", "#0aaec5"),
            danger:    v("--danger", "#FF0055"),
            amber:     v("--amber", "#F59E0B"),
            text:      v("--text", "#DEE5EC"),
            muted:     v("--text-muted", "#5f8ba8"),
            void_:     v("--void", "#000000"),
            border:    v("--border", "#214a68"),
            screen:    v("--arcade-screen", "#04121d"),
            grid:      v("--arcade-grid", "rgba(14,202,227,0.10)"),
        };
    }

    function makeCtx(def) {
        return {
            t,
            STAGE_W,
            STAGE_H,
            canvas: makeCanvas,
            loop: makeLoop,
            palette,
            // Throttled — for the per-tick churn of a real-time game.
            save: () => scheduleSave(def.id),
            // Immediate — for score / life / level changes and every
            // discrete move of a turn-based game.
            saveNow: () => flushSave(def.id),
            setOverlay: (text, sub) => {
                if (awaitingResume) return;   // hub's pause prompt wins
                setOverlay(text, sub);
            },
            clearOverlay: () => {
                if (awaitingResume) return;
                clearOverlay();
            },
        };
    }

    // ─── Save plumbing ───────────────────────────────────────────────────────

    function writeState(id) {
        if (!active || active.def.id !== id || !storeLoaded) return;
        const gs = gameStore(id);
        // Keep-state OFF discards the run — but never the highscore, which is
        // written on its own path in handleScore().
        const state = gs.keepState ? safeCall(() => active.inst.getState()) : null;
        gs.saved = state || null;
        persist();
    }

    function scheduleSave(id) {
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            writeState(id);
        }, SAVE_THROTTLE_MS);
    }

    function flushSave(id) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        writeState(id);
    }

    function safeCall(fn, fallback = null) {
        try { return fn(); } catch (e) { console.warn("arcade:", e); return fallback; }
    }

    // ─── Overlay ─────────────────────────────────────────────────────────────

    function setOverlay(text, sub = "") {
        overlayTextEl.textContent = text;
        overlayEl.querySelector(".arcade-overlay-sub").textContent = sub;
        overlayEl.hidden = false;
    }

    function clearOverlay() {
        overlayEl.hidden = true;
        overlayEl.classList.remove("is-blocking");
    }

    function showResumePrompt() {
        awaitingResume = true;
        setOverlay(t("arcadePaused"), t("arcadePausedHint"));
        // Only the hub's own pause prompt swallows clicks — a game's prompt
        // ("click to launch") has to let the pointer through to the canvas.
        overlayEl.classList.add("is-blocking");
    }

    // Any key or click inside the arcade dismisses the pause prompt. Never
    // auto-resumes: a real-time game restored from storage stays frozen until
    // the user actually asks for it.
    function dismissResumePrompt() {
        if (!awaitingResume) return true;
        awaitingResume = false;
        clearOverlay();
        if (active) safeCall(() => active.inst.resume());
        return true;
    }

    // ─── Score readout ───────────────────────────────────────────────────────

    function handleScore(id, score) {
        if (!active || active.def.id !== id) return;
        scoreEl.textContent = String(score);
        const gs = gameStore(id);
        // Highscores are unconditional and written the moment they're beaten —
        // a popup close (which fires no reliable unload event) can never lose
        // one, and the keep-state toggle has no say over it.
        if (score > (gs.highscore || 0)) {
            gs.highscore = score;
            highEl.textContent = String(score);
            persist();
        }
    }

    // ─── Game lifecycle ──────────────────────────────────────────────────────

    function teardownActive() {
        if (!active) return;
        const { def, inst } = active;
        // pause() returns the snapshot; route it through the same keep-state
        // gate as every other save.
        safeCall(() => inst.pause());
        flushSave(def.id);
        safeCall(() => inst.destroy());
        active = null;
        awaitingResume = false;
        clearOverlay();
        stageEl.innerHTML = "";
    }

    function startGame(id, { fresh = false } = {}) {
        const def = registry.find((g) => g.id === id) || registry[0];
        if (!def) return;

        teardownActive();

        const gs = gameStore(def.id);
        let saved = fresh || !gs.keepState ? null : gs.saved;
        // Versioned saved state — a schema change from a previous extension
        // build discards the run instead of feeding a game a shape it can't
        // read.
        if (saved && saved.v !== def.saveVersion) saved = null;

        const inst = def.create(makeCtx(def));
        inst.onScore((score) => handleScore(def.id, score));

        try {
            inst.init(stageEl, saved);
        } catch (e) {
            // Belt and braces on top of the version check: a saved run that
            // still can't be restored costs the run, never the session.
            console.warn("arcade: restore failed, starting fresh:", e);
            safeCall(() => inst.destroy());
            stageEl.innerHTML = "";
            inst.init(stageEl, null);
        }

        active = { def, inst };
        store.lastGame = def.id;

        // Reflect the picker + readout + per-game controls.
        const radio = picker.querySelector(`#arcade-game-${def.id}`);
        if (radio) radio.checked = true;
        keepCb.checked = !!gs.keepState;
        highEl.textContent = String(gs.highscore || 0);
        // Routed through handleScore rather than written straight to the
        // readout: a restored run can already be carrying a score above the
        // stored highscore (e.g. the highscore was reset mid-run), and that
        // should show as the best right away, not one move later.
        handleScore(def.id, safeCall(() => inst.getState()?.score, 0) ?? 0);
        resetConfirmState();

        // A restored real-time run opens frozen behind the pause prompt.
        // Turn-based games (2048) are inherently frozen — no prompt needed.
        if (def.realtime && saved) showResumePrompt();

        persist();
    }

    // Belt-and-braces auto-pause. The popup closing on an outside click fires
    // nothing we can hook, so continuous saving is the real mechanism — these
    // two just stop a game running unseen when the window loses focus.
    function autoPause() {
        if (!active || !active.def.realtime || awaitingResume) return;
        if (safeCall(() => active.inst.isOver?.())) return;
        const state = safeCall(() => active.inst.getState());
        if (!state) return;   // not started / not resumable — nothing to freeze
        safeCall(() => active.inst.pause());
        flushSave(active.def.id);
        showResumePrompt();
    }

    // ─── View switching ──────────────────────────────────────────────────────

    function isOpen() {
        return popupEl.classList.contains("is-arcade");
    }

    function open() {
        if (isOpen()) return;
        // Same courtesy the other toggles extend each other — never leave two
        // subpages half-open.
        if (popupEl.classList.contains("is-settings")) window.setSettings?.(false);
        if (popupEl.classList.contains("is-helping")) window.setHelp?.(false);
        if (popupEl.classList.contains("is-legal-settings")) window.setLegalSettingsView?.(false);

        viewArcade.hidden = false;
        popupEl.classList.add("is-arcade");
        headerIcon.setAttribute("aria-expanded", "true");
        headerIcon.title = t("arcadeCloseTitle");

        const id = registry.some((g) => g.id === store.lastGame)
            ? store.lastGame
            : registry[0]?.id;
        if (id) startGame(id);
    }

    function close() {
        if (!isOpen()) return;
        teardownActive();
        viewArcade.hidden = true;
        popupEl.classList.remove("is-arcade");
        headerIcon.setAttribute("aria-expanded", "false");
        headerIcon.title = t("arcadeOpenTitle");
    }

    // ─── Picker ──────────────────────────────────────────────────────────────

    function renderPicker() {
        picker.innerHTML = "";
        for (const def of registry) {
            const input = document.createElement("input");
            input.type = "radio";
            input.name = "arcade-game";
            input.id = `arcade-game-${def.id}`;
            input.value = def.id;
            const label = document.createElement("label");
            label.setAttribute("for", input.id);
            // Rendered through t() rather than data-i18n: the picker is built
            // after i18n.js has already walked the DOM, and it's re-rendered
            // outright on a runtime language change (see relocalize).
            label.textContent = t(def.nameKey);
            picker.append(input, label);
            input.addEventListener("change", () => {
                if (!input.checked) return;
                // A focused radio would answer arrow keys itself and walk the
                // picker mid-game. onKeyDown preventDefault()s arrows for the
                // same reason; dropping focus is the belt to that braces.
                input.blur();
                startGame(def.id);
            });
        }
    }

    // ─── Reset controls ──────────────────────────────────────────────────────

    // "Reset highscore" is destructive and irreversible, so it takes a second
    // click — inline, never a native confirm() (which a popup can't survive).
    function resetConfirmState() {
        if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
        resetHighBtn.classList.remove("is-confirming");
        resetHighBtn.textContent = t("arcadeResetHigh");
    }

    function wireResets() {
        resetGameBtn.addEventListener("click", () => {
            if (!active) return;
            const gs = gameStore(active.def.id);
            gs.saved = null;
            persist();
            startGame(active.def.id, { fresh: true });
            // Hand the keyboard straight back to the game.
            resetGameBtn.blur();
        });

        resetHighBtn.addEventListener("click", () => {
            if (!active) return;
            if (!resetHighBtn.classList.contains("is-confirming")) {
                resetHighBtn.classList.add("is-confirming");
                resetHighBtn.textContent = t("arcadeResetSure");
                confirmTimer = setTimeout(resetConfirmState, CONFIRM_WINDOW_MS);
                return;
            }
            const gs = gameStore(active.def.id);
            gs.highscore = 0;
            highEl.textContent = "0";
            persist();
            resetConfirmState();
            resetHighBtn.blur();
        });
    }

    // ─── Input routing ───────────────────────────────────────────────────────
    //
    // The hub owns the single keydown listener rather than each game, so keys
    // can never fire while another view is active and nothing survives a game
    // teardown. Games attach their own pointer listeners to their canvas and
    // drop them in destroy().
    const GAME_KEYS = new Set([
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        " ", "Spacebar",
    ]);

    function onKeyDown(e) {
        if (!isOpen()) return;
        if (e.key === "Escape") { close(); return; }
        // A focused control (the keep-state checkbox, a reset button, the
        // close ×) keeps its own activation keys — but only those. Arrows and
        // WASD always belong to the game, or clicking "Reset game" would
        // leave the keyboard dead until the user clicked the screen.
        const tag = document.activeElement?.tagName;
        const onControl =
            tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA";
        if (onControl && (e.key === " " || e.key === "Enter" || e.key === "Tab")) return;
        // Arrows/space would otherwise scroll the view or re-click a button.
        if (GAME_KEYS.has(e.key)) e.preventDefault();
        // The key that dismisses the pause prompt is consumed by it — it
        // must not also count as a move in the game underneath.
        if (awaitingResume) { dismissResumePrompt(); return; }
        if (!active) return;
        safeCall(() => active.inst.handleKey?.(e));
    }

    // Held-key games (Breakout's arrow-key paddle) need the release too.
    function onKeyUp(e) {
        if (!isOpen() || !active) return;
        safeCall(() => active.inst.handleKeyUp?.(e));
    }

    // ─── Init ────────────────────────────────────────────────────────────────

    async function init() {
        popupEl       = document.querySelector(".popup");
        viewArcade    = document.getElementById("view-arcade");
        headerIcon    = document.getElementById("header-icon");
        stageEl       = document.getElementById("arcade-stage");
        overlayEl     = document.getElementById("arcade-overlay");
        overlayTextEl = overlayEl?.querySelector(".arcade-overlay-text");
        picker        = document.getElementById("arcade-games");
        scoreEl       = document.getElementById("arcade-score");
        highEl        = document.getElementById("arcade-high");
        keepCb        = document.getElementById("arcade-keep");
        resetGameBtn  = document.getElementById("arcade-reset-game");
        resetHighBtn  = document.getElementById("arcade-reset-high");
        closeBtn      = document.getElementById("arcade-close");

        if (!popupEl || !viewArcade || !headerIcon || !stageEl) return;

        await loadStore();
        await window.__i18n.ready;

        renderPicker();
        wireResets();

        headerIcon.title = t("arcadeOpenTitle");

        headerIcon.addEventListener("click", () => (isOpen() ? close() : open()));
        headerIcon.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            isOpen() ? close() : open();
        });

        closeBtn.addEventListener("click", close);

        keepCb.addEventListener("change", () => {
            if (!active) return;
            const gs = gameStore(active.def.id);
            gs.keepState = keepCb.checked;
            // Switching it off discards the run right away — leaving it on
            // disk until the next teardown would resurrect it if the popup
            // died in between.
            if (!gs.keepState) gs.saved = null;
            persist();
            if (gs.keepState) flushSave(active.def.id);
        });

        // Clicking the frozen screen resumes, exactly like pressing a key.
        overlayEl.addEventListener("mousedown", (e) => {
            if (!awaitingResume) return;
            e.preventDefault();
            e.stopPropagation();
            dismissResumePrompt();
        });

        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("keyup", onKeyUp);
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) autoPause();
        });
        window.addEventListener("blur", autoPause);
    }

    // Re-render every string the hub wrote imperatively. Called from popup.js's
    // refreshDynamicStrings() after a runtime language switch.
    window.__Arcade.relocalize = () => {
        if (!picker) return;
        const current = active?.def.id;
        renderPicker();
        if (current) {
            const radio = picker.querySelector(`#arcade-game-${current}`);
            if (radio) radio.checked = true;
        }
        resetConfirmState();
        resetGameBtn.textContent = t("arcadeResetGame");
        headerIcon.title = isOpen() ? t("arcadeCloseTitle") : t("arcadeOpenTitle");
        if (awaitingResume) setOverlay(t("arcadePaused"), t("arcadePausedHint"));
    };

    window.__Arcade.close = close;
    window.__Arcade.isOpen = () => !!popupEl && isOpen();

    // Runs after every other classic script has executed, so the four games
    // have already registered by the time the picker is built.
    document.addEventListener("DOMContentLoaded", init);
})();
