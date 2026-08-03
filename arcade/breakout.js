// Arcade · Breakout — paddle, ball, brick rows, three lives.
//
// The paddle follows the pointer inside the cabinet screen (the natural
// input for a popup), with arrow keys as a fallback for anyone playing
// keyboard-only. Score = bricks broken; clearing the wall starts a faster
// level and keeps the score.
(function () {
    const COLS = 8;
    const ROWS = 6;   // one more than the 270px-tall stage carried
    const MARGIN = 12;
    const GAP    = 4;
    const BRICK_H = 12;
    const BRICK_TOP = 34;

    const PADDLE_W = 62;
    const PADDLE_H = 8;
    const PADDLE_Y = 309;   // STAGE_H - 21, same floor gap as before
    const PADDLE_SPEED = 380;   // px/s, arrow-key fallback

    const BALL_R = 4;
    const BALL_SPEED = 195;     // px/s, level 1
    const LEVEL_SPEEDUP = 18;

    const LIVES = 3;

    function create(ctx) {
        let el = null, g = null, loop = null, scoreCb = null;

        let bricks, ball, paddleX, score, lives, level, launched, started;
        let over = false, paused = false;
        let keyLeft = false, keyRight = false;

        const BRICK_W = (ctx.STAGE_W - MARGIN * 2 - GAP * (COLS - 1)) / COLS;

        // ── State ──────────────────────────────────────────────────────────

        function serve() {
            launched = false;
            ball = { x: paddleX, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0 };
        }

        function speed() { return BALL_SPEED + (level - 1) * LEVEL_SPEEDUP; }

        function freshWall() {
            bricks = Array(COLS * ROWS).fill(1);
        }

        function freshRun() {
            score = 0;
            lives = LIVES;
            level = 1;
            over = false;
            started = false;
            paddleX = ctx.STAGE_W / 2;
            freshWall();
            serve();
        }

        function restore(saved) {
            if (!Array.isArray(saved.bricks) || saved.bricks.length !== COLS * ROWS) {
                throw new Error("bad breakout state");
            }
            bricks   = saved.bricks.map((b) => (b ? 1 : 0));
            paddleX  = Number(saved.paddleX) || ctx.STAGE_W / 2;
            score    = saved.score | 0;
            lives    = Math.max(1, saved.lives | 0);
            level    = Math.max(1, saved.level | 0);
            launched = !!saved.launched;
            started  = true;
            over     = false;
            ball = launched
                ? {
                      x: Number(saved.ball.x), y: Number(saved.ball.y),
                      vx: Number(saved.ball.vx), vy: Number(saved.ball.vy),
                  }
                : { x: paddleX, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0 };
        }

        function launch() {
            if (launched || over) return;
            launched = true;
            started = true;
            // Slight random rake so a launch is never perfectly repeatable.
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
            ball.vx = Math.cos(angle) * speed();
            ball.vy = Math.sin(angle) * speed();
            ctx.clearOverlay();
            ctx.saveNow();
        }

        function loseBall() {
            lives -= 1;
            if (lives <= 0) {
                over = true;
                ctx.saveNow();
                ctx.setOverlay(ctx.t("arcadeGameOver"), ctx.t("arcadeRestartHintClick"));
                return;
            }
            serve();
            // Life change — persist immediately rather than on the next tick.
            ctx.saveNow();
        }

        function nextLevel() {
            level += 1;
            freshWall();
            serve();
            ctx.saveNow();
            ctx.setOverlay(ctx.t("arcadeLevelCleared", String(level)), ctx.t("arcadeLaunchHint"));
        }

        // ── Simulation ─────────────────────────────────────────────────────

        function brickRect(i) {
            const c = i % COLS;
            const r = (i / COLS) | 0;
            return {
                x: MARGIN + c * (BRICK_W + GAP),
                y: BRICK_TOP + r * (BRICK_H + GAP),
                w: BRICK_W,
                h: BRICK_H,
            };
        }

        function step(dt) {
            const s = dt / 1000;

            if (keyLeft)  paddleX -= PADDLE_SPEED * s;
            if (keyRight) paddleX += PADDLE_SPEED * s;
            paddleX = clamp(paddleX, PADDLE_W / 2, ctx.STAGE_W - PADDLE_W / 2);

            if (!launched) {
                ball.x = paddleX;
                ball.y = PADDLE_Y - BALL_R - 1;
                return;
            }

            ball.x += ball.vx * s;
            ball.y += ball.vy * s;

            if (ball.x < BALL_R)                  { ball.x = BALL_R;                  ball.vx = Math.abs(ball.vx); }
            if (ball.x > ctx.STAGE_W - BALL_R)    { ball.x = ctx.STAGE_W - BALL_R;    ball.vx = -Math.abs(ball.vx); }
            if (ball.y < BALL_R)                  { ball.y = BALL_R;                  ball.vy = Math.abs(ball.vy); }

            // Paddle — the hit offset steers the bounce, so the player aims
            // with the paddle rather than just blocking.
            if (
                ball.vy > 0 &&
                ball.y + BALL_R >= PADDLE_Y &&
                ball.y - BALL_R <= PADDLE_Y + PADDLE_H &&
                ball.x >= paddleX - PADDLE_W / 2 - BALL_R &&
                ball.x <= paddleX + PADDLE_W / 2 + BALL_R
            ) {
                const offset = clamp((ball.x - paddleX) / (PADDLE_W / 2), -1, 1);
                const angle = -Math.PI / 2 + offset * 1.05;
                ball.vx = Math.cos(angle) * speed();
                ball.vy = Math.sin(angle) * speed();
                ball.y = PADDLE_Y - BALL_R - 1;
            }

            if (ball.y - BALL_R > ctx.STAGE_H) { loseBall(); return; }

            // Bricks — axis-resolved so a corner hit reverses the shallower
            // axis rather than tunnelling straight through the wall.
            for (let i = 0; i < bricks.length; i++) {
                if (!bricks[i]) continue;
                const b = brickRect(i);
                if (
                    ball.x + BALL_R < b.x || ball.x - BALL_R > b.x + b.w ||
                    ball.y + BALL_R < b.y || ball.y - BALL_R > b.y + b.h
                ) continue;

                bricks[i] = 0;
                score += 1;
                scoreCb?.(score);

                const overlapX = Math.min(ball.x + BALL_R - b.x, b.x + b.w - (ball.x - BALL_R));
                const overlapY = Math.min(ball.y + BALL_R - b.y, b.y + b.h - (ball.y - BALL_R));
                if (overlapX < overlapY) ball.vx = -ball.vx;
                else                      ball.vy = -ball.vy;

                ctx.saveNow();   // score change
                break;
            }

            if (!bricks.some(Boolean)) nextLevel();
            else ctx.save();     // throttled ball/paddle churn
        }

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // ── Rendering ──────────────────────────────────────────────────────

        function rowColor(p, r) {
            if (r === 0) return p.danger;
            if (r === 1) return p.amber;
            if (r === 2) return p.accent;
            return p.accentDim;
        }

        function draw() {
            const p = ctx.palette();
            g.clearRect(0, 0, ctx.STAGE_W, ctx.STAGE_H);

            g.globalAlpha = over ? 0.45 : 1;

            // Bricks
            for (let i = 0; i < bricks.length; i++) {
                if (!bricks[i]) continue;
                const b = brickRect(i);
                const color = rowColor(p, (i / COLS) | 0);
                g.save();
                g.shadowColor = color;
                g.shadowBlur = 6;
                g.fillStyle = color;
                g.globalAlpha = (over ? 0.45 : 1) * 0.85;
                g.fillRect(b.x, b.y, b.w, b.h);
                g.restore();
            }

            // Paddle
            g.save();
            g.shadowColor = p.accent;
            g.shadowBlur = 10;
            g.fillStyle = p.accent;
            g.fillRect(paddleX - PADDLE_W / 2, PADDLE_Y, PADDLE_W, PADDLE_H);
            g.restore();

            // Ball
            g.save();
            g.shadowColor = p.text;
            g.shadowBlur = 10;
            g.fillStyle = p.text;
            g.beginPath();
            g.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
            g.fill();
            g.restore();

            // Lives pips + level, top-left/right of the screen.
            g.globalAlpha = 1;
            g.fillStyle = p.danger;
            for (let i = 0; i < lives; i++) {
                g.fillRect(MARGIN + i * 10, 12, 6, 6);
            }
            g.fillStyle = p.muted;
            g.font = "600 11px 'Roboto Condensed', 'Arial Narrow', sans-serif";
            g.textAlign = "right";
            g.textBaseline = "top";
            g.fillText(ctx.t("arcadeLevelShort", String(level)), ctx.STAGE_W - MARGIN, 11);
        }

        function frame(dt) {
            if (!over) step(dt);
            draw();
        }

        // ── Attract screen ─────────────────────────────────────────────────

        function intro() {
            ctx.setIntro({
                title: ctx.t("arcadeGameBreakout"),
                lines: [
                    ctx.t("arcadeBreakoutIntro1"),
                    ctx.t("arcadeBreakoutIntro2"),
                    ctx.t("arcadeBreakoutIntro3"),
                ],
                start: ctx.t("arcadeBreakoutIntroStart"),
            });
        }

        // ── Pointer input ──────────────────────────────────────────────────

        function onPointerMove(e) {
            if (paused || over) return;
            const { x } = ctx.pointer(el, e);
            paddleX = clamp(x, PADDLE_W / 2, ctx.STAGE_W - PADDLE_W / 2);
        }

        function onPointerDown() {
            if (paused) return;
            if (over) {
                freshRun();
                scoreCb?.(score);
                intro();
                return;
            }
            launch();
        }

        // ── Interface ──────────────────────────────────────────────────────

        return {
            init(container, saved) {
                const made = ctx.canvas();
                el = made.el;
                g  = made.g;
                container.appendChild(el);

                freshRun();
                if (saved) restore(saved);

                el.addEventListener("mousemove", onPointerMove);
                el.addEventListener("mousedown", onPointerDown);

                scoreCb?.(score);
                loop = ctx.loop(frame);
                loop.start();
                paused = false;

                if (!saved) intro();
            },

            getState() {
                if (over || !started) return null;
                return {
                    v: 1,
                    bricks: bricks.slice(),
                    ball: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy },
                    paddleX, score, lives, level, launched,
                };
            },

            pause() {
                paused = true;
                keyLeft = keyRight = false;
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
                el?.removeEventListener("mousemove", onPointerMove);
                el?.removeEventListener("mousedown", onPointerDown);
                el?.remove();
                el = null; g = null;
            },

            onScore(cb) { scoreCb = cb; },

            isOver() { return over; },

            showIntro: intro,

            handleKey(e) {
                if (paused) return;

                if (over) {
                    freshRun();
                    scoreCb?.(score);
                    intro();
                    return;
                }

                if (e.type !== "keydown") return;
                if (e.key === "ArrowLeft"  || e.key === "a" || e.key === "A") keyLeft = true;
                if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") keyRight = true;
                if (e.key === " " || e.key === "ArrowUp" || e.key === "w" || e.key === "W") launch();
            },

            handleKeyUp(e) {
                if (e.key === "ArrowLeft"  || e.key === "a" || e.key === "A") keyLeft = false;
                if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") keyRight = false;
            },
        };
    }

    window.__Arcade.register({
        id: "breakout",
        nameKey: "arcadeGameBreakout",
        realtime: true,
        // 2: the wall gained a row and the paddle moved with the square
        // stage, so a v1 snapshot describes a board that no longer exists.
        saveVersion: 2,
        create,
    });
})();
