// Arcade — the mini-game hub behind the header brand mark.
//
// Entirely popup-local: no service worker, no permissions, no manifest
// changes. Clicking the logo swaps the popup to #view-arcade (same
// view-switching pattern as Settings / Help / Legal Capture Settings).
// The header itself is left untouched — no hero transform, nothing moves.
//
// This file owns everything that isn't a game: view switching, the game
// picker, the score readout, chrome.storage.local persistence, the
// pause/resume plumbing, and a shared rAF loop helper. The games register
// themselves against it (see arcade/snake.js and friends) and only ever
// talk to the `ctx` object handed to their create().
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
//   showIntro?()                 optional; re-renders the game's attract
//                                screen. Called on every activation and
//                                after a language switch, so a game that
//                                has one always opens on its description.
//
// Registration also takes `ephemeral: true` (Typing Trainer) — a game whose
// run ends when you leave it: never restored, never persisted.
//
// Storage lives in one `arcade` object in chrome.storage.local:
//   { lastGame, games: { <id>: { highscore, highDetail, saved } } }
// Saved runs carry their game's own `v` (saveVersion); a mismatch is
// discarded in favour of a fresh game rather than crashing on stale shape.
(function () {
    // The cabinet screen. Fixed logical size, and square: the popup is
    // 360px wide and the arcade view keeps the standard 14px side padding,
    // leaving 330 — so 330 is also the height.
    const STAGE_W = 330;
    const STAGE_H = 330;

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
            gs = store.games[id] = {
                highscore: 0,
                // Optional second figure banked alongside the highscore —
                // Typing Trainer's accuracy at the moment its best WPM was
                // set. Empty for every game that never calls setDetail().
                highDetail: "",
                saved: null,
            };
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
    let picker, scoreEl, highEl, resetGameBtn, resetHighBtn, closeBtn;
    let scoreDetailEl, highDetailEl;
    let introTitleEl, introLinesEl, introStartEl, gameControlsEl;

    // ─── Active game ─────────────────────────────────────────────────────────

    let active = null;          // { def, inst }
    let awaitingResume = false; // hub owns the overlay while true
    let introShowing = false;   // overlay is currently a game's attract screen
    let liveDetail = "";        // current run's setDetail() value, if any
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
    //
    // Deliberately no inline CSS size: the canvas fills the screen box, which
    // is square and allowed to shrink (see .arcade-screen) when a short main
    // view leaves the cabinet less than its full height. The arcade view is
    // pinned to the popup's height, so without that the bottom of the
    // playfield — where every game puts its prompts — would end up below the
    // fold. Games keep drawing in logical units either way; pointer input
    // comes back through pointer(), which undoes whatever scale is in effect.
    function makeCanvas() {
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const el = document.createElement("canvas");
        el.className = "arcade-canvas";
        el.width  = Math.round(STAGE_W * dpr);
        el.height = Math.round(STAGE_H * dpr);
        const g = el.getContext("2d");
        g.scale(dpr, dpr);
        return { el, g };
    }

    // Pointer event -> logical stage coordinates. The canvas is displayed at
    // whatever size the screen box ended up, so a raw clientX - rect.left
    // would miss by that ratio on any popup where it shrank.
    function pointerPos(el, e) {
        const rect = el.getBoundingClientRect();
        return {
            x: rect.width ? (e.clientX - rect.left) * (STAGE_W / rect.width) : 0,
            y: rect.height ? (e.clientY - rect.top) * (STAGE_H / rect.height) : 0,
        };
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
            pointer: pointerPos,
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
            // The animated how-to-play screen a game can open on.
            // spec: { title, lines: [string], start }
            // Not suppressed while awaitingResume: setIntro() itself
            // substitutes the continue prompt, so a game that builds its
            // attract screen inside init() renders the paused variant.
            setIntro: (spec) => setIntro(spec),
            // Live DOM controls belonging to the game, parked in the
            // topbar for as long as it is the active one.
            setControls: (els) => setControls(els),
            clearOverlay: () => {
                if (awaitingResume) return;
                clearOverlay();
            },
            // Optional second readout figure, shown next to the score and
            // banked next to the highscore when one is beaten.
            setDetail: (text) => setDetail(text),
        };
    }

    // ─── Save plumbing ───────────────────────────────────────────────────────

    function writeState(id) {
        if (!active || active.def.id !== id || !storeLoaded) return;
        const gs = gameStore(id);
        // A game that has nothing worth resuming returns null and thereby
        // discards its own run — the highscore is never involved, it's
        // written on its own path in handleScore().
        gs.saved = safeCall(() => active.inst.getState()) || null;
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
        clearIntro();
        overlayTextEl.textContent = text;
        overlayEl.querySelector(".arcade-overlay-sub").textContent = sub;
        overlayEl.hidden = false;
    }

    // Builds a game's attract screen. Re-adding .is-intro from scratch (via
    // clearIntro first) is what re-triggers the CSS entrance animations —
    // they're one-shot `both`-filled keyframes, so a plain content swap
    // would repaint the panel without ever replaying them.
    //
    // While awaitingResume, the same panel doubles as the pause prompt: the
    // description still shows (activating a game should always say what the
    // game is), and only the `start` line is swapped for the continue
    // prompt — what the user has to do is continue, not begin.
    function setIntro({ title = "", lines = [], start = "" } = {}) {
        clearIntro();
        // Removing and re-adding .is-intro in one task resolves to the same
        // computed animation-name, which is not a restart. Reading a layout
        // property forces the recalc in between, so a second setIntro()
        // (Typing Trainer swapping "loading" for the real prompt) actually
        // replays the entrance rather than snapping the new copy in.
        void overlayEl.offsetWidth;

        introTitleEl.textContent = title;
        introStartEl.textContent = awaitingResume ? t("arcadePausedHint") : start;

        for (const line of lines) {
            const li = document.createElement("li");
            li.textContent = line;
            introLinesEl.appendChild(li);
        }
        introShowing = true;
        overlayEl.classList.add("is-intro");
        // Only the pause prompt swallows clicks — a game's own start prompt
        // has to let the pointer through to the canvas underneath.
        overlayEl.classList.toggle("is-blocking", awaitingResume);
        overlayEl.hidden = false;
    }

    function clearIntro() {
        if (!introShowing) return;
        introShowing = false;
        overlayEl.classList.remove("is-intro");
        introTitleEl.textContent = "";
        introStartEl.textContent = "";
        introLinesEl.replaceChildren();
    }

    // The game's own live elements (it keeps the references and reads them
    // back), so they are moved into the slot, never cloned. Cleared on
    // teardown so one game's controls never outlive it.
    function setControls(els = []) {
        gameControlsEl?.replaceChildren(...els);
    }

    function clearOverlay() {
        clearIntro();
        overlayEl.hidden = true;
        overlayEl.classList.remove("is-blocking");
    }

    function showResumePrompt() {
        awaitingResume = true;
        // Freeze first, then prompt. Without this a run restored from
        // storage would open behind the prompt while still simulating —
        // Breakout's ball kept travelling under a screen that said Paused.
        // autoPause() also pauses before calling here; pause() is idempotent.
        if (active) safeCall(() => active.inst.pause());
        // Prefer the game's own description panel — setIntro() swaps the
        // continue prompt in for its start line. The bare two-liner is the
        // fallback for a game that has no attract screen at all.
        const shown =
            !!active &&
            !!safeCall(() => {
                if (!active.inst.showIntro) return false;
                active.inst.showIntro();
                return introShowing;
            });
        if (!shown) setOverlay(t("arcadePaused"), t("arcadePausedHint"));
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
            // The detail is a property of the run that set the record, so
            // it's banked from whatever the game last reported, not
            // recomputed later.
            gs.highDetail = liveDetail;
            highEl.textContent = String(score);
            highDetailEl.textContent = liveDetail;
            persist();
        }
    }

    function setDetail(text) {
        liveDetail = text ? String(text) : "";
        if (scoreDetailEl) scoreDetailEl.textContent = liveDetail;
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
        setControls([]);
        setDetail("");
        stageEl.innerHTML = "";
    }

    function startGame(id, { fresh = false } = {}) {
        const def = registry.find((g) => g.id === id) || registry[0];
        if (!def) return;

        teardownActive();

        const gs = gameStore(def.id);
        // An ephemeral game (Typing Trainer) never resumes: leaving it ends
        // the drill, so there is nothing to restore and nothing to keep.
        const discard = fresh || def.ephemeral;
        // Wipe the stored run here, not in the callers: teardownActive()
        // above just flushed the outgoing instance's state back into gs, so
        // a caller that cleared gs.saved before calling in would have had it
        // written straight back and resurrected on the next activation.
        if (discard) gs.saved = null;
        let saved = discard ? null : gs.saved;
        // Versioned saved state — a schema change from a previous extension
        // build discards the run instead of feeding a game a shape it can't
        // read.
        if (saved && saved.v !== def.saveVersion) saved = null;

        const inst = def.create(makeCtx(def));
        inst.onScore((score) => handleScore(def.id, score));

        // Armed before init(), so a game that builds its attract screen in
        // there renders it with the continue prompt already substituted.
        awaitingResume = !!saved;

        try {
            inst.init(stageEl, saved);
        } catch (e) {
            // Belt and braces on top of the version check: a saved run that
            // still can't be restored costs the run, never the session.
            console.warn("arcade: restore failed, starting fresh:", e);
            safeCall(() => inst.destroy());
            stageEl.innerHTML = "";
            saved = null;
            awaitingResume = false;
            inst.init(stageEl, null);
        }

        active = { def, inst };
        store.lastGame = def.id;

        // Reflect the picker + readout + per-game controls.
        const radio = picker.querySelector(`#arcade-game-${def.id}`);
        if (radio) radio.checked = true;
        highEl.textContent = String(gs.highscore || 0);
        highDetailEl.textContent = gs.highDetail || "";
        // Routed through handleScore rather than written straight to the
        // readout: a restored run can already be carrying a score above the
        // stored highscore (e.g. the highscore was reset mid-run), and that
        // should show as the best right away, not one move later.
        handleScore(def.id, safeCall(() => inst.getState()?.score, 0) ?? 0);
        resetConfirmState();

        // Activating a game always opens on its description. A restored run
        // additionally opens frozen, behind the same panel carrying the
        // continue prompt instead of the start prompt; a fresh one already
        // put its attract screen up from init().
        if (saved) showResumePrompt();

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

    // Both reset buttons carry an icon alongside their label, so their text
    // lives in a <span> — writing to the button's own textContent would
    // take the <svg> with it.
    function btnLabel(btn) {
        return btn.querySelector("span") || btn;
    }

    // "Reset highscore" is destructive and irreversible, so it takes a second
    // click — inline, never a native confirm() (which a popup can't survive).
    function resetConfirmState() {
        if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
        resetHighBtn.classList.remove("is-confirming");
        btnLabel(resetHighBtn).textContent = t("arcadeResetHigh");
    }

    function wireResets() {
        resetGameBtn.addEventListener("click", () => {
            if (!active) return;
            // startGame({fresh}) drops the stored run itself — see the note
            // there about teardown flushing it back.
            startGame(active.def.id, { fresh: true });
            // Hand the keyboard straight back to the game.
            resetGameBtn.blur();
        });

        resetHighBtn.addEventListener("click", () => {
            if (!active) return;
            if (!resetHighBtn.classList.contains("is-confirming")) {
                resetHighBtn.classList.add("is-confirming");
                btnLabel(resetHighBtn).textContent = t("arcadeResetSure");
                confirmTimer = setTimeout(resetConfirmState, CONFIRM_WINDOW_MS);
                return;
            }
            const id = active.def.id;
            const gs = gameStore(id);
            gs.highscore = 0;
            gs.highDetail = "";
            persist();
            // Wiping the record wipes the run that was chasing it: leaving a
            // half-played game on screen next to a zeroed best is a readout
            // nobody can interpret. Restarting also puts the description
            // back up, so the board reads as a clean slate.
            startGame(id, { fresh: true });
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

    // The numpad's steering block (Snake reads it by e.code, so it works
    // with NumLock either way). With NumLock off these arrive as Home / End /
    // PageUp / PageDown / Clear, every one of which scrolls or jumps the
    // view, so they need the same suppression the arrows get.
    const GAME_CODES = new Set([
        "Numpad1", "Numpad2", "Numpad3", "Numpad4",
        "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9",
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
        // A focused <select> (the Typing Trainer's language picker) is the
        // one control that genuinely needs the arrows — a checkbox or a
        // button does not, and taking them from a game to feed one would be
        // the worse trade.
        if (tag === "SELECT" && GAME_KEYS.has(e.key)) return;
        // Arrows/space would otherwise scroll the view or re-click a button.
        // The numpad only when NumLock is off, i.e. when it is producing a
        // navigation key rather than a digit — a digit is a character the
        // Typing Trainer is owed.
        if (GAME_KEYS.has(e.key)) e.preventDefault();
        else if (GAME_CODES.has(e.code) && e.key.length !== 1) e.preventDefault();
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
        scoreDetailEl = document.getElementById("arcade-score-detail");
        highDetailEl  = document.getElementById("arcade-high-detail");
        introTitleEl    = document.getElementById("arcade-intro-title");
        introLinesEl    = document.getElementById("arcade-intro-lines");
        introStartEl    = document.getElementById("arcade-intro-start");
        gameControlsEl  = document.getElementById("arcade-game-controls");
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
        btnLabel(resetGameBtn).textContent = t("arcadeResetGame");
        headerIcon.title = isOpen() ? t("arcadeCloseTitle") : t("arcadeOpenTitle");
        // The attract screen's copy came from the game, in the old language —
        // ask it to rebuild rather than trying to re-translate the strings.
        // It carries the pause prompt too when one is pending, so it's tried
        // first; the bare overlay is only for a game without an intro.
        if (introShowing) safeCall(() => active?.inst.showIntro?.());
        else if (awaitingResume) setOverlay(t("arcadePaused"), t("arcadePausedHint"));
    };

    window.__Arcade.close = close;
    window.__Arcade.isOpen = () => !!popupEl && isOpen();

    // Runs after every other classic script has executed, so the four games
    // have already registered by the time the picker is built.
    document.addEventListener("DOMContentLoaded", init);
})();
