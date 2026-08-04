// The live design card.
//
// Injected alongside elementHighlighter.js in design mode. The highlighter owns
// targeting (DOM walk, same-rect collapsing, keyboard); this file owns the card
// that follows it. The two meet at one global — window.__DesignInspector —
// whose onTarget/onCommit/onRelease the highlighter calls. That is deliberately
// the entire contract: forking the highlighter for a second mode would mean
// maintaining its tree navigation twice.
//
// Two costs shape everything below:
//
//   1. The scan runs on every hover, so it must stay cheap. CSS colours and
//      fonts are a getComputedStyle sweep over a capped subtree — single-digit
//      ms — and that is all that runs on hover.
//   2. The rendered palette is sampled from a screenshot, which is async and
//      quota-limited (chrome.tabs.captureVisibleTab is throttled to ~2/sec).
//      So it runs on freeze only, never on hover, and lands in a card that has
//      already stopped moving.
(function () {
    if (window.__DesignInspectorDestroy) window.__DesignInspectorDestroy();

    // ─── Tunables ────────────────────────────────────────────────────────────
    // MAX_NODES caps the hover sweep. Hovering <body> on a large page would
    // otherwise walk tens of thousands of nodes on every pointer move; a
    // component's palette is fully described long before this.
    const MAX_NODES = 1400;
    const MIN_TEXT_LEN = 1;
    const CARD_GAP = 16;
    const HOST_ID = "__ds-inspector";

    let strings = {};
    let session = null;      // {deviceMetrics, screenshotSuffix}
    let frozen = false;
    let currentEl = null;
    let currentScan = null;
    let rasterToken = 0;

    // Colours the user grabbed with the eyedropper. Session-scoped rather than
    // per-element on purpose: the picker reads pixels from anywhere on screen,
    // including outside the page, so what it collects isn't a property of
    // whichever element happens to be selected. Walking to another element
    // must not throw the collection away.
    const pickedColors = [];

    // Items the user has struck off the card, keyed per element so curating
    // one component doesn't affect another. Kept as keys rather than by
    // splicing the arrays because the scan re-runs (on freeze, and after a
    // page mutation) and a spliced entry would simply come back.
    const removedKeys = new WeakMap();

    function removedFor(el) {
        let set = removedKeys.get(el);
        if (!set) {
            set = new Set();
            removedKeys.set(el, set);
        }
        return set;
    }

    // Namespaced so a hex removed from the CSS palette doesn't also vanish
    // from the rendered one — they're different claims about the same colour.
    const colorKey = (c) => `color:${c.css}`;
    const fontKey = (f) => `font:${f.resolved}|${f.source}`;
    const rasterKey = (s) => `raster:${s.hex}`;

    function isRemoved(el, key) {
        return el ? removedFor(el).has(key) : false;
    }

    // What the card shows and what the export contains, after curation.
    function visible(scan, raster) {
        const el = currentEl;
        return {
            families: (scan?.families || []).filter(
                (f) => !isRemoved(el, fontKey(f))
            ),
            colors: (scan?.colors || []).filter(
                (c) => !isRemoved(el, colorKey(c))
            ),
            swatches: (raster?.swatches || []).filter(
                (s) => !isRemoved(el, rasterKey(s))
            ),
        };
    }

    const t = (key, fallback) => strings[key] || fallback;

    // ─── Colour normalization ────────────────────────────────────────────────
    // Round-trip through a canvas fillStyle: assigning resolves any CSS colour
    // syntax — oklch(), color(), named keywords — to "#rrggbb" or "rgba(...)".
    // One code path, total coverage.
    //
    // Assigning an *invalid* colour is a silent no-op that leaves the previous
    // value in place, so a single-sentinel probe reports that sentinel as a
    // successful parse. Two sentinels disambiguate: only a real colour yields
    // the same answer from both.
    const probeCtx = document.createElement("canvas").getContext("2d");

    function resolveCssColor(v) {
        if (!v) return null;
        try {
            probeCtx.fillStyle = "#000000";
            probeCtx.fillStyle = v;
            const first = probeCtx.fillStyle;
            probeCtx.fillStyle = "#ffffff";
            probeCtx.fillStyle = v;
            return first === probeCtx.fillStyle ? first : null;
        } catch {
            return null;
        }
    }

    function parseColor(value) {
        const resolved = resolveCssColor(value);
        if (!resolved) return null;
        if (resolved.startsWith("#")) {
            const n = parseInt(resolved.slice(1), 16);
            return {
                r: (n >> 16) & 255,
                g: (n >> 8) & 255,
                b: n & 255,
                a: 1,
                hex: resolved.toUpperCase(),
            };
        }
        const m = resolved.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
        const [r, g, b] = parts;
        const a = parts.length > 3 ? parts[3] : 1;
        if (a === 0) return null; // fully transparent contributes nothing
        return { r, g, b, a, hex: toHex(r, g, b) };
    }

    function toHex(r, g, b) {
        const h = (n) =>
            Math.max(0, Math.min(255, Math.round(n)))
                .toString(16)
                .padStart(2, "0");
        return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
    }

    function colorCss(c) {
        return c.a < 1
            ? `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})`
            : c.hex;
    }

    function luminance(c) {
        const ch = (v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
    }

    // Pulls every colour literal out of a compound value. Gradient stops and
    // shadow colours are authored values that never surface as a computed
    // background-color, so a scan reading only the plain colour properties
    // misses the entire palette of a gradient-heavy or shadow-heavy component.
    const COLOR_LITERAL_RE =
        /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|color\([^)]*\))/gi;

    function extractColors(value) {
        if (!value) return [];
        const out = [];
        COLOR_LITERAL_RE.lastIndex = 0;
        let m;
        while ((m = COLOR_LITERAL_RE.exec(value)) !== null) {
            const c = parseColor(m[1]);
            if (c) out.push(c);
        }
        return out;
    }

    // ─── Font resolution ─────────────────────────────────────────────────────
    //
    // getComputedStyle hands back the declared *stack*, not the face that
    // actually rendered. A page asking for "Inter, system-ui, sans-serif" where
    // Inter never loaded would otherwise be reported as Inter — confidently
    // wrong, and precisely the thing this card exists to answer.
    //
    // document.fonts.check() resolves it: walk the stack left to right and take
    // the first family the browser can actually serve. Generic families always
    // answer true, so the walk always terminates.
    const fontCheckCache = new Map();

    function familyAvailable(family, weight, size) {
        const key = `${weight}|${size}|${family}`;
        if (fontCheckCache.has(key)) return fontCheckCache.get(key);
        let ok = false;
        try {
            ok = document.fonts.check(`${weight} ${size}px ${family}`);
        } catch {
            ok = false;
        }
        fontCheckCache.set(key, ok);
        return ok;
    }

    function splitStack(stackStr) {
        // Split on commas outside quotes, then strip the quotes.
        return String(stackStr || "")
            .split(/,(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    function bareName(family) {
        return family.replace(/^["']|["']$/g, "");
    }

    const GENERIC = new Set([
        "serif", "sans-serif", "monospace", "cursive", "fantasy",
        "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace",
        "ui-rounded", "math", "emoji", "fangsong",
    ]);

    // Everything the page successfully loaded as a webfont. Gives the card the
    // webfont-vs-installed distinction, which DevTools doesn't surface and
    // which decides whether a designer can actually use the font.
    function loadedWebfonts() {
        const set = new Set();
        try {
            document.fonts.forEach((face) => {
                if (face.status === "loaded") set.add(bareName(face.family).toLowerCase());
            });
        } catch { /* FontFaceSet unavailable */ }
        return set;
    }

    function resolveStack(stackStr, weight, size, webfonts) {
        const families = splitStack(stackStr);
        for (const family of families) {
            const name = bareName(family);
            if (GENERIC.has(name.toLowerCase())) {
                return { resolved: name, source: "generic", families };
            }
            if (familyAvailable(family, weight, size)) {
                return {
                    resolved: name,
                    source: webfonts.has(name.toLowerCase()) ? "webfont" : "local",
                    families,
                };
            }
        }
        return {
            resolved: families.length ? bareName(families[families.length - 1]) : "—",
            source: "unresolved",
            families,
        };
    }

    // ─── Scan ────────────────────────────────────────────────────────────────

    function hasOwnText(el) {
        for (const node of el.childNodes) {
            if (node.nodeType === 3 && node.textContent.trim().length >= MIN_TEXT_LEN) {
                return true;
            }
        }
        return false;
    }

    function isOurNode(el) {
        const id = el.id;
        return id === HOST_ID || id === "__hl-overlay" || id === "__hl-style";
    }

    function scan(root) {
        const webfonts = loadedWebfonts();
        const colors = new Map();   // css string -> {..., count, roles}
        const fonts = new Map();    // signature -> font entry
        let count = 0;
        let truncated = false;
        let imageCount = 0;

        const note = (c, role) => {
            if (!c) return;
            const css = colorCss(c);
            let entry = colors.get(css);
            if (!entry) {
                entry = {
                    css,
                    hex: c.hex,
                    alpha: +c.a.toFixed(3),
                    luminance: luminance(c),
                    count: 0,
                    roles: {},
                };
                colors.set(css, entry);
            }
            entry.count++;
            entry.roles[role] = (entry.roles[role] || 0) + 1;
        };

        const walk = (el) => {
            if (count >= MAX_NODES) {
                truncated = true;
                return;
            }
            if (isOurNode(el)) return;
            count++;

            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") return;

            const tag = el.tagName.toLowerCase();
            const textual = hasOwnText(el);

            if (textual) note(parseColor(cs.color), "text");
            note(parseColor(cs.backgroundColor), "background");

            for (const side of ["Top", "Right", "Bottom", "Left"]) {
                if (parseFloat(cs[`border${side}Width`]) > 0
                    && cs[`border${side}Style`] !== "none") {
                    note(parseColor(cs[`border${side}Color`]), "border");
                }
            }
            if (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== "none") {
                note(parseColor(cs.outlineColor), "outline");
            }

            const bgImage = cs.backgroundImage;
            if (bgImage && bgImage !== "none") {
                for (const c of extractColors(bgImage)) note(c, "gradient");
                if (bgImage.indexOf("url(") !== -1) imageCount++;
            }
            if (tag === "img" || tag === "picture" || tag === "video"
                || tag === "canvas") {
                imageCount++;
            }

            // SVG paints through fill/stroke rather than color/background-color
            // — but `fill` computes to black on *every* element, SVG or not, so
            // reading it unconditionally would stamp #000000 onto the palette
            // of every component on the web.
            if (el instanceof SVGElement) {
                if (cs.fill && cs.fill !== "none") note(parseColor(cs.fill), "fill");
                if (cs.stroke && cs.stroke !== "none") {
                    note(parseColor(cs.stroke), "stroke");
                }
            }

            if (cs.boxShadow && cs.boxShadow !== "none") {
                for (const c of extractColors(cs.boxShadow)) note(c, "shadow");
            }

            if (textual) {
                const size = Math.round(parseFloat(cs.fontSize) || 16);
                const weight = cs.fontWeight || "400";
                const sig = `${cs.fontFamily}|${weight}|${size}|${cs.fontStyle}`;
                let entry = fonts.get(sig);
                if (!entry) {
                    const r = resolveStack(cs.fontFamily, weight, size, webfonts);
                    entry = {
                        resolved: r.resolved,
                        source: r.source,
                        stack: r.families.map(bareName),
                        weight,
                        size,
                        style: cs.fontStyle,
                        lineHeight: cs.lineHeight,
                        letterSpacing: cs.letterSpacing,
                        color: parseColor(cs.color)
                            ? colorCss(parseColor(cs.color))
                            : null,
                        count: 0,
                        sample: "",
                    };
                    fonts.set(sig, entry);
                }
                entry.count++;
                if (!entry.sample) {
                    entry.sample = (el.textContent || "").trim().slice(0, 60);
                }
            }

            for (const child of el.children) {
                if (count >= MAX_NODES) {
                    truncated = true;
                    break;
                }
                walk(child);
            }
        };

        walk(root);

        const colorList = [...colors.values()].sort((a, b) => b.count - a.count);
        for (const c of colorList) {
            c.role = Object.keys(c.roles).sort(
                (a, b) => c.roles[b] - c.roles[a]
            )[0] || "";
        }

        // Families deduplicated for the headline list, sizes kept as detail —
        // "which fonts is this built from" is the question, not "list every
        // size permutation".
        const familyMap = new Map();
        for (const f of fonts.values()) {
            const key = `${f.resolved}|${f.source}`;
            let fam = familyMap.get(key);
            if (!fam) {
                fam = {
                    resolved: f.resolved,
                    source: f.source,
                    stack: f.stack,
                    count: 0,
                    styles: [],
                };
                familyMap.set(key, fam);
            }
            fam.count += f.count;
            fam.styles.push(f);
        }
        const families = [...familyMap.values()].sort((a, b) => b.count - a.count);
        for (const fam of families) {
            fam.styles.sort((a, b) => b.size - a.size || b.count - a.count);
        }

        return {
            role: guessRole(root),
            selector: buildSelector(root),
            families,
            typeStyles: [...fonts.values()].sort(
                (a, b) => b.size - a.size || b.count - a.count
            ),
            colors: colorList,
            nodeCount: count,
            truncated,
            imageCount,
            url: location.href,
            title: document.title,
        };
    }

    function guessRole(el) {
        const tag = el.tagName.toLowerCase();
        const explicit = (el.getAttribute("role") || "").toLowerCase();
        if (explicit) return explicit;
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "input" || tag === "textarea" || tag === "select") return "input";
        if (tag === "img" || tag === "picture" || tag === "svg") return "image";
        if (tag === "nav") return "navigation";
        if (tag === "header") return "header";
        if (tag === "footer") return "footer";
        if (/^h[1-6]$/.test(tag)) return "heading";
        const hint = `${typeof el.className === "string" ? el.className : ""} ${el.id || ""}`
            .toLowerCase();
        if (/\bbtn\b|button/.test(hint)) return "button";
        if (/\bcard\b/.test(hint)) return "card";
        if (/\bbadge\b|\bchip\b|\btag\b|\bpill\b/.test(hint)) return "badge";
        if (/\bmodal\b|\bdialog\b/.test(hint)) return "dialog";
        if (/\bhero\b|\bbanner\b/.test(hint)) return "banner";
        return "container";
    }

    function buildSelector(el) {
        const tag = el.tagName.toLowerCase();
        if (el.id) return `${tag}#${el.id}`;
        const cls =
            typeof el.className === "string" && el.className
                ? el.className.trim().split(/\s+/).slice(0, 2)
                : [];
        return cls.length ? `${tag}.${cls.join(".")}` : tag;
    }

    // ─── Card ────────────────────────────────────────────────────────────────
    //
    // Shadow root: the card sits inside arbitrary pages, and a page stylesheet
    // that styles `div` or `button` globally would otherwise reshape it.

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
        "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;" +
        "pointer-events: none;";
    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
        <style>
            :host { all: initial; }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            .card {
                position: fixed;
                width: 300px;
                max-height: calc(100vh - 24px);
                overflow-y: auto;
                overflow-x: hidden;
                font: 400 12px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
                color: #E8EEF7;
                background: rgba(11, 18, 32, 0.97);
                border: 1px solid rgba(168, 85, 247, 0.55);
                border-radius: 10px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.55),
                            0 0 0 1px rgba(0, 0, 0, 0.35);
                padding: 12px;
                opacity: 0;
                transition: opacity 140ms ease-out, left 180ms ease-out,
                            top 180ms ease-out;
                scrollbar-width: thin;
            }
            .card.on { opacity: 1; }
            .card.frozen {
                border-color: #A855F7;
                box-shadow: 0 10px 44px rgba(0, 0, 0, 0.6),
                            0 0 0 1px rgba(168, 85, 247, 0.35),
                            0 0 22px rgba(168, 85, 247, 0.28);
            }
            .head {
                display: flex; align-items: baseline; gap: 8px;
                margin-bottom: 10px;
            }
            .role {
                font-weight: 700; font-size: 14px; letter-spacing: 0.01em;
                text-transform: capitalize;
            }
            .sel {
                font: 500 10px/1 ui-monospace, "Cascadia Mono", Menlo, monospace;
                color: #7E8CA3; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap; flex: 1; text-align: right;
            }
            .sec { margin-top: 12px; }
            .sec:first-of-type { margin-top: 0; }
            .sec-t {
                display: flex; align-items: center; gap: 8px;
                font: 700 9.5px/1 -apple-system, "Segoe UI", Arial, sans-serif;
                letter-spacing: 0.13em; color: #6B7A91;
                text-transform: uppercase; margin-bottom: 7px;
            }
            .sec-t::after {
                content: ""; flex: 1; height: 1px;
                background: rgba(255, 255, 255, 0.08);
            }
            .sec-t .n { color: #47536A; letter-spacing: 0.04em; }

            .font-row { margin-bottom: 9px; }
            .font-name {
                display: flex; align-items: center; gap: 6px;
                font-size: 13px; font-weight: 600;
            }
            .badge {
                font: 700 8.5px/1 -apple-system, "Segoe UI", Arial, sans-serif;
                letter-spacing: 0.08em; text-transform: uppercase;
                padding: 2.5px 5px; border-radius: 3px; flex: none;
            }
            .badge.webfont { background: rgba(168,85,247,.22); color: #D8B4FE; }
            .badge.local   { background: rgba(148,163,184,.18); color: #A9B6C9; }
            .badge.generic { background: rgba(148,163,184,.12); color: #7E8CA3; }
            .badge.unresolved { background: rgba(248,113,113,.18); color: #FCA5A5; }
            .font-stack {
                font: 400 10px/1.4 ui-monospace, Menlo, monospace;
                color: #5D6B82; margin-top: 2px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .font-sizes {
                font: 500 10px/1.4 ui-monospace, Menlo, monospace;
                color: #8B99AE; margin-top: 3px;
            }

            /* Remove buttons only exist on a frozen card — while hovering, the
               card isn't hit-testable at all, so an always-visible x would be
               a control that looks live and isn't. */
            .rm {
                position: absolute; top: -5px; right: -5px;
                width: 14px; height: 14px; border-radius: 50%;
                border: 1px solid rgba(255,255,255,.2);
                background: #1B2438; color: #C7D2E1;
                font: 700 9px/1 -apple-system, "Segoe UI", Arial, sans-serif;
                display: none; align-items: center; justify-content: center;
                cursor: pointer; padding: 0; z-index: 3;
            }
            .rm:hover { background: #DC2626; color: #fff; border-color: #DC2626; }
            .frozen .sw:hover .rm,
            .frozen .picked-sw:hover .rm { display: flex; }

            /* On rows there's horizontal room, so the x sits inline at the end
               rather than overlapping the content. */
            .rm--row {
                position: static; width: 15px; height: 15px; flex: none;
                display: flex; opacity: 0; margin-left: 6px;
            }
            .frozen .font-row:hover .rm--row,
            .frozen .bar:hover .rm--row { opacity: 1; }

            .swatches { display: flex; flex-wrap: wrap; gap: 5px; }
            .sw {
                width: 30px; height: 30px; border-radius: 5px; cursor: pointer;
                border: 1px solid rgba(255,255,255,.14); position: relative;
                flex: none; transition: transform 90ms ease-out;
                background-image:
                    linear-gradient(45deg, #444 25%, transparent 25%),
                    linear-gradient(-45deg, #444 25%, transparent 25%),
                    linear-gradient(45deg, transparent 75%, #444 75%),
                    linear-gradient(-45deg, transparent 75%, #444 75%);
                background-size: 8px 8px;
                background-position: 0 0, 0 4px, 4px -4px, -4px 0px;
            }
            .sw i {
                position: absolute; inset: 0; border-radius: 4px; display: block;
            }
            .frozen .sw:hover { transform: scale(1.14); z-index: 2; }

            /* The rendered palette is sampled from pixels, not read from CSS.
               Pasting a photo's average brown into a stylesheet as a brand
               token is a real foot-gun, so it never shares a shape or a row
               with the CSS swatches: wide bars, coverage percentages, its own
               titled section. */
            .bars { display: flex; flex-direction: column; gap: 3px; }
            .bar {
                display: flex; align-items: center; gap: 7px; cursor: pointer;
                padding: 2px 3px; border-radius: 4px;
            }
            .frozen .bar:hover { background: rgba(255,255,255,.06); }
            .bar .chip {
                width: 46px; height: 15px; border-radius: 3px; flex: none;
                border: 1px solid rgba(255,255,255,.14);
            }
            .bar .hx {
                font: 500 10px/1 ui-monospace, Menlo, monospace; color: #C7D2E1;
            }
            .bar .pc {
                margin-left: auto; font: 500 10px/1 ui-monospace, Menlo, monospace;
                color: #5D6B82;
            }
            .raster-note {
                font-size: 10px; color: #5D6B82; margin-top: 6px; line-height: 1.4;
            }

            /* The picked palette is the user's own collection, so it gets the
               accent treatment the two measured sections deliberately don't:
               a tinted panel marking it as authored rather than observed. */
            .picked {
                background: rgba(168, 85, 247, .1);
                border: 1px solid rgba(168, 85, 247, .28);
                border-radius: 7px; padding: 8px;
            }
            .picked-list { display: flex; flex-wrap: wrap; gap: 5px; }
            .picked-sw {
                width: 34px; height: 34px; border-radius: 5px; cursor: pointer;
                border: 1px solid rgba(255,255,255,.2); position: relative;
                flex: none; transition: transform 90ms ease-out;
            }
            .frozen .picked-sw:hover { transform: scale(1.1); z-index: 2; }
            .picked-hint {
                font-size: 9.5px; color: #8B6BB8; margin-top: 7px;
                line-height: 1.4;
            }
            .spin {
                display: flex; align-items: center; gap: 7px;
                font-size: 10.5px; color: #6B7A91; padding: 3px 0;
            }
            .spin::before {
                content: ""; width: 10px; height: 10px; border-radius: 50%;
                border: 1.5px solid rgba(168,85,247,.3);
                border-top-color: #A855F7; animation: sp .7s linear infinite;
            }
            @keyframes sp { to { transform: rotate(360deg); } }

            .foot {
                display: flex; gap: 6px; margin-top: 13px; padding-top: 11px;
                border-top: 1px solid rgba(255,255,255,.08);
            }
            .btn {
                font: 600 11px/1 -apple-system, "Segoe UI", Arial, sans-serif;
                border-radius: 6px; padding: 8px 10px; cursor: pointer;
                border: 1px solid rgba(255,255,255,.14);
                background: rgba(255,255,255,.05); color: #C7D2E1;
                display: flex; align-items: center; justify-content: center;
                gap: 6px;
            }
            .btn:hover { background: rgba(255,255,255,.1); color: #fff; }
            .btn.primary {
                flex: 1; background: #A855F7; border-color: #A855F7; color: #fff;
            }
            .btn.primary:hover { background: #9333EA; }
            .btn.primary:disabled { opacity: .55; cursor: default; }
            .btn svg { width: 13px; height: 13px; flex: none; }

            .hint {
                font-size: 10px; color: #5D6B82; margin-top: 8px;
                text-align: center; line-height: 1.4;
            }
            .toast {
                position: fixed; padding: 5px 9px; border-radius: 5px;
                background: #A855F7; color: #fff;
                font: 700 10.5px/1 -apple-system, "Segoe UI", Arial, sans-serif;
                letter-spacing: .04em; pointer-events: none; opacity: 0;
                transition: opacity 120ms ease-out, transform 180ms ease-out;
                transform: translateY(4px); z-index: 5;
            }
            .toast.on { opacity: 1; transform: translateY(-4px); }
            .empty { font-size: 10.5px; color: #5D6B82; }
        </style>
        <div class="card" part="card"></div>
        <div class="toast"></div>
    `;

    const cardEl = shadow.querySelector(".card");
    const toastEl = shadow.querySelector(".toast");
    document.documentElement.appendChild(host);

    function esc(s) {
        return String(s).replace(/[&<>"]/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
        );
    }

    // ─── Render ──────────────────────────────────────────────────────────────

    // The little x. Rendered only on a frozen card: while hovering, the card
    // isn't hit-testable, so an x that looked pressable but wasn't would be a
    // lie about the interface.
    function rmBtn(key, row) {
        if (!frozen) return "";
        return (
            `<button class="rm${row ? " rm--row" : ""}" data-remove="${esc(key)}"` +
            ` title="${esc(t("remove", "Remove"))}"` +
            ` aria-label="${esc(t("remove", "Remove"))}">×</button>`
        );
    }

    function renderCard(data, raster) {
        const parts = [];
        const view = visible(data, raster && raster.swatches ? raster : null);

        parts.push(`
            <div class="head">
                <span class="role">${esc(data.role)}</span>
                <span class="sel">${esc(data.selector)}</span>
            </div>
        `);

        // Fonts
        parts.push(`<div class="sec"><div class="sec-t">${esc(t("fonts", "Fonts"))}` +
            `<span class="n">${view.families.length}</span></div>`);
        if (!view.families.length) {
            parts.push(
                `<div class="empty">${esc(
                    data.families.length
                        ? t("allRemoved", "All removed.")
                        : t("noText", "No text in this element.")
                )}</div>`
            );
        } else {
            for (const fam of view.families.slice(0, 4)) {
                const sizes = fam.styles
                    .slice(0, 4)
                    .map((s) => `${s.size}/${normLh(s.lineHeight)} · ${s.weight}`)
                    .join("   ");
                parts.push(`
                    <div class="font-row">
                        <div class="font-name">
                            <span>${esc(fam.resolved)}</span>
                            <span class="badge ${fam.source}">${esc(sourceLabel(fam.source))}</span>
                            ${rmBtn(fontKey(fam), true)}
                        </div>
                        <div class="font-sizes">${esc(sizes)}</div>
                        <div class="font-stack" title="${esc(fam.stack.join(", "))}">${esc(fam.stack.join(", "))}</div>
                    </div>
                `);
            }
        }
        parts.push(`</div>`);

        // CSS colours
        parts.push(`<div class="sec"><div class="sec-t">${esc(t("cssColors", "CSS colours"))}` +
            `<span class="n">${view.colors.length}</span></div>`);
        if (!view.colors.length) {
            parts.push(
                `<div class="empty">${esc(
                    data.colors.length
                        ? t("allRemoved", "All removed.")
                        : t("noColors", "No colours declared.")
                )}</div>`
            );
        } else {
            parts.push(`<div class="swatches">`);
            for (const c of view.colors.slice(0, 24)) {
                parts.push(
                    `<span class="sw" data-copy="${esc(c.css)}"` +
                    ` title="${esc(c.css)} · ${esc(c.role)} · ×${c.count}">` +
                    `<i style="background:${esc(c.css)}"></i>` +
                    rmBtn(colorKey(c)) +
                    `</span>`
                );
            }
            parts.push(`</div>`);
        }
        parts.push(`</div>`);

        // Rendered palette — sampled, deliberately a different shape.
        parts.push(`<div class="sec"><div class="sec-t">${esc(t("rendered", "Rendered palette"))}</div>`);
        if (raster === "loading") {
            parts.push(`<div class="spin">${esc(t("sampling", "Sampling pixels…"))}</div>`);
        } else if (raster === "idle") {
            parts.push(`<div class="empty">${esc(t("rasterOnClick", "Click the element to sample."))}</div>`);
        } else if (raster && raster.error) {
            parts.push(`<div class="empty">${esc(raster.error)}</div>`);
        } else if (view.swatches.length) {
            parts.push(`<div class="bars">`);
            for (const s of view.swatches) {
                parts.push(`
                    <div class="bar" data-copy="${esc(s.hex)}" title="${esc(s.hex)}">
                        <span class="chip" style="background:${esc(s.hex)}"></span>
                        <span class="hx">${esc(s.hex)}</span>
                        <span class="pc">${s.share}%</span>
                        ${rmBtn(rasterKey(s), true)}
                    </div>
                `);
            }
            parts.push(`</div>`);
            parts.push(
                `<div class="raster-note">${esc(
                    t("rasterNote", "Averaged from the captured pixels — includes images, video and gradients. Not CSS values.")
                )}</div>`
            );
        } else if (raster && raster.swatches && raster.swatches.length) {
            parts.push(`<div class="empty">${esc(t("allRemoved", "All removed."))}</div>`);
        } else {
            parts.push(`<div class="empty">${esc(t("rasterNone", "Nothing to sample."))}</div>`);
        }
        parts.push(`</div>`);

        // Picked palette — only present once the eyedropper has been used, so
        // the card doesn't carry an empty section around waiting for it.
        if (pickedColors.length) {
            parts.push(
                `<div class="sec"><div class="sec-t">${esc(t("picked", "User pick"))}` +
                `<span class="n">${pickedColors.length}</span></div>` +
                `<div class="picked"><div class="picked-list">`
            );
            for (const hex of pickedColors) {
                parts.push(
                    `<span class="picked-sw" data-copy="${esc(hex)}"` +
                    ` style="background:${esc(hex)}" title="${esc(hex)}">` +
                    rmBtn(`picked:${hex}`) +
                    `</span>`
                );
            }
            parts.push(`</div>`);
            parts.push(
                `<div class="picked-hint">${esc(
                    t("pickedNote", "Picked with the eyedropper. Saved with the card when you capture.")
                )}</div>`
            );
            parts.push(`</div></div>`);
        }

        if (frozen) {
            parts.push(`
                <div class="foot">
                    <button class="btn" data-act="eyedrop" title="${esc(t("pick", "Pick a colour"))}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/>
                            <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>
                        </svg>
                    </button>
                    <button class="btn primary" data-act="capture">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/>
                            <circle cx="12" cy="13" r="3"/>
                        </svg>
                        ${esc(t("capture", "Capture element + card"))}
                    </button>
                </div>
                <div class="hint">${esc(t("frozenHint", "Click a swatch to copy · Esc to pick another"))}</div>
            `);
        } else {
            parts.push(
                `<div class="hint">${esc(t("hoverHint", "Click to freeze this card"))}</div>`
            );
        }

        cardEl.innerHTML = parts.join("");
        cardEl.classList.toggle("frozen", frozen);
        cardEl.classList.add("on");
    }

    function sourceLabel(source) {
        if (source === "webfont") return t("srcWebfont", "webfont");
        if (source === "local") return t("srcLocal", "installed");
        if (source === "generic") return t("srcGeneric", "generic");
        return t("srcMissing", "not loaded");
    }

    // Computed line-height is the keyword "normal" when unset, which is a real
    // answer and must not be rendered as NaN.
    function normLh(lh) {
        const n = parseFloat(lh);
        return isFinite(n) ? String(Math.round(n)) : "normal";
    }

    // ─── Placement ───────────────────────────────────────────────────────────
    // Right of the element if it fits, else left, else pinned to whichever
    // side has more room. Never over the element — the card exists to describe
    // something the user is still looking at.
    let placedOnce = false;

    function placeCard(rect) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const cw = cardEl.offsetWidth || 300;
        const chH = cardEl.offsetHeight || 200;

        // left/top are transitioned so the card glides between elements as the
        // user walks the tree. On the very first placement there is nothing to
        // glide from — the card would slide in from the viewport's top-left
        // corner — so the first assignment is made without one.
        if (!placedOnce) {
            placedOnce = true;
            cardEl.style.transition = "none";
            requestAnimationFrame(() => {
                cardEl.style.transition = "";
            });
        }

        let left;
        if (rect.right + CARD_GAP + cw <= vw - 8) left = rect.right + CARD_GAP;
        else if (rect.left - CARD_GAP - cw >= 8) left = rect.left - CARD_GAP - cw;
        else if (vw - rect.right > rect.left) left = Math.max(8, vw - cw - 8);
        else left = 8;

        let top = rect.top + rect.height / 2 - chH / 2;
        top = Math.max(8, Math.min(top, vh - chH - 8));

        cardEl.style.left = `${Math.round(left)}px`;
        cardEl.style.top = `${Math.round(top)}px`;
    }

    // ─── Raster sampling ─────────────────────────────────────────────────────
    //
    // The screenshot is taken by the service worker via
    // chrome.tabs.captureVisibleTab, which photographs the whole visible
    // viewport — including the highlighter's backdrop dim (rgba black at 45%)
    // and this card. Both must be out of the frame or every sampled colour is
    // wrong. Hidden for the two frames the capture needs, then restored.
    async function sampleRaster(el) {
        const token = ++rasterToken;
        const rect = el.getBoundingClientRect();

        const clip = {
            x: Math.max(0, rect.left),
            y: Math.max(0, rect.top),
            width: Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left),
            height: Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top),
        };
        if (clip.width < 2 || clip.height < 2) {
            return { error: t("rasterOffscreen", "Element is off-screen — scroll it into view.") };
        }

        const overlay = document.getElementById("__hl-overlay");
        host.style.visibility = "hidden";
        if (overlay) overlay.style.visibility = "hidden";

        try {
            await new Promise((r) =>
                requestAnimationFrame(() => requestAnimationFrame(r))
            );
            const res = await chrome.runtime.sendMessage({
                action: "designSampleRaster",
                clip,
                // The worker derives its scale factor from the captured
                // bitmap's width against this, not from devicePixelRatio —
                // browser zoom moves the two apart.
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                },
            });
            if (token !== rasterToken) return null;
            if (!res || !res.ok) {
                return { error: res?.error || t("rasterFailed", "Could not sample pixels.") };
            }
            return { swatches: res.swatches };
        } catch (e) {
            return { error: e?.message || String(e) };
        } finally {
            host.style.visibility = "";
            if (overlay) overlay.style.visibility = "";
        }
    }

    // ─── Copy / eyedropper ───────────────────────────────────────────────────

    let toastTimer = null;
    function toast(text, x, y) {
        toastEl.textContent = text;
        toastEl.style.left = `${x}px`;
        toastEl.style.top = `${y}px`;
        toastEl.classList.add("on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove("on"), 900);
    }

    async function copyText(text, x, y) {
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch {
            // Clipboard API needs focus + a secure context; a plain page click
            // usually satisfies both, but execCommand is the reliable floor.
            try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
                document.body.appendChild(ta);
                ta.select();
                ok = document.execCommand("copy");
                ta.remove();
            } catch { /* give up */ }
        }
        toast(
            ok ? `${text} ${t("copied", "copied")}` : t("copyFailed", "Copy failed"),
            x, y
        );
    }

    async function runEyedropper() {
        if (!window.EyeDropper) {
            toast(t("noEyedropper", "Not supported here"), 40, 40);
            return;
        }
        // The OS picker paints over everything; our own overlay would otherwise
        // be the thing the user samples.
        const overlay = document.getElementById("__hl-overlay");
        host.style.visibility = "hidden";
        if (overlay) overlay.style.visibility = "hidden";
        try {
            const result = await new window.EyeDropper().open();
            host.style.visibility = "";
            if (overlay) overlay.style.visibility = "";
            const hex = String(result.sRGBHex).toUpperCase();

            // Newest first, and never twice — re-picking a colour you already
            // have should surface it, not grow the list.
            const dup = pickedColors.indexOf(hex);
            if (dup !== -1) pickedColors.splice(dup, 1);
            pickedColors.unshift(hex);

            renderCard(currentScan, lastRaster);
            if (currentEl) placeCard(currentEl.getBoundingClientRect());

            const r = cardEl.getBoundingClientRect();
            await copyText(hex, r.left + 20, r.bottom - 40);
        } catch {
            host.style.visibility = "";
            if (overlay) overlay.style.visibility = "";
        }
    }

    // ─── Capture ─────────────────────────────────────────────────────────────

    let capturing = false;

    async function runCapture(btn) {
        if (!currentEl || !currentScan || capturing) return;
        capturing = true;
        btn.disabled = true;
        const labelNode = btn.lastChild;
        if (labelNode) labelNode.textContent = ` ${t("capturing", "Capturing…")}`;

        // Same marker contract as element capture: emulation can rebuild the
        // subtree and invalidate a positional XPath, but the attribute rides
        // through any reflow that doesn't recreate the node. The capture side
        // strips it when the session ends.
        const marker =
            Date.now().toString(36) + Math.random().toString(36).slice(2);
        currentEl.setAttribute("data-sharpshooter-target", marker);

        // The export gets the curated card, not the raw scan — anything the
        // user struck off is gone from the artifact too, which is the whole
        // point of being able to strike things off.
        const view = visible(currentScan, lastRaster);

        const payload = {
            action: "designCapture",
            marker,
            xpath: getXPath(currentEl),
            scan: { ...currentScan, families: view.families, colors: view.colors },
            raster: view.swatches,
            picked: pickedColors.slice(),
            // The capture emulates *this* viewport rather than the popup's
            // resolution preset: the card's numbers describe the layout on
            // screen right now, and a screenshot of a different layout beside
            // them would be wrong in a way nobody could see. The preset's
            // quality multiplier still applies, as pixel density only.
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
            },
            deviceScaleFactor: session?.deviceMetrics?.deviceScaleFactor || 2,
        };

        // The element screenshot is a picture of what the site served, so the
        // extension's own furniture must be out of frame — the highlighter's
        // backdrop dim covers the whole viewport, and this card sits right
        // beside the element it is describing. Same discipline Legal Capture
        // applies before serializing a page: visually absent is not enough
        // when the artifact is the evidence.
        const overlay = document.getElementById("__hl-overlay");
        host.style.visibility = "hidden";
        if (overlay) overlay.style.visibility = "hidden";

        try {
            const res = await chrome.runtime.sendMessage(payload);
            if (res && res.ok) {
                destroy();
                return;
            }
            toast(res?.error || t("captureFailed", "Capture failed"), 40, 40);
        } catch (e) {
            toast(e?.message || String(e), 40, 40);
        } finally {
            if (document.getElementById(HOST_ID)) {
                host.style.visibility = "";
                if (overlay) overlay.style.visibility = "";
                capturing = false;
                currentEl.removeAttribute("data-sharpshooter-target");
                renderCard(currentScan, lastRaster);
                placeCard(currentEl.getBoundingClientRect());
            }
        }
    }

    // Mirrors elementHighlighter's own XPath builder — the capture side falls
    // back to it when the marker attribute has been stripped by the page.
    function getXPath(element) {
        if (element.id && !element.id.includes('"')) return `//*[@id="${element.id}"]`;
        if (element === document.body) return "/html/body";
        if (element === document.documentElement) return "/html";
        if (!element.parentNode) return null;
        let ix = 0;
        const siblings = element.parentNode.childNodes;
        for (const sibling of siblings) {
            if (sibling === element) {
                const parentPath = getXPath(element.parentNode);
                if (!parentPath) return null;
                return `${parentPath}/${element.tagName.toLowerCase()}[${ix + 1}]`;
            }
            if (sibling.nodeType === 1 && sibling.tagName === element.tagName) ix++;
        }
        return null;
    }

    // ─── Card interaction (frozen only) ──────────────────────────────────────

    function removeItem(key) {
        if (key.startsWith("picked:")) {
            const hex = key.slice(7);
            const i = pickedColors.indexOf(hex);
            if (i !== -1) pickedColors.splice(i, 1);
        } else if (currentEl) {
            removedFor(currentEl).add(key);
        }
        renderCard(currentScan, lastRaster);
        if (currentEl) placeCard(currentEl.getBoundingClientRect());
    }

    function onCardClick(e) {
        if (!frozen) return;
        e.stopPropagation();

        // Checked before [data-copy]: the x sits *inside* the swatch, so a
        // copy-first lookup would match the swatch and never remove anything.
        const rmEl = e.target.closest("[data-remove]");
        if (rmEl) {
            removeItem(rmEl.dataset.remove);
            return;
        }
        const copyEl = e.target.closest("[data-copy]");
        if (copyEl) {
            copyText(copyEl.dataset.copy, e.clientX + 10, e.clientY - 26);
            return;
        }
        const actEl = e.target.closest("[data-act]");
        if (!actEl) return;
        if (actEl.dataset.act === "eyedrop") runEyedropper();
        else if (actEl.dataset.act === "capture") runCapture(actEl);
    }
    cardEl.addEventListener("click", onCardClick);

    // The card is above the page; while picking it must not intercept the
    // pointer or hovering toward it would re-target onto the card itself.
    // Freezing is what makes it interactive.
    function setInteractive(on) {
        host.style.pointerEvents = on ? "auto" : "none";
    }

    // ─── Highlighter contract ────────────────────────────────────────────────

    let lastRaster = "idle";

    // Walking the tree revisits elements constantly — wheel up then back down,
    // or simply moving the pointer within one element, which the highlighter
    // reports once per frame. Re-scanning a subtree that hasn't changed is the
    // one thing that would make hovering feel heavy, so the result is cached
    // per element. Weak, so it can't outlive the nodes it describes.
    const scanCache = new WeakMap();

    function scanCached(el) {
        const hit = scanCache.get(el);
        if (hit) return hit;
        const fresh = scan(el);
        scanCache.set(el, fresh);
        return fresh;
    }

    function onTarget(el, rect) {
        if (frozen || !el) return;
        if (el === currentEl) return;
        currentEl = el;
        try {
            currentScan = scanCached(el);
        } catch (e) {
            console.warn("design scan failed:", e);
            return;
        }
        lastRaster = "idle";
        renderCard(currentScan, lastRaster);
        placeCard(rect || el.getBoundingClientRect());
    }

    async function onCommit(el, ctx) {
        if (frozen) return;
        frozen = true;
        currentEl = el;
        session = ctx || session;
        // Fresh, not cached: the page may have re-rendered since the hover
        // scan, and this is the reading the user is about to copy from.
        try {
            currentScan = scan(el);
            scanCache.set(el, currentScan);
        } catch { /* keep the last good scan */ }
        lastRaster = "loading";
        renderCard(currentScan, lastRaster);
        placeCard(el.getBoundingClientRect());
        setInteractive(true);

        const result = await sampleRaster(el);
        if (result === null) return;      // superseded
        lastRaster = result;
        renderCard(currentScan, lastRaster);
        placeCard(el.getBoundingClientRect());
    }

    // Esc while frozen returns to picking rather than tearing down — a frozen
    // card is a state the user chose, so the first Esc should undo that choice,
    // not the whole session.
    function onRelease() {
        if (!frozen) return false;
        frozen = false;
        rasterToken++;
        lastRaster = "idle";
        setInteractive(false);
        if (currentScan) renderCard(currentScan, lastRaster);
        return true;
    }

    function onReposition() {
        if (!currentEl) return;
        placeCard(currentEl.getBoundingClientRect());
    }

    function setStrings(next) {
        strings = next || {};
        if (currentScan) renderCard(currentScan, lastRaster);
    }

    function setSession(next) {
        session = next;
    }

    function isFrozen() {
        return frozen;
    }

    // The scan the card is currently showing. Nothing in the extension reads
    // this — it exists so the scanner can be exercised against a stubbed DOM,
    // which is the only way to test colour normalization and font resolution
    // outside a browser.
    function getScan() {
        return currentScan;
    }

    // ─── Teardown ────────────────────────────────────────────────────────────

    function destroy() {
        rasterToken++;
        clearTimeout(toastTimer);
        cardEl.removeEventListener("click", onCardClick);
        host.remove();
        delete window.__DesignInspector;
        delete window.__DesignInspectorDestroy;
        // Tear the picker down with the card: they are one session as far as
        // the user is concerned.
        if (window.__HighlighterDestroy) window.__HighlighterDestroy();
    }

    window.__DesignInspectorDestroy = destroy;
    window.__DesignInspector = {
        onTarget,
        onCommit,
        onRelease,
        onReposition,
        setStrings,
        setSession,
        isFrozen,
        getScan,
        destroy,
    };
})();
