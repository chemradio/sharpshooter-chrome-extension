// Orchestrates a full Legal Capture: forced clean reload → recorded network
// exchange (WARC/WACZ, including WebSocket transcripts and best-effort
// Service Worker traffic) → screenshot + independent DOM/MHTML snapshots →
// a hash-sealed manifest (with chain-of-custody provenance, and optionally
// machine/operator data) → independent RFC 3161 timestamps over that
// manifest's hash → a single downloaded zip containing all of it.
//
// Every evidentiary component listed above is individually switchable by the
// operator (see legalCaptureOptions.js and the Legal Capture Settings
// subpage in the popup) — this module reads the resolved options object and
// skips collecting/recording/packaging whatever is turned off, rather than
// collecting it and discarding it afterward. The exact option set used for
// a given capture is itself recorded inside the sealed manifest
// (`captureOptions`), so a verifier can confirm what was and wasn't
// collected without trusting report.txt's prose alone.
//
// Unlike Page/Element capture, this can't just call
// screenshots/captureSession.js's withEmulatedCapture as a black box: Network
// recording has to be enabled *before* the forced reload so the reload's own
// request/response traffic (i.e. the actual page load we're trying to prove
// is unaltered) ends up in the WARC — not just whatever happens after. So
// this module attaches the debugger itself and composes the same
// attach → hide scrollbars → emulate → settle steps captureSession.js
// exports, in a different order.
//
// Hash-chain design (why two files, not one manifest.json with everything):
//   manifest.json is built, frozen, and hashed *before* any TSA request —
//   it lists the sha256 of every other evidentiary file actually present
//   (capture.wacz, screenshot.png, page.html, page.mhtml — whichever
//   options left enabled). That frozen hash is what gets independently
//   timestamped, by however many TSA providers are enabled. Only *after*
//   those responses come back is timestamps.json written, pointing at
//   manifest.json's hash — it can't itself be inside the sealed hash
//   (nothing can attest to its own future). A verifier: recompute
//   sha256(manifest.json), check it against manifest.json's own recorded
//   per-file hashes, then check each capture-*.tsr's messageImprint against
//   that same manifest hash with `openssl ts -reply -in capture-*.tsr -text`.
//   SHA256SUMS.txt additionally lists the sha256 of every file physically in
//   the zip (including report.txt and the .tsr files) purely as a
//   convenience integrity check — unlike manifest.json, it isn't itself
//   sealed by anything (it's written last), so it doesn't replace the
//   manifest-hash verification above, it just makes "did anyone swap a file
//   in this zip after the fact" a five-second check instead of a
//   from-scratch one.

import {
    attachDebugger,
    detachDebugger,
} from "../debugerAttachment.js";
import { withZoomReset } from "../zoomReset.js";
import { showCaptureOverlay, hideCaptureOverlay } from "../captureOverlay.js";
import { suppressPageInput, restorePageInput } from "../inputSuppression.js";
import {
    hideScrollbars,
    restoreScrollbars,
    postEmulationBreather,
} from "../../screenshots/captureSession.js";
import { enableEmulation, clearEmulation } from "../../screenshots/emulation/emulationEnabler.js";
import { injectMutationWatcher, waitForMutationSettle } from "../mutationObserver.js";
import { takeScreenshotClip } from "../../screenshots/capture/captureScreenshot.js";
import { measurePageHeight, measureViewportSize } from "../pageMeasure.js";
import { startRecording, stopRecording } from "./networkRecorder.js";
import { buildWarc } from "./warcWriter.js";
import { buildWacz, buildZip } from "./zipWriter.js";
import { requestTimestamp, TSA_PROVIDERS } from "./tsaClient.js";
import { sha256Bytes, sha256Hex, bytesToBase64, base64ToBytes } from "../binary.js";
import { resolveLegalCaptureOptions } from "./legalCaptureOptions.js";

const RELOAD_TIMEOUT_MS = 20000;

// Maps a TSA_PROVIDERS entry's `name` to the option key that gates it.
const TSA_OPTION_KEY = { FreeTSA: "tsaFreeTSA", DigiCert: "tsaDigiCert", Sectigo: "tsaSectigo" };

function reloadAndWaitForComplete(tabId) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        };
        const timeout = setTimeout(finish, RELOAD_TIMEOUT_MS);
        function listener(id, changeInfo) {
            if (id === tabId && changeInfo.status === "complete") finish();
        }
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.reload(tabId, { bypassCache: true }, () => {
            const err = chrome.runtime.lastError;
            if (err && !settled) {
                settled = true;
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error(err.message));
            }
        });
    });
}

// "User" and "Full Page" presets are measured from the live page by
// popup.js *before* the click — but Legal Capture forces a fresh reload
// afterward, and a fresh load can genuinely have less content on screen
// (lazy-loaded images/feeds, etc.) than whatever was already on screen when
// the popup measured it. Re-measure against the post-reload page instead of
// trusting those stale numbers, so "the currently active preset" means what
// the user expects instead of a snapshot from before the reload.
async function reMeasureForPreset(tabId, deviceMetrics, presetType, fullPageHeightCap) {
    if (presetType === "viewport") {
        const size = await measureViewportSize(tabId).catch(() => null);
        return size ? { ...deviceMetrics, width: size.width, height: size.height } : deviceMetrics;
    }
    if (presetType === "fullpage") {
        const [size, height] = await Promise.all([
            measureViewportSize(tabId).catch(() => null),
            measurePageHeight(tabId).catch(() => null),
        ]);
        const cap = fullPageHeightCap > 0 ? fullPageHeightCap : Infinity;
        return {
            ...deviceMetrics,
            width: size?.width ?? deviceMetrics.width,
            height: height != null ? Math.min(height, cap) : deviceMetrics.height,
        };
    }
    // "fixed" / custom presets are literal, user-chosen dimensions — not
    // derived from the page, so there's nothing to re-measure.
    return deviceMetrics;
}

// Picks the exchange that represents the final (post-redirect) main-document
// response, using the frameId/type tracking networkRecorder.js does via
// Page.getFrameTree — a structural fact, not a URL-string-equality guess.
// Falls back to the old heuristics only if that tracking came back empty
// (e.g. Page.getFrameTree failed on a restricted page).
function findMainDocumentExchange(exchanges, mainDocumentRequestId, url) {
    if (mainDocumentRequestId != null) {
        const ex = exchanges.find((e) => e.requestId === mainDocumentRequestId && !e.isRedirectLeg);
        if (ex) return ex;
    }
    return exchanges.find((ex) => ex.url === url) ?? exchanges[0] ?? null;
}

function redirectChainFor(exchanges, mainDocumentRequestId) {
    if (mainDocumentRequestId == null) return [];
    return exchanges
        .filter((ex) => ex.requestId === mainDocumentRequestId && ex.isRedirectLeg && ex.response)
        .map((ex) => ({ url: ex.url, status: ex.response.status, location: ex.response.headers?.location ?? ex.response.headers?.Location ?? null }));
}

function tlsSummaryFrom(mainExchange) {
    const sec = mainExchange?.response?.securityDetails;
    if (!sec) return null;

    // Certificate Transparency is the single most useful anti-fabrication
    // field in the whole securityDetails payload. A certificate minted by a
    // locally-trusted root — the standard way to serve a forged page to a
    // browser you control — cannot carry valid SCTs, because no public CT log
    // will have signed it. It therefore looks perfectly valid to the browser
    // (the operator installed the root) while being visibly non-compliant
    // here. Issuer/subject/validity alone cannot distinguish that case.
    const scts = Array.isArray(sec.signedCertificateTimestampList)
        ? sec.signedCertificateTimestampList
        : [];

    return {
        protocol: sec.protocol ?? null,
        cipher: sec.cipher ?? null,
        keyExchange: sec.keyExchange ?? null,
        keyExchangeGroup: sec.keyExchangeGroup ?? null,
        serverSignatureAlgorithm: sec.serverSignatureAlgorithm ?? null,
        issuer: sec.issuer ?? null,
        subjectName: sec.subjectName ?? null,
        sanList: Array.isArray(sec.sanList) ? sec.sanList : null,
        validFrom: sec.validFrom ? new Date(sec.validFrom * 1000).toISOString() : null,
        validTo: sec.validTo ? new Date(sec.validTo * 1000).toISOString() : null,
        certificateTransparencyCompliance: sec.certificateTransparencyCompliance ?? "unknown",
        signedCertificateTimestampCount: scts.length,
        signedCertificateTimestamps: scts.map((s) => ({
            status: s.status ?? null,
            origin: s.origin ?? null,
            logDescription: s.logDescription ?? null,
            logId: s.logId ?? null,
            timestamp: s.timestamp ?? null,
        })),
    };
}

// RFC 1918 / loopback / link-local / unique-local. A main document served
// from any of these is the signature of a locally-run server or proxy
// standing in for the real site — the cheapest way to fabricate a capture on
// a machine you control. Flagged rather than blocked: a genuine capture of an
// intranet host is legitimate and must still work, it just needs to be
// visible to whoever reads the package instead of silently indistinguishable
// from a capture of the public internet.
function isPrivateOrLoopbackAddress(ip) {
    if (typeof ip !== "string" || !ip) return null;
    const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();
    if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
    if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique-local
    if (addr.startsWith("fe80:")) return true; // link-local
    const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!v4) return false;
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

// Which host actually answered, at the IP level. Independently checkable
// against passive DNS / the site's published ranges by anyone reading the
// package — the recorder already captured this from Network.responseReceived,
// it just never reached the manifest.
function connectionSummaryFrom(mainExchange) {
    const res = mainExchange?.response;
    if (!res) return null;
    const ip = res.remoteIPAddress ?? null;
    return {
        remoteIPAddress: ip,
        remotePort: res.remotePort ?? null,
        protocol: res.protocol ?? null,
        remoteAddressIsPrivateOrLoopback: isPrivateOrLoopbackAddress(ip),
    };
}

// ─── Best-effort collectors ─────────────────────────────────────────────────
// Every function in this section returns null (never throws) when its data
// isn't available — missing permission, API unsupported, page blocks
// scripting, etc. Absence is disclosed in report.txt, not silently hidden.

async function captureMhtmlSnapshot(tabId) {
    try {
        const result = await new Promise((resolve, reject) => {
            chrome.debugger.sendCommand({ tabId }, "Page.captureSnapshot", { format: "mhtml" }, (res) => {
                const err = chrome.runtime.lastError;
                if (err) return reject(new Error(err.message));
                resolve(res);
            });
        });
        return typeof result?.data === "string" ? result.data : null;
    } catch {
        return null;
    }
}

// Single injected call for both the DOM snapshot and the page-environment
// fingerprint, so two independently-toggleable pieces of evidence don't cost
// two separate chrome.scripting round trips. Environment fields mirror what
// a forensic examiner would want to know about the rendering context: screen
// geometry/DPI, locale, hardware concurrency, IANA timezone name (more
// precise than a UTC offset alone), and basic document metadata.
async function captureDomAndEnvironment(tabId, wantDom, wantEnv) {
    if (!wantDom && !wantEnv) return { html: null, environment: null };
    try {
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (wantDom, wantEnv) => {
                const out = {};
                if (wantDom) out.html = document.documentElement.outerHTML;
                if (wantEnv) {
                    out.environment = {
                        screen: {
                            width: screen.width,
                            height: screen.height,
                            availWidth: screen.availWidth,
                            availHeight: screen.availHeight,
                            colorDepth: screen.colorDepth,
                            pixelDepth: screen.pixelDepth,
                        },
                        devicePixelRatio: window.devicePixelRatio,
                        navigatorLanguage: navigator.language,
                        navigatorLanguages: navigator.languages ? Array.from(navigator.languages) : null,
                        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
                        deviceMemoryGb: navigator.deviceMemory ?? null,
                        cookieEnabled: navigator.cookieEnabled,
                        doNotTrack: navigator.doNotTrack ?? null,
                        documentTitle: document.title,
                        documentReferrer: document.referrer || null,
                        characterSet: document.characterSet,
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    };
                }
                return out;
            },
            args: [wantDom, wantEnv],
        });
        return injection?.result ?? { html: null, environment: null };
    } catch {
        return { html: null, environment: null };
    }
}

function cpuInfo() {
    return new Promise((resolve) => {
        if (!chrome.system?.cpu) return resolve(null);
        chrome.system.cpu.getInfo((info) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(info ?? null);
        });
    });
}
function memoryInfo() {
    return new Promise((resolve) => {
        if (!chrome.system?.memory) return resolve(null);
        chrome.system.memory.getInfo((info) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(info ?? null);
        });
    });
}
function displayInfo() {
    return new Promise((resolve) => {
        if (!chrome.system?.display) return resolve(null);
        chrome.system.display.getInfo((info) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(info ?? null);
        });
    });
}

// Hardware fingerprint of the machine running the capture — CPU model/core
// count, installed RAM, and connected displays (resolution/DPI/layout).
// Requires the optional "system.cpu"/"system.memory"/"system.display"
// permissions, granted only when the operator turns the Machine Info toggle
// on in Legal Capture Settings (see popup.js). If the permission isn't
// actually held (toggle on but grant somehow missing/revoked), each
// sub-call resolves null rather than throwing.
async function collectMachineInfo() {
    const [cpu, memory, displays] = await Promise.all([cpuInfo(), memoryInfo(), displayInfo()]);
    if (!cpu && !memory && !displays) return null;
    return {
        cpu: cpu ? { numOfProcessors: cpu.numOfProcessors, archName: cpu.archName, modelName: cpu.modelName } : null,
        memoryCapacityBytes: memory ? memory.capacity : null,
        displays: displays
            ? displays.map((d) => ({
                  name: d.name,
                  isPrimary: d.isPrimary,
                  isInternal: d.isInternal,
                  bounds: d.bounds,
                  dpiX: d.dpiX,
                  dpiY: d.dpiY,
                  rotation: d.rotation,
              }))
            : null,
    };
}

// The signed-in Chrome profile's account email, if any — an operator
// identity signal stronger than the free-text operatorName field (Google
// account ownership vs. a typed string) but still not a legal identity
// verification. Requires the optional "identity" permission, granted only
// when the Account Email toggle is turned on.
function collectAccountEmail() {
    return new Promise((resolve) => {
        if (!chrome.identity?.getProfileUserInfo) return resolve(null);
        chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(info?.email || null);
        });
    });
}

// Chain-of-custody metadata: what software, on what OS, produced this
// package. Doesn't identify the *operator* (see operatorName/caseReference,
// which are a human-supplied, unverified label printed on the report) but
// does let anyone independently confirm what tool/version/environment made
// the capture, which is the kind of "process or system that produces an
// accurate result" detail FRE 901(b)(9)/902(13) certifications rely on.
// SHA-256 fingerprint of each DER certificate in the chain that served the
// captured origin. `Network.getCertificate` is a CDP extra (not part of the
// stable surface) and needs the debugger still attached, so this is
// best-effort like every other collector — but when it works it is the
// strongest single artifact here: a leaf fingerprint can be looked up in
// public CT logs by anyone, with no trust in this extension at all. A
// forged certificate from a locally-installed root simply will not be there.
async function collectCertificateChain(tabId, origin) {
    if (!origin || !origin.startsWith("https:")) return null;
    try {
        const result = await new Promise((resolve, reject) => {
            chrome.debugger.sendCommand({ tabId }, "Network.getCertificate", { origin }, (res) => {
                const err = chrome.runtime.lastError;
                if (err) return reject(new Error(err.message));
                resolve(res);
            });
        });
        const derBase64List = Array.isArray(result?.tableNames) ? result.tableNames : [];
        if (!derBase64List.length) return null;
        return await Promise.all(
            derBase64List.map(async (der, i) => ({
                position: i === 0 ? "leaf" : `intermediate-${i}`,
                sha256: await sha256Hex(base64ToBytes(der)),
            }))
        );
    } catch {
        return null;
    }
}

async function collectToolProvenance(startedAt) {
    const platformInfo = await chrome.runtime.getPlatformInfo().catch(() => null);
    const ext = chrome.runtime.getManifest();

    // How this extension was installed. `chrome.management.getSelf` is one of
    // the few management APIs callable without the "management" permission.
    // "normal" means it came from the Chrome Web Store — i.e. the code that
    // produced this package is the published, reviewed build. "development"
    // means an unpacked directory the operator can edit freely, which makes
    // every other claim in this package only as good as that local copy.
    //
    // This is a tripwire, not a control: a modified build could patch out
    // this very check. It catches the casual case and makes the honest case
    // affirmatively verifiable, which is all an in-process check can ever do.
    let installType = null;
    try {
        installType = (await chrome.management.getSelf())?.installType ?? null;
    } catch {
        installType = null;
    }

    return {
        tool: "Sharpshooter Legal Capture",
        toolVersion: ext.version,
        extensionId: chrome.runtime.id,
        installType,
        installedFromWebStore: installType === null ? null : installType === "normal",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        platformOs: platformInfo?.os ?? null,
        platformArch: platformInfo?.arch ?? null,
        captureTimezoneOffsetMinutes: startedAt.getTimezoneOffset(),
    };
}

function slugForProvider(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ─── Report ─────────────────────────────────────────────────────────────────

function buildReport({
    url,
    finalUrl,
    startedAt,
    manifestSha256,
    waczSha256,
    screenshotSha256,
    domSha256,
    mhtmlSha256,
    tsaResults,
    tsaErrors,
    tlsSummary,
    connectionSummary,
    certificateChain,
    exchangeCount,
    redirectChain,
    stats,
    webSocketCount,
    provenance,
    machineInfo,
    pageEnvironment,
    operatorName,
    caseReference,
    geolocation,
    accountEmail,
    options,
    timestampsRequestedCount,
    pageInputSuppressed,
}) {
    const lines = [
        "SHARPSHOOTER LEGAL CAPTURE — CAPTURE REPORT",
        "",
        `Captured URL:           ${url}`,
        ...(finalUrl && finalUrl !== url ? [`Final URL (after redirects): ${finalUrl}`] : []),
        `Capture started (UTC):  ${startedAt}`,
        `Network exchanges:      ${options.networkRecording ? exchangeCount : "recording disabled by operator"}`,
        `WebSocket connections:  ${options.networkRecording && options.webSocketCapture ? webSocketCount : "disabled by operator"}`,
        `manifest.json SHA-256:  ${manifestSha256}`,
        ...(waczSha256 ? [`capture.wacz SHA-256:   ${waczSha256}`] : []),
        ...(screenshotSha256 ? [`screenshot.png SHA-256: ${screenshotSha256}`] : []),
        ...(domSha256 ? [`page.html SHA-256:      ${domSha256}`] : []),
        ...(mhtmlSha256 ? [`page.mhtml SHA-256:     ${mhtmlSha256}`] : []),
        "",
    ];

    lines.push(
        "CAPTURE OPTIONS (exactly as recorded, unmodifiable, in manifest.json's",
        "captureOptions — this list is a human-readable copy of it):",
        `  Network exchange recording (WARC/WACZ): ${options.networkRecording ? "ON" : "OFF"}`,
        `  WebSocket capture:                      ${options.webSocketCapture ? "ON" : "OFF"}`,
        `  Service Worker network capture:         ${options.serviceWorkerCapture ? "ON" : "OFF"}`,
        `  Screenshot:                              ${options.screenshot ? "ON" : "OFF"}`,
        `  DOM snapshot (page.html):                ${options.domSnapshot ? "ON" : "OFF"}`,
        `  Full-page MHTML archive (page.mhtml):    ${options.mhtmlSnapshot ? "ON" : "OFF"}`,
        `  Independent RFC 3161 timestamps:         ${options.timestampsEnabled ? "ON" : "OFF"}`,
        `    - FreeTSA:                             ${options.tsaFreeTSA ? "ON" : "OFF"}`,
        `    - DigiCert:                            ${options.tsaDigiCert ? "ON" : "OFF"}`,
        `    - Sectigo:                             ${options.tsaSectigo ? "ON" : "OFF"}`,
        `  SHA256SUMS.txt convenience checksums:    ${options.sha256Sums ? "ON" : "OFF"}`,
        `  Machine info (CPU/memory/displays):      ${options.machineInfo ? "ON" : "OFF"}`,
        `  Browser/page environment info:           ${options.browserPageInfo ? "ON" : "OFF"}`,
        `  Operator geolocation:                    ${options.geolocation ? "ON" : "OFF"}`,
        `  Operator Chrome account email:           ${options.accountEmail ? "ON" : "OFF"}`,
        ""
    );

    if (operatorName || caseReference || geolocation || accountEmail) {
        lines.push(
            "CERTIFICATION / OPERATOR DATA",
            ...(operatorName ? [`  Operator name (typed):    ${operatorName}`] : []),
            ...(caseReference ? [`  Case/matter reference:    ${caseReference}`] : []),
            ...(accountEmail ? [`  Chrome account email:     ${accountEmail}`] : []),
            ...(geolocation
                ? [
                      `  Geolocation (browser API): ${geolocation.latitude}, ${geolocation.longitude} (±${Math.round(geolocation.accuracyMeters)}m, source-dependent — GPS/Wi-Fi/IP)`,
                  ]
                : []),
            "  None of these fields are cryptographically verified by this tool — they",
            "  identify who/where to ask, they are not proof of who captured this or",
            "  from where. The technical authenticity of the package itself rests",
            "  entirely on the hashes and independent timestamps below.",
            ""
        );
    }

    lines.push(
        "CAPTURE TOOL PROVENANCE:",
        `  Tool:            ${provenance.tool} v${provenance.toolVersion}`,
        `  Extension ID:    ${provenance.extensionId}`,
        `  Browser:         ${provenance.userAgent ?? "unknown"}`,
        `  OS/Arch:         ${provenance.platformOs ?? "unknown"} / ${provenance.platformArch ?? "unknown"}`,
        `  Local TZ offset: ${provenance.captureTimezoneOffsetMinutes} minutes from UTC`,
        `  Install type:    ${provenance.installType ?? "unknown"}`,
        ""
    );

    if (provenance.installedFromWebStore === true) {
        lines.push(
            "  Installed from the Chrome Web Store: the extension that produced this",
            "  package is the published, store-reviewed build at the version above,",
            "  not a locally-modified copy.",
            ""
        );
    } else if (provenance.installedFromWebStore === false) {
        lines.push(
            `  *** NOTE: install type is "${provenance.installType}", not a Chrome Web`,
            "  Store installation. The extension was loaded from a local or sideloaded",
            "  copy that the operator could have modified. Nothing here indicates that",
            "  it was modified — but this package's technical claims are only as",
            "  reliable as that local copy, and the artifacts should be verified",
            "  independently (see LIMITS below) rather than taken on the tool's word.",
            ""
        );
    }

    lines.push(
        "CAPTURE-TIME PAGE PROTECTION:",
        "  Forced reload:   yes — the page was reloaded with the HTTP cache",
        "                   bypassed before anything was captured, so any edit",
        "                   made to the DOM beforehand (including via this",
        "                   extension's Remove Elements helper or the browser's",
        "                   own developer tools) was discarded.",
        pageInputSuppressed
            ? "  Input blocked:   yes — mouse, wheel, keyboard and touch input to the\n" +
              "                   page were suppressed at the browser level for the whole\n" +
              "                   capture, so the operator could not alter the page between\n" +
              "                   the reload and the snapshots."
            : "  Input blocked:   NO — the browser did not accept the input-suppression\n" +
              "                   command, so the page remained interactive during the\n" +
              "                   capture. Nothing indicates it was interacted with; this\n" +
              "                   simply records that the protection was not in force.",
        "  Note: this covers input to the page only. It does not, and cannot,",
        "  constrain the browser itself, the page's own JavaScript, or anything",
        "  the operator did before the capture was started.",
        ""
    );

    if (machineInfo) {
        lines.push(
            "MACHINE INFO (operator's device — optional, operator-enabled):",
            `  CPU:      ${machineInfo.cpu ? `${machineInfo.cpu.modelName ?? "unknown model"} (${machineInfo.cpu.archName ?? "?"}, ${machineInfo.cpu.numOfProcessors ?? "?"} logical processors)` : "unavailable"}`,
            `  Memory:   ${machineInfo.memoryCapacityBytes ? `${(machineInfo.memoryCapacityBytes / (1024 ** 3)).toFixed(1)} GB` : "unavailable"}`,
            `  Displays: ${machineInfo.displays ? machineInfo.displays.map((d) => `${d.bounds?.width ?? "?"}x${d.bounds?.height ?? "?"}${d.isPrimary ? " (primary)" : ""}`).join(", ") : "unavailable"}`,
            ""
        );
    }

    if (pageEnvironment) {
        lines.push(
            "BROWSER/PAGE ENVIRONMENT (of the captured tab):",
            `  Screen:            ${pageEnvironment.screen?.width}x${pageEnvironment.screen?.height} @ ${pageEnvironment.devicePixelRatio}x DPR, ${pageEnvironment.screen?.colorDepth}-bit color`,
            `  Locale:            ${pageEnvironment.navigatorLanguage ?? "unknown"} (${(pageEnvironment.navigatorLanguages ?? []).join(", ") || "n/a"})`,
            `  Timezone (IANA):   ${pageEnvironment.timeZone ?? "unknown"}`,
            `  Hardware threads:  ${pageEnvironment.hardwareConcurrency ?? "unknown"}`,
            `  Device memory:     ${pageEnvironment.deviceMemoryGb != null ? `${pageEnvironment.deviceMemoryGb} GB (browser-reported, coarse)` : "unreported"}`,
            `  Document title:    ${pageEnvironment.documentTitle ?? "unknown"}`,
            `  Referrer:          ${pageEnvironment.documentReferrer ?? "(none)"}`,
            ""
        );
    }

    if (redirectChain.length) {
        lines.push("Redirect chain for the requested URL (recorded in full, each hop is its own request/response pair in the WARC):");
        redirectChain.forEach((hop, i) => {
            lines.push(`  ${i + 1}. ${hop.status} ${hop.url}${hop.location ? ` → ${hop.location}` : ""}`);
        });
        lines.push("");
    }

    if (connectionSummary) {
        const priv = connectionSummary.remoteAddressIsPrivateOrLoopback;
        lines.push(
            "SERVING HOST (which machine actually answered, per the browser):",
            `  Remote address: ${connectionSummary.remoteIPAddress ?? "unknown"}${
                connectionSummary.remotePort != null ? `:${connectionSummary.remotePort}` : ""
            }`,
            `  HTTP protocol:  ${connectionSummary.protocol ?? "unknown"}`,
            ""
        );
        if (priv === true) {
            lines.push(
                "  *** NOTE: this address is a loopback, private or link-local address.",
                "  The content captured was served by a machine on the local network or",
                "  the capture machine itself — NOT from the public internet. That is",
                "  expected and legitimate for an intranet or local-development capture,",
                "  but it means the address cannot be checked against public DNS records,",
                "  and a reader should establish independently what host this was.",
                ""
            );
        } else if (priv === false) {
            lines.push(
                "  This is a public address. It can be checked independently against DNS",
                "  and passive-DNS records for the captured domain, by anyone, without",
                "  trusting this extension or this package.",
                ""
            );
        }
    }

    if (tlsSummary) {
        const ct = tlsSummary.certificateTransparencyCompliance;
        lines.push(
            "TLS connection (reported by the browser for the main document response):",
            `  Protocol:  ${tlsSummary.protocol ?? "unknown"}`,
            `  Cipher:    ${tlsSummary.cipher ?? "unknown"}${
                tlsSummary.keyExchange ? ` (key exchange: ${tlsSummary.keyExchange})` : ""
            }`,
            `  Issuer:    ${tlsSummary.issuer ?? "unknown"}`,
            `  Subject:   ${tlsSummary.subjectName ?? "unknown"}`,
            `  Valid:     ${tlsSummary.validFrom ?? "?"} to ${tlsSummary.validTo ?? "?"}`,
            `  CT status: ${ct} (${tlsSummary.signedCertificateTimestampCount} signed certificate timestamp(s))`,
            ""
        );
        if (ct === "compliant") {
            lines.push(
                "  Certificate Transparency compliant: the certificate is published in",
                "  public, append-only CT logs operated by independent parties. A",
                "  certificate issued by a privately-installed root — the usual way to",
                "  serve forged content to a browser under one's own control — cannot",
                "  obtain valid CT log signatures, so this materially corroborates that",
                "  the content came from the real certificate holder.",
                ""
            );
        } else {
            lines.push(
                `  *** NOTE: Certificate Transparency status is "${ct}", not "compliant".`,
                "  This is common and often innocuous (internal/enterprise certificates,",
                "  older certificates, some proxies), but it does mean the certificate",
                "  is NOT corroborated by independent public CT logs. Where the identity",
                "  of the serving party is contested, this should be investigated rather",
                "  than assumed.",
                ""
            );
        }
    } else if (options.networkRecording) {
        lines.push(
            "TLS connection details were not available (e.g. a plain HTTP page, or the",
            "main document response wasn't recorded).",
            ""
        );
    }

    if (certificateChain?.length) {
        lines.push(
            "CERTIFICATE CHAIN (SHA-256 fingerprints of the DER certificates):",
            ...certificateChain.map((c) => `  ${c.position.padEnd(14)} ${c.sha256}`),
            "",
            "  The leaf fingerprint can be searched directly in public Certificate",
            "  Transparency log aggregators (e.g. crt.sh) by anyone, with no reliance",
            "  on this extension. A match establishes that a publicly-logged",
            "  certificate for this domain — not a locally-generated substitute —",
            "  served the captured content.",
            ""
        );
    }

    lines.push(
        "INDEPENDENT TIMESTAMPS (RFC 3161):",
        "  manifest.json's SHA-256 above (not just the WACZ's) is what was sent to",
        "  each authority — manifest.json itself lists the sha256 of every other",
        "  evidentiary file present, so timestamping its hash transitively covers",
        "  them. Each response's messageImprint hash and nonce were verified by",
        "  this extension to match what was actually sent before being accepted",
        "  below — a wrong or corrupted response is treated as a failure, not",
        "  saved and reported as a success.",
        ""
    );
    if (!options.timestampsEnabled) {
        lines.push(
            "  Independent timestamping was turned OFF by the operator for this",
            "  capture. The capture is still hash-sealed (see manifest.json SHA-256",
            "  above), but has no third-party proof of capture time beyond this",
            "  computer's own clock.",
            ""
        );
    } else {
        if (tsaResults.length) {
            for (const r of tsaResults) {
                lines.push(
                    `  [OK] ${r.tsaName} (${r.tsaUrl})`,
                    `       Token time:        ${r.genTime ?? "could not auto-read — verify the .tsr directly (see below)"}`,
                    `       Hash verified:      yes`,
                    `       Nonce verified:     ${r.nonceVerified ? "yes" : "authority did not echo a nonce"}`,
                    `       Local clock skew:   ${r.clockSkewSeconds != null ? `${r.clockSkewSeconds.toFixed(2)}s (local minus authority)` : "could not compute"}`,
                    `       Saved as:           ${r.filename}`
                );
            }
            if (tsaResults.length > 1) {
                const skews = tsaResults.map((r) => r.clockSkewSeconds).filter((s) => s != null);
                if (skews.length > 1) {
                    const spread = Math.max(...skews) - Math.min(...skews);
                    lines.push(
                        `  Spread between independent authorities' skew readings: ${spread.toFixed(2)}s`,
                        "  (a small spread here corroborates that both authorities and this",
                        "  machine's clock agree closely, independent of any single party)"
                    );
                }
            }
            lines.push("");
        }
        if (tsaErrors.length) {
            for (const e of tsaErrors) {
                lines.push(`  [FAILED] ${e.provider}: ${e.error}`);
            }
            lines.push("");
        }
        if (!tsaResults.length) {
            lines.push(
                "  No independent timestamp could be obtained from any enabled authority.",
                "  The capture is still hash-sealed (see manifest.json SHA-256 above), but",
                "  has no third-party proof of capture time beyond this computer's own",
                "  clock.",
                ""
            );
        } else if (tsaResults.length < timestampsRequestedCount) {
            lines.push(
                `  Only ${tsaResults.length} of ${timestampsRequestedCount} enabled authorities responded`,
                "  successfully. The capture is still validly timestamped by the one(s)",
                "  that did — this is not a failure, just reduced redundancy versus a",
                "  capture with all of them.",
                ""
            );
        }
        lines.push(
            "  Verify independently with standard tools, without trusting this report:",
            "    openssl ts -reply -in capture-<authority>.tsr -text",
            ""
        );
    }

    if (options.networkRecording) {
        lines.push(
            "NETWORK RECORDING COVERAGE:",
            `  - ${stats.bodyFailures} of ${exchangeCount} HTTP exchange(s) had their response body`,
            "    fail to fetch (large/streaming media hitting the recorder's timeout is",
            "    the common cause) — those exchanges are still in the WARC with their",
            "    request/response headers, just without a body.",
            `  - ${stats.loadFailures} exchange(s) failed to load entirely (network error,`,
            "    blocked request, etc.) and are recorded as such.",
            options.webSocketCapture
                ? `  - ${webSocketCount} WebSocket connection(s) recorded` +
                      (stats.webSocketFrameErrors ? `, with ${stats.webSocketFrameErrors} frame error(s).` : ".")
                : "  - WebSocket capture was turned OFF by the operator for this capture.",
            options.serviceWorkerCapture
                ? stats.serviceWorkerAttached
                    ? `  - This page's Service Worker network activity WAS captured (${stats.serviceWorkerAttached} worker target(s) attached) — resources it intercepts/serves from its own cache are included, tagged 'via service-worker' in the WARC headers.`
                    : "  - This page's Service Worker (if any) was NOT captured as a separate source — if the site uses one to serve cached responses without a network round trip, on-screen content may not have a corresponding WARC entry."
                : "  - Service Worker capture was turned OFF by the operator for this capture.",
            ...(options.serviceWorkerCapture && stats.serviceWorkerAttachFailures
                ? [`  - ${stats.serviceWorkerAttachFailures} Service Worker target attach attempt(s) failed.`]
                : []),
            ""
        );
    } else {
        lines.push(
            "NETWORK RECORDING COVERAGE:",
            "  Network exchange recording was turned OFF by the operator for this",
            "  capture — there is no capture.wacz, no TLS summary, and no redirect",
            "  chain. Whatever other artifacts are present above are unaffected.",
            ""
        );
    }

    lines.push("WHAT THIS PROVES:");
    if (waczSha256) {
        lines.push(
            "  - capture.wacz is a byte-exact recording of the actual HTTP exchange",
            "    between this browser and the server for the URL above, including any",
            "    redirect chain, response headers and bodies. Open it at",
            "    https://replayweb.page to replay the page exactly as captured,",
            "    independent of this tool."
        );
        if (options.webSocketCapture) {
            lines.push(
                "  - Recorded WebSocket traffic (if any) is included as a transcript inside",
                "    the same WARC — see the 'application/x-ndjson' resource records."
            );
        }
    }
    if (screenshotSha256) lines.push("  - screenshot.png is a visual capture taken during the same session.");
    if (domSha256) {
        lines.push(
            "  - page.html is the live, post-JavaScript-execution DOM serialized at",
            "    the same moment as the screenshot — independent machine-readable",
            "    evidence of the markup behind what the screenshot shows, separate",
            "    from both the raw HTTP bodies in capture.wacz and the raster image."
        );
    }
    if (mhtmlSha256) {
        lines.push(
            "  - page.mhtml is a browser-native MHTML archive of the complete rendered",
            "    page — markup, stylesheets, scripts, images, and fonts bundled into a",
            "    single self-contained file using Chrome's own DevTools Protocol",
            "    (Page.captureSnapshot), not this codebase's own asset-fetching logic.",
            "    Opens directly in Chrome/Edge (drag onto a tab, or File > Open) or any",
            "    MHTML-capable mail/archive tool, independent of this extension."
        );
    }
    lines.push(
        "  - manifest.json's per-file hashes let anyone confirm every file listed",
        "    above has not been altered since capture, and its own hash is what the",
        "    independent timestamp(s) above actually cover.",
        "  - manifest.json's captureOptions block is a sealed, tamper-evident record",
        "    of exactly which of the above were enabled for this specific capture."
    );
    if (options.sha256Sums) {
        lines.push(
            "  - SHA256SUMS.txt lets anyone confirm no file in this zip (including",
            "    manifest.json itself) was swapped after the package was assembled —",
            "    recompute each listed file's SHA-256 and compare."
        );
    }
    lines.push(
        "",
        "WHAT THIS DOES NOT PROVE:",
        "  - It does not itself validate the TLS certificate chain or query",
        "    Certificate Transparency logs — the TLS summary, CT status and",
        "    certificate fingerprints above are what the browser reported for this",
        "    connection, recorded so that a reader can check them against public",
        "    CT logs independently. That check is deliberately left to the reader",
        "    rather than performed by this tool's own code.",
        "  - It cannot rule out tampering upstream of the browser (compromised DNS,",
        "    a malicious network path, etc.) beyond what a valid TLS handshake for",
        "    the target domain already implies.",
        "  - It does not capture content a Service Worker serves without a network",
        "    round trip, when Service Worker capture was disabled or attach was not",
        "    possible.",
        "  - It does not capture non-WebSocket, non-HTTP channels (e.g. WebRTC data",
        "    channels), if the page uses any.",
        "  - Geolocation (if included) comes from the browser's Geolocation API on",
        "    the operator's machine, not from anything about the captured page — its",
        "    accuracy depends entirely on the OS/network location source used and is",
        "    not independently verified by this tool.",
        "  - This is supporting technical evidence, not a legal determination —",
        "    consult counsel on how to present it."
    );

    // The single most important section for anyone weighing this package.
    // Stated plainly and up front because a tool that overstates its own
    // reach is worth less in front of a tribunal than one that marks its
    // boundary precisely — and because a reader who assumes "tamper-proof"
    // will draw conclusions this package cannot support.
    lines.push(
        "",
        "LIMITS — PLEASE READ:",
        "  This package was produced by a browser extension running on a machine",
        "  the operator controlled. That is an unavoidable property of any capture",
        "  tool of this kind, and it bounds what the package can establish.",
        "",
        "  What the hashes and timestamps establish is INTEGRITY SINCE CAPTURE:",
        "  that these exact bytes existed at the timestamped moment and have not",
        "  been altered since. That is a strong, independently checkable claim.",
        "",
        "  They do not, by themselves, establish PROVENANCE — that the captured",
        "  bytes are what the named website actually served. An operator with",
        "  control of their own machine could direct the browser to a server they",
        "  ran, or use a locally-installed certificate authority, and then capture",
        "  the result honestly: every hash would be correct and every timestamp",
        "  genuine. A timestamp proves when bytes existed; it cannot prove where",
        "  they came from.",
        "",
        "  Provenance is instead corroborated by the independently checkable",
        "  facts recorded above, which a reader should actually check if the",
        "  authenticity of this capture is contested:",
        "    1. The serving host's IP address — verifiable against public DNS and",
        "       passive-DNS history for the domain.",
        "    2. The Certificate Transparency status and the leaf certificate",
        "       fingerprint — searchable in public CT logs (e.g. crt.sh). A",
        "       locally-forged certificate cannot appear there.",
        "    3. The extension's install type — whether the tool was the published",
        "       Chrome Web Store build or a locally-modifiable copy.",
        "    4. The WACZ replay itself — openable in ReplayWeb.page by anyone,",
        "       independently of this extension.",
        "  Where those agree with the claimed source, fabrication would have",
        "  required considerably more than a cooperative local machine. Where they",
        "  are absent or inconsistent, that is worth investigating before relying",
        "  on this package.",
        "",
        "  Note also that items 1-3 are reported by the same extension that wrote",
        "  this file. A deliberately modified build could misreport them. They are",
        "  meaningful because they are checkable against outside sources — not",
        "  because this document asserts them."
    );

    return lines.join("\n");
}

export async function startLegalCapture({
    tabId,
    url,
    deviceMetrics,
    presetType,
    fullPageHeightCap,
    operatorName,
    caseReference,
    options: rawOptions,
    geolocation,
}) {
    const options = resolveLegalCaptureOptions(rawOptions);
    const startedAt = new Date();

    return withZoomReset(tabId, async () => {
        await showCaptureOverlay(tabId);
        await attachDebugger(tabId); // throws DevToolsAttachedError if native DevTools holds the tab

        let exchanges = [];
        let webSockets = [];
        let stats = null;
        let mainDocumentRequestId = null;
        let screenshotBase64;
        let domSnapshotHtml = null;
        let pageEnvironment = null;
        let mhtmlText = null;
        let inputSuppressed = false;
        let certificateChain = null;
        try {
            // Before anything else: stop user input reaching the page, so
            // nothing the operator does (deliberately or by accident) can
            // alter the page between here and the snapshots. Survives the
            // reload below, unlike the DOM overlay.
            inputSuppressed = await suppressPageInput(tabId);

            if (options.networkRecording) {
                await startRecording(tabId, {
                    captureWebSockets: options.webSocketCapture,
                    captureServiceWorker: options.serviceWorkerCapture,
                });
            }
            // The reload's own traffic IS the evidence when recording is on —
            // it also restores the original HTML (undoing any Remove
            // Elements edit) regardless of whether recording is enabled, so
            // it always runs.
            await reloadAndWaitForComplete(tabId);

            // The reload destroyed the document the overlay lived in — put
            // it back, so the page the operator is looking at explains why
            // it has stopped responding. Re-assert the input flag too: it is
            // session-scoped and expected to survive the navigation, but
            // re-asserting is idempotent and cheap next to being wrong.
            await showCaptureOverlay(tabId);
            inputSuppressed = (await suppressPageInput(tabId)) || inputSuppressed;

            const effectiveMetrics = await reMeasureForPreset(
                tabId,
                deviceMetrics,
                presetType,
                fullPageHeightCap
            );

            await hideScrollbars(tabId);
            await enableEmulation(tabId, effectiveMetrics);
            await postEmulationBreather(tabId);
            await injectMutationWatcher(tabId);
            await waitForMutationSettle(tabId);

            if (options.screenshot) screenshotBase64 = await takeScreenshotClip(tabId);

            // Strip this extension's own injected nodes — the capture overlay
            // and the scrollbar-hiding <style> — before serializing the DOM.
            // The screenshot only needs them *visually* absent (takeScreenshotClip
            // handles that via withOverlayHidden), but page.html and page.mhtml
            // are byte-level evidence of what the site served: an examiner
            // finding a `__sharpshooter-capture-overlay` div in them has found
            // proof the artifact was modified after loading, which is exactly
            // the argument this feature exists to foreclose. Input stays
            // suppressed throughout, so removing the overlay does not reopen
            // the tampering window — it only makes the page look normal again
            // for the remaining moments of the capture.
            await Promise.all([hideCaptureOverlay(tabId), restoreScrollbars(tabId)]);

            // Taken immediately after the screenshot, same emulated/settled
            // page state, so all of these describe the same moment.
            ({ html: domSnapshotHtml, environment: pageEnvironment } = await captureDomAndEnvironment(
                tabId,
                options.domSnapshot,
                options.browserPageInfo
            ));
            if (options.mhtmlSnapshot) mhtmlText = await captureMhtmlSnapshot(tabId);

            // Needs the debugger still attached, so it happens here rather
            // than alongside the other TLS bookkeeping after teardown. The
            // tab's current URL is the post-redirect origin — the host that
            // actually served what was captured.
            const settledUrl = await chrome.tabs
                .get(tabId)
                .then((t) => t?.url ?? url)
                .catch(() => url);
            certificateChain = await collectCertificateChain(
                tabId,
                (() => {
                    try {
                        return new URL(settledUrl).origin;
                    } catch {
                        return null;
                    }
                })()
            );
        } finally {
            ({ exchanges, webSockets, stats, mainDocumentRequestId } =
                await stopRecording(tabId).catch(() => ({ exchanges: [], webSockets: [], stats: null, mainDocumentRequestId: null })));
            // restorePageInput must run while the debugger is still attached.
            // Detaching clears the flag anyway, so this is belt-and-braces
            // for the case where detach itself fails.
            await Promise.all([
                restoreScrollbars(tabId),
                clearEmulation(tabId),
                restorePageInput(tabId),
            ]);
            await detachDebugger(tabId);
            await hideCaptureOverlay(tabId);
        }
        stats = stats ?? {
            bodyFailures: 0,
            loadFailures: 0,
            webSocketFrameErrors: 0,
            serviceWorkerAttachFailures: 0,
            serviceWorkerAttached: 0,
        };

        const startedAtIso = startedAt.toISOString();
        const encoder = new TextEncoder();

        let waczBytes = null;
        let waczSha256 = null;
        if (options.networkRecording) {
            const { bytes: warcBytes, index } = await buildWarc(exchanges, webSockets, {
                url,
                startedAt: startedAtIso,
                startedAtSeconds: Math.floor(startedAt.getTime() / 1000),
            });
            const warcSha256 = await sha256Hex(warcBytes);
            waczBytes = await buildWacz({ warcBytes, index, url, startedAt: startedAtIso, warcSha256 });
            waczSha256 = await sha256Hex(waczBytes);
        }

        const screenshotBytes = screenshotBase64 ? base64ToBytes(screenshotBase64) : null;
        const screenshotSha256 = screenshotBytes ? await sha256Hex(screenshotBytes) : null;

        const domBytes = domSnapshotHtml != null ? encoder.encode(domSnapshotHtml) : null;
        const domSha256 = domBytes ? await sha256Hex(domBytes) : null;

        const mhtmlBytes = mhtmlText != null ? encoder.encode(mhtmlText) : null;
        const mhtmlSha256 = mhtmlBytes ? await sha256Hex(mhtmlBytes) : null;

        const mainExchange = options.networkRecording ? findMainDocumentExchange(exchanges, mainDocumentRequestId, url) : null;
        const finalUrl = mainExchange?.url ?? url;
        const tlsSummary = tlsSummaryFrom(mainExchange);
        const connectionSummary = connectionSummaryFrom(mainExchange);
        const redirectChain = options.networkRecording ? redirectChainFor(exchanges, mainDocumentRequestId) : [];
        const toolProvenance = await collectToolProvenance(startedAt);
        const machineInfo = options.machineInfo ? await collectMachineInfo() : null;
        const accountEmail = options.accountEmail ? await collectAccountEmail() : null;

        // ── manifest.json: frozen BEFORE any TSA request, since its hash is
        // what gets independently timestamped (see file header). Nothing
        // added after this point may change these bytes.
        const manifestCore = {
            // 5: added connection (server IP), certificateChain fingerprints,
            // CT/SCT detail on tls, and provenance.installType /
            // provenance.pageInputSuppressed.
            formatVersion: 5,
            url,
            finalUrl,
            startedAt: startedAtIso,
            tool: "Sharpshooter Legal Capture",
            captureOptions: options,
            operator: {
                name: operatorName || null,
                caseReference: caseReference || null,
                accountEmail,
                geolocation: geolocation ?? null,
            },
            provenance: {
                ...toolProvenance,
                machine: machineInfo,
                page: pageEnvironment,
                // Recorded rather than asserted: if the browser refused the
                // command, the package says so instead of report.txt claiming
                // a protection that wasn't in force.
                pageInputSuppressed: inputSuppressed,
            },
            files: {
                ...(waczSha256 ? { "capture.wacz": { sha256: waczSha256 } } : {}),
                ...(screenshotSha256 ? { "screenshot.png": { sha256: screenshotSha256 } } : {}),
                ...(domSha256 ? { "page.html": { sha256: domSha256 } } : {}),
                ...(mhtmlSha256 ? { "page.mhtml": { sha256: mhtmlSha256 } } : {}),
            },
            tls: tlsSummary,
            certificateChain,
            connection: connectionSummary,
            redirectChain,
            network: {
                enabled: options.networkRecording,
                exchangeCount: options.networkRecording ? exchanges.length : 0,
                bodyFailures: stats.bodyFailures,
                loadFailures: stats.loadFailures,
                webSocketCount: options.networkRecording && options.webSocketCapture ? webSockets.length : 0,
                webSocketFrameErrors: stats.webSocketFrameErrors,
            },
            serviceWorker: {
                targetsAttached: stats.serviceWorkerAttached,
                attachFailures: stats.serviceWorkerAttachFailures,
                exchangesCaptured: exchanges.filter((ex) => ex.viaServiceWorker).length,
                webSocketsCaptured: webSockets.filter((ws) => ws.viaServiceWorker).length,
            },
        };
        const manifestBytes = encoder.encode(JSON.stringify(manifestCore, null, 2));
        const manifestSha256 = await sha256Hex(manifestBytes);
        const manifestHashBytes = await sha256Bytes(manifestBytes);

        // ── Independent public TSAs (see TSA_PROVIDERS), filtered to the
        // ones the operator left enabled, queried concurrently. None
        // succeeding doesn't abort the capture (the hash-seal stands on its
        // own); more succeeding is simply stronger evidence than fewer.
        const enabledProviders = options.timestampsEnabled
            ? TSA_PROVIDERS.filter((p) => options[TSA_OPTION_KEY[p.name]] !== false)
            : [];
        const tsaSettled = await Promise.allSettled(
            enabledProviders.map((provider) => requestTimestamp(manifestHashBytes, provider))
        );
        const tsaResults = [];
        const tsaErrors = [];
        tsaSettled.forEach((result, i) => {
            if (result.status === "fulfilled") {
                tsaResults.push({ ...result.value, filename: `capture-${slugForProvider(enabledProviders[i].name)}.tsr` });
            } else {
                tsaErrors.push({ provider: enabledProviders[i].name, error: result.reason?.message ?? String(result.reason) });
            }
        });

        const timestamps = {
            enabled: options.timestampsEnabled,
            manifestSha256,
            results: tsaResults.map((r) => ({
                authority: r.tsaName,
                url: r.tsaUrl,
                genTime: r.genTime,
                nonceVerified: r.nonceVerified,
                clockSkewSeconds: r.clockSkewSeconds,
                filename: r.filename,
            })),
            errors: tsaErrors,
        };
        const timestampsBytes = encoder.encode(JSON.stringify(timestamps, null, 2));

        const report = buildReport({
            url,
            finalUrl,
            startedAt: startedAtIso,
            manifestSha256,
            waczSha256,
            screenshotSha256,
            domSha256,
            mhtmlSha256,
            tsaResults,
            tsaErrors,
            tlsSummary,
            connectionSummary,
            certificateChain,
            exchangeCount: exchanges.length,
            redirectChain,
            stats,
            webSocketCount: webSockets.length,
            provenance: toolProvenance,
            machineInfo,
            pageEnvironment,
            operatorName: operatorName || null,
            caseReference: caseReference || null,
            geolocation: geolocation ?? null,
            accountEmail,
            options,
            timestampsRequestedCount: enabledProviders.length,
            pageInputSuppressed: inputSuppressed,
        });
        const reportBytes = encoder.encode(report);

        const packageEntries = [
            { name: "manifest.json", data: manifestBytes },
            { name: "timestamps.json", data: timestampsBytes },
            { name: "report.txt", data: reportBytes },
        ];
        if (waczBytes) packageEntries.push({ name: "capture.wacz", data: waczBytes });
        if (screenshotBytes) packageEntries.push({ name: "screenshot.png", data: screenshotBytes });
        if (domBytes) packageEntries.push({ name: "page.html", data: domBytes });
        if (mhtmlBytes) packageEntries.push({ name: "page.mhtml", data: mhtmlBytes });
        for (const r of tsaResults) packageEntries.push({ name: r.filename, data: r.tsrBytes });

        if (options.sha256Sums) {
            // SHA256SUMS.txt: convenience whole-package integrity check over
            // every file actually going into the zip (see file header for
            // why this is not itself the sealed anchor — manifest.json is).
            const sumsLines = await Promise.all(
                packageEntries.map(async ({ name, data }) => `${await sha256Hex(data)}  ${name}`)
            );
            packageEntries.push({ name: "SHA256SUMS.txt", data: encoder.encode(sumsLines.join("\n") + "\n") });
        }

        const zipBytes = buildZip(packageEntries);
        const suffix = startedAtIso.replace(/[:.]/g, "-");

        await new Promise((resolve, reject) => {
            chrome.downloads.download(
                {
                    url: `data:application/zip;base64,${bytesToBase64(zipBytes)}`,
                    filename: `legal-capture-${suffix}.zip`,
                    saveAs: true,
                },
                (downloadId) => {
                    const err = chrome.runtime.lastError;
                    if (err) return reject(new Error(err.message));
                    if (downloadId == null) return reject(new Error("Download did not start"));
                    resolve(downloadId);
                }
            );
        });

        return {
            exchangeCount: exchanges.length,
            waczSha256,
            manifestSha256,
            timestamped: tsaResults.length > 0,
            timestampCount: tsaResults.length,
        };
    });
}
