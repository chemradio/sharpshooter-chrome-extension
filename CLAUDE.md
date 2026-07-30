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
view. Two optional free-text fields — **operator name** and **case/matter
reference** — live in Legal Capture Settings (see below), not the main view;
they're printed on `report.txt` and recorded (unverified) in
`manifest.json`'s `operator` field, and identify who to ask about the
capture, not proof of who performed it.

**Every evidentiary component is individually switchable.** A small gear
icon next to the "Legal Capture" section label opens **Legal Capture
Settings** ([popup.html](popup.html) `#view-legal-settings`), a dedicated
subpage listing every artifact/data source below as its own on/off toggle,
each with a plain-language note on what it does and what it adds for legal
admissibility, plus a closing "How Legal Capture Works" explainer. Defaults:
everything that only needs permissions the extension already has defaults
**on** (network/WebSocket/Service-Worker recording, screenshot, DOM/MHTML
snapshots, timestamps + which TSAs, SHA256SUMS.txt, browser/page environment
info); anything needing a *new* optional permission — and therefore a new
category of personal data — defaults **off** (machine info, operator
geolocation, operator's Chrome account email). The resolved toggle set for a
given capture travels with it as `manifest.json`'s `captureOptions` block —
sealed and timestamped like everything else, so the package is a
tamper-evident record of what it does and doesn't contain, not just
`report.txt`'s prose. Single source of truth for the defaults/permission
mapping: [support/legalCapture/legalCaptureOptions.js](support/legalCapture/legalCaptureOptions.js)
(popup.js duplicates the same defaults, since it's a classic script and
can't `import` that module).

**What it does, in order** ([support/legalCapture/legalCaptureSession.js](support/legalCapture/legalCaptureSession.js)), each step skipped rather than collected-and-discarded when its toggle is off:

1. Attaches the debugger and (if network recording is on) starts CDP `Network`/`Security`/`Page` domain recording
   ([support/legalCapture/networkRecorder.js](support/legalCapture/networkRecorder.js)) **before** anything else. This also records **WebSocket** handshakes/frames (`Network.webSocket*`, its own toggle) and, best-effort, the page's own **Service Worker** network activity (its own toggle) by discovering matching `service_worker` debug targets (`chrome.debugger.getTargets()`, same-origin match) and attaching a second debugger session directly to them — a tab-scoped session alone can't see requests a Service Worker intercepts/serves from its own cache. `Page.getFrameTree` is used to record the true main-frame id, so the "main document" exchange is identified structurally (frame + type) rather than by guessing which URL matches.
2. Forces a clean, cache-bypassed reload (`chrome.tabs.reload({bypassCache:true})`) and waits for it to finish, **regardless of which toggles are on** — it's what restores the original HTML (undoing any Remove Elements edit) before anything is captured, not just a network-recording detail. When recording is on, the reload's own request/response traffic *is* the evidence being captured, so recording must already be active when it happens.
3. If the active resolution preset is `viewport` (User) or `fullpage` (Full Page), re-measures the tab's viewport/page height **after** the reload ([support/pageMeasure.js](support/pageMeasure.js)) rather than trusting the numbers the popup measured before the click — a fresh reload can have less lazy-loaded content on screen than whatever the popup saw a moment earlier, and using the stale numbers produces an undersized screenshot. Fixed/custom presets are used as-is (they're explicit numbers, not page-derived).
4. Emulates the (possibly re-measured) device metrics and, if enabled, takes the screenshot through the same `withZoomReset` / mutation-settle path as Page Capture. Then, in one combined `chrome.scripting.executeScript` call, optionally serializes the live, post-JS-execution `document.documentElement.outerHTML` as `page.html` and/or captures a **browser/page environment fingerprint** (screen geometry/DPI, locale, IANA timezone name, hardware thread count, document title/referrer) — independent machine-readable evidence from both the raw HTTP bodies in the WARC and the raster screenshot. Then, if enabled, captures a **full-page MHTML archive** (`page.mhtml`) via CDP `Page.captureSnapshot({format:"mhtml"})` — a browser-native, self-contained bundle of the rendered page's markup, stylesheets, scripts, images, and fonts in one file, built by Chrome itself rather than this codebase's own asset-fetching logic; opens directly in Chrome/Edge or any MHTML-capable tool. All of the above happen back-to-back against the same settled page state, so they describe the same moment. Every one of these is best-effort: a failure (e.g. a page that blocks scripting) is disclosed as absent in `report.txt`, not silently dropped.
5. If network recording is on, stops recording and builds a **WARC/1.0** file from the recorded exchanges (raw request/response headers + bodies + TLS `securityDetails`) — [support/legalCapture/warcWriter.js](support/legalCapture/warcWriter.js), hand-written (no bundler/npm dependency exists in this repo, so no WARC library could be pulled in). Redirect legs are recorded as their own complete request/response pairs (the CDP `requestId` is reused across a redirect, so the recorder splits each hop into a distinct exchange rather than letting the final destination overwrite the redirect response). Each WebSocket connection becomes a `resource` record: an NDJSON transcript of its handshake and every frame, in wire order.
6. Wraps the WARC into a **WACZ** (a ZIP, method STORE — no DEFLATE implementation needed) with a CDXJ index, `pages.jsonl`, and `datapackage.json` — [support/legalCapture/zipWriter.js](support/legalCapture/zipWriter.js). Playable in [ReplayWeb.page](https://replayweb.page) by anyone, independent of this extension.
7. Builds `manifest.json` — sha256 of every artifact actually produced (`capture.wacz`, `screenshot.png`, `page.html`, `page.mhtml` — whichever toggles left on), the TLS summary, redirect chain, network/Service-Worker coverage stats, the exact `captureOptions` used, a **tool provenance** block (extension version/id, browser `userAgent`, OS/arch via `chrome.runtime.getPlatformInfo`, local timezone offset), and — each gated by its own toggle — a **machine info** block (CPU model/core count via `chrome.system.cpu`, installed RAM via `chrome.system.memory`, connected display layout/resolution via `chrome.system.display`; needs the `system.cpu`/`system.memory`/`system.display` *optional* permissions, requested only when the toggle is turned on), the operator's **Chrome account email** (`chrome.identity.getProfileUserInfo`, needs the `identity` optional permission), and **operator geolocation** (gathered in [popup.js](popup.js) via `navigator.geolocation`, not in the service worker — the Geolocation API isn't available in an MV3 service worker context — then passed through `startLegalCapture`'s `geolocation` param. No manifest permission is involved: Chrome rejects `"geolocation"` in `optional_permissions` outright — it's one of a handful of API permissions, like `debugger`/`devtools`, that can only ever be a standing permission — so this toggle instead relies on the ordinary per-origin Geolocation prompt Chrome shows the first time `navigator.geolocation.getCurrentPosition` is actually called. Turning the toggle on triggers that call immediately so a denial reverts the toggle right away instead of failing silently at capture time — but that call is deliberately *not* made from the toolbar popup itself: an undecided permission prompt steals focus, and Chrome auto-closes `action` popups on blur, which used to kill the popup (and the toggle's checked state with it) before an answer ever came back. `popup.js`'s change handler first checks `navigator.permissions.query({name:"geolocation"})` — if the state is already `granted`/`denied` there's no prompt and the popup is safe; only when the state is undecided does it message [support/legalCapture/geoPermissionRelay.js](support/legalCapture/geoPermissionRelay.js) to open [support/legalCapture/geoPermission.html](support/legalCapture/geoPermission.html) as an ordinary `chrome.windows.create` window — immune to popup-on-blur — which makes the real call and reports the outcome back for the relay to persist into `legalCaptureOptions`. `gatherGeolocation()` (the actual per-capture read, run from the popup when the Legal Capture button is clicked) guards the same way — it only calls `getCurrentPosition` when `permissions.query` already reports `granted`, skipping geolocation for that capture rather than risk a mid-capture prompt closing the popup and aborting the whole capture). All of it — including `operator.name`/`operator.caseReference` (unverified, human-typed) — is **frozen** before any timestamp request: manifest.json's own sha256 is what gets sealed, so a single hash transitively covers every other evidentiary file and metadata block inside it.
8. If timestamping is on, requests an **RFC 3161 timestamp** over `manifest.json`'s hash from whichever of **FreeTSA, DigiCert, Sectigo** are individually enabled (`TSA_PROVIDERS` in [support/legalCapture/tsaClient.js](support/legalCapture/tsaClient.js), all queried over HTTPS) concurrently, so the capture isn't sealed by one third party's availability or trustworthiness. Any succeeding is enough; more succeeding is simply stronger. The DER request is hand-encoded (no ASN.1 library); each response is independently **verified** — not just parsed — by checking its `messageImprint` hash matches what was actually sent and (when present) that its nonce echoes ours, before being accepted as a successful timestamp. Each verified response also has its embedded `genTime` diffed against this machine's local clock at request time (`clockSkewSeconds`, in `timestamps.json` and `report.txt`) — cheap cross-corroboration that preempts a "the local clock was manipulated" dispute, since independent authorities' skew readings can be compared against each other. We deliberately do not attempt to validate the TSA's CMS signature itself (that would need a full X.509 chain validator, making the report only as trustworthy as this codebase's own from-scratch one) — the raw signed token is saved untouched per authority (`capture-freetsa.tsr`, `capture-digicert.tsr`, `capture-sectigo.tsr`) for independent verification: `openssl ts -reply -in capture-freetsa.tsr -text`.
9. Downloads one zip (`legal-capture-<timestamp>.zip`, `saveAs: true`) containing whichever of `capture.wacz`, `screenshot.png`, `page.html`, `page.mhtml` were produced, `manifest.json` (frozen, hash-sealed core), `timestamps.json` (the TSA results/errors, written after — it points at manifest.json's hash rather than being inside it, since nothing can attest to its own future), whichever `capture-<authority>.tsr` files succeeded, `SHA256SUMS.txt` (sha256 of every file physically in the zip — its own toggle, a convenience check that nothing was swapped post-assembly, not itself sealed unlike manifest.json), and `report.txt` (plain-language "what this proves / doesn't prove" writeup, including a **Capture Options** section mirroring `captureOptions` exactly, the operator/case-reference/geolocation/account-email certification block, tool + machine + page-environment provenance, redirect chain, TSA verification + clock-skew results, and network/WebSocket/Service-Worker coverage stats).

**Guards against disputing "the HTML was unaltered":**
- **Remove Elements**: [contentScripts/domKiller.js](contentScripts/domKiller.js) broadcasts `domKillerUsed` the first time an element is actually removed on a tab; [support/tabState.js](support/tabState.js) records that per-tab in `chrome.storage.session` (cleared on the tab's next navigation via `chrome.tabs.onUpdated`). The popup surfaces this as an informational warning banner in the Legal Capture section — informational only, since step 2's forced reload already restores the original HTML regardless (and always runs, even with every other toggle off).
- **Native DevTools open on the tab**: `chrome.debugger.attach` fails if a real DevTools window already holds the tab's debugger slot. [support/debugerAttachment.js](support/debugerAttachment.js)'s `attachDebugger` normally auto-recovers from an "already attached" error (a leaked *own* prior session), but if the retry fails too, it now throws a distinguishable `DevToolsAttachedError` instead of a generic Chrome error string, which the popup turns into "DevTools is open on this tab. Close it and try again." There's no reliable way to detect a DevTools-made DOM edit *after the fact* — a live MutationObserver can't distinguish a human editing via Elements-panel from the page's own routine JS-driven DOM churn — so the forced reload is the actual safeguard, not detection.

**What this does and doesn't prove** (also spelled out in the generated `report.txt`): with everything left on, the WACZ is a byte-exact recording of the real HTTP exchange — including its full redirect chain and any WebSocket traffic — sealed via `manifest.json`'s hash with up to three independent third-party timestamps, plus independent `page.html`/`page.mhtml` snapshots and tool/machine/page provenance metadata. It doesn't re-verify the TLS certificate chain or a TSA's signature itself, can't capture Service-Worker-served content when that capture is disabled or attach wasn't possible, doesn't capture non-WebSocket real-time channels (e.g. WebRTC), and is supporting technical evidence, not a legal determination. The operator name/case-reference/geolocation/account-email fields are human-supplied or machine-reported-but-unverified labels, not a cryptographic identity claim. Any artifact whose toggle was off simply isn't part of the package — `manifest.json`'s `captureOptions` records exactly which.

---

## Architecture notes

- **Service worker:** [backgroundScript.js](backgroundScript.js). Owns a specific set of message actions (`getPageHeight`, `getViewportSize`, `capturePage`, `captureElement`, `detectSite`, `captureSiteElement`, `domKiller`, `stopDomKiller`, `imageExtractor`, `imageExtractorDownload`, `imageExtractorCropUrl`, `getTabCaptureFlags`, `startLegalCapture`) and always responds with `{ok: true, ...}` or `{ok: false, error}`. Other listeners own their own actions to avoid channel conflicts: the element-click handler in [screenshots/elementSelect/elementClickListener.js](screenshots/elementSelect/elementClickListener.js) claims `elementClicked`; [support/tabState.js](support/tabState.js) claims the `domKillerUsed` broadcast; [support/legalCapture/geoPermissionRelay.js](support/legalCapture/geoPermissionRelay.js) claims `openGeolocationPermissionWindow` and `legalGeolocationPermissionResult`. `domKillerEnded` (broadcast by [contentScripts/domKiller.js](contentScripts/domKiller.js) when a Remove Elements session ends) is only listened for by [popup.js](popup.js) — the service worker doesn't claim it.
- **Geolocation permission relay:** [support/legalCapture/geoPermissionRelay.js](support/legalCapture/geoPermissionRelay.js) + [support/legalCapture/geoPermission.html](support/legalCapture/geoPermission.html)/`.js`. Exists solely because an undecided geolocation permission prompt closes the toolbar action popup (focus steals to the native prompt, Chrome dismisses `action` popups on blur). `geoPermissionRelay.js` opens `geoPermission.html` as a real `chrome.windows.create` window (not an action popup, so it isn't subject to that auto-close), which calls `navigator.geolocation.getCurrentPosition` itself and reports the grant/deny back via a message the relay persists into `legalCaptureOptions.geolocation`, then closes its own window. `popup.js` only takes this path when `navigator.permissions.query({name:"geolocation"})` reports an undecided state; an already-resolved (`granted`/`denied`) state is read in the popup directly since no prompt — and therefore no close-on-blur risk — is involved. **Known benign console warning:** when `geoPermission.html` calls `navigator.geolocation.getCurrentPosition`, Chromium logs "Is the 'geolocation' permission appropriate? See https://developer.chrome.com/extensions/manifest.html#permissions." to that page's console (visible via the extension's "Errors" button in `chrome://extensions`). This is a built-in Chromium advisory triggered by any extension page calling the Geolocation Web API — it fires regardless of what's declared in `manifest.json` and is unrelated to the actual permission grant flow (which works correctly). It can only be silenced by adding `"geolocation"` to `manifest.json`'s standing `permissions` array, which would grant geolocation access unconditionally at install instead of the current opt-in-per-toggle design — a deliberate tradeoff not worth making. Leave the warning as-is.
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
- **Legal Capture is the one feature that makes outbound requests to servers the developer doesn't operate** — RFC 3161 timestamp requests to whichever of three public authorities are enabled (FreeTSA, DigiCert, Sectigo — see `TSA_PROVIDERS`), each sending only a SHA-256 hash (never the captured URL, page content, or any other identifying data). See [PRIVACY.md](PRIVACY.md) for the user-facing disclosure. Every other capture mode remains fully local.
- **Legal Capture's Machine Info and Account Email toggles use `optional_permissions`, not standing `permissions`.** `system.cpu`/`system.memory`/`system.display` (Machine Info) and `identity` (Account Email) are declared in `manifest.json`'s `optional_permissions` array and requested via `chrome.permissions.request()` only at the moment the operator flips the corresponding toggle on in Legal Capture Settings (popup.js) — never granted upfront just because the feature exists. If the operator denies the browser's prompt, the toggle reverts to off and nothing is requested. **The Operator Geolocation toggle is different: `"geolocation"` cannot be listed in `optional_permissions` at all** — Chrome rejects it at install with a console warning and silently drops it (confirmed by testing: `chrome://extensions` reports "Permission 'geolocation' cannot be listed as optional"). It's one of a small set of API permissions, alongside e.g. `debugger`/`devtools`, that Chrome only allows as a standing permission. Since a standing permission would defeat "off by default," this toggle isn't backed by any manifest permission at all — it relies on the ordinary per-origin Geolocation API prompt Chrome shows the first time `navigator.geolocation.getCurrentPosition` is called from an extension page, exactly like a regular website.

---

## Planned (not implemented)

These were in the original spec but do not exist in the codebase. Listed here so future work has a clear target.

### Personal & sensitive data remover
Hides the logged-in user's avatar and name in comment sections on social sites. Per-site selectors; bundled, not remote. Not wired into any capture flow yet.

