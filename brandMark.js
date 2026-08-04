// Loads the brand-mark SVG out of static/embed-{dark,light}.html and injects
// it into every [data-brand-mark] placeholder. The embed HTML files are the
// single source of truth for the icon design; editing them updates both the
// standalone embed pages and the popup brand mark.
//
// On top of that, this file is the mark's behavior engine — the thing that
// makes the lens feel like a machine that is watching the operator rather
// than a looping decoration. HAL-9000 rules: dead-precise, silent, patient.
//
//   - The red dot is an eye. It tracks the cursor; when the cursor goes
//     still it acts on its own — quick robotic saccades, slow deliberate
//     sweeps, a rare lens-blink, a dead-center stare.
//   - Hovering the mark itself makes it notice you: near-zero-lag tracking,
//     constricted fast pupil pulse, hot fill, tightened reticle. The scan
//     beam keeps a constant speed always — retiming it restarts its SMIL
//     cycle, which visibly snaps it back to the top; it is only recolored.
//   - Clicking it provokes one of three rotating reactions (glitch-and-
//     stare, shutdown-reboot, scan-you).
//   - Hovering any capture button makes the eye lock onto *that button*,
//     with per-category flavors (danger = eager, extract = curious
//     double-blink, help/settings = dims and looks away).
//
// All reactive state is driven from here via inline styles / attributes so
// nothing has to be duplicated across popup.css and popup-light.css. The
// SVG parts are addressed through data attributes rigged in the embed
// files: [data-crosshair-dot] (the eye) + [data-eye-pulse] (its SMIL r
// pulse), [data-reticle] > [data-reticle-aim] (JS-owned parallax/tighten
// layer) > [data-reticle-pulse], [data-beam-anim] (scan-beam SMIL),
// [data-guts] (everything inside the screen clip, for glitch jitter),
// [data-screen] (the clip group, for flicker flicks).

(() => {
    const themeQuery = matchMedia("(prefers-color-scheme: dark)");
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const cache = new Map();
    let override = null; // "dark" | "light" | null (= follow OS)

    async function loadEmbedSvg(dark) {
        const key = dark ? "dark" : "light";
        if (cache.has(key)) return cache.get(key);
        const url = chrome.runtime.getURL(`static/embed-${key}.html`);
        const html = await fetch(url).then((r) => r.text());
        const match = html.match(/<svg[\s\S]*?<\/svg>/i);
        const svg = match ? match[0] : "";
        cache.set(key, svg);
        return svg;
    }

    // ------------------------------------------------------------------
    // Rig — re-queried after every paint() since innerHTML injection
    // replaces the nodes.
    // ------------------------------------------------------------------

    let marks = [];

    function bindMarks() {
        marks = [...document.querySelectorAll("[data-brand-mark]")]
            .map((container) => {
                const q = (s) => container.querySelector(s);
                return {
                    container,
                    eye: q("[data-crosshair-dot]"),
                    eyePulse: q("[data-eye-pulse]"),
                    reticleAim: q("[data-reticle-aim]"),
                    reticleStroke: q("[data-reticle-stroke]"),
                    corners: q("[data-corners]"),
                    guts: q("[data-guts]"),
                    screen: q("[data-screen]"),
                    screenBg: q("[data-screen-bg]"),
                    // Cyan-only surfaces that hue-shift with a mood's tint.
                    tintParts: [
                        ...container.querySelectorAll(
                            "[data-scanlines], [data-beam-glow], [data-beam-core]"
                        ),
                    ],
                };
            })
            .filter((m) => m.eye);
    }

    async function paint() {
        const dark = override ? override === "dark" : themeQuery.matches;
        const svg = await loadEmbedSvg(dark);
        if (!svg) return;
        document.querySelectorAll("[data-brand-mark]").forEach((el) => {
            el.innerHTML = svg;
        });
        bindMarks();
        applyMood();
        applyAim({ ms: 0 });
    }

    // Lets popup.js re-paint when the user manually overrides the theme.
    // theme: "dark" | "light" | "auto".
    window.__paintBrandMark = (theme) => {
        override = theme === "dark" || theme === "light" ? theme : null;
        paint();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
    themeQuery.addEventListener("change", paint);

    // ------------------------------------------------------------------
    // Aim engine. Eye offsets are in svg user units (viewBox is 200x200),
    // clamped so the lens never leaves the reticle ring. The reticle-aim
    // layer follows with a smaller parallax offset so the whole mechanism
    // reads as aimed, not just the dot sliding around.
    // ------------------------------------------------------------------

    const MAX_DOT_OFFSET = 16;
    const RETICLE_PARALLAX = 0.35;

    let eyeAim = { dx: 0, dy: 0 };
    let eyeScale = 1;
    let reticleScale = 1;

    function eyeTransform() {
        const { dx, dy } = eyeAim;
        // Sandwich keeps the scale centered on the lens (cx/cy = 100) and
        // keeps the transform-list shape constant so transitions always
        // interpolate smoothly instead of falling back to matrix jumps.
        return (
            `translate(${dx.toFixed(2)},${dy.toFixed(2)}) ` +
            `translate(100,100) scale(${eyeScale.toFixed(3)}) translate(-100,-100)`
        );
    }

    function applyAim(opts = {}) {
        const ms = opts.ms ?? 150;
        const ease = opts.ease ?? "ease-out";
        for (const m of marks) {
            m.eye.style.transition = ms ? `transform ${ms}ms ${ease}` : "none";
            m.eye.setAttribute("transform", eyeTransform());
            if (m.reticleAim) {
                const px = eyeAim.dx * RETICLE_PARALLAX;
                const py = eyeAim.dy * RETICLE_PARALLAX;
                m.reticleAim.style.transition = ms
                    ? `transform ${Math.round(ms * 1.4)}ms ease-out`
                    : "none";
                m.reticleAim.setAttribute(
                    "transform",
                    `translate(${px.toFixed(2)},${py.toFixed(2)}) scale(${reticleScale.toFixed(3)})`
                );
            }
        }
    }

    function aimEye(dx, dy, opts = {}) {
        const max = opts.max ?? MAX_DOT_OFFSET;
        const mag = Math.hypot(dx, dy);
        if (mag > max) {
            const k = max / mag;
            dx *= k;
            dy *= k;
        }
        eyeAim = { dx, dy };
        applyAim(opts);
    }

    function setEyeScale(s, ms) {
        eyeScale = s;
        applyAim({ ms, ease: "ease-out" });
    }

    function setReticleScale(s, ms) {
        reticleScale = s;
        applyAim({ ms, ease: "ease-out" });
    }

    // Converts a client-coordinate point to an eye offset in svg units,
    // measured from the primary mark's center.
    function clientToUnits(clientX, clientY) {
        const c = marks[0]?.container;
        if (!c) return { dx: 0, dy: 0 };
        const rect = c.getBoundingClientRect();
        if (!rect.width) return { dx: 0, dy: 0 };
        const scale = 200 / rect.width;
        return {
            dx: (clientX - (rect.left + rect.width / 2)) * scale,
            dy: (clientY - (rect.top + rect.height / 2)) * scale,
        };
    }

    // ------------------------------------------------------------------
    // Moods. Each mood retunes the SMIL pulse/beam and restyles the eye
    // via inline styles (which win over both theme stylesheets and the
    // SVG's own attributes, and revert cleanly when cleared).
    // ------------------------------------------------------------------

    const MOODS = {
        // Calm, wide, slow — routine surveillance.
        idle: { pulse: ["7;21;7", "1.6s"], reticle: 1 },
        // It has noticed you. Constricted pupil, hot lens, everything fast.
        alert: {
            fill: "#FF1133",
            glow: "drop-shadow(0 0 6px rgba(255, 0, 70, 0.95))",
            pulse: ["5.5;8.5;5.5", "0.65s"],
            reticle: 0.85,
        },
        // Watching what you reach for. Steady, interested.
        lock: {
            fill: "#FF0844",
            glow: "drop-shadow(0 0 4px rgba(255, 0, 70, 0.7))",
            pulse: ["6.5;11;6.5", "0.95s"],
            reticle: 0.92,
        },
        // A main action button (Page/Element Capture, Extract Image, Legal
        // Capture). The pupil dilates hard — pure anticipation.
        primed: {
            fill: "#FF0844",
            glow: "drop-shadow(0 0 7px rgba(255, 0, 70, 0.85))",
            pulse: ["8;12;8", "1.1s"],
            reticle: 0.9,
            eyeScale: 1.9,
        },
        // Remove Elements — RAGE. Deeper red, fastest pulse, dilated, the
        // reticle and corner brackets turn red, the cyan scanlines/beam
        // hue-shift to red, and the whole screen trembles.
        danger: {
            fill: "#FF0022",
            glow: "drop-shadow(0 0 8px rgba(255, 0, 40, 1))",
            pulse: ["7;10;7", "0.45s"],
            reticle: 0.8,
            eyeScale: 1.85,
            reticleStroke: "#FF1133",
            cornersStroke: "#FF3355",
            tint: "hue-rotate(168deg) saturate(1.5)",
            rage: true,
        },
        // Extract Image — the screen floods amber to match the button,
        // the cyan surfaces hue-shift to match, pupil stays dilated.
        amber: {
            fill: "#FF0844",
            glow: "drop-shadow(0 0 7px rgba(245, 158, 11, 0.9))",
            pulse: ["8;12;8", "1.1s"],
            reticle: 0.9,
            eyeScale: 1.9,
            screenBg: "#F59E0B",
            tint: "hue-rotate(211deg) saturate(1.4)",
        },
        // Extract Design — same shape as amber, violet screen. The hue
        // rotations are measured from the mark's own cyan (~187deg), so
        // violet (~279deg) is +92; do not eyeball these, a wrong rotation
        // lands the screen on a colour the button doesn't use.
        violet: {
            fill: "#FF0844",
            glow: "drop-shadow(0 0 7px rgba(168, 85, 247, 0.9))",
            pulse: ["8;12;8", "1.1s"],
            reticle: 0.9,
            eyeScale: 1.9,
            screenBg: "#A855F7",
            tint: "hue-rotate(92deg) saturate(1.4)",
        },
        // Help / settings — disinterest. Dims and slows.
        dim: {
            eyeOpacity: "0.45",
            pulse: ["7;9;7", "2.8s"],
            reticle: 1.05,
        },
    };

    let mood = "idle";

    // Retunes a running SMIL animation. Changing values/dur alone doesn't
    // reliably retime an active interval, so end + begin forces a restart
    // on the new numbers. The hard cut reads as intentional — machines
    // don't ease between moods. Never used on the scan beam: a restart
    // visibly snaps it back to the top of its sweep, so the beam keeps a
    // constant speed and is only ever recolored.
    function retime(anim, values, dur) {
        if (!anim) return;
        if (
            anim.getAttribute("values") === values &&
            anim.getAttribute("dur") === dur
        ) {
            return;
        }
        anim.setAttribute("values", values);
        anim.setAttribute("dur", dur);
        try {
            anim.endElement();
        } catch (_) {}
        try {
            anim.beginElement();
        } catch (_) {}
    }

    function applyMood() {
        const v = MOODS[mood] || MOODS.idle;
        reticleScale = v.reticle ?? 1;
        eyeScale = v.eyeScale ?? 1;
        for (const m of marks) {
            m.eye.style.fill = v.fill || "";
            m.eye.style.filter = v.glow || "";
            m.eye.style.opacity = v.eyeOpacity || "";
            if (m.reticleStroke) m.reticleStroke.style.stroke = v.reticleStroke || "";
            if (m.corners) m.corners.style.stroke = v.cornersStroke || "";
            if (m.screenBg) {
                m.screenBg.style.transition = "fill 0.25s ease";
                m.screenBg.style.fill = v.screenBg || "";
            }
            for (const part of m.tintParts || []) {
                part.style.filter = v.tint || "";
            }
            retime(m.eyePulse, v.pulse[0], v.pulse[1]);
        }
        setRage(!!v.rage && !reducedMotion.matches);
        applyAim({ ms: 220 });
    }

    // Rage tremor — a continuous sub-pixel shudder of everything inside
    // the screen while the danger mood holds. Suspended during click fx
    // (which owns the guts transform for its own jitter).
    let rageTimer = null;

    function setRage(on) {
        if (on && !rageTimer) {
            rageTimer = setInterval(() => {
                if (fxBusy || document.hidden) return;
                const x = (Math.random() * 1.8 - 0.9).toFixed(2);
                const y = (Math.random() * 1.2 - 0.6).toFixed(2);
                for (const m of marks) {
                    if (!m.guts) continue;
                    m.guts.style.transition = "none";
                    m.guts.setAttribute("transform", `translate(${x},${y})`);
                }
            }, 90);
        } else if (!on && rageTimer) {
            clearInterval(rageTimer);
            rageTimer = null;
            for (const m of marks) m.guts?.removeAttribute("transform");
        }
    }

    function resolveMood() {
        if (hoverLogo) return "alert";
        if (lockEl) {
            if (lockEl.matches(".btn-helper--danger")) return "danger";
            if (lockEl.matches(".help-toggle, .settings-toggle")) return "dim";
            if (lockEl.matches(".btn-capture--amber")) return "amber";
            if (lockEl.matches(".btn-capture--violet")) return "violet";
            if (lockEl.matches(".btn-capture--main")) return "primed";
            return "lock";
        }
        return "idle";
    }

    function setMood(next) {
        if (mood === next) return;
        mood = next;
        autoToken += 1;
        // During a click sequence the fx owns the visuals; its finally
        // block applies whatever mood is current once it finishes.
        if (!fxBusy) applyMood();
    }

    // ------------------------------------------------------------------
    // Pointer tracking. Alert mode (cursor on the mark itself) tracks with
    // near-zero lag — un-humanly precise is the point.
    // ------------------------------------------------------------------

    let lastPointerTs = 0;
    let hoverLogo = false;
    let lockEl = null;
    let fxBusy = false;
    let autoToken = 0; // bumped to abort in-flight autonomous behaviors

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    document.addEventListener("mousemove", (e) => {
        lastPointerTs = performance.now();
        // Movement inside a locked element must not cancel the lock's own
        // choreography — the eye is staring at the element, not the cursor.
        if (!lockEl) autoToken += 1;
        if (fxBusy) return;
        if (lockEl) return;
        const { dx, dy } = clientToUnits(e.clientX, e.clientY);
        if (hoverLogo) {
            aimEye(dx, dy, { ms: 45, ease: "linear" });
        } else {
            aimEye(dx, dy, { ms: 150 });
        }
    });

    // ------------------------------------------------------------------
    // Idle autonomy. When the operator's hand goes still the eye keeps
    // working: saccades, sweeps, blinks, stares. Suspended during fx,
    // hover, lock, reduced-motion, or a hidden document.
    // ------------------------------------------------------------------

    let idleTimer = null;

    function scheduleIdle() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(idleTick, 1700 + Math.random() * 2600);
    }

    function idleTick() {
        const stillFor = performance.now() - lastPointerTs;
        if (!fxBusy && !hoverLogo && !lockEl && !document.hidden && stillFor > 1600) {
            if (reducedMotion.matches) {
                aimEye(0, 0, { ms: 500 });
            } else {
                runIdleBehavior();
            }
        }
        scheduleIdle();
    }

    async function runIdleBehavior() {
        const t = ++autoToken;
        const alive = () => autoToken === t && !fxBusy;
        const r = Math.random();
        if (r < 0.45) {
            // Saccade — a fast dart to a random point, sometimes with the
            // tiny secondary correction real servos make.
            const a = Math.random() * Math.PI * 2;
            const mag = 5 + Math.random() * 9;
            aimEye(Math.cos(a) * mag, Math.sin(a) * mag, { ms: 70, ease: "linear" });
            if (Math.random() < 0.35) {
                await sleep(160);
                if (!alive()) return;
                aimEye(eyeAim.dx * 0.85, eyeAim.dy * 0.85, { ms: 60, ease: "linear" });
            }
        } else if (r < 0.65) {
            // Sweep — slow deliberate pan across the room.
            const y1 = -4 + Math.random() * 8;
            const y2 = -4 + Math.random() * 8;
            aimEye(-13, y1, { ms: 1500, ease: "ease-in-out" });
            await sleep(1650);
            if (!alive()) return;
            aimEye(13, y2, { ms: 1900, ease: "ease-in-out" });
            await sleep(2050);
            if (!alive()) return;
            aimEye(0, 0, { ms: 900, ease: "ease-in-out" });
        } else if (r < 0.8) {
            // Blink — a quick lens-shutter collapse. Always restored, even
            // if the behavior gets cancelled mid-blink.
            setEyeScale(0.12, 60);
            await sleep(110);
            setEyeScale(1, 90);
        } else {
            // Stare — return to dead center and briefly tighten the
            // reticle, like refocusing on the operator.
            aimEye(0, 0, { ms: 600, ease: "ease-in-out" });
            const base = reticleScale;
            setReticleScale(base * 0.88, 400);
            await sleep(750);
            if (!alive()) return;
            setReticleScale(MOODS[mood]?.reticle ?? 1, 600);
        }
    }

    // ------------------------------------------------------------------
    // Hovering the mark itself — it notices you.
    // ------------------------------------------------------------------

    function bindContainers() {
        document.querySelectorAll("[data-brand-mark]").forEach((c) => {
            c.addEventListener("mouseenter", () => {
                hoverLogo = true;
                setMood("alert");
            });
            c.addEventListener("mouseleave", () => {
                hoverLogo = false;
                setMood(resolveMood());
            });
            c.addEventListener("click", () => runClickFx());
        });
    }

    // ------------------------------------------------------------------
    // Click reactions — three rotating sequences, never two at once.
    // ------------------------------------------------------------------

    let lastFx = -1;

    function jitterGuts(m, x) {
        if (!m.guts) return;
        m.guts.style.transition = "none";
        if (x) m.guts.setAttribute("transform", `translate(${x},0)`);
        else m.guts.removeAttribute("transform");
    }

    function flickScreen(m, opacity) {
        if (!m.screen) return;
        if (opacity == null) m.screen.style.opacity = "";
        else m.screen.style.opacity = String(opacity);
    }

    function styleEye(fill, glow) {
        for (const m of marks) {
            m.eye.style.fill = fill;
            m.eye.style.filter = glow;
        }
    }

    async function runClickFx() {
        if (fxBusy || !marks.length) return;
        fxBusy = true;
        autoToken += 1;
        try {
            if (reducedMotion.matches) {
                // Minimal version: a hot bloom, nothing that moves.
                styleEye("#FF0022", "drop-shadow(0 0 9px rgba(255, 0, 40, 1))");
                await sleep(500);
            } else {
                const pool = [fxGlitchStare, fxShutdownReboot, fxScanYou];
                let pick = Math.floor(Math.random() * pool.length);
                if (pick === lastFx) pick = (pick + 1) % pool.length;
                lastFx = pick;
                await pool[pick]();
            }
        } finally {
            // Hard-reset every fx-touched surface, whatever happened.
            for (const m of marks) {
                jitterGuts(m, 0);
                flickScreen(m, null);
                if (m.guts) {
                    m.guts.style.transition = "";
                    m.guts.style.opacity = "";
                }
                m.eye.style.opacity = "";
            }
            fxBusy = false;
            applyMood(); // also restores the mood's own eyeScale
            applyAim({ ms: 400 });
        }
    }

    // "Do not do that again." Screen glitches, the lens flashes white,
    // then blooms deep red and holds on you.
    async function fxGlitchStare() {
        aimEye(0, 0, { ms: 60, ease: "linear" });
        styleEye("#FFFFFF", "drop-shadow(0 0 10px rgba(255, 255, 255, 0.9))");
        const frames = [
            [-3, 0.5],
            [2.6, 1],
            [-1.8, 0.65],
            [0, 1],
        ];
        for (const [x, op] of frames) {
            for (const m of marks) {
                jitterGuts(m, x);
                flickScreen(m, op);
            }
            await sleep(55);
        }
        styleEye("#FF0022", "drop-shadow(0 0 9px rgba(255, 0, 40, 1))");
        for (const m of marks) retime(m.eyePulse, "9;10.5;9", "0.9s");
        setEyeScale(1.6, 320);
        await sleep(900);
        setEyeScale(1, 450);
        await sleep(450);
    }

    // "Did you just try to turn me off." The lens dies, the screen dims —
    // then it comes back, brighter than before.
    async function fxShutdownReboot() {
        for (const m of marks) {
            m.eye.style.transition = "opacity 110ms linear";
            m.eye.style.opacity = "0";
            if (m.guts) {
                m.guts.style.transition = "opacity 160ms linear";
                m.guts.style.opacity = "0.3";
            }
        }
        await sleep(650);
        for (const m of marks) {
            if (m.guts) {
                m.guts.style.transition = "none";
                m.guts.style.opacity = "1";
            }
            jitterGuts(m, -2.2);
            flickScreen(m, 0.55);
            m.eye.style.transition = "none";
            m.eye.style.opacity = "1";
        }
        styleEye("#FF0022", "drop-shadow(0 0 9px rgba(255, 0, 40, 1))");
        await sleep(60);
        for (const m of marks) {
            jitterGuts(m, 1.4);
            flickScreen(m, 1);
        }
        await sleep(55);
        for (const m of marks) jitterGuts(m, 0);
        setEyeScale(1.5, 90);
        await sleep(120);
        setEyeScale(1, 550);
        await sleep(550);
    }

    // "Identifying." Four rapid corner saccades — it is scanning you —
    // then a hard center lock, everything contracted.
    async function fxScanYou() {
        const corners = [
            [-13, -11],
            [13, -11],
            [13, 11],
            [-13, 11],
        ];
        if (Math.random() < 0.5) corners.reverse();
        styleEye("#FF1133", "drop-shadow(0 0 6px rgba(255, 0, 70, 0.95))");
        for (const [x, y] of corners) {
            aimEye(x, y, { ms: 55, ease: "linear" });
            await sleep(95);
        }
        aimEye(0, 0, { ms: 80, ease: "linear" });
        setReticleScale(0.78, 200);
        setEyeScale(0.72, 150);
        styleEye("#FF0022", "drop-shadow(0 0 8px rgba(255, 0, 40, 1))");
        for (const m of marks) retime(m.eyePulse, "6;8;6", "0.5s");
        await sleep(600);
        setEyeScale(1, 400);
        setReticleScale(1, 500);
        await sleep(400);
    }

    // ------------------------------------------------------------------
    // UI awareness — the eye watches what the operator reaches for.
    // Delegated so it covers every view (main, settings, help) without
    // per-button wiring.
    // ------------------------------------------------------------------

    const LOCK_SELECTOR =
        ".btn-capture, .btn-helper, .help-toggle, .settings-toggle, .radio-group label";

    document.addEventListener("mouseover", (e) => {
        const t =
            e.target instanceof Element ? e.target.closest(LOCK_SELECTOR) : null;
        if (t === lockEl) return;
        lockEl = t;
        autoToken += 1;
        setMood(resolveMood());
        if (t && !fxBusy) stareAt(t);
    });

    async function stareAt(el) {
        const t = autoToken;
        const alive = () => autoToken === t && !fxBusy && lockEl === el;
        const rect = el.getBoundingClientRect();
        const { dx, dy } = clientToUnits(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
        );

        // Extract Image gets a curious double-blink before the lock.
        if (el.classList.contains("btn-capture--amber") && !reducedMotion.matches) {
            setEyeScale(0.2, 50);
            await sleep(90);
            setEyeScale(0.9, 50);
            await sleep(90);
            setEyeScale(0.2, 50);
            await sleep(90);
            // Reopen straight into the mood's own scale (primed = dilated).
            setEyeScale(MOODS[mood]?.eyeScale ?? 1, 140);
            if (!alive()) return;
        }

        if (mood === "dim") {
            // Help / settings: one brief glance, then it looks away.
            aimEye(dx, dy, { ms: 90, ease: "linear", max: 14 });
            await sleep(400);
            if (!alive()) return;
            aimEye(-dx * 0.5, -Math.abs(dy) * 0.4 - 3, { ms: 1400, ease: "ease-in-out", max: 10 });
            return;
        }

        // Robotic two-step: overshoot snap, then an exact micro-settle.
        aimEye(dx * 1.12, dy * 1.12, { ms: 70, ease: "linear", max: 15 });
        await sleep(130);
        if (!alive()) return;
        aimEye(dx, dy, { ms: 90, ease: "linear", max: 14 });
    }

    // ------------------------------------------------------------------
    // Boot.
    // ------------------------------------------------------------------

    async function init() {
        await paint();
        bindContainers();
        scheduleIdle();
        if (!reducedMotion.matches) {
            // Wake scan — one quick look left, right, then settle on center.
            const t = ++autoToken;
            await sleep(350);
            if (autoToken !== t || fxBusy) return;
            aimEye(-10, 2, { ms: 90, ease: "linear" });
            await sleep(260);
            if (autoToken !== t || fxBusy) return;
            aimEye(10, -2, { ms: 110, ease: "linear" });
            await sleep(300);
            if (autoToken !== t || fxBusy) return;
            aimEye(0, 0, { ms: 500, ease: "ease-out" });
        }
    }
})();
