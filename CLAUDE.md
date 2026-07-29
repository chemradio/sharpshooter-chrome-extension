# Sharpshooter

Chrome MV3 extension for high-resolution page and element screenshots. Used for MotionGFX, archiving, and general purpose. All capture uses the Chrome DevTools Protocol (CDP) via `chrome.debugger` for device emulation + `Page.captureScreenshot`.

This document describes the current implementation. Aspirational features are split into a "Planned" section at the end; do not assume they exist.

> **Removed:** the Cleanup / Filters feature (EasyList fetching, bundled +
> user filters, AdRemover, the Expert-mode filter manager) has been deleted
> from the codebase — not just disabled. There is no Cleanup button, no
> `adRemover/` directory, no `contentScripts/adRemover.js` /
> `contentScripts/cleanup.js`, and no filter-related message actions. "Expert
> mode" is now a **Settings** panel (gear icon) — output format (PNG/JPEG +
> quality), opaque PNG re-encode (on by default), filename prefix,
> default-crop, full-page height cap, navigation-hint toggle, and theme /
> language overrides. There is no setting to skip the Save-As dialog —
> every download shows Chrome's native save dialog (`saveAs: true`, hardcoded).

---

## Entry points

All captures are triggered from the **toolbar popup** ([popup.html](popup.html) / [popup.js](popup.js)) — main UI with quality multiplier (scale), resolution presets, and the capture buttons: **Page Capture** and **Capture Element**. Each capture control is a **segmented button**: a wide main segment that captures and saves directly, plus a narrow **with crop** segment (`.btn-capture--crop`) that routes the shot through the crop editor. When the **Always open the crop editor** setting is on, every capture goes to the editor and the crop segments are hidden via the `.crop-default` class on `.popup`. A **Helpers** row holds **Remove Elements** (interactive DOM killer) and **Extract Image**. Extract Image is also a segmented button: the main segment extracts and saves directly, the narrow **with crop** segment sends the image to the crop editor. When opened on a supported site (Facebook, Instagram, Telegram, X, VK, Threads) the popup also runs a non-destructive site-detection pass and surfaces a "Capture this <post/story>" button at the top if a target is recognized. A header **?** button opens an in-popup help panel, and a header **gear** button opens the **Settings** panel. A specialist **Legal Capture** section (see below) appears at the bottom of the main view, hidden by default behind a Settings toggle.

The radio chips (quality multiplier, resolution presets, settings radio groups) get a prominent hover state — accent border, tinted fill, and cyan glow (`.radio-group label:hover`). The resolution row shows just the two number inputs and a `×` separator (no "px" suffix).

---

## Capture modes

### Emulated viewport capture (Capture Page)

User picks a resolution preset and scale factor. The extension attaches the debugger, emulates the chosen device metrics, waits for the page to settle (MutationObserver-based), captures, and detaches.

Resolution presets in the popup ([popup.js](popup.js)):

| Preset         | Width            | Height                          |
|----------------|------------------|---------------------------------|
| User (default) | tab `innerWidth` | tab `innerHeight`               |
| Full Page      | tab `innerWidth` | measured from the live document |
| Vertical HD    | 1920             | 7000                            |
| FullHD         | 1920             | 1080                            |
| 4K             | 3840             | 2160                            |
| Custom         | user-editable    | user-editable                   |

The User and Full Page presets size to the active tab's viewport (CSS pixels at the user's current zoom — what they actually see). The popup fetches this on open via the `getViewportSize` action in [backgroundScript.js](backgroundScript.js), which runs `chrome.scripting.executeScript` against the tab and returns `{innerWidth, innerHeight}`. Until the message resolves (or on restricted URLs like `chrome://` where scripting is blocked) the popup falls back to its own `window.screen.{width,height}` so inputs are never blank. Editing either input on any preset other than Full Page auto-switches the radio to **Custom**.

Presets are user-configurable via Settings: each can be shown/hidden, reordered by drag-handle, and the fixed-dimension ones (Vertical HD, FullHD, 4K) can have their label and W×H edited or be deleted outright. User-added presets (type `"fixed"`) can also be created. The **Restore factory presets** button resets the list to the six defaults above.

Scale factor (`deviceScaleFactor`): 1× / 2× / 3× / 4×. Default **2×**.

### DOM element capture (Capture Element)

User clicks the button, then hovers elements on the page. A cyan glow indicates the current target. **Scroll wheel** walks the DOM tree:
- **Wheel up** → parent element
- **Wheel down** → first child element

Click commits the selection. The extension then:
1. Attaches the debugger and emulates the same device metrics the popup had set.
2. Locates the element via XPath (built at click time in [contentScripts/elementHighlighter.js](contentScripts/elementHighlighter.js)).
3. `scrollIntoView({block:"center", inline:"center", behavior:"instant"})` inside a CDP `Runtime.evaluate` call (same channel as the screenshot — minimizes the measure→capture gap so scroll-restoration handlers can't run between the two).
4. If the element exceeds the emulated viewport, expands emulation up to 16384 px (CDP cap) with 64 px padding, re-injects the mutation watcher, re-emulates, settles, re-measures.
5. Takes a viewport screenshot and crops it in JS via `OffscreenCanvas` + `createImageBitmap`.

**Why crop in JS instead of using CDP's `clip` parameter:** CDP page-absolute coordinates drift on sites with custom scroll containers (Facebook), CSS zoom, or CSS transforms. Viewport-relative `getBoundingClientRect` always matches what's on screen. See [screenshots/elementSelect/elementClickListener.js](screenshots/elementSelect/elementClickListener.js) header comment.

### Site-detection prompt (Capture this post/story)

When the popup opens, it sends `detectSite` to the background, which calls `detectSite` in [screenshots/autoCapture.js](screenshots/autoCapture.js). That function picks a site module by hostname (`SITE_MODULES` map) and first runs a URL-pattern gate (`SITE_URL_PATTERNS`) to ensure the URL looks like a single-post / single-story page — without this gate the in-page DOM detectors false-fire on feed and profile pages (e.g. Instagram's `article`, Facebook's `data-pagelet="GroupFeed"`, X's `article[tabindex="-1"]` all match on timelines). Only if the URL passes does it inject [contentScripts/sites/_xpath.js](contentScripts/sites/_xpath.js) + `contentScripts/sites/<name>.js` after setting `window.__SiteOptions = { detectOnly: true }`. In that mode each module's IIFE runs only its `getPageType()` detector and resolves `window.__AutoCapturePending` with `{ mode: "detect", pageType }` — no DOM cleanup, no xpath build. If `pageType` is `post` / `story` / `groupPost`, the popup unhides the top "Capture this <X>" section with a label tuned to the type.

Click → background dispatches `captureSiteElement`, which:

1. Re-injects the site module with `detectOnly: false`. The module now runs its full pipeline: per-page-type DOM cleanup (remove comment-as toolbars, see-more buttons, sidebar panels; set `font-family`) and xpath build. Resolves with `{ mode: "element", xpath }`.
2. Calls `captureElement()` (defaults to `innerWidth`×7000 @ user scale so the captured layout matches what the user sees at their browser zoom; auto-expands up to 16384 px per the element pipeline; a site module may attach a `viewport` hint to override).

If the post/story is no longer present by the time the user clicks (page navigated, post deleted), `captureSiteElement` throws "No element target detected" and the popup surfaces the error — it does **not** silently fall through to a full-page capture.

Profile and unknown pages have no entry in `PROMPT_LABELS` ([popup.js](popup.js)) and never show the prompt — those flows go through Page Capture.

Supported sites: Facebook, Instagram, Telegram (t.me), X / Twitter, VK, Threads. Site modules are intentionally independent files so adding a host = drop a new file under [contentScripts/sites/](contentScripts/sites/) and add one line to `SITE_MODULES`. **Each module's IIFE must honor `window.__SiteOptions?.detectOnly`** — early-return with `{ mode: "detect", pageType }` before any DOM mutation, otherwise simply opening the popup will mutate the user's page.

Site modules do not touch `document.body.style.zoom`. All capture paths (page, element) wrap the emulated session in `withZoomReset` ([support/zoomReset.js](support/zoomReset.js)): the user's per-tab browser zoom is set to 1 for the duration of the capture, then restored. This is required for accurate element crops *and* for page-mode captures to produce the layout the user expects — at non-1 zoom, `Emulation.setDeviceMetricsOverride` and the browser zoom transform interact and the page lays out for the wrong width (e.g. at 175% zoom a "1920" request ends up emulating ~1097 CSS px, which forces social sites into their narrow/mobile layout).

---

## Image Extractor

The **Extract Image** helper ([contentScripts/imageExtractor.js](contentScripts/imageExtractor.js)) downloads the highest-resolution raster image found inside a selected DOM subtree, without taking a screenshot at all. User clicks the button, then hovers elements on the page. A **amber** (#F59E0B) glow indicates the current target (same DOM navigation model as element capture: scroll wheel = parent/child, arrow keys = parent/child/siblings, Esc = cancel).

On click (or Enter):

1. `findImages(el)` scans the element's subtree for raster sources in priority order:
   - `<img>` elements (picks the largest `srcset` candidate, or `src`; skips fallback `<img>` inside `<picture>`; skips SVG; skips elements < 50×50 px).
   - `<picture>` elements — one best candidate per `<picture>`: the highest descriptor URL across all `<source>` srcsets and the fallback `<img>`.
   - CSS `background-image` on every descendant and the element itself (skips SVG; skips < 50×50 px).
   - `<canvas>` elements are flagged separately — not downloadable directly, shown in the picker with a "use Capture Element" hint.
2. Results are sorted highest-resolution first (`w × h`).
3. If **one** non-canvas result is found, it goes straight to download (or crop). If **multiple** are found, a modal picker appears with thumbnail previews; the top entry is badged **BEST**.
4. If **no** images are found in the subtree, the extractor walks the DOM upward looking for a CSS `background-image` on an ancestor (`walkUpForBg`). If still nothing, a toast message is shown.
5. The selected URL is sent to the background:
   - **Download:** `imageExtractorDownload` action — the service worker fetches the URL, converts to PNG via `OffscreenCanvas`, and calls `chrome.downloads.download`. Before fetching, `stripCdnSuffix` strips common dimension/size suffixes (e.g. `_800x600`, `_large`) and probes the stripped URL via HEAD; if it responds 200, the stripped (likely full-size) URL is fetched instead.
   - **Crop:** `imageExtractorCropUrl` action — same fetch + convert flow, then `handoffToCropEditor` to send the PNG into the crop editor.

`window.__ImageExtractorOptions = { manualCrop: true }` is set by the background before injecting the script when the user clicked the crop segment.

[contentScripts/imageExtractor.js](contentScripts/imageExtractor.js) is an IIFE that exposes `window.__ImageExtractorDestroy` so re-injection cleans up the previous instance (overlay, event listeners, picker) instead of double-binding.

---

## Legal Capture

A specialist capture mode aimed at investigative/legal use, where a plain
screenshot isn't strong enough evidence: it produces a hash-sealed,
independently-timestamped forensic package instead of just an image. Hidden
by default — enabled via the **Enable Legal Capture** toggle in Settings,
which unhides a **Legal Capture** section at the bottom of the main popup
view.

**What it does, in order** ([support/legalCapture/legalCaptureSession.js](support/legalCapture/legalCaptureSession.js)):

1. Attaches the debugger and starts CDP `Network`/`Security` domain recording
   ([support/legalCapture/networkRecorder.js](support/legalCapture/networkRecorder.js)) **before** anything else.
2. Forces a clean, cache-bypassed reload (`chrome.tabs.reload({bypassCache:true})`) and waits for it to finish. This is deliberate ordering, not incidental: the reload's own request/response traffic *is* the evidence being captured, so recording must already be active when it happens — and forcing a fresh load also means neither a prior **Remove Elements** edit nor a live DevTools DOM edit can be part of what gets captured (see below).
3. If the active resolution preset is `viewport` (User) or `fullpage` (Full Page), re-measures the tab's viewport/page height **after** the reload ([support/pageMeasure.js](support/pageMeasure.js)) rather than trusting the numbers the popup measured before the click — a fresh reload can have less lazy-loaded content on screen than whatever the popup saw a moment earlier, and using the stale numbers produces an undersized screenshot. Fixed/custom presets are used as-is (they're explicit numbers, not page-derived).
4. Emulates the (possibly re-measured) device metrics and takes the screenshot through the same `withZoomReset` / mutation-settle path as Page Capture.
5. Stops recording and builds a **WARC/1.0** file from the recorded exchanges (raw request/response headers + bodies + TLS `securityDetails`) — [support/legalCapture/warcWriter.js](support/legalCapture/warcWriter.js), hand-written (no bundler/npm dependency exists in this repo, so no WARC library could be pulled in).
6. Wraps the WARC into a **WACZ** (a ZIP, method STORE — no DEFLATE implementation needed) with a CDXJ index, `pages.jsonl`, and `datapackage.json` — [support/legalCapture/zipWriter.js](support/legalCapture/zipWriter.js). Playable in [ReplayWeb.page](https://replayweb.page) by anyone, independent of this extension.
7. Hashes the WACZ (`crypto.subtle.digest`, SHA-256) and requests an **RFC 3161 timestamp** for that hash from the public FreeTSA authority (`https://freetsa.org/tsr`) — [support/legalCapture/tsaClient.js](support/legalCapture/tsaClient.js). The DER request is hand-encoded (no ASN.1 library); the raw signed response token is saved untouched rather than self-verified, since re-implementing CMS/X.509 chain validation would make the report only as trustworthy as this codebase's own from-scratch validator. Verify independently with `openssl ts -reply -in capture.tsr -text`.
8. Downloads one zip (`legal-capture-<timestamp>.zip`, `saveAs: true`) containing `capture.wacz`, `screenshot.png`, `capture.tsr`, `manifest.json` (hash, TLS summary, timestamp), and `report.txt` (plain-language "what this proves / doesn't prove" writeup).

**Guards against disputing "the HTML was unaltered":**
- **Remove Elements**: [contentScripts/domKiller.js](contentScripts/domKiller.js) broadcasts `domKillerUsed` the first time an element is actually removed on a tab; [support/tabState.js](support/tabState.js) records that per-tab in `chrome.storage.session` (cleared on the tab's next navigation via `chrome.tabs.onUpdated`). The popup surfaces this as an informational warning banner in the Legal Capture section — informational only, since step 2's forced reload already restores the original HTML regardless.
- **Native DevTools open on the tab**: `chrome.debugger.attach` fails if a real DevTools window already holds the tab's debugger slot. [support/debugerAttachment.js](support/debugerAttachment.js)'s `attachDebugger` normally auto-recovers from an "already attached" error (a leaked *own* prior session), but if the retry fails too, it now throws a distinguishable `DevToolsAttachedError` instead of a generic Chrome error string, which the popup turns into "DevTools is open on this tab. Close it and try again." There's no reliable way to detect a DevTools-made DOM edit *after the fact* — a live MutationObserver can't distinguish a human editing via Elements-panel from the page's own routine JS-driven DOM churn — so the forced reload is the actual safeguard, not detection.

**What this does and doesn't prove** (also spelled out in the generated `report.txt`): the WACZ is a byte-exact recording of the real HTTP exchange, sealed with a hash and an independent third-party timestamp — but this extension doesn't re-verify the TLS certificate chain or the TSA's signature itself, and it's supporting technical evidence, not a legal determination.

---

## Architecture notes

- **Service worker:** [backgroundScript.js](backgroundScript.js). Owns a specific set of message actions (`getPageHeight`, `getViewportSize`, `capturePage`, `captureElement`, `detectSite`, `captureSiteElement`, `domKiller`, `stopDomKiller`, `imageExtractor`, `imageExtractorDownload`, `imageExtractorCropUrl`, `getTabCaptureFlags`, `startLegalCapture`) and always responds with `{ok: true, ...}` or `{ok: false, error}`. Other listeners own their own actions to avoid channel conflicts: the element-click handler in [screenshots/elementSelect/elementClickListener.js](screenshots/elementSelect/elementClickListener.js) claims `elementClicked`; [support/tabState.js](support/tabState.js) claims the `domKillerUsed` broadcast. `domKillerEnded` (broadcast by [contentScripts/domKiller.js](contentScripts/domKiller.js) when a Remove Elements session ends) is only listened for by [popup.js](popup.js) — the service worker doesn't claim it.
- **Debugger lifecycle:** [support/debugerAttachment.js](support/debugerAttachment.js). Idempotent attach/detach tracked in a `Set`. Auto-recovers from "already attached" via detach+retry, but only when that retry succeeds — if it fails too (a real external client, i.e. native DevTools, genuinely holds the slot), it throws a distinguishable `DevToolsAttachedError` rather than retrying forever or surfacing a generic Chrome error. Hooks `chrome.debugger.onDetach` to clear stale state.
- **Mutation settle:** [support/mutationObserver.js](support/mutationObserver.js) + [contentScripts/mutationWatcher.js](contentScripts/mutationWatcher.js). Watcher disconnects any prior watcher via `window.__MutationCleanup` so re-injection doesn't leak observers. The waiter is tab-filtered and has an 8 s timeout fallback — never hangs the worker forever.
- **Shared capture flow:** [screenshots/captureSession.js](screenshots/captureSession.js) exposes `withEmulatedCapture(tabId, deviceMetrics, body)` which handles attach → hide scrollbars → inject watcher → emulate → settle → run body → restore → detach. Used by both page and element capture. The `finally` guarantees teardown even on error. `hideScrollbars`, `restoreScrollbars`, and `postEmulationBreather` are also exported individually — Legal Capture composes them directly in a different order (see above) rather than calling `withEmulatedCapture` as a black box, since it needs the debugger attached and network recording active *before* its forced reload, not after.
- **Element highlighter cleanup:** [contentScripts/elementHighlighter.js](contentScripts/elementHighlighter.js) is an IIFE that exposes `window.__HighlighterDestroy` so re-injection cleans up the previous instance instead of double-binding handlers.
- **Image extractor cleanup:** [contentScripts/imageExtractor.js](contentScripts/imageExtractor.js) follows the same pattern via `window.__ImageExtractorDestroy`.
- **Shared binary helpers:** [support/binary.js](support/binary.js) — chunked base64 encode/decode (`bytesToBase64`/`base64ToBytes`, avoiding the call-stack overflow a naive `String.fromCharCode(...bytes)` hits on large arrays), `crc32`, `sha256Hex`/`sha256Bytes`, `concatBytes`. Used by the screenshot/crop pipeline and by Legal Capture's WARC/ZIP writers — previously this chunked-base64 logic was copy-pasted independently in four places; it's consolidated here now.
- **Shared page measurement:** [support/pageMeasure.js](support/pageMeasure.js) — `measurePageHeight`/`measureViewportSize`, used both by the popup's `getPageHeight`/`getViewportSize` actions (driving the User/Full Page presets) and by Legal Capture's post-reload re-measurement step.
- **Per-tab capture flags:** [support/tabState.js](support/tabState.js) — tracks whether Remove Elements has been used on a tab since its last navigation, in `chrome.storage.session` (not an in-memory `Map`, since the service worker can be killed and restarted between the Remove Elements click and a later Legal Capture click — an in-memory flag would silently reset to "safe").

---

## Constraints to keep in mind

- **MV3 forbids remote code execution.** Any "external script" feature has to mean *bundled-in-extension* JS files selected at runtime — not code fetched from a URL and `eval`ed.
- **`chrome.debugger` attach shows the yellow banner** on the target tab while a capture is in flight. Keep capture sessions short and always detach.
- **`Page.captureScreenshot` has a max dimension of 16384 px** per side. The element-capture viewport expansion clamps to this.
- **No bundler/npm exists in this repo.** Every JS file is loaded as-authored (`import`/`export` ES modules, `chrome.scripting.executeScript({files:[...]})`). A third-party library can only be added by manually vendoring a single dependency-free file into the tree — nothing here can `npm install` anything. Legal Capture's WARC writer, ZIP writer, and RFC 3161 DER encoder are hand-written for exactly this reason, not out of NIH preference.
- **Legal Capture is the one feature that makes an outbound request to a server the developer doesn't operate** — an RFC 3161 timestamp request to the public FreeTSA authority (`https://freetsa.org/tsr`), automatic on every Legal Capture, sending only a SHA-256 hash (never the captured URL, page content, or any other identifying data). See [PRIVACY.md](PRIVACY.md) for the user-facing disclosure. Every other capture mode remains fully local.

---

## Planned (not implemented)

These were in the original spec but do not exist in the codebase. Listed here so future work has a clear target.

### Personal & sensitive data remover
Hides the logged-in user's avatar and name in comment sections on social sites. Per-site selectors; bundled, not remote. Not wired into any capture flow yet.

