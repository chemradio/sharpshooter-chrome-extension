// Arcade · 2048 — 4×4 sliding-tile puzzle, standard rules and scoring.
//
// Turn-based, so persistence is exact: every move writes the full board
// immediately (no throttling) and a restored run is byte-identical to the
// one that was interrupted — no pause prompt needed, the game is already
// waiting on the next keypress.
(function () {
    const N    = 4;
    const PAD  = 8;
    const CELL = 56;
    const BOARD = N * CELL + (N + 1) * PAD;   // 264

    const SLIDE_MS = 110;
    const POP_MS   = 110;

    const KEYS = {
        ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
        w: "up",    W: "up",
        s: "down",  S: "down",
        a: "left",  A: "left",
        d: "right", D: "right",
    };

    // #rrggbb -> rgba(). Palette values come off the stylesheet as hex in both
    // themes; anything else is passed through untouched.
    function withAlpha(color, a) {
        const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
        if (!m) return color;
        const n = parseInt(m[1], 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    }

    function create(ctx) {
        let el = null, g = null, loop = null, scoreCb = null;

        let grid, score;
        let over = false, paused = false;
        // Animation state: a slide (tiles travelling to their new slots)
        // followed by a pop (merged tiles and the spawned tile scaling in).
        let anim = null;
        let originX = 0, originY = 0;

        // ── Board helpers ──────────────────────────────────────────────────

        const emptyGrid = () => Array.from({ length: N }, () => Array(N).fill(0));

        function emptyCells() {
            const out = [];
            for (let r = 0; r < N; r++) {
                for (let c = 0; c < N; c++) if (!grid[r][c]) out.push({ r, c });
            }
            return out;
        }

        function spawn() {
            const free = emptyCells();
            if (!free.length) return null;
            const cell = free[Math.floor(Math.random() * free.length)];
            grid[cell.r][cell.c] = Math.random() < 0.9 ? 2 : 4;
            return cell;
        }

        function freshRun() {
            grid = emptyGrid();
            score = 0;
            over = false;
            anim = null;
            spawn();
            spawn();
        }

        function restore(saved) {
            if (!Array.isArray(saved.grid) || saved.grid.length !== N * N) {
                throw new Error("bad 2048 state");
            }
            grid = emptyGrid();
            for (let i = 0; i < N * N; i++) {
                grid[(i / N) | 0][i % N] = Number(saved.grid[i]) || 0;
            }
            score = saved.score | 0;
            over = false;
            anim = null;
        }

        // Positions of a line, ordered so index 0 is the cell tiles pack into.
        function lineCells(dir, i) {
            const cells = [];
            for (let k = 0; k < N; k++) {
                if (dir === "left")  cells.push({ r: i, c: k });
                if (dir === "right") cells.push({ r: i, c: N - 1 - k });
                if (dir === "up")    cells.push({ r: k, c: i });
                if (dir === "down")  cells.push({ r: N - 1 - k, c: i });
            }
            return cells;
        }

        // Applies a move, returning the tile movements for the slide animation
        // (or null when the move changes nothing — standard 2048 rejects those).
        function move(dir) {
            const moves = [];
            const next = emptyGrid();
            let gained = 0;
            let changed = false;

            for (let i = 0; i < N; i++) {
                const cells = lineCells(dir, i);
                const tiles = cells
                    .map((p) => ({ ...p, value: grid[p.r][p.c] }))
                    .filter((tile) => tile.value);

                let slot = 0;
                for (let k = 0; k < tiles.length; k++) {
                    const to = cells[slot];
                    if (k + 1 < tiles.length && tiles[k].value === tiles[k + 1].value) {
                        const merged = tiles[k].value * 2;
                        moves.push({ from: tiles[k],     to, value: tiles[k].value });
                        moves.push({ from: tiles[k + 1], to, value: tiles[k].value, merges: true });
                        next[to.r][to.c] = merged;
                        gained += merged;
                        changed = true;
                        k++;
                    } else {
                        moves.push({ from: tiles[k], to, value: tiles[k].value });
                        next[to.r][to.c] = tiles[k].value;
                        if (tiles[k].r !== to.r || tiles[k].c !== to.c) changed = true;
                    }
                    slot++;
                }
            }

            if (!changed) return null;

            grid = next;
            score += gained;

            const popped = moves.filter((m) => m.merges).map((m) => m.to);
            const spawned = spawn();
            if (spawned) popped.push({ ...spawned, isNew: true });

            return { moves, popped, gained };
        }

        function canMove() {
            for (let r = 0; r < N; r++) {
                for (let c = 0; c < N; c++) {
                    if (!grid[r][c]) return true;
                    if (c + 1 < N && grid[r][c] === grid[r][c + 1]) return true;
                    if (r + 1 < N && grid[r][c] === grid[r + 1][c]) return true;
                }
            }
            return false;
        }

        // ── Rendering ──────────────────────────────────────────────────────

        function cellX(c) { return originX + PAD + c * (CELL + PAD); }
        function cellY(r) { return originY + PAD + r * (CELL + PAD); }

        function tileStyle(p, value) {
            const n = Math.log2(value);
            if (n <= 2) return { fill: withAlpha(p.accent, 0.14), text: p.accent,  glow: p.accent };
            if (n <= 4) return { fill: p.accentDim,                text: p.void_,  glow: p.accent };
            if (n <= 6) return { fill: p.accent,                   text: p.void_,  glow: p.accent };
            if (n <= 8) return { fill: p.amber,                    text: p.void_,  glow: p.amber  };
            return              { fill: p.danger,                  text: "#ffffff", glow: p.danger };
        }

        function drawTile(p, x, y, value, scale = 1) {
            const st = tileStyle(p, value);
            const size = CELL * scale;
            const ox = x + (CELL - size) / 2;
            const oy = y + (CELL - size) / 2;

            g.save();
            g.shadowColor = st.glow;
            g.shadowBlur = 8;
            g.fillStyle = st.fill;
            g.fillRect(ox, oy, size, size);
            g.restore();

            g.strokeStyle = st.glow;
            g.lineWidth = 1;
            g.strokeRect(ox + 0.5, oy + 0.5, size - 1, size - 1);

            const digits = String(value).length;
            const fontSize = Math.round((digits >= 4 ? 19 : digits === 3 ? 23 : 26) * scale);
            g.fillStyle = st.text;
            g.font = `700 ${fontSize}px 'Roboto Condensed', 'Arial Narrow', sans-serif`;
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(String(value), ox + size / 2, oy + size / 2 + 1);
        }

        function draw() {
            const p = ctx.palette();
            g.clearRect(0, 0, ctx.STAGE_W, ctx.STAGE_H);

            // Board well + empty slots.
            g.strokeStyle = withAlpha(p.accent, 0.35);
            g.lineWidth = 1;
            g.strokeRect(originX + 0.5, originY + 0.5, BOARD - 1, BOARD - 1);
            g.fillStyle = p.grid;
            for (let r = 0; r < N; r++) {
                for (let c = 0; c < N; c++) g.fillRect(cellX(c), cellY(r), CELL, CELL);
            }

            g.globalAlpha = over ? 0.45 : 1;

            if (anim && anim.phase === "slide") {
                // Mid-slide: draw the travelling tiles at their old values,
                // nothing from the (already committed) destination grid.
                const k = Math.min(anim.elapsed / SLIDE_MS, 1);
                const ease = 1 - Math.pow(1 - k, 3);
                for (const m of anim.moves) {
                    const x = cellX(m.from.c) + (cellX(m.to.c) - cellX(m.from.c)) * ease;
                    const y = cellY(m.from.r) + (cellY(m.to.r) - cellY(m.from.r)) * ease;
                    drawTile(p, x, y, m.value);
                }
            } else {
                const popping = anim && anim.phase === "pop" ? anim.popped : null;
                const k = popping ? Math.min(anim.elapsed / POP_MS, 1) : 1;
                for (let r = 0; r < N; r++) {
                    for (let c = 0; c < N; c++) {
                        const value = grid[r][c];
                        if (!value) continue;
                        const hit = popping?.find((q) => q.r === r && q.c === c);
                        // Merges bulge past 1 and settle; a spawned tile grows in.
                        let scale = 1;
                        if (hit) {
                            scale = hit.isNew
                                ? 0.25 + 0.75 * k
                                : 1 + 0.18 * Math.sin(Math.PI * k);
                        }
                        drawTile(p, cellX(c), cellY(r), value, scale);
                    }
                }
            }

            g.globalAlpha = 1;
        }

        function frame(dt) {
            if (anim) {
                anim.elapsed += dt;
                if (anim.phase === "slide" && anim.elapsed >= SLIDE_MS) {
                    anim = { phase: "pop", elapsed: 0, popped: anim.popped };
                } else if (anim.phase === "pop" && anim.elapsed >= POP_MS) {
                    anim = null;
                    if (!canMove()) {
                        over = true;
                        // getState() goes null — the finished run is dropped,
                        // the highscore was already banked on the way up.
                        ctx.saveNow();
                        ctx.setOverlay(ctx.t("arcadeGameOver"), ctx.t("arcadeRestartHint"));
                    }
                }
            }
            draw();
        }

        // ── Attract screen ─────────────────────────────────────────────────

        function intro() {
            ctx.setIntro({
                title: ctx.t("arcadeGame2048"),
                lines: [
                    ctx.t("arcade2048Intro1"),
                    ctx.t("arcade2048Intro2"),
                    ctx.t("arcade2048Intro3"),
                ],
                start: ctx.t("arcade2048IntroStart"),
            });
        }

        // ── Interface ──────────────────────────────────────────────────────

        return {
            init(container, saved) {
                const made = ctx.canvas();
                el = made.el;
                g  = made.g;
                container.appendChild(el);

                originX = Math.round((ctx.STAGE_W - BOARD) / 2);
                originY = Math.round((ctx.STAGE_H - BOARD) / 2);

                freshRun();
                if (saved) restore(saved);

                scoreCb?.(score);
                loop = ctx.loop(frame);
                loop.start();
                paused = false;

                if (!saved) intro();
            },

            getState() {
                if (over) return null;
                return { v: 1, grid: grid.flat(), score };
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
                    ctx.saveNow();
                    intro();
                    return;
                }

                const dir = KEYS[e.key];
                if (!dir || anim) return;   // one move per animation

                ctx.clearOverlay();
                const result = move(dir);
                if (!result) return;

                anim = { phase: "slide", elapsed: 0, moves: result.moves, popped: result.popped };
                scoreCb?.(score);
                // Turn-based: every discrete move is persisted immediately.
                ctx.saveNow();
            },
        };
    }

    window.__Arcade.register({
        id: "2048",
        nameKey: "arcadeGame2048",
        realtime: false,
        saveVersion: 1,
        create,
    });
})();
