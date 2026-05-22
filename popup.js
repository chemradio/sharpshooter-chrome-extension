const layoutInputs   = document.querySelectorAll('input[name="layout"]');
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

const presets = {
    user:         { width: viewportWidth, height: viewportHeight },
    fullpage:     { width: viewportWidth, height: null },
    vertical:     { width: viewportWidth, height: Math.round(viewportWidth * 3.5) },
    fullhd:       { width: 1920, height: 1080 },
    horizontal4k: { width: 3840, height: 2160 },
    custom:       null,
};

function recomputeViewportPresets() {
    presets.user.width      = viewportWidth;
    presets.user.height     = viewportHeight;
    presets.fullpage.width  = viewportWidth;
    presets.vertical.width  = viewportWidth;
    presets.vertical.height = Math.round(viewportWidth * 3.5);
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
        return;
    }

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
                    statusEl.innerHTML = "";
                    statusEl.className = "status";
                }, autoClear);
            }
        }
    }, stepMs);
}

// ─── Resolution ───────────────────────────────────────────────────────────────

function getSelectedLayout() {
    return document.querySelector('input[name="layout"]:checked').value;
}

function updateResolutionInputs() {
    const layout = getSelectedLayout();

    if (layout === "custom") {
        widthInput.disabled  = false;
        heightInput.disabled = false;
        return;
    }

    if (layout === "fullpage") {
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

    widthInput.disabled  = false;
    heightInput.disabled = false;
    const preset         = presets[layout];
    widthInput.value     = preset.width;
    heightInput.value    = preset.height;
}

function checkCustomResolution() {
    const layout = getSelectedLayout();
    if (layout === "custom" || layout === "fullpage") return;

    const preset = presets[layout];
    if (
        parseInt(widthInput.value)  !== preset.width ||
        parseInt(heightInput.value) !== preset.height
    ) {
        document.getElementById("custom").checked = true;
        widthInput.disabled  = false;
        heightInput.disabled = false;
    }
}

function getScaleFactor() {
    for (const s of document.getElementsByName("scale")) {
        if (s.checked) return parseInt(s.value);
    }
    return 2;
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
const skipSaveCb       = document.getElementById("skip-save-dialog");
const filenamePrefixIn = document.getElementById("filename-prefix");
const defaultCropCb    = document.getElementById("default-crop");
const fullpageCapIn    = document.getElementById("fullpage-cap");
const navTooltipCb     = document.getElementById("nav-tooltip");
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
    "reencodeOpaquePng", "outputFormat", "jpegQuality", "skipSaveDialog",
    "filenamePrefix", "defaultCrop", "fullPageHeightCap", "themeOverride",
    "langOverride", "showNavTooltip",
]).then((s) => {
    reencodeOpaqueCb.checked = s.reencodeOpaquePng !== false;

    const format = s.outputFormat === "jpeg" ? "jpeg" : "png";
    setRadio(formatInputs, format);
    setFormatUi(format);

    const q = typeof s.jpegQuality === "number" ? s.jpegQuality : 0.92;
    jpegQualityInput.value = Math.round(q * 100);
    jpegQualityValue.textContent = `${Math.round(q * 100)}%`;

    skipSaveCb.checked = s.skipSaveDialog === true;
    filenamePrefixIn.value = s.filenamePrefix || "";

    applyCropDefault(s.defaultCrop === true);
    defaultCropCb.checked = cropDefault;

    const cap = Number(s.fullPageHeightCap);
    if (Number.isFinite(cap) && cap > 0) fullPageCap = Math.min(cap, 16384);
    fullpageCapIn.value = fullPageCap;

    navTooltipCb.checked = s.showNavTooltip !== false;

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

skipSaveCb.addEventListener("change", () => {
    chrome.storage.local.set({ skipSaveDialog: skipSaveCb.checked });
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
        window.__i18n.reload(r.value).then(() => {
            window.__applyI18n();
            refreshDynamicStrings();
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
    setHelp(!popupEl.classList.contains("is-helping"));
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action !== "domKillerEnded") return false;
    stopCapturing();
    setStatus(t("stManualRemovalStopped"), "ok", 3000);
    return false;
});

// ─── Init ─────────────────────────────────────────────────────────────────────

layoutInputs.forEach((input) =>
    input.addEventListener("change", () => {
        updateResolutionInputs();
        chrome.storage.local.set({ layoutPreset: getSelectedLayout() });
    })
);
widthInput.addEventListener("input",  checkCustomResolution);
heightInput.addEventListener("input", checkCustomResolution);

// Persist custom width/height so the user's last numeric entry is restored.
// Only meaningful when the active preset is "custom"; for other presets these
// inputs are derived from the preset itself.
function persistCustomDimensions() {
    if (getSelectedLayout() !== "custom") return;
    chrome.storage.local.set({
        customWidth:  parseInt(widthInput.value)  || null,
        customHeight: parseInt(heightInput.value) || null,
    });
}
widthInput.addEventListener("change",  persistCustomDimensions);
heightInput.addEventListener("change", persistCustomDimensions);

// Persist the user's scale-factor choice across popup opens. Default stays 2×
// (set via `checked` in popup.html); a stored value just overrides the default.
chrome.storage.local.get("scaleFactor").then(({ scaleFactor }) => {
    if (scaleFactor) {
        const radio = document.querySelector(`input[name="scale"][value="${scaleFactor}"]`);
        if (radio) radio.checked = true;
    }
});
for (const s of document.getElementsByName("scale")) {
    s.addEventListener("change", () => {
        if (s.checked) chrome.storage.local.set({ scaleFactor: parseInt(s.value) });
    });
}

updateResolutionInputs();

// Restore the user's previously chosen resolution preset. Async — the initial
// updateResolutionInputs() call above runs with the HTML default ("user"); once
// storage resolves we switch the radio and re-derive the inputs.
chrome.storage.local
    .get(["layoutPreset", "customWidth", "customHeight"])
    .then(({ layoutPreset, customWidth, customHeight }) => {
        if (!layoutPreset) return;
        const radio = document.querySelector(`input[name="layout"][value="${layoutPreset}"]`);
        if (!radio) return;
        radio.checked = true;
        updateResolutionInputs();
        if (layoutPreset === "custom") {
            if (customWidth)  widthInput.value  = customWidth;
            if (customHeight) heightInput.value = customHeight;
        }
    });

// Pull the active tab's viewport size and refresh the user/fullpage/vertical
// presets. Best-effort: on restricted URLs (chrome://, store) the background
// returns nulls and we keep the screen-based fallback computed at module load.
sendMessage({ action: "getViewportSize" })
    .then((res) => {
        if (!res?.width || !res?.height) return;
        viewportWidth  = res.width;
        viewportHeight = res.height;
        recomputeViewportPresets();
        const layout = getSelectedLayout();
        if (layout === "user" || layout === "fullpage" || layout === "vertical") {
            updateResolutionInputs();
        }
    })
    .catch(() => { /* keep fallback */ });

// If the popup was re-opened by the element-click handoff, show the
// "Capturing…" overlay immediately. The session flag is set in
// elementClickListener.js and cleared when capture finishes; the
// elementCaptureResult listener above will then call stopCapturing().
chrome.storage.session.get("elementCaptureInProgress", (data) => {
    if (data?.elementCaptureInProgress) {
        showCapturing(t("ovCapturingElement"));
    }
});
