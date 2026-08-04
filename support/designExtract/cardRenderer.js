// Renders the downloaded artifact: the captured element and its spec card as
// one image.
//
// Why canvas and not HTML: a service worker has no DOM, and an offscreen
// document can't be screenshotted. The live card in the page is real DOM
// (contentScripts/designInspector.js) because it has to be clickable; this is
// the same card drawn a second time because the export path has no DOM to
// screenshot. The two are deliberately driven from the same scan object, and
// section order here mirrors the live card's — when one changes, change both.
//
// Layout runs in two passes over the same section list: a measure pass to
// compute total height, then a paint pass into a correctly-sized canvas. That
// is what lets the canvas be sized to its content instead of guessed at and
// cropped.

import { bytesToBase64 } from "../binary.js";

const W = 620;                 // logical width; output is W × SCALE
const SCALE = 2;
const PAD = 32;
const SWATCH = 54;
const MAX_HERO_H = 380;

const THEMES = {
    light: {
        bg: "#FFFFFF",
        panel: "#F8FAFC",
        panelEdge: "#E9EEF5",
        text: "#0F172A",
        muted: "#64748B",
        faint: "#94A3B8",
        rule: "#E2E8F0",
        accent: "#7C3AED",
        accentSoft: "#F3E8FF",
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
        accentSoft: "#2A1F45",
    },
};

// Generic families only. A worker cannot load webfonts, and naming one that
// isn't installed silently falls back anyway — so ask for the system stack and
// let each platform answer with its own.
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

function truncate(ctx, text, maxWidth) {
    let s = String(text ?? "");
    if (ctx.measureText(s).width <= maxWidth) return s;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) {
        s = s.slice(0, -1);
    }
    return `${s}…`;
}

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

// ─── Sections ────────────────────────────────────────────────────────────────
//
// Each returns the height it occupies. With `paint` false nothing is drawn —
// the same code path measures, so a layout change can't desync the two.

function sectionTitle(ctx, t, label, count, y, paint) {
    if (paint) {
        ctx.textBaseline = "top";
        ctx.fillStyle = t.faint;
        ctx.font = font(700, 10);
        const text = label.toUpperCase();
        ctx.fillText(text, PAD, y);
        let x = PAD + ctx.measureText(text).width + 8;

        if (count != null) {
            ctx.font = font(500, 10, MONO);
            ctx.fillText(String(count), x, y);
            x += ctx.measureText(String(count)).width + 8;
        }

        ctx.strokeStyle = t.rule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + 5.5);
        ctx.lineTo(W - PAD, y + 5.5);
        ctx.stroke();
    }
    return 22;
}

function header(ctx, t, scan, y, paint) {
    const start = y;
    const title = scan.role.charAt(0).toUpperCase() + scan.role.slice(1);

    if (paint) {
        ctx.textBaseline = "top";
        ctx.fillStyle = t.text;
        ctx.font = font(700, 25);
        ctx.fillText(title, PAD, y);

        ctx.font = font(500, 12, MONO);
        const sel = truncate(ctx, scan.selector, 230);
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
    y += 33;

    if (paint) {
        ctx.fillStyle = t.muted;
        ctx.font = font(400, 12);
        let host = scan.url;
        try { host = new URL(scan.url).hostname.replace(/^www\./, ""); } catch { /* raw */ }
        ctx.fillText(truncate(ctx, host, W - PAD * 2), PAD, y);
    }
    y += 22;

    return y - start;
}

function hero(ctx, t, bitmap, y, paint) {
    if (!bitmap) return 0;
    const boxW = W - PAD * 2;
    const scale = Math.min(boxW / bitmap.width, MAX_HERO_H / bitmap.height, 1);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    const boxH = Math.max(dh + 28, 72);

    if (paint) {
        roundRect(ctx, PAD, y, boxW, boxH, 10);
        ctx.fillStyle = t.panel;
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

const SOURCE_LABEL = {
    webfont: "WEBFONT",
    local: "INSTALLED",
    generic: "GENERIC",
    unresolved: "NOT LOADED",
};

// The resolved face leads and the declared stack sits under it in muted type.
// Reporting the stack alone is the trap this whole section exists to close: a
// page asking for a font that never loaded would otherwise be documented as
// using it.
function fonts(ctx, t, scan, y, paint) {
    const families = scan.families || [];
    const start = y;
    y += sectionTitle(ctx, t, "Fonts", families.length || null, y, paint);

    if (!families.length) {
        if (paint) {
            ctx.fillStyle = t.faint;
            ctx.font = font(400, 12);
            ctx.textBaseline = "top";
            ctx.fillText("No text in this element.", PAD, y);
        }
        return y + 20 - start;
    }

    for (const fam of families.slice(0, 4)) {
        if (paint) {
            ctx.textBaseline = "top";
            ctx.fillStyle = t.text;
            ctx.font = font(600, 15);
            const nameW = ctx.measureText(fam.resolved).width;
            ctx.fillText(fam.resolved, PAD, y);

            // Ground truth from the renderer, when the capture path could get
            // it — see designCaptureSession.js. Only present on the exported
            // card, never on the live one.
            const label = SOURCE_LABEL[fam.source] || "";
            if (label) {
                ctx.font = font(700, 9);
                const bw = ctx.measureText(label).width + 12;
                roundRect(ctx, PAD + nameW + 10, y + 2, bw, 15, 3);
                ctx.fillStyle =
                    fam.source === "webfont" ? t.accentSoft : t.panel;
                ctx.fill();
                ctx.fillStyle =
                    fam.source === "webfont" ? t.accent : t.muted;
                ctx.fillText(label, PAD + nameW + 16, y + 5);
            }
        }
        y += 20;

        if (paint) {
            const spec = (fam.styles || [])
                .slice(0, 4)
                .map((s) => `${s.size}px · ${s.weight}`)
                .join("    ");
            ctx.fillStyle = t.muted;
            ctx.font = font(500, 11, MONO);
            ctx.fillText(truncate(ctx, spec, W - PAD * 2), PAD, y);
        }
        y += 16;

        if (paint) {
            ctx.fillStyle = t.faint;
            ctx.font = font(400, 10.5, MONO);
            ctx.fillText(
                truncate(ctx, (fam.stack || []).join(", "), W - PAD * 2),
                PAD,
                y
            );
        }
        y += 20;
    }

    return y - start + 4;
}

function cssColors(ctx, t, scan, y, paint) {
    const colors = scan.colors || [];
    if (!colors.length) return 0;

    const start = y;
    y += sectionTitle(ctx, t, "CSS colours", colors.length, y, paint);

    const perRow = Math.floor((W - PAD * 2 + 10) / (SWATCH + 10));
    const shown = colors.slice(0, perRow * 2);
    let x = PAD;
    let rowTop = y;

    shown.forEach((c, i) => {
        if (i > 0 && i % perRow === 0) {
            x = PAD;
            rowTop += SWATCH + 34;
        }
        if (paint) {
            // Semi-transparent colours are drawn over a checkerboard, or a 10%
            // white and a 10% black read as the same near-white square.
            if (c.alpha < 1) {
                ctx.save();
                roundRect(ctx, x, rowTop, SWATCH, SWATCH, 7);
                ctx.clip();
                const sq = 7;
                for (let gy = 0; gy < SWATCH; gy += sq) {
                    for (let gx = 0; gx < SWATCH; gx += sq) {
                        ctx.fillStyle =
                            ((gx / sq + gy / sq) % 2 === 0) ? t.panel : t.panelEdge;
                        ctx.fillRect(x + gx, rowTop + gy, sq, sq);
                    }
                }
                ctx.restore();
            }

            roundRect(ctx, x, rowTop, SWATCH, SWATCH, 7);
            ctx.fillStyle = c.css;
            ctx.fill();
            ctx.strokeStyle = c.luminance > 0.85 ? t.panelEdge : "rgba(0,0,0,0)";
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.textBaseline = "top";
            ctx.fillStyle = t.text;
            ctx.font = font(600, 9.5, MONO);
            ctx.fillText(truncate(ctx, c.hex, SWATCH + 6), x, rowTop + SWATCH + 6);

            ctx.fillStyle = t.faint;
            ctx.font = font(400, 9);
            ctx.fillText(truncate(ctx, c.role || "", SWATCH + 6), x, rowTop + SWATCH + 19);
        }
        x += SWATCH + 10;
    });

    return rowTop + SWATCH + 34 - start;
}

// Deliberately a different shape from the CSS swatches above: bars with
// coverage percentages, its own titled section, and a caption saying where the
// numbers came from. These are averages of painted pixels, and a photo's
// average brown pasted into a stylesheet as a brand token is a real foot-gun.
const RASTER_CAPTION =
    "Averaged from the captured pixels — includes images, video and " +
    "gradients. These are measurements, not CSS values.";

function renderedPalette(ctx, t, raster, y, paint) {
    if (!raster || !raster.length) return 0;

    const start = y;
    y += sectionTitle(ctx, t, "Rendered palette", null, y, paint);

    const barH = 22;
    const chipW = 74;

    for (const s of raster) {
        if (paint) {
            roundRect(ctx, PAD, y, chipW, barH, 5);
            ctx.fillStyle = s.hex;
            ctx.fill();
            ctx.strokeStyle = t.panelEdge;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.textBaseline = "middle";
            ctx.fillStyle = t.text;
            ctx.font = font(500, 11.5, MONO);
            ctx.fillText(s.hex, PAD + chipW + 12, y + barH / 2);

            // The share bar, drawn to scale rather than only stated.
            const trackX = PAD + chipW + 100;
            const trackW = W - PAD - trackX - 46;
            roundRect(ctx, trackX, y + barH / 2 - 3, trackW, 6, 3);
            ctx.fillStyle = t.panel;
            ctx.fill();
            roundRect(
                ctx, trackX, y + barH / 2 - 3,
                Math.max(4, (trackW * s.share) / 100), 6, 3
            );
            ctx.fillStyle = t.accent;
            ctx.fill();

            ctx.fillStyle = t.muted;
            ctx.font = font(500, 11, MONO);
            const pct = `${s.share}%`;
            ctx.fillText(pct, W - PAD - ctx.measureText(pct).width, y + barH / 2);
            ctx.textBaseline = "top";
        }
        y += barH + 6;
    }

    y += 4;

    // The caption is wrapped in both passes, not measured in one and guessed
    // at in the other — a guess that comes up a line short crops the last line
    // of the card off the canvas.
    ctx.font = font(400, 10.5);
    const lines = wrap(ctx, RASTER_CAPTION, W - PAD * 2);
    if (paint) {
        ctx.fillStyle = t.faint;
        ctx.textBaseline = "top";
        for (const line of lines) {
            ctx.fillText(line, PAD, y);
            y += 14;
        }
    } else {
        y += lines.length * 14;
    }

    return y - start + 6;
}

// The user's own colours, picked with the eyedropper. Given the accent panel
// the two measured sections deliberately don't get: everything else on this
// card was observed, and this was authored. Same distinction the live card
// draws, for the same reason.
const PICKED_SWATCH = 46;

function pickedPalette(ctx, t, picked, y, paint) {
    if (!picked || !picked.length) return 0;

    const start = y;
    y += sectionTitle(ctx, t, "User pick", picked.length, y, paint);

    const perRow = Math.floor((W - PAD * 2 - 24 + 10) / (PICKED_SWATCH + 10));
    const rows = Math.ceil(Math.min(picked.length, perRow * 2) / perRow);
    const panelH = 12 + rows * (PICKED_SWATCH + 26) + 2;

    if (paint) {
        roundRect(ctx, PAD, y, W - PAD * 2, panelH, 10);
        ctx.fillStyle = t.accentSoft;
        ctx.fill();
        ctx.strokeStyle = t.accent;
        ctx.lineWidth = 1;
        ctx.stroke();

        let x = PAD + 12;
        let rowTop = y + 12;
        picked.slice(0, perRow * 2).forEach((hex, i) => {
            if (i > 0 && i % perRow === 0) {
                x = PAD + 12;
                rowTop += PICKED_SWATCH + 26;
            }
            roundRect(ctx, x, rowTop, PICKED_SWATCH, PICKED_SWATCH, 6);
            ctx.fillStyle = hex;
            ctx.fill();
            ctx.strokeStyle = t.panelEdge;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.textBaseline = "top";
            ctx.fillStyle = t.text;
            ctx.font = font(600, 9, MONO);
            ctx.fillText(
                truncate(ctx, hex, PICKED_SWATCH + 8),
                x,
                rowTop + PICKED_SWATCH + 6
            );
            x += PICKED_SWATCH + 10;
        });
    }

    y += panelH + 18;
    return y - start;
}

function footer(ctx, t, scan, y, paint) {
    if (paint) {
        ctx.strokeStyle = t.rule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD, y);
        ctx.lineTo(W - PAD, y);
        ctx.stroke();

        ctx.textBaseline = "top";
        ctx.fillStyle = t.faint;
        ctx.font = font(400, 10);
        const when = new Date().toISOString().slice(0, 10);
        const note = scan.truncated
            ? `${when} · first ${scan.nodeCount} elements`
            : `${when} · ${scan.nodeCount} elements`;
        ctx.fillText(note, PAD, y + 12);

        const mark = "Sharpshooter";
        ctx.fillText(mark, W - PAD - ctx.measureText(mark).width, y + 12);
    }
    return 34;
}

// ─── Compose ─────────────────────────────────────────────────────────────────

export async function renderDesignCard({
    scan,
    raster,
    picked,
    screenshotBase64,
    theme = "light",
}) {
    const t = THEMES[theme === "dark" ? "dark" : "light"];

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

    const run = (ctx, paint) => {
        let y = PAD;
        y += header(ctx, t, scan, y, paint);
        y += hero(ctx, t, bitmap, y, paint);
        y += fonts(ctx, t, scan, y, paint);
        y += cssColors(ctx, t, scan, y, paint);
        y += renderedPalette(ctx, t, raster, y, paint);
        y += pickedPalette(ctx, t, picked, y, paint);
        y += footer(ctx, t, scan, y, paint);
        return y + PAD - 12;
    };

    const measureCanvas = new OffscreenCanvas(W, 10);
    const totalH = Math.ceil(run(measureCanvas.getContext("2d"), false));

    const canvas = new OffscreenCanvas(W * SCALE, totalH * SCALE);
    const ctx = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, W, totalH);
    run(ctx, true);

    if (bitmap) bitmap.close();

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}
