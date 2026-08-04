// Dominant-colour extraction from rendered pixels.
//
// Why a screenshot rather than fetching the page's image files:
//
//   * It reports the colour that is actually *painted* — after filters,
//     opacity, blend modes, and object-fit cropping. A source file's palette
//     routinely contains colours that never reach the screen.
//   * It covers <canvas>, <video>, WebGL, SVG and CSS gradients uniformly.
//     Fetching only ever covers <img> and background-image.
//   * It makes no network request and hits no CORS wall, so Extract Design
//     stays entirely local — see CLAUDE.md's constraint list.
//
// chrome.tabs.captureVisibleTab needs `activeTab` or host permission, both of
// which this extension already holds, and — unlike CDP Page.captureScreenshot
// — attaches no debugger, so sampling never raises the yellow banner. It is
// quota-throttled to roughly two calls a second, which is why this runs on
// freeze and never on hover.

// Long edge of the downsampled buffer the histogram is built from. Quantizers
// downsample first anyway; at this size a component's palette is fully
// described and JPEG/scaling noise averages out instead of arriving as phantom
// swatches.
const SAMPLE_EDGE = 160;
const SWATCH_COUNT = 6;
// Two output swatches closer than this in RGB space are the same colour as far
// as a human reading the card is concerned.
const MERGE_DISTANCE = 34;
// Below this alpha a pixel is showing the page behind the element, not the
// element.
const MIN_ALPHA = 128;
// A box this uniform holds one colour, and splitting it anyway invents a
// boundary where the image has none. Without this guard a flat three-colour
// component still gets carved into SWATCH_COUNT boxes, and the extra
// boundaries land *between* real colours — reporting a violet-white average
// that appears nowhere on screen.
const MIN_BOX_RANGE = 14;
// Swatches this marginal after true-coverage counting are quantization
// residue, not part of the component's palette.
const MIN_SHARE = 2;

export async function captureViewportBitmap(windowId) {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "png",
    });
    const blob = await (await fetch(dataUrl)).blob();
    return createImageBitmap(blob);
}

// ─── Median cut ──────────────────────────────────────────────────────────────
//
// Chosen over k-means because it is deterministic (the same element always
// yields the same swatches, which matters when the output is a spec someone
// quotes) and needs no iteration count tuning.

function boxFor(pixels, indices) {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const i of indices) {
        const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
        if (g < gMin) gMin = g;
        if (g > gMax) gMax = g;
        if (b < bMin) bMin = b;
        if (b > bMax) bMax = b;
    }
    return {
        indices,
        ranges: [rMax - rMin, gMax - gMin, bMax - bMin],
    };
}

function splitBox(pixels, box) {
    const channel = box.ranges.indexOf(Math.max(...box.ranges));
    const sorted = [...box.indices].sort(
        (a, b) => pixels[a * 3 + channel] - pixels[b * 3 + channel]
    );
    const mid = Math.floor(sorted.length / 2);
    if (mid === 0 || mid === sorted.length) return null;
    return [
        boxFor(pixels, sorted.slice(0, mid)),
        boxFor(pixels, sorted.slice(mid)),
    ];
}

function averageOf(pixels, indices) {
    let r = 0, g = 0, b = 0;
    for (const i of indices) {
        r += pixels[i * 3];
        g += pixels[i * 3 + 1];
        b += pixels[i * 3 + 2];
    }
    const n = indices.length;
    return { r: r / n, g: g / n, b: b / n, count: n };
}

function toHex(c) {
    const h = (n) =>
        Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

function distance(a, b) {
    return Math.sqrt(
        (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2
    );
}

function quantize(pixels, pixelCount, wanted) {
    if (!pixelCount) return [];

    const all = new Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) all[i] = i;

    let boxes = [boxFor(pixels, all)];
    while (boxes.length < wanted) {
        // Always split the box spanning the widest channel range: that's where
        // the image still holds distinguishable colour. A box already below
        // MIN_BOX_RANGE holds one colour and is left whole, which is what
        // stops a flat palette being carved into invented in-between tones.
        boxes.sort(
            (a, b) =>
                Math.max(...b.ranges) * b.indices.length -
                Math.max(...a.ranges) * a.indices.length
        );
        const target = boxes.find(
            (box) =>
                box.indices.length > 1 && Math.max(...box.ranges) >= MIN_BOX_RANGE
        );
        if (!target) break;
        const split = splitBox(pixels, target);
        if (!split) break;
        boxes = boxes.filter((box) => box !== target).concat(split);
    }

    let centres = boxes.map((box) => averageOf(pixels, box.indices));

    // Merge visually identical centres before counting, so two boxes that
    // landed on the same colour don't split its coverage in half.
    const merged = [];
    for (const c of centres.sort((a, b) => b.count - a.count)) {
        const near = merged.find((m) => distance(m, c) < MERGE_DISTANCE);
        if (near) {
            const total = near.count + c.count;
            near.r = (near.r * near.count + c.r * c.count) / total;
            near.g = (near.g * near.count + c.g * c.count) / total;
            near.b = (near.b * near.count + c.b * c.count) / total;
            near.count = total;
        } else {
            merged.push({ ...c });
        }
    }
    centres = merged;
    if (!centres.length) return [];

    // Median cut splits boxes at the *median*, so every box ends up holding
    // roughly the same number of pixels — box size says nothing about how much
    // of the image a colour actually covers. Reassigning every pixel to its
    // nearest surviving centre is what turns these into real coverage figures,
    // and it is one cheap pass over a buffer already capped at SAMPLE_EDGE².
    const counts = new Array(centres.length).fill(0);
    for (let i = 0; i < pixelCount; i++) {
        const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
        let best = 0;
        let bestD = Infinity;
        for (let c = 0; c < centres.length; c++) {
            const d =
                (r - centres[c].r) ** 2 +
                (g - centres[c].g) ** 2 +
                (b - centres[c].b) ** 2;
            if (d < bestD) {
                bestD = d;
                best = c;
            }
        }
        counts[best]++;
    }

    return centres
        .map((c, i) => ({
            hex: toHex(c),
            share: Math.round((counts[i] / pixelCount) * 100),
            count: counts[i],
        }))
        .filter((s) => s.share >= MIN_SHARE)
        .sort((a, b) => b.count - a.count)
        .map(({ hex, share }) => ({ hex, share }));
}

// ─── Entry point ─────────────────────────────────────────────────────────────
//
// `clip` is CSS-pixel, viewport-relative — the same coordinate space
// getBoundingClientRect works in, and the same reason element capture measures
// in the viewport rather than trusting CDP page-absolute coordinates.
// The scale factor is derived from the bitmap itself rather than from a
// reported devicePixelRatio, because browser zoom and OS scaling both move
// that number independently of what captureVisibleTab actually returns.
export async function sampleRenderedPalette({ windowId, clip, viewport }) {
    const bitmap = await captureViewportBitmap(windowId);

    try {
        const scale =
            viewport?.width > 0 ? bitmap.width / viewport.width : 1;

        const sx = Math.max(0, Math.round(clip.x * scale));
        const sy = Math.max(0, Math.round(clip.y * scale));
        const sw = Math.max(
            1,
            Math.min(Math.round(clip.width * scale), bitmap.width - sx)
        );
        const sh = Math.max(
            1,
            Math.min(Math.round(clip.height * scale), bitmap.height - sy)
        );

        const ratio = Math.min(1, SAMPLE_EDGE / Math.max(sw, sh));
        const dw = Math.max(1, Math.round(sw * ratio));
        const dh = Math.max(1, Math.round(sh * ratio));

        const canvas = new OffscreenCanvas(dw, dh);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);

        const { data } = ctx.getImageData(0, 0, dw, dh);
        const pixels = new Uint8Array((data.length / 4) * 3);
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < MIN_ALPHA) continue;
            pixels[n * 3] = data[i];
            pixels[n * 3 + 1] = data[i + 1];
            pixels[n * 3 + 2] = data[i + 2];
            n++;
        }

        return quantize(pixels, n, SWATCH_COUNT);
    } finally {
        bitmap.close();
    }
}
