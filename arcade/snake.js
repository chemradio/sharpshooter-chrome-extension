// Arcade · Snake — grid snake on the shared cabinet canvas.
//
// Keyboard only (arrows + WASD), so a fresh run opens behind an overlay
// saying as much: the popup gives no other hint that it wants key input.
// Wall and self collision both end the run. Score = food eaten.
(function () {
    const CELL = 15;
    const COLS = 22;   // 22 * 15 = 330 = STAGE_W
    const ROWS = 18;   // 18 * 15 = 270 = STAGE_H

    const TICK_START = 130;   // ms per step
    const TICK_MIN   = 62;
    const TICK_STEP  = 2.5;   // shaved per food eaten

    const KEYS = {
        ArrowUp:    { x:  0, y: -1 },
        ArrowDown:  { x:  0, y:  1 },
        ArrowLeft:  { x: -1, y:  0 },
        ArrowRight: { x:  1, y:  0 },
        w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
        s: { x: 0, y:  1 }, S: { x: 0, y:  1 },
        a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
        d: { x:  1, y: 0 }, D: { x:  1, y: 0 },
    };

    function create(ctx) {
        let el = null, g = null, loop = null, scoreCb = null;

        let snake, dir, pendingDir, food, score, tickMs;
        let started = false, over = false, paused = false;
        let acc = 0, phase = 0;

        // ── State ──────────────────────────────────────────────────────────

        function freshRun() {
            const cy = Math.floor(ROWS / 2);
            snake = [{ x: 6, y: cy }, { x: 5, y: cy }, { x: 4, y: cy }];
            dir = { x: 1, y: 0 };
            pendingDir = null;
            score = 0;
            tickMs = TICK_START;
            started = false;
            over = false;
            placeFood();
        }

        function placeFood() {
            const free = [];
            for (let y = 0; y < ROWS; y++) {
                for (let x = 0; x < COLS; x++) {
                    if (!snake.some((s) => s.x === x && s.y === y)) free.push({ x, y });
                }
            }
            food = free.length
                ? free[Math.floor(Math.random() * free.length)]
                : { x: 0, y: 0 };
        }

        function restore(saved) {
            if (!Array.isArray(saved.snake) || !saved.snake.length) throw new Error("bad snake state");
            snake  = saved.snake.map((s) => ({ x: s.x | 0, y: s.y | 0 }));
            dir    = { x: saved.dir.x | 0, y: saved.dir.y | 0 };
            food   = { x: saved.food.x | 0, y: saved.food.y | 0 };
            score  = saved.score | 0;
            tickMs = Number(saved.tickMs) || TICK_START;
            pendingDir = null;
            started = true;
            over = false;
        }

        // ── Simulation ─────────────────────────────────────────────────────

        function step() {
            if (pendingDir) { dir = pendingDir; pendingDir = null; }

            const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

            if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) return die();
            if (snake.some((s) => s.x === head.x && s.y === head.y)) return die();

            snake.unshift(head);

            if (head.x === food.x && head.y === food.y) {
                score += 1;
                tickMs = Math.max(TICK_MIN, tickMs - TICK_STEP);
                placeFood();
                scoreCb?.(score);
                ctx.saveNow();          // score change — persist at once
            } else {
                snake.pop();
                ctx.save();             // throttled tick churn
            }
        }

        function die() {
            over = true;
            // getState() now returns null, so this both clears the saved run
            // and leaves the highscore (already written on the way up) alone.
            ctx.saveNow();
            ctx.setOverlay(ctx.t("arcadeGameOver"), ctx.t("arcadeRestartHint"));
        }

        // ── Rendering ──────────────────────────────────────────────────────

        function draw() {
            const p = ctx.palette();
            g.clearRect(0, 0, ctx.STAGE_W, ctx.STAGE_H);

            // Faint playfield grid — reads as the phosphor mask behind the run.
            g.strokeStyle = p.grid;
            g.lineWidth = 1;
            g.beginPath();
            for (let x = CELL; x < ctx.STAGE_W; x += CELL) {
                g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, ctx.STAGE_H);
            }
            for (let y = CELL; y < ctx.STAGE_H; y += CELL) {
                g.moveTo(0, y + 0.5); g.lineTo(ctx.STAGE_W, y + 0.5);
            }
            g.stroke();

            // Food — a small pulsing reticle rather than a plain block.
            const pulse = 0.5 + 0.5 * Math.sin(phase / 260);
            const fx = food.x * CELL + CELL / 2;
            const fy = food.y * CELL + CELL / 2;
            g.save();
            g.strokeStyle = p.danger;
            g.shadowColor = p.danger;
            g.shadowBlur = 6 + 4 * pulse;
            g.lineWidth = 1.5;
            g.beginPath();
            g.arc(fx, fy, 3.2 + pulse, 0, Math.PI * 2);
            g.moveTo(fx - 6, fy); g.lineTo(fx - 4, fy);
            g.moveTo(fx + 4, fy); g.lineTo(fx + 6, fy);
            g.moveTo(fx, fy - 6); g.lineTo(fx, fy - 4);
            g.moveTo(fx, fy + 4); g.lineTo(fx, fy + 6);
            g.stroke();
            g.restore();

            // Body — brightest at the head, fading down the tail.
            g.save();
            g.shadowColor = p.accent;
            g.shadowBlur = 7;
            for (let i = snake.length - 1; i >= 0; i--) {
                const seg = snake[i];
                const k = 1 - (i / snake.length) * 0.55;
                g.globalAlpha = over ? k * 0.4 : k;
                g.fillStyle = i === 0 ? p.accent : p.accentDim;
                g.fillRect(seg.x * CELL + 1.5, seg.y * CELL + 1.5, CELL - 3, CELL - 3);
            }
            g.restore();
        }

        function frame(dt) {
            phase += dt;
            if (started && !over) {
                acc += dt;
                while (acc >= tickMs) {
                    acc -= tickMs;
                    step();
                    if (over) break;
                }
            }
            draw();
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

                scoreCb?.(score);
                loop = ctx.loop(frame);
                loop.start();
                paused = false;

                // A restored run is frozen behind the hub's pause prompt, so
                // only a fresh one needs the "this wants the keyboard" nudge.
                if (!saved) ctx.setOverlay(ctx.t("arcadeSnakePrompt"), ctx.t("arcadeSnakeHint"));
            },

            getState() {
                if (!started || over) return null;
                return {
                    v: 1,
                    snake: snake.map((s) => ({ x: s.x, y: s.y })),
                    dir, food, score, tickMs,
                };
            },

            pause() {
                paused = true;
                loop?.stop();
                return this.getState();
            },

            resume() {
                if (!paused) return;
                paused = false;
                acc = 0;
                loop?.start();
            },

            destroy() {
                loop?.stop();
                loop = null;
                el?.remove();
                el = null; g = null;
            },

            onScore(cb) { scoreCb = cb; },

            isOver() { return over; },

            handleKey(e) {
                if (paused) return;

                if (over) {
                    // Any key restarts — no separate "play again" control.
                    freshRun();
                    scoreCb?.(score);
                    ctx.setOverlay(ctx.t("arcadeSnakePrompt"), ctx.t("arcadeSnakeHint"));
                    return;
                }

                const next = KEYS[e.key];
                if (!next) return;

                if (!started) {
                    started = true;
                    acc = 0;
                    ctx.clearOverlay();
                }
                // Reversing straight into the neck is an instant self-collision;
                // treat it as no input rather than a death sentence.
                const cur = pendingDir || dir;
                if (next.x === -cur.x && next.y === -cur.y) return;
                pendingDir = next;
            },
        };
    }

    window.__Arcade.register({
        id: "snake",
        nameKey: "arcadeGameSnake",
        realtime: true,
        saveVersion: 1,
        create,
    });
})();
