const layoutInputs   = document.querySelectorAll('input[name="layout"]');
const widthInput     = document.getElementById("width");
const heightInput    = document.getElementById("height");
const statusEl       = document.getElementById("status");
const popupEl        = document.querySelector(".popup");
const captureLabelEl = document.getElementById("capture-label");
const captureHintEl  = document.getElementById("capture-hint");

// Localized-string helper. Pulls from _locales/<lang>/messages.json via the
// browser UI language; positional substitutions ($1…$9) map to extra args.
// Falls back to the key itself if a message is missing.
const t = (key, ...subs) =>
    chrome.i18n.getMessage(key, subs.length ? subs.map(String) : undefined) || key;

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
                heightInput.value = 16000;
                setStatus(t("stMeasureFailed"), "error", 3000);
                return;
            }
            heightInput.value = Math.min(response.pageHeight ?? 16000, 16000);
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

document.getElementById("capture-page").addEventListener("click", () => runPageCapture(false));
document.getElementById("capture-page-crop").addEventListener("click", () => runPageCapture(true));

document.getElementById("capture-element").addEventListener("click", () => runElementCapture(false));
document.getElementById("capture-element-crop").addEventListener("click", () => runElementCapture(true));

document.getElementById("capture-auto").addEventListener("click", () => runAutoCapture(false));
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
// a prompt — those pages should fall through to Auto/Page Capture.
const PROMPT_LABELS = {
    post:      t("promptPost"),
    story:     t("promptStory"),
    groupPost: t("promptPost"),
};

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

sendMessage({ action: "detectSite" })
    .then((res) => {
        if (res?.module && PROMPT_LABELS[res.pageType]) {
            showSitePrompt(res.module, res.pageType);
        }
    })
    .catch(() => { /* detection is best-effort — silent on failure */ });

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

document.getElementById("manual-cleanup").addEventListener("click", () => {
    setStatus(t("stCleaningUp"));
    sendMessage({ action: "manualCleanup" })
        .then((res) => {
            const s = res?.stats;
            if (!s) {
                setStatus(t("stCleanupDone"), "ok", 3000);
                return;
            }
            const { removed = 0, sources = {} } = s;
            const breakdown =
                `easylist:${sources.easylist ?? 0} ` +
                `bundled:${sources.bundled ?? 0} ` +
                `user:${sources.user ?? 0} ` +
                `user-global:${sources.userGlobal ?? 0}`;
            setStatus(t("stRemovedNodes", removed, breakdown), "ok", 5000);
        })
        .catch((e) => setStatus(e.message ?? t("stError"), "error", 5000));
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

// ─── Hidden expert UI: triple-click the header to reveal Export ──────────────

const exportBtn        = document.getElementById("export-filters");
const clearDomainBtn   = document.getElementById("clear-domain-filters");
const clearGlobalBtn   = document.getElementById("clear-global-filters");
const disableBundledCb = document.getElementById("disable-bundled");

chrome.storage.local.get("bundledFiltersDisabled").then(({ bundledFiltersDisabled }) => {
    disableBundledCb.checked = !!bundledFiltersDisabled;
});

disableBundledCb.addEventListener("change", () => {
    const disabled = disableBundledCb.checked;
    chrome.storage.local.set({ bundledFiltersDisabled: disabled });
    setStatus(
        disabled ? t("stBundledDisabled") : t("stBundledEnabled"),
        "ok",
        2000
    );
});
// Re-encode PNG opaque — off by default; the stored value sticks across opens.
const reencodeOpaqueCb = document.getElementById("reencode-opaque");

chrome.storage.local.get("reencodeOpaquePng").then(({ reencodeOpaquePng }) => {
    reencodeOpaqueCb.checked = !!reencodeOpaquePng;
});

reencodeOpaqueCb.addEventListener("change", () => {
    const enabled = reencodeOpaqueCb.checked;
    chrome.storage.local.set({ reencodeOpaquePng: enabled });
    setStatus(
        enabled ? t("stOpaqueOn") : t("stOpaqueOff"),
        "ok",
        2000
    );
});

const viewNormal       = document.getElementById("view-normal");
const viewExpert       = document.getElementById("view-expert");
const filterHostEl     = document.getElementById("filter-host");
const filterInput      = document.getElementById("filter-input");
const filterAddBtn     = document.getElementById("filter-add");
const filterListEl     = document.getElementById("filter-list");
const filterListGlobal = document.getElementById("filter-list-global");
const filterPreview    = document.getElementById("filter-preview");
const filterParentCb   = document.getElementById("filter-parent");
const scopeInputs      = document.getElementsByName("filter-scope");

function getScope() {
    for (const r of scopeInputs) if (r.checked) return r.value;
    return "host";
}
const modeToggleInput  = document.getElementById("mode-toggle-input");
const modeToggleLabel  = document.getElementById("mode-toggle-label");

function setMode(expert) {
    viewExpert.hidden = !expert;
    viewNormal.hidden = expert;
    modeToggleInput.checked = expert;
    modeToggleLabel.textContent = expert ? t("modeExpert") : t("modeNormal");
    popupEl.classList.toggle("is-expert", expert);
    helpContentNormal.hidden = expert;
    helpContentExpert.hidden = !expert;
    if (expert) refreshFilterList();
}

// ─── Help view ────────────────────────────────────────────────────────────────

const helpToggleBtn      = document.getElementById("help-toggle");
const helpView           = document.getElementById("view-help");
const helpContentNormal  = document.getElementById("help-content-normal");
const helpContentExpert  = document.getElementById("help-content-expert");

function setHelp(open) {
    popupEl.classList.toggle("is-helping", open);
    helpView.hidden = !open;
    helpToggleBtn.textContent = open ? "×" : "?";
    helpToggleBtn.title = open ? t("helpBtnTitleClose") : t("helpBtnTitle");
}

helpToggleBtn.addEventListener("click", () => {
    setHelp(!popupEl.classList.contains("is-helping"));
});

modeToggleInput.addEventListener("change", () => {
    const expert = modeToggleInput.checked;
    setMode(expert);
    setStatus(expert ? t("stExpertOn") : t("stExpertOff"), "ok", 1500);
});

// ─── Manual user-filter management ────────────────────────────────────────────

function isValidCssSelector(sel) {
    try {
        document.createDocumentFragment().querySelector(sel);
        return true;
    } catch {
        return false;
    }
}

const cssEsc = (s) =>
    CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/(["\\\]])/g, "\\$1");

// Accepts a CSS selector OR an HTML-fragment shape and returns a CSS selector.
// Recognized fragment shapes:
//   class="foo bar"          → .foo.bar
//   id="main"                → #main
//   data-testid="tweet"      → [data-testid="tweet"]
//   <div class="foo" data-x="y">  → div.foo[data-x="y"]
//   div class="foo"          → div.foo
// Anything that doesn't look like a fragment (no angle brackets, no name="value")
// is passed through untouched so plain CSS selectors keep working.
function normalizeSelector(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return "";

    const hasAngle = /^</.test(s) || />\s*$/.test(s);
    const hasAttrPair = /([a-zA-Z_:][\w:.-]*)\s*=\s*"[^"]*"/.test(s);
    if (!hasAngle && !hasAttrPair) return s;

    let body = s.replace(/^<\s*/, "").replace(/\s*\/?>\s*$/, "").trim();

    let tag = "";
    const tagMatch = body.match(/^([a-zA-Z][\w-]*)(?=\s|$)/);
    if (tagMatch) {
        tag = tagMatch[1].toLowerCase();
        body = body.slice(tagMatch[0].length).trim();
    }

    const attrs = {};
    for (const m of body.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
        attrs[m[1]] = m[2];
    }

    let out = tag;
    if (attrs.id) {
        out += `#${cssEsc(attrs.id)}`;
        delete attrs.id;
    }
    if (attrs.class) {
        for (const c of attrs.class.split(/\s+/).filter(Boolean)) {
            out += `.${cssEsc(c)}`;
        }
        delete attrs.class;
    }
    for (const [k, v] of Object.entries(attrs)) {
        out += `[${k}="${v.replace(/(["\\])/g, "\\$1")}"]`;
    }

    return out || s;
}

function wrapParent(sel) {
    return filterParentCb.checked && sel ? `*:has(> ${sel})` : sel;
}

function updatePreview() {
    const raw = filterInput.value;
    const normalized = wrapParent(normalizeSelector(raw));
    const differs = normalized && normalized !== raw.trim();
    const valid = normalized ? isValidCssSelector(normalized) : true;

    if (!raw.trim()) {
        filterPreview.hidden = true;
        filterPreview.classList.remove("invalid");
        filterInput.classList.remove("invalid");
        return;
    }

    filterInput.classList.toggle("invalid", !valid);
    filterPreview.classList.toggle("invalid", !valid);

    if (!valid) {
        filterPreview.hidden = false;
        filterPreview.textContent = t("invalidPreview");
        return;
    }
    if (differs) {
        filterPreview.hidden = false;
        filterPreview.innerHTML = "";
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = "→";
        const sel = document.createElement("span");
        sel.textContent = normalized;
        filterPreview.append(arrow, sel);
    } else {
        filterPreview.hidden = true;
    }
}

function renderListInto(ulEl, selectors, scope) {
    ulEl.innerHTML = "";
    for (const sel of selectors) {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.className = "sel";
        span.textContent = sel;
        span.title = sel;
        const btn = document.createElement("button");
        btn.className = "remove";
        btn.type = "button";
        btn.textContent = "×";
        btn.title = t("removeTitle");
        btn.addEventListener("click", () => removeFilter(sel, scope));
        li.append(span, btn);
        ulEl.appendChild(li);
    }
}

function renderFilterList(host, selectors, globalSelectors) {
    filterHostEl.textContent = host || t("noHost");
    renderListInto(filterListEl,     selectors,       "host");
    renderListInto(filterListGlobal, globalSelectors, "global");
}

function refreshFilterList() {
    sendMessage({ action: "listUserFilters" })
        .then((res) =>
            renderFilterList(
                res?.host,
                res?.selectors ?? [],
                res?.globalSelectors ?? []
            )
        )
        .catch((e) => setStatus(e.message ?? t("stError"), "error", 4000));
}

function addFilter() {
    const sel = wrapParent(normalizeSelector(filterInput.value));
    if (!sel) return;
    if (!isValidCssSelector(sel)) {
        filterInput.classList.add("invalid");
        setStatus(t("stInvalidSelector"), "error", 3000);
        return;
    }
    filterInput.classList.remove("invalid");
    const scope = getScope();
    sendMessage({ action: "addUserFilter", selector: sel, scope })
        .then((res) => {
            renderFilterList(
                res?.host,
                res?.selectors ?? [],
                res?.globalSelectors ?? []
            );
            filterInput.value = "";
            updatePreview();
            const where = scope === "global" ? t("scopeAllHosts") : t("scopeThisHost");
            setStatus(
                res?.added ? t("stAddedTo", where, sel) : t("stAlreadyPresent"),
                "ok",
                2500
            );
        })
        .catch((e) => setStatus(e.message ?? t("stError"), "error", 4000));
}

function removeFilter(sel, scope) {
    sendMessage({ action: "removeUserFilter", selector: sel, scope })
        .then((res) => {
            renderFilterList(
                res?.host,
                res?.selectors ?? [],
                res?.globalSelectors ?? []
            );
            setStatus(t("stRemovedSel", sel), "ok", 2500);
        })
        .catch((e) => setStatus(e.message ?? t("stError"), "error", 4000));
}

filterAddBtn.addEventListener("click", addFilter);
filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFilter();
});
filterInput.addEventListener("input", updatePreview);
filterParentCb.addEventListener("change", updatePreview);

clearDomainBtn.addEventListener("click", () => {
    const ok = confirm(t("confirmClearDomain"));
    if (!ok) return;
    setStatus(t("stClearing"));
    sendMessage({ action: "clearDomainFilters" })
        .then((res) => {
            const n = res?.selectorCount ?? 0;
            const h = res?.hostCount ?? 0;
            setStatus(
                n === 0
                    ? t("stNoDomainFilters")
                    : t("stClearedDomain", n, h),
                "ok",
                4000
            );
            refreshFilterList();
        })
        .catch((e) => setStatus(e.message ?? t("stError"), "error", 5000));
});

clearGlobalBtn.addEventListener("click", () => {
    const ok = confirm(t("confirmClearGlobal"));
    if (!ok) return;
    setStatus(t("stClearing"));
    sendMessage({ action: "clearGlobalFilters" })
        .then((res) => {
            const n = res?.selectorCount ?? 0;
            setStatus(
                n === 0
                    ? t("stNoGlobalFilters")
                    : t("stClearedGlobal", n),
                "ok",
                4000
            );
            refreshFilterList();
        })
        .catch((e) => setStatus(e.message ?? t("stError"), "error", 5000));
});

exportBtn.addEventListener("click", () => {
    setStatus(t("stExporting"));
    sendMessage({ action: "exportFilters" })
        .then((res) => {
            const n = res?.selectorCount ?? 0;
            const h = res?.hostCount ?? 0;
            if (n === 0) {
                setStatus(t("stNoExport"), "ok", 3000);
            } else {
                setStatus(t("stExported", n, h), "ok", 4000);
            }
        })
        .catch((e) => setStatus(e.message ?? t("stError"), "error", 5000));
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action !== "domKillerEnded") return false;
    stopCapturing();
    setStatus(t("stManualRemovalStopped"), "ok", 3000);
    return false;
});

// ─── Init ─────────────────────────────────────────────────────────────────────

layoutInputs.forEach((input) =>
    input.addEventListener("change", updateResolutionInputs)
);
widthInput.addEventListener("input",  checkCustomResolution);
heightInput.addEventListener("input", checkCustomResolution);

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
