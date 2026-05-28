const layoutGroupEl  = document.getElementById("layout-group");
const widthInput     = document.getElementById("width");
const heightInput    = document.getElementById("height");
const statusEl       = document.getElementById("status");
const popupEl        = document.querySelector(".popup");
const captureLabelEl = document.getElementById("capture-label");
const captureHintEl  = document.getElementById("capture-hint");

// Localized-string helper. Resolves through window.__i18n (see localize.js),
// which honors the Settings language override; positional substitutions
// ($1…$9) map to extra args. Falls back to the key if a message is missing.
const t = (key, ...subs) =>
    window.__i18n.get(key, subs.length ? subs.map(String) : undefined);

// User-configurable full-page height cap (Settings). Loaded from storage
// below; the built-in default keeps the UI sane before storage resolves.
let fullPageCap = 16000;

// Whether every capture should route to the crop editor (Settings →
// "Always open the crop editor"). Updated from storage on load.
let cropDefault = false;

// "User" / "Full Page" / "Vertical" presets size to the active tab's viewport
// (CSS pixels at the user's current zoom — what they actually see). The
// background fetches it from the tab on popup open; until that resolves, fall
// back to the popup's own screen dimensions so the UI never shows blank inputs.
let viewportWidth  = window.screen.width;
let viewportHeight = window.screen.height;

// Resolution presets are user-configurable (Settings → Resolution). Stored
// in chrome.storage.local under `resolutionPresets` as an array of:
//   { id, type, scale, hidden?, labelKey?, label?, width?, height? }
//
// `type` is one of:
//   - "viewport" : width = tab viewport w, height = tab viewport h
//   - "fullpage" : width = tab viewport w, height = measured page height (capped)
//   - "fixed"    : literal `width` × `height`, fully editable
//   - "custom"   : free-form, inputs editable on the main view
//
// `scale` is null (inherit Settings → Default quality multiplier) or 1/2/3/4.
// `hidden: true` removes the preset from the main view but keeps the row in
// the Settings editor. Every preset can be hidden; user-added presets are
// purged by the "Restore factory presets" button.
// `labelKey` (i18n key) is set for seeded presets so the language override
// re-localizes them; user-added presets carry a plain `label`.
const DEFAULT_PRESETS = [
    { id: "user",         type: "viewport", labelKey: "presetUser",       scale: null },
    { id: "fullpage",     type: "fullpage", labelKey: "presetFullPage",   scale: null },
    { id: "vertical",     type: "fixed",    labelKey: "presetVerticalHd", scale: null, width: 1920, height: 7000 },
    { id: "fullhd",       type: "fixed",    label: "FullHD",              scale: null, width: 1920, height: 1080 },
    { id: "horizontal4k", type: "fixed",    label: "4K",                  scale: null, width: 3840, height: 2160 },
    { id: "custom",       type: "custom",   labelKey: "presetCustom",     scale: null },
];

let presets = DEFAULT_PRESETS.map((p) => ({ ...p }));
let defaultScaleFactor = 2;

function presetLabel(p) {
    if (p.labelKey) {
        const v = window.__i18n?.get?.(p.labelKey);
        if (v && v !== p.labelKey) return v;
    }
    return p.label || p.id;
}

function getPreset(id) {
    return presets.find((p) => p.id === id);
}

function presetDimensions(p) {
    if (p.type === "viewport") return { width: viewportWidth, height: viewportHeight };
    if (p.type === "fullpage") return { width: viewportWidth, height: null };
    if (p.type === "fixed")    return { width: p.width, height: p.height };
    return null; // custom
}

// Persist the editable preset state. We strip the seeded `labelKey` only when
// the user has overwritten the label (not the case in current UI — label is
// read-only for seeded presets — but kept defensive).
function savePresets() {
    chrome.storage.local.set({ resolutionPresets: presets });
}

function saveDefaultScale() {
    chrome.storage.local.set({ defaultScaleFactor });
}

// ─── Capture overlay ──────────────────────────────────────────────────────────

function showCapturing(label, hint = "") {
    captureLabelEl.textContent = label;
    captureHintEl.textContent  = hint;
    captureHintEl.hidden       = !hint;
    popupEl.classList.add("is-capturing");
}

function stopCapturing() {
    popupEl.classList.remove("is-capturing");
}

// ─── Status helper ────────────────────────────────────────────────────────────

let statusTimer = null;
let statusTypeTimer = null;

const STATUS_CARET = '<span class="status-caret">_</span>';

function escapeStatus(s) {
    return String(s).replace(/[&<>]/g, (c) => (
        c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
    ));
}

// Typewriter readout — characters land one at a time and a blinking
// underscore trails the cursor like an old terminal.
function setStatus(msg, type = "busy", autoClear = 0) {
    clearTimeout(statusTimer);
    clearInterval(statusTypeTimer);
    statusTypeTimer = null;
    statusEl.className = `status ${type}`;

    if (!msg) {
        statusEl.innerHTML = "";
        actionLocked = false;
        renderCurrentHint();
        return;
    }

    actionLocked = true;

    const total = msg.length;
    // Speed scales with length so short toasts stay snappy and long
    // sentences still finish within ~600 ms.
    const stepMs = Math.max(12, Math.min(28, Math.round(520 / total)));
    let i = 0;

    const render = () => {
        statusEl.innerHTML = escapeStatus(msg.slice(0, i)) + STATUS_CARET;
    };

    render();
    statusTypeTimer = setInterval(() => {
        i += 1;
        render();
        if (i >= total) {
            clearInterval(statusTypeTimer);
            statusTypeTimer = null;
            if (autoClear > 0) {
                statusTimer = setTimeout(() => {
                    actionLocked = false;
                    renderCurrentHint();
                }, autoClear);
            }
        }
    }, stepMs);
}

// ─── Hints — bottom-bar tooltips ──────────────────────────────────────────────
//
// The status bar pulls double duty: action results (typewriter, autoClear) take
// priority; otherwise it shows context tips. On hover over a known control we
// render a per-control tip; with nothing hovered it cycles through general
// usage tips on a slow timer.

// Action status is currently displayed — hint renders are suppressed until it
// clears (autoClear timer, or setStatus("")).
let actionLocked = false;
let hoverTipKey  = null;
let generalIdx   = 0;
let generalTimer = null;
// Settings → "Show popup tooltips". When off, hover hints and rotating tips
// are suppressed and CSS hides the status row entirely (popup shrinks).
let tooltipsEnabled = true;

const BUTTON_TIPS = [
    ["#capture-auto",         "tipAutoCapture"],
    ["#capture-auto-crop",    "tipCropSegment"],
    ["#capture-page",         "tipPageCapture"],
    ["#capture-page-crop",    "tipCropSegment"],
    ["#capture-element",      "tipCaptureElement"],
    ["#capture-element-crop", "tipCropSegment"],
    ["#capture-site",         "tipCaptureSite"],
    ["#capture-site-crop",    "tipCropSegment"],
    ["#dom-killer",           "tipRemoveElements"],
    ["#help-toggle",          "tipHelp"],
    ["#settings-toggle",      "tipSettings"],
    ["#width",                "tipResolution"],
    ["#height",               "tipResolution"],
    ["#layout-group",         "tipPresets"],
];

// Generic rotating tips live in tips/genericTips.json so they can be edited
// freely without touching the locked-down messages.json schema. Shape:
// { "en": ["Tip: …", …], "ru": [...], … }. Locales fall back to "en".
let GENERAL_TIPS = [];

function currentLangCode() {
    const override = window.__i18n?.lang;
    const raw = (override && override !== "auto")
        ? override
        : (chrome.i18n.getUILanguage?.() || navigator.language || "en");
    return String(raw).split("-")[0].toLowerCase();
}

async function loadGenericTips() {
    try {
        const url = chrome.runtime.getURL("tips/genericTips.json");
        const res = await fetch(url);
        const data = await res.json();
        const lang = currentLangCode();
        const list = Array.isArray(data[lang]) ? data[lang]
                   : Array.isArray(data.en)   ? data.en
                   : [];
        GENERAL_TIPS = list.filter((s) => typeof s === "string" && s.length > 0);
    } catch {
        GENERAL_TIPS = [];
    }
}

function applyTooltipsEnabled(on) {
    tooltipsEnabled = !!on;
    popupEl.classList.toggle("no-tooltips", !tooltipsEnabled);
    if (!tooltipsEnabled) {
        if (generalTimer) { clearInterval(generalTimer); generalTimer = null; }
        clearTimeout(statusTimer);
        clearInterval(statusTypeTimer);
        statusTypeTimer = null;
        hoverTipKey = null;
        statusEl.innerHTML = "";
        statusEl.className = "status";
    } else if (!generalTimer) {
        startGeneralTipRotation();
    }
}

function renderHintText(text) {
    if (actionLocked || !tooltipsEnabled) return;
    clearTimeout(statusTimer);
    clearInterval(statusTypeTimer);
    statusTypeTimer = null;
    statusEl.className = "status hint";

    if (!text) {
        statusEl.innerHTML = "";
        return;
    }

    // Same typewriter + blinking caret used by setStatus, so hints feel
    // continuous with action readouts — just without the autoClear.
    const total = text.length;
    const stepMs = Math.max(10, Math.min(24, Math.round(520 / total)));
    let i = 0;
    const render = () => {
        statusEl.innerHTML = escapeStatus(text.slice(0, i)) + STATUS_CARET;
    };
    render();
    statusTypeTimer = setInterval(() => {
        i += 1;
        render();
        if (i >= total) {
            clearInterval(statusTypeTimer);
            statusTypeTimer = null;
        }
    }, stepMs);
}

function currentGeneralTipText() {
    if (!GENERAL_TIPS.length) return "";
    return GENERAL_TIPS[generalIdx % GENERAL_TIPS.length];
}

function renderCurrentHint() {
    if (actionLocked || !tooltipsEnabled) return;
    if (hoverTipKey) {
        renderHintText(t(hoverTipKey));
    } else {
        renderHintText(currentGeneralTipText());
    }
}

function setHoverTip(key) {
    hoverTipKey = key || null;
    renderCurrentHint();
}

function wireHoverTips() {
    for (const [sel, key] of BUTTON_TIPS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        el.addEventListener("mouseenter", () => setHoverTip(key));
        el.addEventListener("mouseleave", () => setHoverTip(null));
        // Keyboard parity — keep accessible focus showing the same tip.
        el.addEventListener("focus", () => setHoverTip(key));
        el.addEventListener("blur",  () => setHoverTip(null));
    }
}

function startGeneralTipRotation() {
    if (!tooltipsEnabled) return;
    if (generalTimer) clearInterval(generalTimer);
    if (!GENERAL_TIPS.length) return;
    // Start on a random tip so reopens don't always show #1, and shuffle the
    // order so consecutive ticks don't always march in file order.
    generalIdx = Math.floor(Math.random() * GENERAL_TIPS.length);
    renderCurrentHint();
    generalTimer = setInterval(() => {
        generalIdx += 1;
        if (!hoverTipKey && !actionLocked) renderHintText(currentGeneralTipText());
    }, 35000);
}

// Click the status bar → advance to the next general tip immediately and
// reset the rotation timer so the new tip gets its full dwell.
statusEl.addEventListener("click", () => {
    if (!tooltipsEnabled || actionLocked) return;
    generalIdx += 1;
    hoverTipKey = null;
    renderHintText(currentGeneralTipText());
    if (generalTimer) clearInterval(generalTimer);
    generalTimer = setInterval(() => {
        generalIdx += 1;
        if (!hoverTipKey && !actionLocked) renderHintText(currentGeneralTipText());
    }, 35000);
});
statusEl.style.cursor = "pointer";

// ─── Resolution ───────────────────────────────────────────────────────────────

function getSelectedLayout() {
    const checked = document.querySelector('input[name="layout"]:checked');
    return checked ? checked.value : (presets[0]?.id || "custom");
}

function updateResolutionInputs() {
    const layout = getSelectedLayout();
    const preset = getPreset(layout);
    if (!preset) return;

    if (preset.type === "custom") {
        widthInput.disabled  = false;
        heightInput.disabled = false;
        return;
    }

    if (preset.type === "fullpage") {
        widthInput.disabled  = true;
        heightInput.disabled = true;
        widthInput.value     = viewportWidth;
        heightInput.value    = "";
        setStatus(t("stMeasuringHeight"));
        chrome.runtime.sendMessage({ action: "getPageHeight" }, (response) => {
            if (chrome.runtime.lastError || !response || response.ok === false) {
                heightInput.value = fullPageCap;
                setStatus(t("stMeasureFailed"), "error", 3000);
                return;
            }
            heightInput.value = Math.min(response.pageHeight ?? fullPageCap, fullPageCap);
            setStatus("");
        });
        return;
    }

    const dims = presetDimensions(preset);
    widthInput.disabled  = false;
    heightInput.disabled = false;
    if (dims) {
        widthInput.value  = dims.width;
        heightInput.value = dims.height;
    }
}

function checkCustomResolution() {
    const layout = getSelectedLayout();
    const preset = getPreset(layout);
    if (!preset || preset.type === "custom" || preset.type === "fullpage") return;

    const dims = presetDimensions(preset);
    if (!dims) return;
    if (
        parseInt(widthInput.value)  !== dims.width ||
        parseInt(heightInput.value) !== dims.height
    ) {
        // Switch to the custom preset (which is always present).
        const custom = presets.find((p) => p.type === "custom");
        if (!custom) return;
        const radio = document.querySelector(`input[name="layout"][value="${custom.id}"]`);
        if (radio) radio.checked = true;
        widthInput.disabled  = false;
        heightInput.disabled = false;
    }
}

function getScaleFactor() {
    const preset = getPreset(getSelectedLayout());
    if (preset && Number.isFinite(preset.scale) && preset.scale >= 1 && preset.scale <= 4) {
        return preset.scale;
    }
    return defaultScaleFactor;
}

function getSettings(extras = {}) {
    return {
        layout:            getSelectedLayout(),
        width:             parseInt(widthInput.value)  || 1920,
        height:            parseInt(heightInput.value) || 1080,
        deviceScaleFactor: getScaleFactor(),
        ...extras,
    };
}

// ─── Messaging ────────────────────────────────────────────────────────────────

const sendMessage = (message) =>
    new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.ok === false) {
                return reject(new Error(response.error || t("stRequestFailed")));
            }
            resolve(response);
        });
    });

// ─── Button handlers ──────────────────────────────────────────────────────────

function runPageCapture(manualCrop) {
    showCapturing(t("stCapturingPage"));
    sendMessage({ action: "capturePage", settings: getSettings({ manualCrop }) })
        .then(() => { stopCapturing(); setStatus(t(manualCrop ? "stCropReady" : "stDone"), "ok", 4000); })
        .catch((e) => { stopCapturing(); setStatus(e.message ?? t("stError"), "error", 5000); });
}

async function runElementCapture(manualCrop) {
    showCapturing(t("ovSelectElement"), t("ovSelectElementHint"));
    try {
        // Await injection so the highlighter is listening before we close the popup.
        // Closing immediately afterward avoids the two-click trap: if the popup is
        // open when the user clicks the page, Chrome dismisses the popup and swallows
        // that first click — it never reaches the highlighter's listener.
        await sendMessage({ action: "captureElement", settings: getSettings({ manualCrop }) });
        window.close();
    } catch (e) {
        stopCapturing();
        setStatus(e.message ?? t("stError"), "error", 5000);
    }
}

function runAutoCapture(manualCrop) {
    showCapturing(t("stAutoCapturing"));
    sendMessage({ action: "autoCapture", settings: getSettings({ manualCrop }) })
        .then(() => { stopCapturing(); setStatus(t(manualCrop ? "stCropReady" : "stAutoDone"), "ok", 4000); })
        .catch((e) => { stopCapturing(); setStatus(e.message ?? t("stError"), "error", 5000); });
}

// The "main" capture buttons route to the crop editor when the Settings
// "Always open the crop editor" option is on (cropDefault). The dedicated
// "-crop" buttons always crop; they are hidden by CSS when cropDefault is on.
document.getElementById("capture-page").addEventListener("click", () => runPageCapture(cropDefault));
document.getElementById("capture-page-crop").addEventListener("click", () => runPageCapture(true));

document.getElementById("capture-element").addEventListener("click", () => runElementCapture(cropDefault));
document.getElementById("capture-element-crop").addEventListener("click", () => runElementCapture(true));

document.getElementById("capture-auto").addEventListener("click", () => runAutoCapture(cropDefault));
document.getElementById("capture-auto-crop").addEventListener("click", () => runAutoCapture(true));

// ─── Site-detection prompt ────────────────────────────────────────────────────
//
// On open, ask the background to run a non-destructive detection pass on
// the active tab. If the site module recognizes a capturable target (post,
// story, group post), surface a single-click "Capture this <X>" button at
// the top of the popup. Click → site-aware element capture using the same
// pipeline Auto Mode used to dispatch to.

const sitePromptSection = document.getElementById("site-prompt");
const sitePromptDivider = document.getElementById("site-prompt-divider");
const captureSiteBtn    = document.getElementById("capture-site");
const captureSiteLabel  = document.getElementById("capture-site-label");
const captureSiteHint   = document.getElementById("capture-site-hint");

// Page-type → button label. Types not listed (profile, unknown) don't get
// a prompt — those pages should fall through to Auto/Page Capture. Populated
// once __i18n is ready so a language override is honored.
let PROMPT_LABELS = {};

const SITE_DISPLAY_NAMES = {
    facebook:  "Facebook",
    instagram: "Instagram",
    telegram:  "Telegram",
    vk:        "VK",
    x:         "X / Twitter",
    threads:   "Threads",
};

function showSitePrompt(module, pageType) {
    captureSiteLabel.textContent = PROMPT_LABELS[pageType];
    captureSiteHint.textContent  =
        t("promptDetectedOn", SITE_DISPLAY_NAMES[module] ?? module);
    sitePromptSection.hidden = false;
    sitePromptDivider.hidden = false;
}

// Wait for __i18n so the prompt labels reflect any language override, then
// run the non-destructive site detection pass.
window.__i18n.ready.then(() => {
    PROMPT_LABELS = {
        post:      t("promptPost"),
        story:     t("promptStory"),
        groupPost: t("promptPost"),
    };
    sendMessage({ action: "detectSite" })
        .then((res) => {
            if (res?.module && PROMPT_LABELS[res.pageType]) {
                showSitePrompt(res.module, res.pageType);
            }
        })
        .catch(() => { /* detection is best-effort — silent on failure */ });
});

function runSiteCapture(manualCrop) {
    showCapturing(t("ovCapturing"));
    sendMessage({ action: "captureSiteElement", settings: getSettings({ manualCrop }) })
        .then(() => { stopCapturing(); setStatus(t(manualCrop ? "stCropReady" : "stDone"), "ok", 4000); })
        .catch((e) => { stopCapturing(); setStatus(e.message ?? t("stError"), "error", 5000); });
}

captureSiteBtn.addEventListener("click", () => runSiteCapture(false));
document.getElementById("capture-site-crop").addEventListener("click", () => runSiteCapture(true));

// Element capture result — fires if the popup is still open when capture ends.
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action !== "elementCaptureResult") return false;
    stopCapturing();
    if (msg.ok) {
        setStatus(t("stDone"), "ok", 4000);
    } else {
        setStatus(msg.error || t("stElementCaptureFailed"), "error", 5000);
    }
    return false;
});

document.getElementById("dom-killer").addEventListener("click", async () => {
    showCapturing(t("ovManualRemoval"), t("ovManualRemovalHint"));
    try {
        // Same one-click fix as capture-element: close the popup once the
        // content script is listening, so the user's first click on the page
        // reaches the kill handler instead of being swallowed by popup dismissal.
        await sendMessage({ action: "domKiller" });
        window.close();
    } catch (e) {
        stopCapturing();
        setStatus(e.message ?? t("stError"), "error", 5000);
    }
});

// ─── Settings view ────────────────────────────────────────────────────────────
//
// The former "Expert mode" view is now a plain Settings panel, opened from
// the gear icon in the header. Filter management and the Cleanup feature were
// obsoleted — see FROZEN-CLEANUP.md.

const viewNormal       = document.getElementById("view-normal");
const viewSettings     = document.getElementById("view-settings");
const settingsToggle   = document.getElementById("settings-toggle");

const reencodeOpaqueCb = document.getElementById("reencode-opaque");
const reencodeBlock    = document.getElementById("reencode-block");
const formatInputs     = document.getElementsByName("output-format");
const jpegQualityRow   = document.getElementById("jpeg-quality-row");
const jpegQualityInput = document.getElementById("jpeg-quality");
const jpegQualityValue = document.getElementById("jpeg-quality-value");
const filenamePrefixIn = document.getElementById("filename-prefix");
const defaultCropCb    = document.getElementById("default-crop");
const fullpageCapIn    = document.getElementById("fullpage-cap");
const navTooltipCb     = document.getElementById("nav-tooltip");
const showTooltipsCb   = document.getElementById("show-tooltips");
const themeInputs      = document.getElementsByName("theme");
const langInputs       = document.getElementsByName("lang");

const cssLight = document.getElementById("css-light");
const cssDark  = document.getElementById("css-dark");

// Theme override — flip the media attribute on the two gated stylesheets so
// exactly one applies. "auto" restores the prefers-color-scheme queries.
function applyTheme(theme) {
    if (theme === "light") {
        cssLight.media = "all";
        cssDark.media  = "not all";
    } else if (theme === "dark") {
        cssLight.media = "not all";
        cssDark.media  = "all";
    } else {
        cssLight.media = "(prefers-color-scheme: light)";
        cssDark.media  = "(prefers-color-scheme: dark)";
    }
    window.__paintBrandMark?.(theme);
}

// "Always open the crop editor" — also hides the dedicated "-crop" buttons.
function applyCropDefault(on) {
    cropDefault = !!on;
    popupEl.classList.toggle("crop-default", cropDefault);
}

function setFormatUi(format) {
    const jpeg = format === "jpeg";
    // JPEG carries a quality slider; the opaque-PNG re-encode is meaningless
    // for it (JPEG has no alpha channel), so that block is hidden in JPEG mode.
    jpegQualityRow.hidden = !jpeg;
    reencodeBlock.hidden = jpeg;
}

function setRadio(inputs, value) {
    for (const r of inputs) r.checked = r.value === value;
}

// Load every persisted setting and reflect it into the controls.
chrome.storage.local.get([
    "reencodeOpaquePng", "outputFormat", "jpegQuality",
    "filenamePrefix", "defaultCrop", "fullPageHeightCap", "themeOverride",
    "langOverride", "showNavTooltip", "showPopupTooltips",
]).then((s) => {
    reencodeOpaqueCb.checked = s.reencodeOpaquePng !== false;

    const format = s.outputFormat === "jpeg" ? "jpeg" : "png";
    setRadio(formatInputs, format);
    setFormatUi(format);

    const q = typeof s.jpegQuality === "number" ? s.jpegQuality : 0.92;
    jpegQualityInput.value = Math.round(q * 100);
    jpegQualityValue.textContent = `${Math.round(q * 100)}%`;

    filenamePrefixIn.value = s.filenamePrefix || "";

    applyCropDefault(s.defaultCrop === true);
    defaultCropCb.checked = cropDefault;

    const cap = Number(s.fullPageHeightCap);
    if (Number.isFinite(cap) && cap > 0) fullPageCap = Math.min(cap, 16384);
    fullpageCapIn.value = fullPageCap;

    navTooltipCb.checked = s.showNavTooltip !== false;

    tooltipsEnabled = s.showPopupTooltips !== false;
    showTooltipsCb.checked = tooltipsEnabled;
    applyTooltipsEnabled(tooltipsEnabled);

    setRadio(themeInputs, s.themeOverride || "auto");
    setRadio(langInputs,  s.langOverride  || "auto");
    applyTheme(s.themeOverride || "auto");
});

reencodeOpaqueCb.addEventListener("change", () => {
    const enabled = reencodeOpaqueCb.checked;
    chrome.storage.local.set({ reencodeOpaquePng: enabled });
    setStatus(enabled ? t("stOpaqueOn") : t("stOpaqueOff"), "ok", 2000);
});

for (const r of formatInputs) {
    r.addEventListener("change", () => {
        if (!r.checked) return;
        chrome.storage.local.set({ outputFormat: r.value });
        setFormatUi(r.value);
        setStatus(t("stSettingSaved"), "ok", 1500);
    });
}

jpegQualityInput.addEventListener("input", () => {
    jpegQualityValue.textContent = `${jpegQualityInput.value}%`;
});
jpegQualityInput.addEventListener("change", () => {
    chrome.storage.local.set({
        jpegQuality: parseInt(jpegQualityInput.value, 10) / 100,
    });
    setStatus(t("stSettingSaved"), "ok", 1500);
});

filenamePrefixIn.addEventListener("change", () => {
    // Strip characters illegal in download filenames.
    const clean = filenamePrefixIn.value.trim().replace(/[\\/:*?"<>|]+/g, "");
    filenamePrefixIn.value = clean;
    chrome.storage.local.set({ filenamePrefix: clean });
    setStatus(t("stSettingSaved"), "ok", 1500);
});

defaultCropCb.addEventListener("change", () => {
    applyCropDefault(defaultCropCb.checked);
    chrome.storage.local.set({ defaultCrop: cropDefault });
    setStatus(t("stSettingSaved"), "ok", 1500);
});

navTooltipCb.addEventListener("change", () => {
    chrome.storage.local.set({ showNavTooltip: navTooltipCb.checked });
    setStatus(t("stSettingSaved"), "ok", 1500);
});

showTooltipsCb.addEventListener("change", () => {
    applyTooltipsEnabled(showTooltipsCb.checked);
    chrome.storage.local.set({ showPopupTooltips: tooltipsEnabled });
    setStatus(t("stSettingSaved"), "ok", 1500);
});

fullpageCapIn.addEventListener("change", () => {
    let v = parseInt(fullpageCapIn.value, 10);
    if (!Number.isFinite(v) || v <= 0) v = 16000;
    v = Math.min(Math.max(v, 1000), 16384);
    fullpageCapIn.value = v;
    fullPageCap = v;
    chrome.storage.local.set({ fullPageHeightCap: v });
    if (getSelectedLayout() === "fullpage") updateResolutionInputs();
    setStatus(t("stSettingSaved"), "ok", 1500);
});

for (const r of themeInputs) {
    r.addEventListener("change", () => {
        if (!r.checked) return;
        applyTheme(r.value);
        chrome.storage.local.set({ themeOverride: r.value });
        setStatus(t("stSettingSaved"), "ok", 1500);
    });
}

for (const r of langInputs) {
    r.addEventListener("change", () => {
        if (!r.checked) return;
        chrome.storage.local.set({ langOverride: r.value });
        // Re-localize the whole popup in place.
        window.__i18n.reload(r.value).then(async () => {
            window.__applyI18n();
            applyLangClass();
            refreshDynamicStrings();
            await loadGenericTips();
            startGeneralTipRotation();
            setStatus(t("stSettingSaved"), "ok", 1500);
        });
    });
}

// Strings the markup can't carry as data-i18n (toggle titles set in JS).
// Re-applied after a runtime language change.
function refreshDynamicStrings() {
    settingsToggle.title = popupEl.classList.contains("is-settings")
        ? t("settingsBtnTitleClose") : t("settingsBtnTitle");
    helpToggleBtn.title = popupEl.classList.contains("is-helping")
        ? t("helpBtnTitleClose") : t("helpBtnTitle");
    // Preset labels resolve through __i18n for seeded presets — re-render so
    // a language change shows localized names in both views.
    renderLayoutGroup();
    renderPresetsEditor();
    // Re-render the bottom-bar hint in the new language.
    if (!actionLocked) renderCurrentHint();
}

function setSettings(open) {
    viewSettings.hidden = !open;
    viewNormal.hidden = open;
    popupEl.classList.toggle("is-settings", open);
    settingsToggle.title = open ? t("settingsBtnTitleClose") : t("settingsBtnTitle");
}

settingsToggle.addEventListener("click", () => {
    // Leaving help open while switching views would be confusing — close it.
    if (popupEl.classList.contains("is-helping")) setHelp(false);
    setSettings(!popupEl.classList.contains("is-settings"));
});

// ─── Help view ────────────────────────────────────────────────────────────────

const helpToggleBtn = document.getElementById("help-toggle");
const helpView      = document.getElementById("view-help");

function setHelp(open) {
    popupEl.classList.toggle("is-helping", open);
    helpView.hidden = !open;
    helpToggleBtn.textContent = open ? "×" : "?";
    helpToggleBtn.title = open ? t("helpBtnTitleClose") : t("helpBtnTitle");
}

helpToggleBtn.addEventListener("click", () => {
    if (popupEl.classList.contains("is-settings")) setSettings(false);
    setHelp(!popupEl.classList.contains("is-helping"));
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action !== "domKillerEnded") return false;
    stopCapturing();
    setStatus(t("stManualRemovalStopped"), "ok", 3000);
    return false;
});

// ─── Presets: rendering ───────────────────────────────────────────────────────

const presetsEditorEl  = document.getElementById("presets-editor");
const addPresetBtn     = document.getElementById("add-preset");
const defaultScaleEls  = document.getElementsByName("default-scale");

// Build the radio group on the main view. Preserves the currently checked id
// when possible; falls back to the first preset.
function renderLayoutGroup() {
    const prev = layoutGroupEl.querySelector('input[name="layout"]:checked')?.value;
    layoutGroupEl.innerHTML = "";
    const visible = presets.filter((p) => !p.hidden);
    let pickedId = null;
    for (const p of visible) {
        const input = document.createElement("input");
        input.type    = "radio";
        input.name    = "layout";
        input.id      = `layout-${p.id}`;
        input.value   = p.id;
        const label = document.createElement("label");
        label.setAttribute("for", input.id);
        label.textContent = presetLabel(p);
        if (p.type === "custom") label.classList.add("custom-label");
        layoutGroupEl.appendChild(input);
        layoutGroupEl.appendChild(label);

        input.addEventListener("change", () => {
            if (!input.checked) return;
            updateResolutionInputs();
            chrome.storage.local.set({ layoutPreset: getSelectedLayout() });
        });

        if (!pickedId && prev === p.id) pickedId = p.id;
    }
    if (!pickedId) pickedId = visible[0]?.id;
    if (pickedId) {
        const chosen = layoutGroupEl.querySelector(`input[value="${pickedId}"]`);
        if (chosen) chosen.checked = true;
    }
}

// Build the per-preset row inside the Settings editor.
function renderPresetsEditor() {
    presetsEditorEl.innerHTML = "";
    for (const p of presets) {
        const row = document.createElement("div");
        row.className = "preset-row";
        row.dataset.id = p.id;

        // Drag handle — initiates row reorder. Sets the row's draggable
        // attribute only while the handle is grabbed so the surrounding text
        // inputs stay interactive otherwise.
        const handle = document.createElement("span");
        handle.className = "preset-handle";
        handle.title = t("presetReorder");
        handle.setAttribute("aria-label", handle.title);
        handle.innerHTML = DRAG_HANDLE_SVG;
        handle.addEventListener("mousedown", () => { row.draggable = true; });
        handle.addEventListener("mouseup",   () => { row.draggable = false; });
        row.appendChild(handle);
        attachRowDrag(row, p.id);

        // Label column — fixed presets are editable; smart/custom are read-only.
        const labelInput = document.createElement("input");
        labelInput.type = "text";
        labelInput.className = "preset-label";
        labelInput.value = presetLabel(p);
        labelInput.placeholder = t("presetLabelPh");
        if (p.type !== "fixed") {
            labelInput.disabled = true;
        } else {
            labelInput.addEventListener("change", () => {
                const v = labelInput.value.trim();
                if (!v) { labelInput.value = presetLabel(p); return; }
                p.label = v;
                delete p.labelKey;
                savePresets();
                renderLayoutGroup();
            });
        }
        row.appendChild(labelInput);

        // Width / height — editable only for fixed.
        const w = document.createElement("input");
        w.type = "number";
        w.className = "preset-dim";
        w.min = 300; w.max = 16384;
        const h = document.createElement("input");
        h.type = "number";
        h.className = "preset-dim";
        h.min = 300; h.max = 16384;
        if (p.type === "fixed") {
            w.value = p.width;
            h.value = p.height;
            const onDimChange = () => {
                const wv = Math.max(300, Math.min(16384, parseInt(w.value, 10) || p.width));
                const hv = Math.max(300, Math.min(16384, parseInt(h.value, 10) || p.height));
                w.value = wv; h.value = hv;
                p.width = wv; p.height = hv;
                savePresets();
                if (getSelectedLayout() === p.id) updateResolutionInputs();
            };
            w.addEventListener("change", onDimChange);
            h.addEventListener("change", onDimChange);
        } else {
            w.disabled = true;
            h.disabled = true;
            w.placeholder = t("presetSmartAuto");
            h.placeholder = t("presetSmartAuto");
        }
        const dimWrap = document.createElement("div");
        dimWrap.className = "preset-dims";
        dimWrap.appendChild(w);
        const x = document.createElement("span");
        x.className = "resolution-x";
        x.textContent = "×";
        dimWrap.appendChild(x);
        dimWrap.appendChild(h);
        row.appendChild(dimWrap);

        // Scale select — Default / 1× / 2× / 3× / 4×.
        const sel = document.createElement("select");
        sel.className = "preset-scale";
        const optDef = document.createElement("option");
        optDef.value = "";
        optDef.textContent = t("presetScaleDefault");
        sel.appendChild(optDef);
        for (const n of [1, 2, 3, 4]) {
            const o = document.createElement("option");
            o.value = String(n);
            o.textContent = `${n}×`;
            sel.appendChild(o);
        }
        sel.value = (p.scale == null) ? "" : String(p.scale);
        sel.addEventListener("change", () => {
            p.scale = sel.value === "" ? null : parseInt(sel.value, 10);
            savePresets();
        });
        row.appendChild(sel);

        // Hide / show toggle — every preset except Custom can be hidden from
        // the main view. Custom is always available so the user can fall back
        // to a free-form W×H entry even if every other preset is hidden.
        if (p.type !== "custom") {
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "preset-toggle";
            const setEye = () => {
                const isHidden = !!p.hidden;
                toggle.innerHTML = isHidden ? EYE_OFF_SVG : EYE_ON_SVG;
                toggle.title = t(isHidden ? "presetShow" : "presetHide");
                toggle.setAttribute("aria-label", toggle.title);
                toggle.classList.toggle("is-off", isHidden);
            };
            setEye();
            toggle.addEventListener("click", () => {
                p.hidden = !p.hidden;
                setEye();
                savePresets();
                renderLayoutGroup();
                // If we just hid the active layout, renderLayoutGroup fell
                // back to the first visible preset — persist the new selection
                // and refresh the resolution inputs.
                const newLayout = getSelectedLayout();
                if (newLayout) chrome.storage.local.set({ layoutPreset: newLayout });
                updateResolutionInputs();
            });
            row.appendChild(toggle);
        } else {
            const spacer = document.createElement("span");
            spacer.className = "preset-toggle-spacer";
            row.appendChild(spacer);
        }

        // Delete — available on every editable (fixed-W×H) preset, including
        // the factory ones (Vertical HD, FullHD, 4K) and any user-added entry.
        // Viewport / Full Page / Custom can only be hidden; "Restore factory
        // presets" brings deleted factory rows back. The cell stays in place
        // either way so the grid stays aligned.
        if (p.type === "fixed") {
            const del = document.createElement("button");
            del.type = "button";
            del.className = "preset-delete";
            del.title = t("presetDelete");
            del.setAttribute("aria-label", t("presetDelete"));
            del.textContent = "×";
            del.addEventListener("click", () => {
                presets = presets.filter((x) => x.id !== p.id);
                savePresets();
                renderPresetsEditor();
                renderLayoutGroup();
                const newLayout = getSelectedLayout();
                if (newLayout) chrome.storage.local.set({ layoutPreset: newLayout });
                updateResolutionInputs();
            });
            row.appendChild(del);
        } else {
            const spacer = document.createElement("span");
            spacer.className = "preset-delete-spacer";
            row.appendChild(spacer);
        }

        presetsEditorEl.appendChild(row);
    }
}

// ─── Drag-to-reorder ──────────────────────────────────────────────────────────

const DRAG_HANDLE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="9"  cy="6"  r="1"/><circle cx="9"  cy="12" r="1"/><circle cx="9"  cy="18" r="1"/>' +
    '<circle cx="15" cy="6"  r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>';

let dragSrcId = null;

function attachRowDrag(row, id) {
    row.addEventListener("dragstart", (e) => {
        dragSrcId = id;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        // Some browsers won't initiate a drag without payload set.
        try { e.dataTransfer.setData("text/plain", id); } catch {}
    });
    row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        row.draggable = false;
        dragSrcId = null;
        for (const r of presetsEditorEl.querySelectorAll(".preset-row")) {
            r.classList.remove("drop-before", "drop-after");
        }
    });
    row.addEventListener("dragover", (e) => {
        if (!dragSrcId || dragSrcId === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = row.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        row.classList.toggle("drop-before", !after);
        row.classList.toggle("drop-after",   after);
    });
    row.addEventListener("dragleave", () => {
        row.classList.remove("drop-before", "drop-after");
    });
    row.addEventListener("drop", (e) => {
        if (!dragSrcId || dragSrcId === id) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        const srcIdx = presets.findIndex((p) => p.id === dragSrcId);
        if (srcIdx < 0) return;
        const [moved] = presets.splice(srcIdx, 1);
        let dstIdx = presets.findIndex((p) => p.id === id);
        if (dstIdx < 0) dstIdx = presets.length;
        if (after) dstIdx += 1;
        presets.splice(dstIdx, 0, moved);
        savePresets();
        renderPresetsEditor();
        renderLayoutGroup();
    });
}

// Eye glyphs for the show/hide toggle on the undeletable presets.
const EYE_ON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9.88 5.09A10.94 10.94 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.13 4.16"/>' +
    '<path d="M6.5 6.71A17.5 17.5 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 5.74-1.64"/>' +
    '<path d="M14.12 14.12A3 3 0 0 1 9.88 9.88"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';

addPresetBtn.addEventListener("click", () => {
    const id = `user-${Date.now().toString(36)}`;
    presets.push({
        id,
        type:   "fixed",
        label:  "New preset",
        width:  1920,
        height: 1080,
        scale:  null,
    });
    if (!presets.some((p) => p.type === "custom")) {
        presets.push({ ...DEFAULT_PRESETS.find((p) => p.type === "custom") });
    }
    savePresets();
    renderPresetsEditor();
    renderLayoutGroup();
});

const restorePresetsBtn = document.getElementById("restore-presets");
restorePresetsBtn.addEventListener("click", () => {
    presets = DEFAULT_PRESETS.map((p) => ({ ...p }));
    savePresets();
    renderPresetsEditor();
    renderLayoutGroup();
    const newLayout = getSelectedLayout();
    if (newLayout) chrome.storage.local.set({ layoutPreset: newLayout });
    updateResolutionInputs();
    setStatus(t("stPresetsRestored"), "ok", 2000);
});

for (const r of defaultScaleEls) {
    r.addEventListener("change", () => {
        if (!r.checked) return;
        defaultScaleFactor = parseInt(r.value, 10);
        saveDefaultScale();
        setStatus(t("stSettingSaved"), "ok", 1500);
    });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

widthInput.addEventListener("input",  checkCustomResolution);
heightInput.addEventListener("input", checkCustomResolution);

// Persist custom width/height so the user's last numeric entry is restored.
// Only meaningful when the active preset is "custom"; for other presets these
// inputs are derived from the preset itself.
function persistCustomDimensions() {
    const preset = getPreset(getSelectedLayout());
    if (!preset || preset.type !== "custom") return;
    chrome.storage.local.set({
        customWidth:  parseInt(widthInput.value)  || null,
        customHeight: parseInt(heightInput.value) || null,
    });
}
widthInput.addEventListener("change",  persistCustomDimensions);
heightInput.addEventListener("change", persistCustomDimensions);

// Initial render with defaults — replaced once storage resolves.
renderLayoutGroup();
renderPresetsEditor();
updateResolutionInputs();

// Re-render once the locale loader settles so a Settings → language override
// (loaded asynchronously) is reflected in the seeded preset labels.
window.__i18n.ready.then(() => {
    renderLayoutGroup();
    renderPresetsEditor();
});

// Restore presets, default scale, last layout, and last custom dimensions.
chrome.storage.local
    .get([
        "resolutionPresets", "defaultScaleFactor", "scaleFactor",
        "layoutPreset", "customWidth", "customHeight",
    ])
    .then((s) => {
        if (Array.isArray(s.resolutionPresets) && s.resolutionPresets.length) {
            presets = s.resolutionPresets;
            // Guarantee the custom preset always exists and stays visible.
            if (!presets.some((p) => p.type === "custom")) {
                presets.push({ ...DEFAULT_PRESETS.find((p) => p.type === "custom") });
            }
            for (const p of presets) {
                if (p.type === "custom" && p.hidden) p.hidden = false;
            }
        }
        // Migrate the old `scaleFactor` key into the new default; honor a
        // freshly written `defaultScaleFactor` if present.
        const ds = Number(s.defaultScaleFactor ?? s.scaleFactor);
        if (Number.isFinite(ds) && ds >= 1 && ds <= 4) defaultScaleFactor = ds;
        setRadio(defaultScaleEls, String(defaultScaleFactor));

        renderPresetsEditor();
        renderLayoutGroup();

        if (s.layoutPreset) {
            const radio = layoutGroupEl.querySelector(`input[value="${s.layoutPreset}"]`);
            if (radio) radio.checked = true;
        }
        updateResolutionInputs();

        const customPreset = presets.find((p) => p.type === "custom");
        if (customPreset && getSelectedLayout() === customPreset.id) {
            if (s.customWidth)  widthInput.value  = s.customWidth;
            if (s.customHeight) heightInput.value = s.customHeight;
        }
    });

// Pull the active tab's viewport size and refresh the smart presets.
// Best-effort: on restricted URLs (chrome://, store) the background returns
// nulls and we keep the screen-based fallback computed at module load.
sendMessage({ action: "getViewportSize" })
    .then((res) => {
        if (!res?.width || !res?.height) return;
        viewportWidth  = res.width;
        viewportHeight = res.height;
        const preset = getPreset(getSelectedLayout());
        if (preset && preset.type !== "fixed" && preset.type !== "custom") {
            updateResolutionInputs();
        }
    })
    .catch(() => { /* keep fallback */ });

// Tag the popup with the effective language code so CSS can adjust layout for
// locales whose copy doesn't fit the default tooltip height (e.g. Russian
// averages ~30% longer than English and needs a third line).
function applyLangClass() {
    const override = window.__i18n?.lang;
    let lang = (override && override !== "auto")
        ? override
        : (chrome.i18n.getUILanguage?.() || navigator.language || "en");
    lang = String(lang).split("-")[0].toLowerCase();
    for (const c of [...popupEl.classList]) {
        if (c.startsWith("lang-")) popupEl.classList.remove(c);
    }
    popupEl.classList.add(`lang-${lang}`);
}

// Start hint rotation once translations are in place; wire hover handlers
// to swap the rotating tip for a per-control hint while pointing at it.
window.__i18n.ready.then(async () => {
    applyLangClass();
    wireHoverTips();
    await loadGenericTips();
    startGeneralTipRotation();
});

// If the popup was re-opened by the element-click handoff, show the
// "Capturing…" overlay immediately. The session flag is set in
// elementClickListener.js and cleared when capture finishes; the
// elementCaptureResult listener above will then call stopCapturing().
chrome.storage.session.get("elementCaptureInProgress", (data) => {
    if (data?.elementCaptureInProgress) {
        showCapturing(t("ovCapturingElement"));
    }
});
