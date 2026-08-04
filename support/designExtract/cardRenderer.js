// Renders the shareable spec card as a PNG, hand-laid on OffscreenCanvas.
//
// Why canvas and not HTML: a service worker has no DOM, and an offscreen
// document can't be screenshotted. SVG-with-foreignObject was the other
// option and it silently drops external fonts. So the layout is drawn.
//
// The design brief this implements: it must not read like a DevTools panel.
// Geometry is *drawn* — the radius is a real rounded corner, the padding is a
// real inset diagram, the shadow is a real shadow — because a table of numbers
// gets scrolled past and a spec card gets posted.
//
// Layout runs in two passes over the same section list: a measure pass to
// compute total height, then a paint pass into a correctly-sized canvas.

import { bytesToBase64 } from "../binary.js";

const W = 600;                 // logical width; output is W × SCALE
const SCALE = 2;
const PAD = 32;
const SWATCH = 56;

const THEMES = {
    light: {
        bg: "#FFFFFF",
        panel: "#F8FAFC",
        panelEdge: "#E9EEF5",
        text: "#0F172A",
        muted: "#64748B",
        faint: "#94A3B8",
        rule: "#E2E8F0",
        accent: "#A855F7",
        good: "#059669",
        bad: "#DC2626",
    },
    dark: {
        bg: "#0B1220",
        panel: "#131C2E",
        panelEdge: "#1E293B",
        text: "#E8EEF7",
        muted: "#94A3B8",
        faint: "#64748B",
        rule: "#1E293B",
        accent: "#C084FC",
        good: "#34D399",
        bad: "#F87171",
    },
};

// Generic families only. A service worker can't load webfonts, and naming a
// font that isn't installed silently falls back anyway — so ask for the
// system UI stack and let each platform answer with its own.
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "Cascadia Mono", "Segoe UI Mono", Menlo, monospace';

const font = (weight, size, family = SANS) => `${weight} ${size}px ${family}`;

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }
}

// Wraps to `maxWidth`, returning the lines. Used by both passes so measure
// and paint can never disagree about how tall a paragraph is.
function wrap(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function truncate(ctx, text, maxWidth) {
    let s = String(text);
    if (ctx.measureText(s).width <= maxWidth) return s;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) {
        s = s.slice(0, -1);
    }
    return `${s}…`;
}

// ─── Sections ────────────────────────────────────────────────────────────────
//
// Each returns the height it occupies. With `paint` false nothing is drawn —
// the same code path measures, so a layout change can't desync the two.

function sectionTitle(ctx, t, label, y, paint) {
    if (paint) {
        ctx.fillStyle = t.faint;
        ctx.font = font(700, 11);
        ctx.textBaseline = "top";
        ctx.fillText(label.toUpperCase(), PAD, y);
        const tw = ctx.measureText(label.toUpperCase()).width;
        ctx.strokeStyle = t.rule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD + tw + 10, y + 6.5);
        ctx.lineTo(W - PAD, y + 6.5);
        ctx.stroke();
    }
    return 24;
}

function header(ctx, t, d, y, paint) {
    const start = y;
    const title = d.element.role.charAt(0).toUpperCase() + d.element.role.slice(1);

    if (paint) {
        ctx.textBaseline = "top";
        ctx.fillStyle = t.text;
        ctx.font = font(700, 26);
        ctx.fillText(title, PAD, y);

        // Selector chip, right-aligned on the title line.
        ctx.font = font(500, 12, MONO);
        const sel = truncate(ctx, d.element.selector, 220);
        const cw = ctx.measureText(sel).width + 16;
        roundRect(ctx, W - PAD - cw, y + 4, cw, 22, 6);
        ctx.fillStyle = t.panel;
        ctx.fill();
        ctx.strokeStyle = t.panelEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = t.muted;
        ctx.fillText(sel, W - PAD - cw + 8, y + 9);
    }
    y += 34;

    if (paint) {
        ctx.fillStyle = t.muted;
        ctx.font = font(400, 12);
        let host = d.page.url;
        try { host = new URL(d.page.url).hostname.replace(/^www\./, ""); } catch {}
        const dims = `${Math.round(d.element.width)} × ${Math.round(d.element.height)} px`;
        ctx.fillText(truncate(ctx, `${host}  ·  ${dims}`, W - PAD * 2), PAD, y);
    }
    y += 22;

    return y - start;
}

async function hero(ctx, t, bitmap, ground, y, paint) {
    if (!bitmap) return 0;
    const maxH = 260;
    const boxW = W - PAD * 2;
    const scale = Math.min(boxW / bitmap.width, maxH / bitmap.height, 1);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    const boxH = Math.max(dh + 32, 80);

    if (paint) {
        // The element sits on the surface it actually sat on in the page —
        // a white component on a white card is otherwise invisible here.
        roundRect(ctx, PAD, y, boxW, boxH, 10);
        ctx.fillStyle = ground || t.panel;
        ctx.fill();
        ctx.strokeStyle = t.panelEdge;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.save();
        roundRect(ctx, PAD, y, boxW, boxH, 10);
        ctx.clip();
        ctx.drawImage(bitmap, PAD + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh);
        ctx.restore();
    }
    return boxH + 20;
}

function palette(ctx, t, colors, y, paint) {
    if (!colors.length) return 0;
    const start = y;
    y += sectionTitle(ctx, t, "Palette", y, paint);

    const perRow = Math.floor((W - PAD * 2 + 12) / (SWATCH + 12));
    const shown = colors.slice(0, perRow * 2);
    let x = PAD;
    let rowTop = y;

    shown.forEach((c, i) => {
        if (i > 0 && i % perRow === 0) {
            x = PAD;
            rowTop += SWATCH + 40;
        }
        if (paint) {
            roundRect(ctx, x, rowTop, SWATCH, SWATCH, 8);
            ctx.fillStyle = c.hex;
            ctx.fill();
            // Light swatches need an edge or they vanish on a light card.
            ctx.strokeStyle = c.luminance > 0.85 ? t.panelEdge : "rgba(0,0,0,0)";
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = t.text;
            ctx.font = font(600, 10, MONO);
            ctx.textBaseline = "top";
            ctx.fillText(c.hex, x, rowTop + SWATCH + 7);

            ctx.fillStyle = t.faint;
            ctx.font = font(400, 9);
            ctx.fillText(
                truncate(ctx, c.primaryRole || "", SWATCH + 8),
                x,
                rowTop + SWATCH + 21
            );
        }
        x += SWATCH + 12;
    });

    return rowTop + SWATCH + 40 - start;
}

function typography(ctx, t, styles, y, paint) {
    if (!styles.length) return 0;
    const start = y;
    y += sectionTitle(ctx, t, "Type", y, paint);

    for (const s of styles.slice(0, 4)) {
        const size = Math.min(parseFloat(s.fontSize) || 14, 30);
        const weight = parseInt(s.fontWeight, 10) || 400;

        if (paint) {
            // A real specimen, set at the captured size and weight — the
            // point of a type section is to see it, not read its parameters.
            ctx.fillStyle = s.color || t.text;
            ctx.font = font(weight, size);
            ctx.textBaseline = "top";
            ctx.fillText(
                truncate(ctx, s.sample || "The quick brown fox", W - PAD * 2 - 150),
                PAD,
                y
            );

            ctx.fillStyle = t.muted;
            ctx.font = font(500, 10, MONO);
            const spec = `${s.fontSize}/${s.lineHeight} · ${s.fontWeight}`;
            ctx.fillText(spec, W - PAD - ctx.measureText(spec).width, y + size - 10);
        }
        y += Math.max(size, 18) + 14;
    }

    return y - start + 6;
}

// The geometry panel: radius as an actual corner, padding as an actual inset.
function geometry(ctx, t, d, y, paint) {
    const s = d.summary || {};
    const start = y;
    y += sectionTitle(ctx, t, "Geometry", y, paint);

    const panelH = 128;
    const colW = (W - PAD * 2 - 12) / 2;

    if (paint) {
        // ── Left: padding diagram ──
        roundRect(ctx, PAD, y, colW, panelH, 10);
        ctx.fillStyle = t.panel;
        ctx.fill();
        ctx.strokeStyle = t.panelEdge;
        ctx.lineWidth = 1;
        ctx.stroke();

        const bx = PAD + 24, by = y + 24;
        const bw = colW - 48, bh = panelH - 48;
        ctx.strokeStyle = t.accent;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);

        const inset = 18;
        ctx.fillStyle = t.accent + "22";
        ctx.fillRect(bx, by, bw, inset);
        ctx.fillRect(bx, by + bh - inset, bw, inset);
        ctx.fillRect(bx, by + inset, inset, bh - inset * 2);
        ctx.fillRect(bx + bw - inset, by + inset, inset, bh - inset * 2);

        ctx.fillStyle = t.bg;
        ctx.fillRect(bx + inset, by + inset, bw - inset * 2, bh - inset * 2);

        ctx.fillStyle = t.text;
        ctx.font = font(600, 11, MONO);
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(String(s.padding || "0"), bx + bw / 2, by + bh / 2);
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = t.faint;
        ctx.font = font(500, 9);
        ctx.fillText("PADDING", PAD + 12, y + 9);

        // ── Right: radius + shadow, drawn ──
        const rx = PAD + colW + 12;
        roundRect(ctx, rx, y, colW, panelH, 10);
        ctx.fillStyle = t.panel;
        ctx.fill();
        ctx.strokeStyle = t.panelEdge;
        ctx.stroke();

        ctx.fillStyle = t.faint;
        ctx.font = font(500, 9);
        ctx.fillText("RADIUS & SHADOW", rx + 12, y + 9);

        const radiusPx = parseFloat(s.borderRadius) || 0;
        const dw2 = colW - 48, dh2 = panelH - 60;
        const dx = rx + 24, dy = y + 32;

        ctx.save();
        if (s.boxShadow && s.boxShadow !== "none") {
            // Approximate the captured shadow rather than inventing one.
            const m = String(s.boxShadow).match(
                /(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/
            );
            if (m) {
                ctx.shadowColor = m[1];
                ctx.shadowOffsetX = parseFloat(m[2]);
                ctx.shadowOffsetY = parseFloat(m[3]);
                ctx.shadowBlur = parseFloat(m[4]);
            }
        }
        roundRect(ctx, dx, dy, dw2, dh2, Math.min(radiusPx, dh2 / 2));
        ctx.fillStyle = s.background || t.bg;
        ctx.fill();
        ctx.restore();

        if (s.border) {
            ctx.strokeStyle = t.panelEdge;
            ctx.lineWidth = 1;
            roundRect(ctx, dx, dy, dw2, dh2, Math.min(radiusPx, dh2 / 2));
            ctx.stroke();
        }

        ctx.fillStyle = t.muted;
        ctx.font = font(600, 10, MONO);
        ctx.textAlign = "center";
        ctx.fillText(String(s.borderRadius || "0px"), dx + dw2 / 2, dy + dh2 / 2 - 5);
        ctx.textAlign = "left";
    }

    y += panelH + 18;
    return y - start;
}

function states(ctx, t, d, y, paint) {
    const st = d.states || {};
    const names = Object.keys(st);
    if (!names.length) return 0;

    const start = y;
    y += sectionTitle(ctx, t, "Interaction states", y, paint);

    for (const name of names) {
        const diff = st[name];
        const entries = Object.entries(diff).slice(0, 4);

        if (paint) {
            ctx.fillStyle = t.accent;
            ctx.font = font(700, 11, MONO);
            ctx.textBaseline = "top";
            ctx.fillText(`:${name}`, PAD, y);
        }
        y += 18;

        for (const [prop, change] of entries) {
            if (paint) {
                ctx.fillStyle = t.muted;
                ctx.font = font(400, 11, MONO);
                ctx.fillText(truncate(ctx, prop, 150), PAD + 8, y);

                ctx.fillStyle = t.faint;
                const fromTxt = truncate(ctx, String(change.from), 145);
                ctx.fillText(fromTxt, PAD + 168, y);

                ctx.fillStyle = t.accent;
                ctx.fillText("→", PAD + 320, y);

                ctx.fillStyle = t.text;
                ctx.fillText(truncate(ctx, String(change.to), 190), PAD + 340, y);
            }
            y += 16;
        }
        y += 8;
    }

    return y - start;
}

function contrastRow(ctx, t, d, y, paint) {
    const fails = (d.contrast || []).filter((c) => !c.passesAA);
    if (!fails.length) return 0;

    const start = y;
    y += sectionTitle(ctx, t, "Contrast warnings", y, paint);

    for (const c of fails.slice(0, 3)) {
        if (paint) {
            roundRect(ctx, PAD, y, 22, 14, 3);
            ctx.fillStyle = c.background;
            ctx.fill();
            ctx.strokeStyle = t.panelEdge;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = c.foreground;
            ctx.font = font(700, 9);
            ctx.textBaseline = "top";
            ctx.fillText("Aa", PAD + 4, y + 3);

            ctx.fillStyle = t.text;
            ctx.font = font(400, 11, MONO);
            ctx.fillText(`${c.foreground} on ${c.background}`, PAD + 32, y + 1);

            ctx.fillStyle = t.bad;
            ctx.font = font(700, 11, MONO);
            const label = `${c.ratio}:1 · below ${c.threshold}:1`;
            ctx.fillText(label, W - PAD - ctx.measureText(label).width, y + 1);
        }
        y += 20;
    }

    return y - start + 4;
}

function footer(ctx, t, d, y, paint) {
    const start = y;
    if (paint) {
        ctx.strokeStyle = t.rule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD, y);
        ctx.lineTo(W - PAD, y);
        ctx.stroke();

        ctx.fillStyle = t.faint;
        ctx.font = font(400, 10);
        ctx.textBaseline = "top";
        const when = new Date(d.capturedAt).toISOString().slice(0, 10);
        ctx.fillText(`Captured ${when} · ${d.nodeCount} elements`, PAD, y + 12);

        const mark = "Sharpshooter";
        ctx.fillText(mark, W - PAD - ctx.measureText(mark).width, y + 12);
    }
    return 34 + (y - start);
}

// ─── Compose ─────────────────────────────────────────────────────────────────

export async function renderDesignCard(dossier, screenshotBase64, opts = {}) {
    const t = THEMES[opts.theme === "dark" ? "dark" : "light"];

    let bitmap = null;
    if (screenshotBase64) {
        try {
            const blob = await (
                await fetch(`data:image/png;base64,${screenshotBase64}`)
            ).blob();
            bitmap = await createImageBitmap(blob);
        } catch (e) {
            console.warn("design card: could not decode screenshot:", e);
        }
    }

    const ground =
        dossier.context &&
        dossier.context.groundColor &&
        dossier.context.groundColor.hex;

    // Section list is walked twice — measure, then paint — so the canvas is
    // sized to its content instead of guessing and cropping.
    const run = async (ctx, paint) => {
        let y = PAD;
        y += header(ctx, t, dossier, y, paint);
        y += await hero(ctx, t, bitmap, ground, y, paint);
        y += palette(ctx, t, dossier.aggregates.palette, y, paint);
        y += typography(ctx, t, dossier.aggregates.typeStyles, y, paint);
        y += geometry(ctx, t, dossier, y, paint);
        y += states(ctx, t, dossier, y, paint);
        y += contrastRow(ctx, t, dossier, y, paint);
        y += footer(ctx, t, dossier, y, paint);
        return y + PAD - 20;
    };

    const measureCanvas = new OffscreenCanvas(W, 10);
    const totalH = Math.ceil(await run(measureCanvas.getContext("2d"), false));

    const canvas = new OffscreenCanvas(W * SCALE, totalH * SCALE);
    const ctx = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, W, totalH);
    await run(ctx, true);

    if (bitmap) bitmap.close();

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}
