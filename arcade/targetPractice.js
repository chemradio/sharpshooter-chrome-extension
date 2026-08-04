// Arcade · Target Practice — the house game.
//
// Crosshair reticles fade in at random points on the screen, then shrink
// and fade out; click one before it vanishes. Consecutive hits build a
// streak multiplier, and a click on empty space breaks it. Rounds are 45
// seconds; the score is the round total, the highscore the best round.
//
// Only the round clock and the tally are persisted — live reticles are
// not. Restoring mid-round therefore resumes the clock with a fresh wave
// rather than reconstructing the exact screen, which is the honest
// behaviour for a game whose targets are pure randomness anyway.
(function () {
    const ROUND_MS = 45000;

    const SPAWN_MS_START = 900;
    const SPAWN_MS_END   = 430;
    const LIFE_MS_START  = 1600;
    const LIFE_MS_END    = 1050;
    const FADE_IN_MS     = 180;
    const MAX_LIVE       = 4;

    const R_MAX = 26;
    const R_MIN = 9;
    const EDGE  = R_MAX + 6;   // keeps a reticle fully on screen

    const BASE_POINTS  = 10;
    const MAX_MULTIPLIER = 8;

    function create(ctx) {
        let el = null, g = null, loop = null, scoreCb = null;

        let targets, score, streak, timeLeft, spawnAcc, spawnEvery;
        let running = false, roundOver = false, paused = false;
        // Short-lived click feedback rings, purely cosmetic.
        let splashes = [];

        // ── State ──────────────────────────────────────────────────────────

        function freshRound() {
            targets = [];
            splashes = [];
            score = 0;
            streak = 0;
            timeLeft = ROUND_MS;
            spawnAcc = 0;
            spawnEvery = SPAWN_MS_START;
            running = false;
            roundOver = false;
        }

        function restore(saved) {
            const left = Number(saved.timeLeft);
            if (!isFinite(left) || left <= 0) throw new Error("bad target-practice state");
            freshRound();
            timeLeft = Math.min(left, ROUND_MS);
            score = saved.score | 0;
            streak = saved.streak | 0;
            running = true;
        }

        // Round progress 0..1 — drives spawn rate and reticle lifetime, so the
        // last ten seconds are meaningfully harder than the first ten.
        function progress() { return 1 - timeLeft / ROUND_MS; }

        function multiplier() {
            return Math.max(1, Math.min(streak, MAX_MULTIPLIER));
        }

        function spawn() {
            const life = LIFE_MS_START + (LIFE_MS_END - LIFE_MS_START) * progress();
            targets.push({
                x: EDGE + Math.random() * (ctx.STAGE_W - EDGE * 2),
                y: EDGE + 14 + Math.random() * (ctx.STAGE_H - EDGE * 2 - 14),
                age: 0,
                life,
            });
        }

        // Current radius: full size once faded in, then shrinking to R_MIN.
        function radiusOf(tgt) {
            if (tgt.age < FADE_IN_MS) return R_MAX * (0.55 + 0.45 * (tgt.age / FADE_IN_MS));
            const k = (tgt.age - FADE_IN_MS) / (tgt.life - FADE_IN_MS);
            return R_MAX + (R_MIN - R_MAX) * Math.min(k, 1);
        }

        function alphaOf(tgt) {
            if (tgt.age < FADE_IN_MS) return tgt.age / FADE_IN_MS;
            const k = (tgt.age - FADE_IN_MS) / (tgt.life - FADE_IN_MS);
            return 1 - 0.75 * Math.min(k, 1);
        }

        function endRound() {
            running = false;
            roundOver = true;
            targets = [];
            // getState() goes null — the finished round is dropped and only
            // the highscore (banked as it was earned) survives.
            ctx.saveNow();
            ctx.setOverlay(
                ctx.t("arcadeRoundOver", String(score)),
                ctx.t("arcadeRoundAgainHint")
            );
        }

        // ── Simulation ─────────────────────────────────────────────────────

        function step(dt) {
            timeLeft -= dt;
            if (timeLeft <= 0) { timeLeft = 0; endRound(); return; }

            spawnEvery = SPAWN_MS_START + (SPAWN_MS_END - SPAWN_MS_START) * progress();
            spawnAcc += dt;
            if (spawnAcc >= spawnEvery) {
                spawnAcc = 0;
                if (targets.length < MAX_LIVE) spawn();
            }

            for (const tgt of targets) tgt.age += dt;
            targets = targets.filter((tgt) => tgt.age < tgt.life);

            for (const s of splashes) s.age += dt;
            splashes = splashes.filter((s) => s.age < 320);

            ctx.save();   // throttled round-clock churn
        }

        function shoot(x, y) {
            // Topmost (newest, smallest) reticle wins an overlapping click.
            for (let i = targets.length - 1; i >= 0; i--) {
                const tgt = targets[i];
                if (Math.hypot(x - tgt.x, y - tgt.y) > radiusOf(tgt)) continue;
                streak += 1;
                score += BASE_POINTS * multiplier();
                targets.splice(i, 1);
                splashes.push({ x, y, age: 0, hit: true });
                scoreCb?.(score);
                ctx.saveNow();   // score change
                return;
            }
            // Empty space — the streak is the whole point of the game mode,
            // so a wild click costs it.
            streak = 0;
            splashes.push({ x, y, age: 0, hit: false });
            ctx.saveNow();
        }

        // ── Rendering ──────────────────────────────────────────────────────

        function drawReticle(p, tgt) {
            const r = radiusOf(tgt);
            const a = alphaOf(tgt);
            g.save();
            g.globalAlpha = a;
            g.strokeStyle = p.accent;
            g.shadowColor = p.accent;
            g.shadowBlur = 8;
            g.lineWidth = 1.5;

            g.beginPath();
            g.arc(tgt.x, tgt.y, r, 0, Math.PI * 2);
            g.stroke();

            g.beginPath();
            g.arc(tgt.x, tgt.y, r * 0.55, 0, Math.PI * 2);
            g.stroke();

            g.beginPath();
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                g.moveTo(tgt.x + dx * (r + 5), tgt.y + dy * (r + 5));
                g.lineTo(tgt.x + dx * (r * 0.55), tgt.y + dy * (r * 0.55));
            }
            g.stroke();

            g.fillStyle = p.danger;
            g.shadowColor = p.danger;
            g.beginPath();
            g.arc(tgt.x, tgt.y, 2.4, 0, Math.PI * 2);
            g.fill();
            g.restore();
        }

        function draw() {
            const p = ctx.palette();
            g.clearRect(0, 0, ctx.STAGE_W, ctx.STAGE_H);

            for (const tgt of targets) drawReticle(p, tgt);

            for (const s of splashes) {
                const k = s.age / 320;
                g.save();
                g.globalAlpha = 1 - k;
                g.strokeStyle = s.hit ? p.accent : p.danger;
                g.lineWidth = 1.5;
                g.beginPath();
                g.arc(s.x, s.y, 4 + 16 * k, 0, Math.PI * 2);
                g.stroke();
                g.restore();
            }

            // HUD — round clock left, streak multiplier right.
            g.font = "700 12px 'Roboto Condensed', 'Arial Narrow', sans-serif";
            g.textBaseline = "top";
            g.fillStyle = timeLeft < 8000 && running ? p.danger : p.muted;
            g.textAlign = "left";
            g.fillText(ctx.t("arcadeTimeLeft", (timeLeft / 1000).toFixed(1)), 10, 9);

            g.textAlign = "right";
            g.fillStyle = streak >= 2 ? p.amber : p.muted;
            g.fillText(`×${multiplier()}`, ctx.STAGE_W - 10, 9);
        }

        function frame(dt) {
            if (running) step(dt);
            else for (const s of splashes) s.age += dt;
            draw();
        }

        // ── Attract screen ─────────────────────────────────────────────────

        function intro() {
            ctx.setIntro({
                title: ctx.t("arcadeGameTargets"),
                lines: [
                    ctx.t("arcadeTargetsIntro1"),
                    ctx.t("arcadeTargetsIntro2"),
                    ctx.t("arcadeTargetsIntro3"),
                ],
                start: ctx.t("arcadeTargetsIntroStart"),
            });
        }

        // ── Pointer input ──────────────────────────────────────────────────

        function onPointerDown(e) {
            if (paused) return;
            const { x, y } = ctx.pointer(el, e);

            if (!running) {
                freshRound();
                running = true;
                scoreCb?.(score);
                ctx.clearOverlay();
                ctx.saveNow();
                return;
            }
            shoot(x, y);
        }

        // ── Interface ──────────────────────────────────────────────────────

        return {
            init(container, saved) {
                const made = ctx.canvas();
                el = made.el;
                g  = made.g;
                container.appendChild(el);

                freshRound();
                if (saved) restore(saved);

                el.addEventListener("mousedown", onPointerDown);

                scoreCb?.(score);
                loop = ctx.loop(frame);
                loop.start();
                paused = false;

                if (!saved) intro();
            },

            getState() {
                if (!running || roundOver || timeLeft <= 0) return null;
                return { v: 1, timeLeft, score, streak };
            },

            pause() {
                paused = true;
                loop?.stop();
                return this.getState();
            },

            resume() {
                if (!paused) return;
                paused = false;
                loop?.start();
            },

            destroy() {
                loop?.stop();
                loop = null;
                el?.removeEventListener("mousedown", onPointerDown);
                el?.remove();
                el = null; g = null;
            },

            onScore(cb) { scoreCb = cb; },

            isOver() { return roundOver; },

            showIntro: intro,

            handleKey(e) {
                if (paused) return;
                // Keyboard only starts a round — aiming is the mouse's job.
                if (e.key !== "Enter" && e.key !== " ") return;
                if (running) return;
                freshRound();
                running = true;
                scoreCb?.(score);
                ctx.clearOverlay();
                ctx.saveNow();
            },
        };
    }

    window.__Arcade.register({
        id: "targets",
        nameKey: "arcadeGameTargets",
        realtime: true,
        saveVersion: 1,
        create,
    });
})();
