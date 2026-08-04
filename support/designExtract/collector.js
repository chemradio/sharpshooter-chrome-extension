// The in-page design collector.
//
// This module exports a *source string* rather than a callable: the body runs
// inside the target page via CDP Runtime.evaluate, on the same debugger
// channel as the screenshot. That matters — see designSession.js — because
// emulation can cross a responsive breakpoint, and a dossier gathered before
// emulation would describe a layout the PNG doesn't show.
//
// Everything below the fold is written as page JS: no imports, no closures
// over module scope, no optional chaining on cross-realm objects.

// ─── Property set ────────────────────────────────────────────────────────────
//
// Deliberately curated rather than "every computed property". A full dump is
// ~340 properties per node, most of them resolved noise (perspective-origin
// derived from box size, every -webkit- alias). These are the ones a designer
// or front-end dev would actually write by hand, grouped so the output is
// already organized for the card and the spec sheet.
const PROPERTY_GROUPS = {
    typography: [
        "font-family", "font-size", "font-weight", "font-style",
        "line-height", "letter-spacing", "word-spacing", "text-transform",
        "text-align", "text-decoration-line", "text-decoration-color",
        "text-shadow", "white-space", "font-variant-numeric", "color",
    ],
    box: [
        "width", "height", "box-sizing", "aspect-ratio",
        "padding-top", "padding-right", "padding-bottom", "padding-left",
        "margin-top", "margin-right", "margin-bottom", "margin-left",
        "border-top-width", "border-right-width", "border-bottom-width",
        "border-left-width", "border-top-style", "border-top-color",
        "border-right-color", "border-bottom-color", "border-left-color",
        "border-top-left-radius", "border-top-right-radius",
        "border-bottom-right-radius", "border-bottom-left-radius",
        "outline-width", "outline-style", "outline-color", "outline-offset",
    ],
    fill: [
        "background-color", "background-image", "background-size",
        "background-position", "background-repeat", "background-clip",
        "background-origin",
    ],
    effects: [
        "box-shadow", "opacity", "filter", "backdrop-filter",
        "mix-blend-mode",
    ],
    layout: [
        "display", "position", "top", "right", "bottom", "left", "z-index",
        "flex-direction", "flex-wrap", "justify-content", "align-items",
        "align-content", "align-self", "flex-grow", "flex-shrink",
        "flex-basis", "order", "gap", "row-gap", "column-gap",
        "grid-template-columns", "grid-template-rows", "grid-auto-flow",
        "grid-auto-columns", "grid-auto-rows", "grid-column", "grid-row",
        "overflow-x", "overflow-y", "visibility",
    ],
    motion: [
        "transition-property", "transition-duration",
        "transition-timing-function", "transition-delay",
        "transform", "transform-origin",
        "animation-name", "animation-duration", "animation-timing-function",
        "animation-iteration-count",
    ],
    misc: ["cursor", "list-style-type", "pointer-events", "user-select"],
};

// ─── Collector body ──────────────────────────────────────────────────────────

function collectorBody(args) {
    var PROPERTY_GROUPS = args.propertyGroups;
    var LIMITS = args.limits;
    var OPTIONS = args.options;

    var ALL_PROPS = [];
    for (var g in PROPERTY_GROUPS) ALL_PROPS = ALL_PROPS.concat(PROPERTY_GROUPS[g]);

    // ─── Locate ──────────────────────────────────────────────────────────
    // Same marker-then-XPath strategy as element capture: the marker survives
    // the reflow that emulation triggers, positional XPath frequently doesn't.
    function locate() {
        var el = null;
        if (args.marker) {
            el = document.querySelector('[data-sharpshooter-target="' + args.marker + '"]');
        }
        if (!el && args.xpath) {
            el = document.evaluate(
                args.xpath, document, null,
                XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;
        }
        return el;
    }

    var root = locate();
    if (!root) return { ok: false, reason: "marker+xpath-miss" };

    // ─── Colour normalization ────────────────────────────────────────────
    // Computed styles hand back whatever colour space the author used —
    // rgb(), rgba(), color(srgb ...), oklch(), or a named keyword. Rather
    // than parse each syntax, round-trip through a canvas: assigning to
    // fillStyle resolves any valid CSS colour, and reading it back yields
    // either "#rrggbb" or "rgba(r, g, b, a)". One code path, total coverage.
    var probeCtx = document.createElement("canvas").getContext("2d");

    // Assigning an invalid colour to fillStyle is a silent no-op — the
    // previous value stays. Probing once against a single sentinel therefore
    // reports that sentinel as a successful parse, which turned every
    // non-colour custom property ("16px") into black. Probing against two
    // different sentinels disambiguates: only a real colour produces the same
    // answer both times.
    function resolveCssColor(v) {
        probeCtx.fillStyle = "#000000";
        probeCtx.fillStyle = v;
        var first = probeCtx.fillStyle;
        probeCtx.fillStyle = "#ffffff";
        probeCtx.fillStyle = v;
        var second = probeCtx.fillStyle;
        return first === second ? first : null;
    }

    function normColor(value) {
        if (!value) return null;
        var v = String(value).trim();
        if (!v || v === "none") return null;
        if (v === "transparent" || v === "rgba(0, 0, 0, 0)") {
            return { css: "transparent", hex: null, alpha: 0, transparent: true };
        }
        var resolved;
        try {
            resolved = resolveCssColor(v);
        } catch (e) {
            return { css: v, hex: null, alpha: 1, unparsed: true };
        }
        if (!resolved) return null;
        var r, g, b, a = 1;
        if (resolved.charAt(0) === "#") {
            r = parseInt(resolved.slice(1, 3), 16);
            g = parseInt(resolved.slice(3, 5), 16);
            b = parseInt(resolved.slice(5, 7), 16);
        } else {
            var m = resolved.match(/rgba?\(([^)]+)\)/);
            if (!m) return { css: v, hex: null, alpha: 1, unparsed: true };
            var parts = m[1].split(",");
            r = parseFloat(parts[0]); g = parseFloat(parts[1]); b = parseFloat(parts[2]);
            a = parts.length > 3 ? parseFloat(parts[3]) : 1;
        }
        if (a === 0) {
            return { css: "transparent", hex: null, alpha: 0, transparent: true };
        }
        return {
            css: v,
            hex: rgbToHex(r, g, b),
            rgb: [r, g, b],
            rgbCss: a < 1
                ? "rgba(" + r + ", " + g + ", " + b + ", " + round(a, 3) + ")"
                : "rgb(" + r + ", " + g + ", " + b + ")",
            hsl: rgbToHslCss(r, g, b, a),
            alpha: round(a, 3),
            luminance: round(relativeLuminance(r, g, b), 4),
        };
    }

    function round(n, places) {
        var f = Math.pow(10, places == null ? 2 : places);
        return Math.round(n * f) / f;
    }
    function hex2(n) {
        var s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
        return s.length === 1 ? "0" + s : s;
    }
    function rgbToHex(r, g, b) {
        return ("#" + hex2(r) + hex2(g) + hex2(b)).toUpperCase();
    }
    function rgbToHslCss(r, g, b, a) {
        var rr = r / 255, gg = g / 255, bb = b / 255;
        var max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
        var h = 0, s = 0, l = (max + min) / 2;
        var d = max - min;
        if (d !== 0) {
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0));
            else if (max === gg) h = ((bb - rr) / d + 2);
            else h = ((rr - gg) / d + 4);
            h *= 60;
        }
        var base = Math.round(h) + ", " + Math.round(s * 100) + "%, " + Math.round(l * 100) + "%";
        return a < 1 ? "hsla(" + base + ", " + round(a, 3) + ")" : "hsl(" + base + ")";
    }
    // WCAG 2.x relative luminance (sRGB).
    function relativeLuminance(r, g, b) {
        function chan(c) {
            c = c / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
    }
    function contrastRatio(l1, l2) {
        var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
    }

    // The background a given element's text is *actually* painted on: itself
    // if it has an opaque fill, otherwise the nearest ancestor that does.
    // Pairing every text colour with every background colour found anywhere
    // in the subtree instead produces confident nonsense — white button text
    // graded against the white card behind the button, failing at 1:1 — and a
    // false accessibility failure is more damaging than reporting nothing.
    function effectiveBackground(el) {
        var cur = el;
        while (cur && cur.nodeType === 1) {
            var bg = normColor(getComputedStyle(cur).backgroundColor);
            if (bg && !bg.transparent && bg.alpha >= 0.9) return bg;
            cur = cur.parentElement;
        }
        var bodyBg = normColor(getComputedStyle(document.body).backgroundColor);
        if (bodyBg && !bodyBg.transparent) return bodyBg;
        return {
            hex: "#FFFFFF", rgbCss: "rgb(255, 255, 255)",
            alpha: 1, luminance: 1,
        };
    }

    // WCAG "large text": >= 24px, or >= 18.66px when bold. Large text is held
    // to 3:1 rather than 4.5:1, so grading without this flags legitimate
    // headings as failures.
    function isLargeText(sizePx, weight) {
        if (sizePx == null) return false;
        var w = parseInt(weight, 10);
        if (sizePx >= 24) return true;
        return sizePx >= 18.66 && w >= 700;
    }

    // ─── Baseline (UA defaults) ──────────────────────────────────────────
    // To report what the *author* set rather than 340 resolved properties per
    // node, each value is diffed against the same tag rendered with no author
    // CSS at all. An about:blank iframe gives exactly that: UA stylesheet
    // only, same engine, same-origin so getComputedStyle is readable.
    var baselineFrame = null;
    var baselineCache = {};

    function baselineFor(tag) {
        if (baselineCache[tag]) return baselineCache[tag];
        try {
            if (!baselineFrame) {
                baselineFrame = document.createElement("iframe");
                baselineFrame.setAttribute("aria-hidden", "true");
                baselineFrame.style.cssText =
                    "position:absolute!important;left:-99999px!important;top:0!important;" +
                    "width:1024px!important;height:768px!important;border:0!important;" +
                    "visibility:hidden!important;pointer-events:none!important";
                document.documentElement.appendChild(baselineFrame);
            }
            var doc = baselineFrame.contentDocument;
            if (!doc || !doc.body) { baselineCache[tag] = {}; return {}; }
            var probe = doc.createElement(tag);
            doc.body.appendChild(probe);
            var cs = doc.defaultView.getComputedStyle(probe);
            var snap = {};
            for (var i = 0; i < ALL_PROPS.length; i++) {
                snap[ALL_PROPS[i]] = cs.getPropertyValue(ALL_PROPS[i]);
            }
            probe.remove();
            baselineCache[tag] = snap;
            return snap;
        } catch (e) {
            baselineCache[tag] = {};
            return {};
        }
    }

    // ─── Shorthand collapsing ────────────────────────────────────────────
    // Computed style is all longhands. A designer copying "padding" wants
    // `padding: 12px 20px`, not four declarations — this is the difference
    // between output you can paste and output you have to clean up first.
    function collapseBox(t, r, b, l) {
        if (t === r && r === b && b === l) return t;
        if (t === b && r === l) return t + " " + r;
        if (r === l) return t + " " + r + " " + b;
        return t + " " + r + " " + b + " " + l;
    }
    function collapseRadius(tl, tr, br, bl) {
        if (tl === tr && tr === br && br === bl) return tl;
        if (tl === br && tr === bl) return tl + " " + tr;
        if (tr === bl) return tl + " " + tr + " " + br;
        return tl + " " + tr + " " + br + " " + bl;
    }

    // ─── Numeric helpers ─────────────────────────────────────────────────
    function px(value) {
        var n = parseFloat(value);
        return isNaN(n) ? null : n;
    }
    var rootFontSize = px(getComputedStyle(document.documentElement).fontSize) || 16;
    function toRem(pxValue) {
        if (pxValue == null) return null;
        return round(pxValue / rootFontSize, 4);
    }

    // ─── Aggregates ──────────────────────────────────────────────────────
    var colorAgg = {};      // hex+alpha -> {..., count, roles}
    var typeAgg = {};       // signature -> type style
    var spacingSet = {};
    var radiusSet = {};
    var shadowAgg = {};
    var fontStacks = {};
    var gapSet = {};
    var contrastAgg = {};   // "fg|bg" -> observed pair with its real context

    function noteColor(colorObj, role) {
        if (!colorObj || colorObj.transparent || !colorObj.hex) return;
        var key = colorObj.hex + "|" + colorObj.alpha;
        if (!colorAgg[key]) {
            colorAgg[key] = {
                hex: colorObj.hex,
                rgb: colorObj.rgbCss,
                hsl: colorObj.hsl,
                alpha: colorObj.alpha,
                luminance: colorObj.luminance,
                count: 0,
                roles: {},
            };
        }
        colorAgg[key].count++;
        colorAgg[key].roles[role] = (colorAgg[key].roles[role] || 0) + 1;
    }

    function noteSpacing(value) {
        var n = px(value);
        if (n == null || n === 0) return;
        spacingSet[n] = (spacingSet[n] || 0) + 1;
    }

    // ─── Per-node capture ────────────────────────────────────────────────
    function describeNode(el, depth) {
        var cs = getComputedStyle(el);
        var tag = el.tagName.toLowerCase();
        var base = baselineFor(tag);
        var rect = el.getBoundingClientRect();

        var groups = {};
        var authored = 0;
        for (var gname in PROPERTY_GROUPS) {
            var list = PROPERTY_GROUPS[gname];
            var out = {};
            for (var i = 0; i < list.length; i++) {
                var prop = list[i];
                var value = cs.getPropertyValue(prop);
                if (!value) continue;
                // width/height are always "authored" in the sense that they
                // resolve to a used value; keep them out of the diff and
                // report geometry from the rect instead.
                if (prop === "width" || prop === "height") continue;
                if (base[prop] !== undefined && base[prop] === value) continue;
                out[prop] = value;
                authored++;
            }
            if (Object.keys(out).length) groups[gname] = out;
        }

        // ── Derived, designer-facing summary ──
        var padding = collapseBox(
            cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft
        );
        var margin = collapseBox(
            cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft
        );
        var radius = collapseRadius(
            cs.borderTopLeftRadius, cs.borderTopRightRadius,
            cs.borderBottomRightRadius, cs.borderBottomLeftRadius
        );

        noteSpacing(cs.paddingTop); noteSpacing(cs.paddingRight);
        noteSpacing(cs.paddingBottom); noteSpacing(cs.paddingLeft);
        noteSpacing(cs.marginTop); noteSpacing(cs.marginRight);
        noteSpacing(cs.marginBottom); noteSpacing(cs.marginLeft);

        if (cs.rowGap && cs.rowGap !== "normal") {
            var rg = px(cs.rowGap);
            if (rg) { gapSet[rg] = (gapSet[rg] || 0) + 1; noteSpacing(cs.rowGap); }
        }
        if (cs.columnGap && cs.columnGap !== "normal") {
            var cg = px(cs.columnGap);
            if (cg) { gapSet[cg] = (gapSet[cg] || 0) + 1; noteSpacing(cs.columnGap); }
        }

        var radiusPx = px(cs.borderTopLeftRadius);
        if (radiusPx) radiusSet[radius] = (radiusSet[radius] || 0) + 1;

        var textColor = normColor(cs.color);
        var bgColor = normColor(cs.backgroundColor);
        var borderColor = normColor(cs.borderTopColor);

        var hasText = false;
        for (var c = 0; c < el.childNodes.length; c++) {
            var cn = el.childNodes[c];
            if (cn.nodeType === 3 && cn.nodeValue && cn.nodeValue.trim()) {
                hasText = true; break;
            }
        }

        if (hasText) noteColor(textColor, "text");
        noteColor(bgColor, "background");
        if (px(cs.borderTopWidth)) noteColor(borderColor, "border");

        // Grade this text against the surface it genuinely sits on, at the
        // point where we still know which element it belongs to.
        if (hasText && OPTIONS.contrastRatios && textColor && textColor.hex) {
            var effBg = effectiveBackground(el);
            if (effBg && effBg.hex) {
                var ckey = textColor.hex + "|" + effBg.hex;
                if (!contrastAgg[ckey]) {
                    contrastAgg[ckey] = {
                        foreground: textColor.hex,
                        background: effBg.hex,
                        fgLuminance: textColor.luminance,
                        bgLuminance: effBg.luminance,
                        count: 0,
                        samples: [],
                        large: false,
                    };
                }
                var pair = contrastAgg[ckey];
                pair.count++;
                if (isLargeText(px(cs.fontSize), cs.fontWeight)) pair.large = true;
                var sampleText = (el.textContent || "").trim().slice(0, 40);
                if (sampleText && pair.samples.length < 3) pair.samples.push(sampleText);
            }
        }

        // Type styles are aggregated only where text actually renders —
        // otherwise every wrapper div contributes an inherited duplicate.
        var typeStyle = null;
        if (hasText && rect.width > 0 && rect.height > 0) {
            var sizePx = px(cs.fontSize);
            var lh = cs.lineHeight === "normal" ? null : px(cs.lineHeight);
            typeStyle = {
                fontFamily: cs.fontFamily,
                fontSize: cs.fontSize,
                fontSizeRem: toRem(sizePx),
                fontWeight: cs.fontWeight,
                fontStyle: cs.fontStyle,
                lineHeight: cs.lineHeight,
                lineHeightRatio: lh && sizePx ? round(lh / sizePx, 3) : null,
                letterSpacing: cs.letterSpacing,
                textTransform: cs.textTransform,
                color: textColor ? textColor.hex : null,
            };
            var sig = [
                typeStyle.fontFamily, typeStyle.fontSize, typeStyle.fontWeight,
                typeStyle.lineHeight, typeStyle.letterSpacing,
                typeStyle.textTransform, typeStyle.color,
            ].join("|");
            if (!typeAgg[sig]) {
                typeAgg[sig] = typeStyle;
                typeAgg[sig].count = 0;
                typeAgg[sig].sample = (el.textContent || "").trim().slice(0, 60);
            }
            typeAgg[sig].count++;
            fontStacks[cs.fontFamily] = (fontStacks[cs.fontFamily] || 0) + 1;
        }

        if (cs.boxShadow && cs.boxShadow !== "none") {
            shadowAgg[cs.boxShadow] = (shadowAgg[cs.boxShadow] || 0) + 1;
        }

        return {
            tag: tag,
            id: el.id || null,
            classes: typeof el.className === "string" && el.className
                ? el.className.trim().split(/\s+/).slice(0, 8)
                : [],
            depth: depth,
            role: el.getAttribute("role") || null,
            text: hasText ? (el.textContent || "").trim().slice(0, 80) : null,
            geometry: {
                width: round(rect.width, 2),
                height: round(rect.height, 2),
                widthRem: toRem(rect.width),
                heightRem: toRem(rect.height),
            },
            summary: {
                display: cs.display,
                padding: padding,
                margin: margin,
                borderRadius: radius,
                background: bgColor && !bgColor.transparent ? bgColor.hex : null,
                color: hasText && textColor ? textColor.hex : null,
                boxShadow: cs.boxShadow !== "none" ? cs.boxShadow : null,
                border: px(cs.borderTopWidth)
                    ? cs.borderTopWidth + " " + cs.borderTopStyle + " " +
                      (borderColor ? borderColor.hex : cs.borderTopColor)
                    : null,
            },
            typeStyle: typeStyle,
            authoredCount: authored,
            properties: groups,
        };
    }

    // ─── Traverse ────────────────────────────────────────────────────────
    var nodes = [];
    var truncated = false;
    var gaps = [];

    function walk(el, depth) {
        if (nodes.length >= LIMITS.maxNodes) { truncated = true; return; }
        if (depth > LIMITS.maxDepth) { truncated = true; return; }

        var cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return;

        // Our own injected nodes must never appear in the dossier.
        var elId = el.id || "";
        if (elId === "__hl-overlay" || elId === "__hl-style" ||
            elId === "__no-scroll" || el === baselineFrame) return;

        var tag = el.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") return;

        nodes.push(describeNode(el, depth));

        // Structures whose interior we genuinely cannot read. Recorded as
        // explicit gaps rather than silently skipped — a spec sheet that
        // quietly omits half a component is worse than one that says so.
        if (el.shadowRoot) {
            gaps.push({
                type: "shadow-dom", tag: tag,
                note: "Element hosts a shadow root; its internal styles are not readable from the page context.",
            });
            return;
        }
        if (tag === "iframe" || tag === "frame") {
            gaps.push({
                type: "iframe", tag: tag,
                note: "Cross-document content; styles inside the frame are not included.",
            });
            return;
        }
        if (tag === "canvas") {
            gaps.push({
                type: "canvas", tag: tag,
                note: "Pixel content is drawn at runtime and has no CSS to report.",
            });
            return;
        }

        var kids = el.children;
        for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }

    // ─── Inherited context ───────────────────────────────────────────────
    // An extracted element inherits typography from its ancestors and sits on
    // an ancestor's background. Both are needed to render it faithfully
    // anywhere else — without them a lifted component renders as unstyled
    // text on white, which is the classic failure of naive extraction.
    function inheritedContext(el) {
        var cs = getComputedStyle(el);
        var ground = null;
        var walkUp = el.parentElement;
        while (walkUp) {
            var pc = normColor(getComputedStyle(walkUp).backgroundColor);
            if (pc && !pc.transparent) { ground = pc; break; }
            walkUp = walkUp.parentElement;
        }
        if (!ground) {
            var bodyBg = normColor(getComputedStyle(document.body).backgroundColor);
            ground = bodyBg && !bodyBg.transparent
                ? bodyBg
                : { hex: "#FFFFFF", rgbCss: "rgb(255, 255, 255)", alpha: 1, luminance: 1 };
        }
        return {
            fontFamily: cs.fontFamily,
            fontSize: cs.fontSize,
            lineHeight: cs.lineHeight,
            color: normColor(cs.color),
            direction: cs.direction,
            groundColor: ground,
            rootFontSize: rootFontSize + "px",
        };
    }

    // ─── Custom properties (design tokens) ───────────────────────────────
    // If the site is built on tokens, these are the actual design system —
    // strictly more valuable than the flattened values they resolve to. Only
    // properties in scope on the selected element are reported, so a site
    // with 400 globals doesn't drown the component's own 12.
    function customProperties(el) {
        var out = {};
        try {
            var cs = getComputedStyle(el);
            // Chrome enumerates registered and inherited custom properties on
            // the computed style object. Older engines expose nothing here,
            // in which case this silently yields an empty set.
            for (var i = 0; i < cs.length; i++) {
                var name = cs[i];
                if (name.indexOf("--") !== 0) continue;
                var raw = cs.getPropertyValue(name).trim();
                if (!raw) continue;
                var entry = { value: raw };
                // Dimension check first: cheaper, and unambiguous for the
                // shapes a token actually takes.
                var asColor = /^-?[\d.]+(px|rem|em|%|vh|vw|s|ms)$/.test(raw)
                    ? null
                    : normColor(raw);
                if (asColor && asColor.hex) {
                    entry.type = "color";
                    entry.hex = asColor.hex;
                    entry.rgb = asColor.rgbCss;
                } else if (/^-?[\d.]+(px|rem|em|%|vh|vw|s|ms)$/.test(raw)) {
                    entry.type = "dimension";
                } else {
                    entry.type = "raw";
                }
                out[name] = entry;
            }
        } catch (e) { /* enumeration unsupported */ }
        return out;
    }

    // ─── Component role heuristic ────────────────────────────────────────
    // A designer names things "button", "card", "input" — the DOM does not.
    // A cheap guess lets the card lead with a recognizable label instead of
    // "div.sc-4f2a1b".
    function guessRole(el) {
        var tag = el.tagName.toLowerCase();
        var explicit = (el.getAttribute("role") || "").toLowerCase();
        if (explicit) return explicit;
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "input" || tag === "textarea" || tag === "select") return "input";
        if (tag === "img" || tag === "picture" || tag === "svg") return "image";
        if (tag === "table") return "table";
        if (tag === "form") return "form";
        if (tag === "nav") return "navigation";
        if (tag === "header") return "header";
        if (tag === "footer") return "footer";
        if (tag === "ul" || tag === "ol") return "list";
        if (/^h[1-6]$/.test(tag)) return "heading";
        var hint = ((typeof el.className === "string" ? el.className : "") + " " +
            (el.id || "")).toLowerCase();
        if (/\bbtn\b|button/.test(hint)) return "button";
        if (/\bcard\b/.test(hint)) return "card";
        if (/\bbadge\b|\bchip\b|\btag\b|\bpill\b/.test(hint)) return "badge";
        if (/\bmodal\b|\bdialog\b/.test(hint)) return "dialog";
        if (/\bnav\b|\bmenu\b/.test(hint)) return "navigation";
        if (/\bhero\b|\bbanner\b/.test(hint)) return "banner";
        return "container";
    }

    // ─── Run ─────────────────────────────────────────────────────────────
    try {
        walk(root, 0);

        // Sort aggregates most-used first — the top of each list is the
        // component's actual palette/scale, the tail is incidental.
        function sortedColors() {
            var list = [];
            for (var k in colorAgg) {
                var c = colorAgg[k];
                var roleNames = [];
                for (var r in c.roles) roleNames.push(r);
                roleNames.sort(function (a, b) { return c.roles[b] - c.roles[a]; });
                list.push({
                    hex: c.hex, rgb: c.rgb, hsl: c.hsl, alpha: c.alpha,
                    luminance: c.luminance, count: c.count,
                    roles: roleNames, primaryRole: roleNames[0] || null,
                });
            }
            list.sort(function (a, b) { return b.count - a.count; });
            return list;
        }
        function sortedNumeric(map, unit) {
            var list = [];
            for (var k in map) list.push({ value: parseFloat(k), count: map[k] });
            list.sort(function (a, b) { return a.value - b.value; });
            return list.map(function (e) {
                return {
                    px: e.value, rem: toRem(e.value),
                    label: e.value + (unit || "px"), count: e.count,
                };
            });
        }
        function sortedKeyed(map) {
            var list = [];
            for (var k in map) list.push({ value: k, count: map[k] });
            list.sort(function (a, b) { return b.count - a.count; });
            return list;
        }
        function sortedTypes() {
            var list = [];
            for (var k in typeAgg) list.push(typeAgg[k]);
            list.sort(function (a, b) {
                var as = parseFloat(a.fontSize), bs = parseFloat(b.fontSize);
                return bs - as;
            });
            return list;
        }

        var context = inheritedContext(root);
        var palette = sortedColors();

        // ── Contrast pairs ──
        // Only combinations that genuinely occur in the component, each
        // already tied to the surface its text is painted on and graded
        // against the threshold appropriate to its size. Web designers
        // routinely own this, and DevTools won't show it across a whole
        // component at once.
        var contrast = [];
        if (OPTIONS.contrastRatios) {
            for (var ck in contrastAgg) {
                var p = contrastAgg[ck];
                var ratio = contrastRatio(p.fgLuminance, p.bgLuminance);
                var threshold = p.large ? 3 : 4.5;
                contrast.push({
                    foreground: p.foreground,
                    background: p.background,
                    ratio: round(ratio, 2),
                    largeText: p.large,
                    threshold: threshold,
                    passesAA: ratio >= threshold,
                    passesAAA: ratio >= (p.large ? 4.5 : 7),
                    occurrences: p.count,
                    samples: p.samples,
                });
            }
            contrast.sort(function (a, b) { return a.ratio - b.ratio; });
        }

        var rootRect = root.getBoundingClientRect();

        return {
            ok: true,
            capturedAt: new Date().toISOString(),
            page: {
                url: location.href,
                origin: location.origin,
                title: document.title,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                devicePixelRatio: window.devicePixelRatio,
            },
            element: {
                tag: root.tagName.toLowerCase(),
                id: root.id || null,
                classes: typeof root.className === "string" && root.className
                    ? root.className.trim().split(/\s+/).slice(0, 12) : [],
                role: guessRole(root),
                selector: buildSelector(root),
                width: round(rootRect.width, 2),
                height: round(rootRect.height, 2),
                widthRem: toRem(rootRect.width),
                heightRem: toRem(rootRect.height),
            },
            context: context,
            summary: nodes.length ? nodes[0].summary : null,
            aggregates: {
                palette: palette,
                typeStyles: sortedTypes(),
                fontStacks: sortedKeyed(fontStacks),
                spacing: sortedNumeric(spacingSet),
                gaps: sortedNumeric(gapSet),
                radii: sortedKeyed(radiusSet),
                shadows: sortedKeyed(shadowAgg),
            },
            contrast: contrast,
            customProperties: OPTIONS.customProperties ? customProperties(root) : {},
            nodes: nodes,
            gaps: gaps,
            truncated: truncated,
            nodeCount: nodes.length,
        };
    } finally {
        if (baselineFrame && baselineFrame.parentNode) baselineFrame.remove();
    }

    // A short, readable selector for the element — for the spec sheet's
    // "where this came from" line, not for re-querying.
    function buildSelector(el) {
        var tag = el.tagName.toLowerCase();
        if (el.id) return tag + "#" + el.id;
        var cls = typeof el.className === "string" && el.className
            ? el.className.trim().split(/\s+/).slice(0, 3) : [];
        return cls.length ? tag + "." + cls.join(".") : tag;
    }
}

// ─── Pseudo-state re-read ────────────────────────────────────────────────────
//
// After CDP forces :hover / :focus / :active on the node, this re-reads only
// the root element's summary properties. A full subtree re-walk per state
// would triple an already non-trivial cost for information nobody reads — the
// interaction states that matter are the ones on the component itself.
function stateProbeBody(args) {
    var el = null;
    if (args.marker) {
        el = document.querySelector('[data-sharpshooter-target="' + args.marker + '"]');
    }
    if (!el && args.xpath) {
        el = document.evaluate(
            args.xpath, document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
    }
    if (!el) return { ok: false };

    var cs = getComputedStyle(el);
    var out = {};
    for (var i = 0; i < args.props.length; i++) {
        out[args.props[i]] = cs.getPropertyValue(args.props[i]);
    }
    return { ok: true, values: out };
}

// Properties worth diffing across interaction states. Kept tight: a hover
// diff is only useful if it reads at a glance.
export const STATE_PROPS = [
    "background-color", "background-image", "color", "border-top-color",
    "border-top-width", "box-shadow", "opacity", "transform", "filter",
    "text-decoration-line", "outline-color", "outline-width", "outline-offset",
    "letter-spacing", "border-top-left-radius", "cursor",
];

export function buildCollectorExpression({ marker, xpath, limits, options }) {
    const args = {
        marker: marker || "",
        xpath: xpath || "",
        limits,
        options,
        propertyGroups: PROPERTY_GROUPS,
    };
    return `(${collectorBody.toString()})(${JSON.stringify(args)})`;
}

export function buildStateProbeExpression({ marker, xpath }) {
    const args = {
        marker: marker || "",
        xpath: xpath || "",
        props: STATE_PROPS,
    };
    return `(${stateProbeBody.toString()})(${JSON.stringify(args)})`;
}
