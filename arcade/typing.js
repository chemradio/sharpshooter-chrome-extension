// Arcade · Typing Trainer — blind-typing drill on the shared canvas.
//
// A short paragraph is fetched at runtime and typed out character by
// character. Speed is net WPM (correct characters / 5, over the time
// actually spent typing) and accuracy is correct keystrokes over total
// keystrokes; the hub banks the WPM as the highscore and the accuracy of
// that run as its detail figure, so the record reads "71 · 96%".
//
// Text comes from Wikipedia's REST summary endpoint — one random article
// summary per drill, in whichever of the offered languages is selected —
// rather than a bundled corpus, so the drills never repeat and every
// language is covered by the same code path. The extension already holds
// <all_urls> host permissions for capture, so no manifest change is
// involved; the request carries no identifying data (it names no article
// — the endpoint picks one) and nothing is sent, only fetched.
//
// A tiny per-language fallback sentence exists for the offline case. It
// is a graceful degradation, not the source: a drill you can still run
// with the network down beats an empty screen.
(function () {
    // Wikipedia language editions offered in the picker. Labels are the
    // endonyms — a typing drill's language list should read in its own
    // language, not the UI's.
    const LANGS = [
        { code: "en", label: "English" },
        { code: "ru", label: "Русский" },
        { code: "de", label: "Deutsch" },
        { code: "fr", label: "Français" },
        { code: "es", label: "Español" },
        { code: "it", label: "Italiano" },
        { code: "pt", label: "Português" },
        { code: "nl", label: "Nederlands" },
        { code: "pl", label: "Polski" },
        { code: "tr", label: "Türkçe" },
        { code: "uk", label: "Українська" },
    ];

    const LANG_KEY = "arcadeTypingLang";

    const MIN_CHARS = 110;
    const MAX_CHARS = 240;
    const FETCH_TRIES = 4;      // random articles to try before giving up

    // Last-resort drills, used only when every fetch attempt failed.
    const FALLBACK = {
        en: "The quick brown fox jumps over the lazy dog while the printer hums in the corner of a quiet office and nobody looks up from their screens.",
        ru: "Съешь же ещё этих мягких французских булок да выпей чаю, пока в тихом кабинете негромко гудит принтер и никто не поднимает глаз от экрана.",
        de: "Franz jagt im komplett verwahrlosten Taxi quer durch Bayern, waehrend der Drucker in der Ecke eines stillen Bueros leise vor sich hin summt.",
        fr: "Portez ce vieux whisky au juge blond qui fume, pendant que l'imprimante ronronne dans le coin d'un bureau tranquille ou personne ne leve les yeux.",
        es: "El veloz murcielago hindu comia feliz cardillo y kiwi mientras la impresora zumbaba en la esquina de una oficina tranquila y nadie levantaba la vista.",
        it: "Pranzo d'acqua fa volti sghembi mentre la stampante ronza nell'angolo di un ufficio tranquillo e nessuno alza lo sguardo dallo schermo del computer.",
        pt: "Um pequeno jabuti xereta viu dez cegonhas felizes enquanto a impressora zumbia no canto de um escritorio tranquilo e ninguem levantava os olhos.",
        nl: "Pa's wijze lynx bezag vroom het fikse aquaduct terwijl de printer zoemde in de hoek van een stil kantoor waar niemand opkeek van zijn scherm.",
        pl: "Pchnac w te lodz jeza lub osiem skrzyn fig, podczas gdy drukarka szumi w rogu cichego biura i nikt nie podnosi wzroku znad ekranu komputera.",
        tr: "Pijamali hasta yagiz sofore cabucak guvendi, yazici sessiz bir ofisin kosesinde ugulderken kimse ekranindan basini kaldirmadi bile.",
        uk: "Чуєш їх, доцю, га? Кумедна ж мова, поки принтер тихо гуде в кутку спокійного кабінету і ніхто не підводить очей від свого екрана.",
    };

    // ── Text acquisition ────────────────────────────────────────────────────

    function summaryUrl(lang) {
        return `https://${lang}.wikipedia.org/api/rest_v1/page/random/summary`;
    }

    // Wikipedia summaries carry pronunciation parentheses, footnote
    // brackets and typographic punctuation that has no key on most
    // layouts — all of which make a drill about hunting for characters
    // rather than about typing. Normalize it down to what a keyboard
    // actually produces.
    function normalize(raw) {
        return String(raw || "")
            .replace(/\[[^\]]*\]/g, " ")
            .replace(/\([^()]*\)/g, " ")
            .replace(/[“”„«»]/g, '"')
            .replace(/[‘’‚]/g, "'")
            .replace(/[–—−]/g, "-")
            .replace(/…/g, "...")
            .replace(/[   ]/g, " ")
            .replace(/\s+([,.;:!?])/g, "$1")
            .replace(/\s+/g, " ")
            .trim();
    }

    // Whole sentences only, up to MAX_CHARS — a paragraph cut mid-clause
    // reads as a bug. Returns "" when the article is too short to use,
    // which the caller treats as "try another one".
    function toDrill(text) {
        const clean = normalize(text);
        if (clean.length < MIN_CHARS) return "";
        if (clean.length <= MAX_CHARS) return clean;

        const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)/g);
        if (sentences) {
            let out = "";
            for (const s of sentences) {
                if (out.length + s.length > MAX_CHARS) break;
                out += s;
            }
            out = out.trim();
            if (out.length >= MIN_CHARS) return out;
        }
        // No sentence punctuation (or the first sentence alone overruns):
        // fall back to a clean word boundary.
        const cut = clean.slice(0, MAX_CHARS);
        const space = cut.lastIndexOf(" ");
        return (space > MIN_CHARS ? cut.slice(0, space) : cut).trim();
    }

    async function fetchDrill(lang) {
        for (let i = 0; i < FETCH_TRIES; i++) {
            try {
                const res = await fetch(summaryUrl(lang), {
                    cache: "no-store",
                    headers: { accept: "application/json" },
                });
                if (!res.ok) continue;
                const drill = toDrill((await res.json())?.extract);
                if (drill) return drill;
            } catch (e) {
                // Offline / blocked / DNS — no point burning the remaining
                // attempts on the same failure.
                console.warn("arcade/typing: fetch failed:", e);
                break;
            }
        }
        return FALLBACK[lang] || FALLBACK.en;
    }

    // ── Game ────────────────────────────────────────────────────────────────

    function create(ctx) {
        let el = null, g = null, loop = null, scoreCb = null;
        let select = null;

        // "loading" -> "ready" -> "typing" -> "done"
        let phase = "loading";
        let lang = "en";
        let text = "";
        let wrong = [];        // per-index: was this character mistyped?
        let pos = 0;
        let keystrokes = 0, correctStrokes = 0;
        let elapsed = 0;       // ms actually spent typing (pause-safe)
        let caretPhase = 0;
        let animT = 0;         // free-running clock for loading/prompt animation
        let nextText = "";     // prefetched, so a restart is instant
        // Bumped on every teardown/reload so a late fetch from a previous
        // run can't overwrite the current one.
        let token = 0;

        // ── Metrics ────────────────────────────────────────────────────────

        function wrongCount() {
            let n = 0;
            for (let i = 0; i < pos; i++) if (wrong[i]) n++;
            return n;
        }

        function wpm() {
            const minutes = elapsed / 60000;
            if (minutes <= 0) return 0;
            return Math.max(0, Math.round(((pos - wrongCount()) / 5) / minutes));
        }

        function accuracy() {
            if (!keystrokes) return 100;
            return Math.max(0, Math.round((correctStrokes / keystrokes) * 100));
        }

        // ── State ──────────────────────────────────────────────────────────

        function resetCounters() {
            wrong = [];
            pos = 0;
            keystrokes = 0;
            correctStrokes = 0;
            elapsed = 0;
        }

        // Loads a drill and arms it. `useNext` spends the prefetched text
        // (instant restart) when one is ready. Nothing here touches an
        // overlay: this game draws its own loading animation and its own
        // start prompt on the canvas, so the drill text is never covered
        // by the panel telling you to type it.
        async function loadDrill({ useNext = false } = {}) {
            const mine = ++token;

            if (useNext && nextText) {
                text = nextText;
                nextText = "";
                if (mine !== token) return;
                phase = "ready";
                prefetch();
                return;
            }

            text = "";
            phase = "loading";
            const drill = await fetchDrill(lang);
            if (mine !== token) return;   // language changed, or torn down
            text = drill;
            phase = "ready";
            prefetch();
        }

        // Warms the next drill in the background. Failures are silent —
        // loadDrill() falls back to a live fetch when nextText is empty.
        async function prefetch() {
            const mine = token;
            const forLang = lang;
            const drill = await fetchDrill(forLang);
            if (mine !== token || forLang !== lang) return;
            nextText = drill;
        }

        function finish() {
            phase = "done";
            const speed = wpm();
            const acc = accuracy();
            // Detail first: the hub banks whatever setDetail last reported
            // at the moment the score beats the record.
            ctx.setDetail(`${acc}%`);
            scoreCb?.(speed);
            ctx.saveNow();   // getState() is null now — drops the finished run
            // The result is drawn into the footer strip rather than thrown
            // over the screen: the paragraph you just typed, with every
            // mistake still flagged in red, is the more useful thing to be
            // looking at while reading the score.
        }

        // ── Input ──────────────────────────────────────────────────────────

        function typeChar(ch) {
            keystrokes += 1;
            if (ch === text[pos]) {
                correctStrokes += 1;
                wrong[pos] = false;
            } else {
                // Advance anyway rather than blocking on the mistake: the
                // error is recorded against the position and can be walked
                // back with Backspace, which is how the metric is defined.
                wrong[pos] = true;
            }
            pos += 1;
            if (pos >= text.length) finish();
            else ctx.save();
        }

        function backspace() {
            if (!pos) return;
            pos -= 1;
            // The keystroke that produced the error still counted against
            // accuracy — only the character's own error flag is undone, so
            // the speed metric recovers but the accuracy metric does not.
            wrong[pos] = false;
            ctx.save();
        }

        // ── Language picker ────────────────────────────────────────────────
        //
        // Parked in the hub's topbar control slot, so it stays reachable
        // between drills without ever sitting on top of the paragraph.

        function makeSelect() {
            const sel = document.createElement("select");
            sel.className = "arcade-select";
            sel.setAttribute("aria-label", ctx.t("arcadeTypingLanguage"));
            for (const l of LANGS) {
                const opt = document.createElement("option");
                opt.value = l.code;
                opt.textContent = l.label;
                sel.appendChild(opt);
            }
            sel.value = lang;
            sel.addEventListener("change", () => {
                lang = sel.value;
                chrome.storage.local.set({ [LANG_KEY]: lang });
                nextText = "";
                // A focused <select> answers letter and arrow keys itself,
                // and the hub yields Space/Enter to any focused control —
                // both of which would eat the first keystrokes of the drill.
                sel.blur();
                // The new drill is a new run: the old one's partial metrics
                // describe a paragraph that is about to be replaced.
                resetCounters();
                ctx.setDetail("");
                scoreCb?.(0);
                loadDrill();
            });
            return sel;
        }

        function mountSelect() {
            if (!select) select = makeSelect();
            select.value = lang;
            ctx.setControls([select]);
        }

        // ── Rendering ──────────────────────────────────────────────────────

        const PAD_X = 15;
        const TOP   = 46;
        const LINE_H = 19;
        const FONT = "14px 'Consolas', 'Menlo', monospace";

        // The footer strip — rules, start prompt, result — occupies the
        // bottom of the screen, clear of the paragraph above it and of the
        // progress bar below it. Everything in it is anchored upward from
        // FOOTER_BOTTOM so a longer localized string grows away from the
        // text rather than into it.
        const BAR_Y = ctx.STAGE_H - 16;
        const FOOTER_BOTTOM = BAR_Y - 20;
        const PROMPT_H = 26;

        // Wraps `text` into lines of {chars, startIndex} without breaking
        // words. Monospace, so a character count is all the measuring the
        // layout needs.
        function layout(charW) {
            const maxCols = Math.max(8, Math.floor((ctx.STAGE_W - PAD_X * 2) / charW));
            const lines = [];
            let start = 0;

            while (start < text.length) {
                if (start + maxCols >= text.length) {
                    lines.push(start);
                    break;
                }
                // Break at the last space that fits; if a single "word" is
                // longer than the line, break it mid-word rather than loop.
                let brk = text.lastIndexOf(" ", start + maxCols);
                if (brk <= start) brk = start + maxCols - 1;
                lines.push(start);
                start = brk + 1;
            }
            return { lines, maxCols };
        }

        function roundRect(x, y, w, h, r) {
            g.beginPath();
            g.moveTo(x + r, y);
            g.arcTo(x + w, y, x + w, y + h, r);
            g.arcTo(x + w, y + h, x, y + h, r);
            g.arcTo(x, y + h, x, y, r);
            g.arcTo(x, y, x + w, y, r);
            g.closePath();
        }

        // Loading animation, drawn exactly where the paragraph will appear:
        // skeleton lines with a highlight sweeping across them. It replaces
        // the old "Fetching a paragraph…" caption — the shape of what's
        // coming says it without a string to read (or translate).
        function drawLoading(p) {
            const w = ctx.STAGE_W - PAD_X * 2;
            const widths = [1, 0.96, 0.99, 0.62];
            const cycle = 1500;
            const sweep = ((animT % cycle) / cycle) * 1.5 - 0.25;

            g.save();
            g.globalAlpha = 0.5;
            for (let i = 0; i < widths.length; i++) {
                const bw = w * widths[i];
                const y = TOP + i * LINE_H;
                // Sweep position expressed in this bar's own 0..1 space, so
                // the highlight crosses the block as one diagonal-less wipe
                // rather than restarting per line.
                const c = (sweep * w) / bw;
                const grad = g.createLinearGradient(PAD_X, 0, PAD_X + bw, 0);
                const stop = (v) => Math.min(1, Math.max(0, v));
                grad.addColorStop(0, p.muted);
                grad.addColorStop(stop(c - 0.22), p.muted);
                grad.addColorStop(stop(c), p.accent);
                grad.addColorStop(stop(c + 0.22), p.muted);
                grad.addColorStop(1, p.muted);
                g.fillStyle = grad;
                roundRect(PAD_X, y, bw, 9, 2);
                g.fill();
            }
            g.restore();
        }

        // The boxed, pulsing call to action at the bottom of the screen —
        // the loud element of the old attract overlay, kept, but sized to
        // sit under the paragraph instead of over it.
        function drawPrompt(p, label, y) {
            g.font = "700 12px 'Roboto Condensed', 'Arial Narrow', sans-serif";
            g.textAlign = "center";
            g.textBaseline = "middle";
            const w = Math.min(ctx.STAGE_W - PAD_X * 2, g.measureText(label).width + 30);
            const x = (ctx.STAGE_W - w) / 2;
            const pulse = 0.72 + 0.28 * Math.sin((animT / 1500) * Math.PI * 2);

            g.save();
            g.globalAlpha = 0.12 * pulse;
            g.fillStyle = p.accent;
            roundRect(x, y, w, PROMPT_H, 4);
            g.fill();
            g.globalAlpha = pulse;
            g.strokeStyle = p.accent;
            g.lineWidth = 1;
            g.shadowColor = p.accent;
            g.shadowBlur = 8;
            roundRect(x + 0.5, y + 0.5, w - 1, PROMPT_H - 1, 4);
            g.stroke();
            g.shadowBlur = 0;
            g.fillStyle = p.accent;
            g.fillText(label, ctx.STAGE_W / 2, y + PROMPT_H / 2 + 0.5);
            g.restore();

            g.textAlign = "left";
            g.textBaseline = "top";
        }

        // Rules while armed, score once finished. Nothing at all while
        // typing — at that point the paragraph is the whole interface.
        function drawFooter(p) {
            if (phase === "ready") {
                const lines = [
                    ctx.t("arcadeTypingIntro1"),
                    ctx.t("arcadeTypingIntro2"),
                    ctx.t("arcadeTypingIntro3"),
                ];
                const promptY = FOOTER_BOTTOM - PROMPT_H;
                g.save();
                g.font = "11px 'Roboto Condensed', 'Arial Narrow', sans-serif";
                g.textAlign = "center";
                g.textBaseline = "alphabetic";
                g.fillStyle = p.muted;
                for (let i = 0; i < lines.length; i++) {
                    const y = promptY - 16 - (lines.length - 1 - i) * 15;
                    g.fillText(lines[i], ctx.STAGE_W / 2, y);
                }
                g.restore();
                g.textAlign = "left";
                g.textBaseline = "top";
                drawPrompt(p, ctx.t("arcadeTypingIntroStart"), promptY);
                return;
            }

            if (phase === "done") {
                const promptY = FOOTER_BOTTOM - PROMPT_H;
                g.save();
                g.font = "700 17px 'Consolas', 'Menlo', monospace";
                g.textAlign = "center";
                g.textBaseline = "alphabetic";
                g.fillStyle = p.accent;
                g.shadowColor = p.accent;
                g.shadowBlur = 10;
                g.fillText(
                    ctx.t("arcadeTypingResult", String(wpm()), String(accuracy())),
                    ctx.STAGE_W / 2,
                    promptY - 16,
                );
                g.restore();
                g.textAlign = "left";
                g.textBaseline = "top";
                drawPrompt(p, ctx.t("arcadeTypingAgainHint"), promptY);
            }
        }

        function draw() {
            const p = ctx.palette();
            g.clearRect(0, 0, ctx.STAGE_W, ctx.STAGE_H);

            g.font = FONT;
            g.textBaseline = "top";
            g.textAlign = "left";
            const charW = g.measureText("M").width;

            // HUD — live speed, accuracy and progress.
            g.font = "700 11px 'Roboto Condensed', 'Arial Narrow', sans-serif";
            g.fillStyle = phase === "typing" ? p.accent : p.muted;
            g.fillText(ctx.t("arcadeTypingWpm", String(wpm())), PAD_X, 12);
            g.textAlign = "center";
            g.fillStyle = accuracy() < 90 ? p.danger : p.muted;
            g.fillText(ctx.t("arcadeTypingAcc", String(accuracy())), ctx.STAGE_W / 2, 12);
            g.textAlign = "right";
            g.fillStyle = p.muted;
            g.fillText(`${pos}/${text.length}`, ctx.STAGE_W - PAD_X, 12);
            g.textAlign = "left";

            if (!text) {
                drawLoading(p);
                drawProgressBar(p);
                return;
            }

            const { lines, maxCols } = layout(charW);

            g.font = FONT;
            for (let li = 0; li < lines.length; li++) {
                const start = lines[li];
                const end = li + 1 < lines.length ? lines[li + 1] : text.length;
                const y = TOP + li * LINE_H;

                for (let i = start; i < end && i - start < maxCols + 1; i++) {
                    const x = PAD_X + (i - start) * charW;
                    const ch = text[i];

                    if (i < pos) {
                        if (wrong[i]) {
                            // Mistyped: the expected character in red, with
                            // a rule under it so it stays findable at a
                            // glance when scanning back with Backspace.
                            g.fillStyle = p.danger;
                            g.fillText(ch, x, y);
                            g.fillRect(x, y + LINE_H - 4, charW, 1);
                        } else {
                            g.fillStyle = p.accent;
                            g.fillText(ch, x, y);
                        }
                    } else {
                        g.fillStyle = p.muted;
                        g.fillText(ch, x, y);
                    }

                    // Caret — a blinking underscore block at the next
                    // character, drawn over it so it never hides the target.
                    if (i === pos && (phase !== "typing" || caretPhase % 1000 < 560)) {
                        g.save();
                        g.fillStyle = p.accent;
                        g.globalAlpha = 0.35;
                        g.fillRect(x - 0.5, y - 1, charW + 1, LINE_H - 3);
                        g.restore();
                        g.fillStyle = p.text;
                        g.fillText(ch, x, y);
                    }
                }
            }

            drawFooter(p);
            drawProgressBar(p);
        }

        // Progress bar along the bottom of the screen.
        function drawProgressBar(p) {
            const barW = ctx.STAGE_W - PAD_X * 2;
            g.fillStyle = p.grid;
            g.fillRect(PAD_X, BAR_Y, barW, 3);
            g.save();
            g.fillStyle = p.accent;
            g.shadowColor = p.accent;
            g.shadowBlur = 6;
            g.fillRect(PAD_X, BAR_Y, barW * (text.length ? pos / text.length : 0), 3);
            g.restore();
        }

        function frame(dt) {
            animT += dt;
            if (phase === "typing") {
                // The clock only runs while typing, and the loop is stopped
                // while paused — so a pause can never inflate elapsed time.
                elapsed += dt;
                caretPhase += dt;
            }
            draw();
        }

        // ── Interface ──────────────────────────────────────────────────────

        return {
            // `saved` is always null — the game is registered ephemeral, so
            // the hub never restores one.
            init(container) {
                const made = ctx.canvas();
                el = made.el;
                g  = made.g;
                container.appendChild(el);

                resetCounters();
                text = "";
                phase = "loading";

                loop = ctx.loop(frame);
                loop.start();
                mountSelect();
                startWithStoredLang();

                scoreCb?.(0);
            },

            // Always null: a drill is a timed run against a paragraph that
            // was fetched for this sitting. Freezing it half-typed and
            // handing it back later would resume a stopwatch the typist has
            // long stopped thinking about, so leaving the game ends the run
            // outright — see `ephemeral` in the registration below.
            getState() { return null; },

            // Never pauses. The clock only accrues in the `typing` phase and
            // rAF stops delivering frames to a hidden popup anyway, so there
            // is nothing a pause would protect — and a pause screen over a
            // typing drill would cover the paragraph.
            pause() { return null; },

            resume() {},

            destroy() {
                token += 1;          // orphan any in-flight fetch
                loop?.stop();
                loop = null;
                // The select lives in the hub's control slot; the hub clears
                // that on teardown, so only the reference is dropped here.
                select = null;
                el?.remove();
                el = null; g = null;
            },

            onScore(cb) { scoreCb = cb; },

            isOver() { return phase === "done"; },

            handleKey(e) {
                // Shortcuts belong to the browser, not the drill.
                if (e.ctrlKey || e.metaKey || e.altKey) return;

                if (phase === "loading") return;

                if (phase === "done") {
                    resetCounters();
                    ctx.setDetail("");
                    scoreCb?.(0);
                    loadDrill({ useNext: true });
                    return;
                }

                if (e.key === "Backspace") {
                    if (phase === "typing") backspace();
                    return;
                }

                // Everything else has to be a single printable character —
                // Tab, Enter, F-keys and the arrows are not drill input.
                if (e.key.length !== 1) return;

                if (phase === "ready") {
                    phase = "typing";
                    caretPhase = 0;
                }
                typeChar(e.key);
            },
        };

        // Reads the stored language before anything is fetched, so the
        // picker and the drill agree from the very first frame. Declared
        // below the returned interface for readability; it's hoisted.
        function startWithStoredLang() {
            chrome.storage.local
                .get(LANG_KEY)
                .then((s) => {
                    const stored = s?.[LANG_KEY];
                    if (LANGS.some((l) => l.code === stored)) lang = stored;
                })
                .catch(() => {})
                .then(() => {
                    if (!el) return;              // destroyed while reading
                    // The picker was mounted before this read resolved, so
                    // it is still showing the default language.
                    if (select) select.value = lang;
                    loadDrill();
                });
        }
    }

    window.__Arcade.register({
        id: "typing",
        nameKey: "arcadeGameTyping",
        realtime: true,
        // The run belongs to the sitting: leaving the game (or the arcade)
        // ends the drill rather than freezing a stopwatch for later. The hub
        // therefore never restores one and never puts up a pause prompt.
        ephemeral: true,
        saveVersion: 1,
        create,
    });
})();
