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

All captures are triggered from the **toolbar popup** ([popup.html](popup.html) / [popup.js](popup.js)) — main UI with quality multiplier (scale), resolution presets, and the capture buttons: **Page Capture** and **Capture Element**. Each capture control is a **segmented button**: a wide main segment that captures and saves directly, plus a narrow **with crop** segment (`.btn-capture--crop`) that routes the shot through the crop editor. When the **Always open the crop editor** setting is on, every capture goes to the editor and the crop segments are hidden via the `.crop-default` class on `.popup`. A **Helpers** row holds **Remove Elements** (interactive DOM killer) and **Extract Image**. Extract Image is also a segmented button: the main segment extracts and saves directly, the narrow **with crop** segment sends the image to the crop editor. When opened on a supported site (Facebook, Instagram, Telegram, X, VK, Threads) the popup also runs a non-destructive site-detection pass and surfaces a "Capture this <post/story>" button at the top if a target is recognized. A header **?** button opens an in-popup help panel, and a header **gear** button opens the **Settings** panel.

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

## Architecture notes

- **Service worker:** [backgroundScript.js](backgroundScript.js). Owns a specific set of message actions (`getPageHeight`, `getViewportSize`, `capturePage`, `captureElement`, `detectSite`, `captureSiteElement`, `domKiller`, `stopDomKiller`, `imageExtractor`, `imageExtractorDownload`, `imageExtractorCropUrl`) and always responds with `{ok: true, ...}` or `{ok: false, error}`. Other listeners (the element-click handler in [screenshots/elementSelect/elementClickListener.js](screenshots/elementSelect/elementClickListener.js)) own their own actions to avoid channel conflicts — `domKillerEnded` (broadcast by [contentScripts/domKiller.js](contentScripts/domKiller.js) when a Remove Elements session ends) is one of these: only [popup.js](popup.js) listens for it, the service worker doesn't claim it.
- **Debugger lifecycle:** [support/debugerAttachment.js](support/debugerAttachment.js). Idempotent attach/detach tracked in a `Set`. Auto-recovers from "already attached" via detach+retry. Hooks `chrome.debugger.onDetach` to clear stale state.
- **Mutation settle:** [support/mutationObserver.js](support/mutationObserver.js) + [contentScripts/mutationWatcher.js](contentScripts/mutationWatcher.js). Watcher disconnects any prior watcher via `window.__MutationCleanup` so re-injection doesn't leak observers. The waiter is tab-filtered and has an 8 s timeout fallback — never hangs the worker forever.
- **Shared capture flow:** [screenshots/captureSession.js](screenshots/captureSession.js) exposes `withEmulatedCapture(tabId, deviceMetrics, body)` which handles attach → hide scrollbars → inject watcher → emulate → settle → run body → restore → detach. Used by both page and element capture. The `finally` guarantees teardown even on error.
- **Element highlighter cleanup:** [contentScripts/elementHighlighter.js](contentScripts/elementHighlighter.js) is an IIFE that exposes `window.__HighlighterDestroy` so re-injection cleans up the previous instance instead of double-binding handlers.
- **Image extractor cleanup:** [contentScripts/imageExtractor.js](contentScripts/imageExtractor.js) follows the same pattern via `window.__ImageExtractorDestroy`.

---

## Constraints to keep in mind

- **MV3 forbids remote code execution.** Any "external script" feature has to mean *bundled-in-extension* JS files selected at runtime — not code fetched from a URL and `eval`ed.
- **`chrome.debugger` attach shows the yellow banner** on the target tab while a capture is in flight. Keep capture sessions short and always detach.
- **`Page.captureScreenshot` has a max dimension of 16384 px** per side. The element-capture viewport expansion clamps to this.

---

## Planned (not implemented)

These were in the original spec but do not exist in the codebase. Listed here so future work has a clear target.

### Personal & sensitive data remover
Hides the logged-in user's avatar and name in comment sections on social sites. Per-site selectors; bundled, not remote. Not wired into any capture flow yet.

