// Orchestrates one Extract Design run.
//
// Ordering here is load-bearing:
//
//   1. Screenshot FIRST, before the collector runs. The collector injects a
//      hidden about:blank iframe to read UA-default styles; screenshotting
//      after that would risk it appearing in the PNG, and more importantly
//      the screenshot must depict the page in the same untouched state the
//      styles describe.
//   2. Collect via CDP Runtime.evaluate on the *same* debugger channel as the
//      screenshot, inside the same emulated session. Emulation can cross a
//      responsive breakpoint, so a dossier gathered before emulation would
//      document a layout the PNG doesn't show.
//   3. Sample interaction states last — forcing :hover mutates what the page
//      renders, so nothing that describes the resting state may run after it.

import { withElementSession } from "../../screenshots/elementSelect/elementSession.js";
import {
    buildCollectorExpression,
    buildStateProbeExpression,
    STATE_PROPS,
} from "./collector.js";
import { resolveDesignOptions, DESIGN_LIMITS } from "./designExtractOptions.js";
import { buildSpecSheet } from "./specSheet.js";
import { renderDesignCard } from "./cardRenderer.js";
import { buildZip } from "../legalCapture/zipWriter.js";
import { base64ToBytes, bytesToBase64 } from "../binary.js";

// Interaction states worth sampling, in the order a user encounters them.
const SAMPLED_STATES = ["hover", "focus", "active"];

// ─── CDP state forcing ───────────────────────────────────────────────────────
//
// CSS.forcePseudoState is what DevTools' ":hov" checkbox drives. It's the only
// way to observe a hover style without a real pointer — page JS cannot force a
// pseudo-class, which is why a static getComputedStyle pass can never answer
// "what does this look like on hover".
async function resolveNodeId(cdp, marker, xpath) {
    await cdp("DOM.enable");
    await cdp("CSS.enable");
    const doc = await cdp("DOM.getDocument", { depth: -1, pierce: false });
    const rootId = doc?.root?.nodeId;
    if (!rootId) return null;

    if (marker) {
        const found = await cdp("DOM.querySelector", {
            nodeId: rootId,
            selector: `[data-sharpshooter-target="${marker}"]`,
        });
        if (found?.nodeId) return found.nodeId;
    }
    // No CDP equivalent of an XPath query on DOM domain; the marker is the
    // reliable path and it's set on every commit, so this is only reached if
    // the page stripped the attribute.
    return null;
}

async function probeState(cdp, marker, xpath) {
    const res = await cdp("Runtime.evaluate", {
        expression: buildStateProbeExpression({ marker, xpath }),
        returnByValue: true,
    });
    const value = res?.result?.value;
    return value?.ok ? value.values : null;
}

// Returns { hover: {prop: {from, to}}, focus: {...}, active: {...} } holding
// only properties that actually changed. Entirely best-effort: a page that
// blocks CDP, or a browser without the CSS domain, yields an empty object and
// the package simply says states weren't captured.
async function sampleInteractionStates(cdp, marker, xpath) {
    const out = {};
    let nodeId = null;
    try {
        nodeId = await resolveNodeId(cdp, marker, xpath);
    } catch (e) {
        console.warn("design: CSS domain unavailable, skipping states:", e?.message);
        return { states: out, supported: false };
    }
    if (!nodeId) return { states: out, supported: false };

    let resting;
    try {
        resting = await probeState(cdp, marker, xpath);
    } catch {
        return { states: out, supported: false };
    }
    if (!resting) return { states: out, supported: false };

    for (const state of SAMPLED_STATES) {
        try {
            await cdp("CSS.forcePseudoState", {
                nodeId,
                forcedPseudoClasses: [state],
            });
            const values = await probeState(cdp, marker, xpath);
            if (!values) continue;
            const diff = {};
            for (const prop of STATE_PROPS) {
                if (values[prop] !== resting[prop]) {
                    diff[prop] = { from: resting[prop], to: values[prop] };
                }
            }
            if (Object.keys(diff).length) out[state] = diff;
        } catch (e) {
            console.warn(`design: could not force :${state}:`, e?.message);
        }
    }

    // Always clear, even if a probe threw midway — leaving a node stuck in
    // forced :active would visibly corrupt the page the user is still on.
    try {
        await cdp("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    } catch { /* detach will clear it anyway */ }

    return { states: out, supported: true, resting };
}

// ─── Packaging ───────────────────────────────────────────────────────────────

function pad(n) {
    return String(n).padStart(2, "0");
}

function slugFromDossier(dossier) {
    const role = dossier?.element?.role || "element";
    let host = "page";
    try {
        host = new URL(dossier.page.url).hostname.replace(/^www\./, "");
    } catch { /* keep default */ }
    const d = new Date();
    const stamp =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `design-${host}-${role}-${stamp}`;
}

// Assembles whichever artifacts the options enabled. A single selected
// artifact downloads bare — zipping one file just adds a step for the user.
export async function buildDesignArtifacts(dossier, screenshotBase64, options) {
    const encoder = new TextEncoder();
    const files = [];

    if (options.screenshot && screenshotBase64) {
        files.push({
            name: "screenshot.png",
            data: base64ToBytes(screenshotBase64),
            mime: "image/png",
        });
    }

    let cardBase64 = null;
    if (options.card) {
        try {
            cardBase64 = await renderDesignCard(dossier, screenshotBase64, {
                theme: options.cardTheme,
            });
            files.push({
                name: "card.png",
                data: base64ToBytes(cardBase64),
                mime: "image/png",
            });
        } catch (e) {
            console.warn("design: card render failed:", e);
        }
    }

    if (options.specSheet) {
        files.push({
            name: "design.md",
            data: encoder.encode(buildSpecSheet(dossier)),
            mime: "text/markdown",
        });
    }

    if (options.designJson) {
        files.push({
            name: "design.json",
            data: encoder.encode(JSON.stringify(dossier, null, 2)),
            mime: "application/json",
        });
    }

    return { files, cardBase64 };
}

async function deliver(files, baseName) {
    if (!files.length) {
        throw new Error(
            "No artifacts are enabled in Design Settings — nothing to produce."
        );
    }

    const { filenamePrefix } = await chrome.storage.local.get("filenamePrefix");
    const prefix = (filenamePrefix || "").trim();
    const stem = prefix ? `${prefix}-${baseName}` : baseName;

    // Single artifact: hand it over directly rather than making the user
    // unzip a one-item archive.
    if (files.length === 1) {
        const only = files[0];
        const ext = only.name.slice(only.name.lastIndexOf("."));
        return chrome.downloads.download({
            url: `data:${only.mime};base64,${bytesToBase64(only.data)}`,
            filename: `${stem}${ext}`,
            saveAs: true,
        });
    }

    const zip = buildZip(files.map((f) => ({ name: f.name, data: f.data })));
    return chrome.downloads.download({
        url: `data:application/zip;base64,${bytesToBase64(zip)}`,
        filename: `${stem}.zip`,
        saveAs: true,
    });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function extractDesignFromElement({
    tabId,
    xpath,
    marker,
    deviceMetrics,
    screenshotSuffix,
}) {
    const stored = await chrome.storage.local.get("designExtractOptions");
    const options = resolveDesignOptions(stored.designExtractOptions);

    const { dossier, screenshot } = await withElementSession(
        { tabId, xpath, marker, deviceMetrics },
        async ({ captureCropped, cdp, rect, metrics }) => {
            // 1. Pixels first — before the collector adds its probe iframe.
            let screenshotBase64 = null;
            if (options.screenshot || options.card) {
                screenshotBase64 = await captureCropped();
            }

            // 2. Resting-state dossier, same channel, same emulated layout.
            const evaluated = await cdp("Runtime.evaluate", {
                expression: buildCollectorExpression({
                    marker,
                    xpath,
                    limits: DESIGN_LIMITS,
                    options,
                }),
                returnByValue: true,
            });

            if (evaluated?.exceptionDetails) {
                const msg =
                    evaluated.exceptionDetails.exception?.description ||
                    evaluated.exceptionDetails.text ||
                    "Runtime.evaluate failed";
                throw new Error(`Design collection failed: ${msg}`);
            }

            const collected = evaluated?.result?.value;
            if (!collected || !collected.ok) {
                throw new Error(
                    "Could not re-locate the selected element after emulation " +
                        `(${collected?.reason || "unknown"}). The page likely ` +
                        "rebuilt its layout at the emulated resolution — try the " +
                        "User preset, or re-select the element."
                );
            }

            // 3. Interaction states last: forcing :hover changes the render.
            if (options.sampleStates) {
                const { states, supported } = await sampleInteractionStates(
                    cdp,
                    marker,
                    xpath
                );
                collected.states = states;
                collected.statesSupported = supported;
            } else {
                collected.states = {};
                collected.statesSupported = null;
            }

            collected.capture = {
                emulatedWidth: metrics.width,
                emulatedHeight: metrics.height,
                deviceScaleFactor: metrics.deviceScaleFactor,
                elementRect: {
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                },
            };

            return { dossier: collected, screenshot: screenshotBase64 };
        }
    );

    const { files, cardBase64 } = await buildDesignArtifacts(
        dossier,
        screenshot,
        options
    );

    const baseName = slugFromDossier(dossier);
    await deliver(files, baseName);

    return { dossier, cardBase64, baseName, artifactCount: files.length };
}
