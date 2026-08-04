// Exports one design card: the element, captured at full quality, laid out
// with the spec the live card was already showing.
//
// Two things here are deliberate reversals of how the old zip-producing
// version worked, and both follow from the card now being live in the page:
//
//   1. **The resolution preset is ignored.** Emulating a different viewport
//      would relayout the page, and the card's numbers were gathered from the
//      layout the user is actually looking at. A screenshot that disagrees
//      with the spec printed next to it is worse than a lower-resolution one,
//      so capture happens at the live viewport and the quality multiplier is
//      applied as deviceScaleFactor only — pixel density, not layout.
//   2. **Nothing is re-collected.** The scan travels in from the content
//      script. Re-running it here, inside the emulated session, would produce
//      a card that differs from the one the user froze and approved.
//
// The one thing this path *adds* is rendered-font ground truth, which needs a
// debugger attach and so can only exist here. See platformFonts below.

import { withElementSession } from "../../screenshots/elementSelect/elementSession.js";
import { renderDesignCard } from "./cardRenderer.js";

// ─── Rendered fonts ──────────────────────────────────────────────────────────
//
// CSS.getPlatformFontsForNode is what powers DevTools' "Rendered Fonts" panel:
// the actual faces the renderer resolved, with a glyph count each. It is the
// only way to see per-glyph fallback — Latin from one family, emoji from
// another — which no amount of document.fonts.check() in the page can predict.
//
// The live card can't have this (it would mean attaching the debugger, and
// therefore raising the yellow banner, on every click), so the exported card is
// slightly more accurate than the one on screen. Entirely best-effort: a page
// that blocks CDP simply keeps the scan's own resolution.
async function platformFonts(cdp, marker) {
    try {
        await cdp("DOM.enable");
        await cdp("CSS.enable");
        const doc = await cdp("DOM.getDocument", { depth: -1, pierce: false });
        const rootId = doc?.root?.nodeId;
        if (!rootId || !marker) return null;

        const found = await cdp("DOM.querySelector", {
            nodeId: rootId,
            selector: `[data-sharpshooter-target="${marker}"]`,
        });
        if (!found?.nodeId) return null;

        const res = await cdp("CSS.getPlatformFontsForNode", {
            nodeId: found.nodeId,
        });
        return res?.fonts?.length ? res.fonts : null;
    } catch (e) {
        console.warn("design: platform fonts unavailable:", e?.message);
        return null;
    }
}

// Upgrades the scan's stack-walk guess with what actually rendered. Families
// the scan predicted get their source corrected; families it couldn't predict
// (fallback faces picked per-glyph) are appended, since their presence is
// usually the interesting part — it means the primary font didn't cover the
// text.
function mergePlatformFonts(families, platform) {
    if (!platform) return families;

    const merged = families.map((fam) => ({ ...fam }));
    const claimed = new Set();

    for (const fam of merged) {
        const match = platform.find(
            (p) =>
                p.familyName &&
                p.familyName.toLowerCase() === fam.resolved.toLowerCase()
        );
        if (match) {
            claimed.add(match.familyName);
            fam.source = match.isCustomFont ? "webfont" : "local";
            fam.glyphCount = match.glyphCount;
            fam.verified = true;
        }
    }

    for (const p of platform) {
        if (!p.familyName || claimed.has(p.familyName)) continue;
        // A face carrying only a handful of glyphs is a fallback for a few
        // characters, not part of the component's type system.
        if ((p.glyphCount || 0) < 4) continue;
        merged.push({
            resolved: p.familyName,
            source: p.isCustomFont ? "webfont" : "local",
            stack: [],
            styles: [],
            count: 0,
            glyphCount: p.glyphCount,
            verified: true,
            fallback: true,
        });
    }

    return merged.sort(
        (a, b) => (b.glyphCount || b.count || 0) - (a.glyphCount || a.count || 0)
    );
}

// ─── Naming ──────────────────────────────────────────────────────────────────

function pad(n) {
    return String(n).padStart(2, "0");
}

function baseNameFor(scan) {
    let host = "page";
    try {
        host = new URL(scan.url).hostname.replace(/^www\./, "");
    } catch { /* keep default */ }
    const d = new Date();
    const stamp =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `design-${host}-${scan.role || "element"}-${stamp}`;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function captureDesignCard({
    tabId,
    xpath,
    marker,
    scan,
    raster,
    picked,
    viewport,
    deviceScaleFactor,
}) {
    // Live viewport, quality multiplier only. See the header note on why the
    // resolution preset is deliberately not consulted.
    const deviceMetrics = {
        width: Math.max(1, Math.round(viewport?.width || 0)) || 1280,
        height: Math.max(1, Math.round(viewport?.height || 0)) || 800,
        deviceScaleFactor: deviceScaleFactor || 2,
        mobile: false,
    };

    const { screenshot, fonts } = await withElementSession(
        { tabId, xpath, marker, deviceMetrics },
        async ({ captureCropped, cdp }) => {
            const shot = await captureCropped();
            const platform = await platformFonts(cdp, marker);
            return { screenshot: shot, fonts: platform };
        }
    );

    const enriched = {
        ...scan,
        families: mergePlatformFonts(scan.families || [], fonts),
    };

    const cardBase64 = await renderDesignCard({
        scan: enriched,
        raster: raster || [],
        picked: picked || [],
        screenshotBase64: screenshot,
        theme: "light",
    });

    const { filenamePrefix } = await chrome.storage.local.get("filenamePrefix");
    const prefix = (filenamePrefix || "").trim();
    const base = baseNameFor(scan);
    const stem = prefix ? `${prefix}-${base}` : base;

    await chrome.downloads.download({
        url: `data:image/png;base64,${cardBase64}`,
        filename: `${stem}.png`,
        saveAs: true,
    });

    return { baseName: stem, fontsVerified: !!fonts };
}
