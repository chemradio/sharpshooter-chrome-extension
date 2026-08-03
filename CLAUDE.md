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

All captures are triggered from the **toolbar popup** ([popup.html](popup.html) / [popup.js](popup.js)). The main view runs top to bottom: quality multiplier (scale) and resolution presets, a small centred divider (`.divider--small`), then one stacked group of capture actions (`section.capture-actions`) — **Page Capture**, **Legal Capture**, **Element Capture** — then a `.divider` and the **Helpers** section (**Remove Elements**, the interactive DOM killer, and **Extract Image**).

Every capture control is a **segmented button**: a wide main segment (`.btn-capture--main`) that runs the action directly, plus a narrow segment on its right. For Page Capture, Element Capture and Extract Image that narrow segment is **with crop** (`.btn-capture--crop`), which runs the same action through the crop editor — so hovering it lights the main button too, since the two together read as one combined action. When the **Always open the crop editor** setting is on, every capture goes to the editor and the crop segments are hidden via the `.crop-default` class on `.popup` (Extract Image keeps both, since its crop segment means *screenshot the element* rather than *download the image*).

**Legal Capture's narrow segment is a different thing and is deliberately a different class** (`.btn-capture--sub`): a gear + **settings** label that opens the Legal Capture Settings subpage instead of capturing. It shares the crop segment's geometry but not its linked hover — it highlights alone, and hovering Legal Capture leaves it dark, so it can never imply it will fire the capture next to it. Its whole block (`#legal-capture-section`, which also carries the Remove-Elements warning banner) is hidden by the **Enable Legal Capture** setting.

A header **?** button opens an in-popup help panel, and a header **gear** button opens the **Settings** panel. Clicking the brand mark in the header opens the **Arcade** (see below) — the header itself does not move when it does.

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
2. Locates the element via a one-shot `data-sharpshooter-target` marker attribute set on the node at click time in [contentScripts/elementHighlighter.js](contentScripts/elementHighlighter.js), falling back to a positional XPath (also built at click time). The marker exists because emulation can cross a responsive breakpoint and rebuild the subtree, which invalidates positional XPaths (`xpath-miss`); the attribute survives reflow/re-render as long as the node itself isn't recreated. The capture side strips the attribute in a `finally` when the session ends.
3. `scrollIntoView({block:"center", inline:"center", behavior:"instant"})` inside a CDP `Runtime.evaluate` call (same channel as the screenshot — minimizes the measure→capture gap so scroll-restoration handlers can't run between the two).
4. If the element exceeds the emulated viewport, expands emulation up to 16384 px (CDP cap) with 64 px padding, re-injects the mutation watcher, re-emulates, settles, re-measures.
5. Takes a viewport screenshot and crops it in JS via `OffscreenCanvas` + `createImageBitmap`.

**Why crop in JS instead of using CDP's `clip` parameter:** CDP page-absolute coordinates drift on pages with custom scroll containers, CSS zoom, or CSS transforms. Viewport-relative `getBoundingClientRect` always matches what's on screen. See [screenshots/elementSelect/elementClickListener.js](screenshots/elementSelect/elementClickListener.js) header comment.

All capture paths (page, element) wrap the emulated session in `withZoomReset` ([support/zoomReset.js](support/zoomReset.js)): the user's per-tab browser zoom is set to 1 for the duration of the capture, then restored. This is required for accurate element crops *and* for page-mode captures to produce the layout the user expects — at non-1 zoom, `Emulation.setDeviceMetricsOverride` and the browser zoom transform interact and the page lays out for the wrong width (e.g. at 175% zoom a "1920" request ends up emulating ~1097 CSS px, which forces the page into a narrower layout than requested).

---

## Image Extractor

The **Extract Image** helper ([contentScripts/imageExtractor.js](contentScripts/imageExtractor.js)) downloads the highest-resolution image found inside a selected DOM subtree, without taking a screenshot at all. User clicks the button, then hovers elements on the page. A **amber** (#F59E0B) glow indicates the current target (same DOM navigation model as element capture: scroll wheel = parent/child, arrow keys = parent/child/siblings, Esc = cancel).

On click (or Enter):

1. `findImages(el)` scans the element's subtree for image sources in priority order:
   - `<img>` elements (picks the largest `srcset` candidate, or `src`; skips fallback `<img>` inside `<picture>`; skips elements < 50×50 px).
   - `<picture>` elements — one best candidate per `<picture>`: the highest descriptor URL across all `<source>` srcsets and the fallback `<img>`.
   - CSS `background-image` on every descendant and the element itself (skips < 50×50 px).
   - `<canvas>` elements are flagged separately — not downloadable directly, shown in the picker with a "use Capture Element" hint.

   **SVG sources are included** (flagged `vector: true`, badged `SVG` in the picker) and are rasterized to PNG on download — see below. They're sized by their rendered box rather than `naturalWidth`/`naturalHeight`, which is 0 for markup that declares no intrinsic size. Inline `<svg>` elements in the page's own DOM are *not* handled — only SVG referenced by URL (`<img src>`, `srcset`, `background-image`); use Capture Element for inline vector graphics.
2. Results are sorted highest-resolution first (`w × h`).
3. If **one** non-canvas result is found, it goes straight to download (or crop). If **multiple** are found, a modal picker appears with thumbnail previews; the top entry is badged **BEST**.
4. If **no** images are found in the subtree, the extractor walks the DOM upward looking for a CSS `background-image` on an ancestor (`walkUpForBg`). If still nothing, a toast message is shown.
5. The selected URL is sent to the background. Both actions share `resolveBestUrl` (`stripCdnSuffix` strips common dimension/size suffixes like `_800x600` / `_large` and probes the stripped URL via HEAD; if it responds 200, the stripped — likely full-size — URL is fetched instead) and `fetchAsPngBase64` (fetch → PNG, in [backgroundScript.js](backgroundScript.js)):
   - **Download:** `imageExtractorDownload` action — result goes to `chrome.downloads.download`.
   - **Crop:** `imageExtractorCropUrl` action — result goes to `handoffToCropEditor`.

   `fetchAsPngBase64` branches on the response: a normal raster is decoded with `createImageBitmap` + `OffscreenCanvas`, while an SVG (Content-Type `image/svg*`, or a `.svg`/`.svgz` URL whose Content-Type isn't an image type) is rasterized via [support/svgRaster.js](support/svgRaster.js). Neither path ever fills the canvas, so **transparency is preserved** in the PNG. Download failures still fall back to `chrome.downloads.download({url})` on the original asset unconverted.

`window.__ImageExtractorOptions = { manualCrop: true }` is set by the background before injecting the script when the user clicked the crop segment.

[contentScripts/imageExtractor.js](contentScripts/imageExtractor.js) is an IIFE that exposes `window.__ImageExtractorDestroy` so re-injection cleans up the previous instance (overlay, event listeners, picker) instead of double-binding.

---

## Legal Capture

A specialist capture mode aimed at investigative/legal use, where a plain
screenshot isn't strong enough evidence: it produces a hash-sealed,
independently-timestamped forensic package instead of just an image. The
**Legal Capture** button sits in the main view's capture stack, between
Page Capture and Element Capture, and is **shown by default**; the **Enable
Legal Capture** toggle in Settings hides it for users who don't want it. It
has no resolution readout of its own — it sends the identical settings
payload Page Capture does, i.e. whatever preset / dimensions / quality
multiplier are selected directly above it, which is now close enough to be
self-evident (there used to be a read-only mirror of those numbers above the
button, from when the section lived at the bottom of the popup; it and
`updateLegalResolutionReadout()` are gone). (Visibility only — showing the section sends
nothing anywhere; the TSA requests described below happen only when a Legal
Capture is actually run. `popup.html` starts the section unhidden so first
paint matches the default, since the `chrome.storage.local` read is async.) Two optional free-text fields — **operator name** and **case/matter
reference** — live in Legal Capture Settings (see below), not the main view;
they're printed on `report.txt` and recorded (unverified) in
`manifest.json`'s `operator` field, and identify who to ask about the
capture, not proof of who performed it.

**Resolution has no Legal Capture control of its own.** The screenshot is
taken at whatever resolution preset / W×H / quality multiplier are selected
at the *top* of the popup — `popup.js`'s Legal Capture handler sends the
identical `getSettings()` payload Page Capture does. Because that dependency
is invisible from the bottom of the popup, the section carries a read-only
**readout row** (`#legal-resolution`, `updateLegalResolutionReadout()` in
[popup.js](popup.js)) mirroring the resolved values as
`Screenshot · <preset> · W × H · N×`. It re-renders from every input that can
change them (preset radios, the W/H inputs, the default-scale radios, a
per-preset scale override, a language change) and reads `off — no image in
this package` when the **Screenshot** toggle in Legal Capture Settings is
off. For the page-derived presets (`viewport` / `fullpage`) a sub-hint notes
the numbers are a preview only — `reMeasureForPreset` re-measures them after
the forced reload, so the final PNG can differ. Do **not** give Legal Capture
its own resolution controls: a second source of truth for device metrics
produces packages whose screenshot doesn't match what the operator believed
they selected.

**Every evidentiary component is individually switchable.** The gear
sub-segment of the Legal Capture button opens **Legal Capture
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
2. Suppresses user input to the page via CDP `Input.setIgnoreInputEvents` ([support/inputSuppression.js](support/inputSuppression.js)) — mouse, wheel, keyboard and touch are dropped by the browser process for the whole session, so the operator cannot alter the page between the reload and the snapshots. Always on (not a toggle); the flag is session-scoped, so it survives the reload that destroys the DOM overlay and Chrome clears it automatically on debugger detach — a failed capture can't strand the tab inert. The result is recorded (not asserted) as `provenance.pageInputSuppressed` in `manifest.json` and in `report.txt`'s **Capture-Time Page Protection** section, so a browser that refuses the command produces a package that says so. The visual "Capturing…" overlay ([support/captureOverlay.js](support/captureOverlay.js)) is re-injected after the reload for the same reason — it explains why the page went inert, but it is *not* the enforcement (a DOM overlay only intercepts what bubbles through the page's event path; wheel still chain-scrolls and keystrokes still reach the focused element).
3. Forces a clean, cache-bypassed reload (`chrome.tabs.reload({bypassCache:true})`) and waits for it to finish, **regardless of which toggles are on** — it's what restores the original HTML (undoing any Remove Elements edit) before anything is captured, not just a network-recording detail. When recording is on, the reload's own request/response traffic *is* the evidence being captured, so recording must already be active when it happens.
4. If the active resolution preset is `viewport` (User) or `fullpage` (Full Page), re-measures the tab's viewport/page height **after** the reload ([support/pageMeasure.js](support/pageMeasure.js)) rather than trusting the numbers the popup measured before the click — a fresh reload can have less lazy-loaded content on screen than whatever the popup saw a moment earlier, and using the stale numbers produces an undersized screenshot. Fixed/custom presets are used as-is (they're explicit numbers, not page-derived).
5. Emulates the (possibly re-measured) device metrics and, if enabled, takes the screenshot through the same `withZoomReset` / mutation-settle path as Page Capture. Then, in one combined `chrome.scripting.executeScript` call, optionally serializes the live, post-JS-execution `document.documentElement.outerHTML` as `page.html` and/or captures a **browser/page environment fingerprint** (screen geometry/DPI, locale, IANA timezone name, hardware thread count, document title/referrer) — independent machine-readable evidence from both the raw HTTP bodies in the WARC and the raster screenshot. Then, if enabled, captures a **full-page MHTML archive** (`page.mhtml`) via CDP `Page.captureSnapshot({format:"mhtml"})` — a browser-native, self-contained bundle of the rendered page's markup, stylesheets, scripts, images, and fonts in one file, built by Chrome itself rather than this codebase's own asset-fetching logic; opens directly in Chrome/Edge or any MHTML-capable tool. All of the above happen back-to-back against the same settled page state, so they describe the same moment. Every one of these is best-effort: a failure (e.g. a page that blocks scripting) is disclosed as absent in `report.txt`, not silently dropped. **Immediately after the screenshot and before the DOM/MHTML serialization, the extension's own injected nodes are removed** — the capture overlay and the scrollbar-hiding `<style id="__no-scroll">` — via `hideCaptureOverlay` + `restoreScrollbars`. The screenshot only needs them visually absent (`withOverlayHidden` handles that in the same CDP channel), but `page.html`/`page.mhtml` are byte-level evidence of what the site served: an examiner finding a `__sharpshooter-capture-overlay` div in them has found proof the artifact was modified after loading. Input stays suppressed across the removal, so the page never becomes editable again.
6. If network recording is on, stops recording and builds a **WARC/1.0** file from the recorded exchanges (raw request/response headers + bodies + TLS `securityDetails`) — [support/legalCapture/warcWriter.js](support/legalCapture/warcWriter.js), hand-written (no bundler/npm dependency exists in this repo, so no WARC library could be pulled in). Redirect legs are recorded as their own complete request/response pairs (the CDP `requestId` is reused across a redirect, so the recorder splits each hop into a distinct exchange rather than letting the final destination overwrite the redirect response). Each WebSocket connection becomes a `resource` record: an NDJSON transcript of its handshake and every frame, in wire order.
7. Wraps the WARC into a **WACZ** (a ZIP, method STORE — no DEFLATE implementation needed) with a CDXJ index, `pages.jsonl`, and `datapackage.json` — [support/legalCapture/zipWriter.js](support/legalCapture/zipWriter.js). Playable in [ReplayWeb.page](https://replayweb.page) by anyone, independent of this extension.
8. Builds `manifest.json` — sha256 of every artifact actually produced (`capture.wacz`, `screenshot.png`, `page.html`, `page.mhtml` — whichever toggles left on), the TLS summary, redirect chain, network/Service-Worker coverage stats, the exact `captureOptions` used, a **tool provenance** block (extension version/id, browser `userAgent`, OS/arch via `chrome.runtime.getPlatformInfo`, local timezone offset, and **install type** via `chrome.management.getSelf()` — one of the few management APIs callable *without* the `management` permission; `"normal"` means the published Web Store build produced the package, `"development"` means an unpacked copy the operator could edit, which `report.txt` flags loudly), a **connection** block (the main document's `remoteIPAddress`/`remotePort`/`protocol`, already recorded by [networkRecorder.js](support/legalCapture/networkRecorder.js) but previously never surfaced, plus a computed `remoteAddressIsPrivateOrLoopback` flag — a loopback/RFC1918 address is the signature of a locally-run server standing in for the real site), an expanded **tls** block (cipher/key exchange/SAN list plus `certificateTransparencyCompliance` and the full SCT list — a certificate minted by a locally-installed root cannot obtain valid CT log signatures, so this distinguishes a forged cert that the browser nonetheless trusts), a **certificateChain** block (SHA-256 fingerprints of each DER cert via CDP `Network.getCertificate`, best-effort — the leaf fingerprint is searchable on crt.sh by anyone), and — each gated by its own toggle — a **machine info** block (CPU model/core count via `chrome.system.cpu`, installed RAM via `chrome.system.memory`, connected display layout/resolution via `chrome.system.display`; needs the `system.cpu`/`system.memory`/`system.display` *optional* permissions, requested only when the toggle is turned on), the operator's **Chrome account email** (`chrome.identity.getProfileUserInfo`, needs the `identity` optional permission), and **operator geolocation** (gathered in [popup.js](popup.js) via `navigator.geolocation`, not in the service worker — the Geolocation API isn't available in an MV3 service worker context — then passed through `startLegalCapture`'s `geolocation` param. No manifest permission is involved: Chrome rejects `"geolocation"` in `optional_permissions` outright — it's one of a handful of API permissions, like `debugger`/`devtools`, that can only ever be a standing permission — so this toggle instead relies on the ordinary per-origin Geolocation prompt Chrome shows the first time `navigator.geolocation.getCurrentPosition` is actually called. Turning the toggle on triggers that call immediately so a denial reverts the toggle right away instead of failing silently at capture time — but that call is deliberately *not* made from the toolbar popup itself: an undecided permission prompt steals focus, and Chrome auto-closes `action` popups on blur, which used to kill the popup (and the toggle's checked state with it) before an answer ever came back. `popup.js`'s change handler first checks `navigator.permissions.query({name:"geolocation"})` — if the state is already `granted`/`denied` there's no prompt and the popup is safe; only when the state is undecided does it message [support/legalCapture/geoPermissionRelay.js](support/legalCapture/geoPermissionRelay.js) to open [support/legalCapture/geoPermission.html](support/legalCapture/geoPermission.html) as an ordinary `chrome.windows.create` window — immune to popup-on-blur — which makes the real call and reports the outcome back for the relay to persist into `legalCaptureOptions`. `gatherGeolocation()` (the actual per-capture read, run from the popup when the Legal Capture button is clicked) guards the same way — it only calls `getCurrentPosition` when `permissions.query` already reports `granted`, skipping geolocation for that capture rather than risk a mid-capture prompt closing the popup and aborting the whole capture). All of it — including `operator.name`/`operator.caseReference` (unverified, human-typed) — is **frozen** before any timestamp request: manifest.json's own sha256 is what gets sealed, so a single hash transitively covers every other evidentiary file and metadata block inside it.
9. If timestamping is on, requests an **RFC 3161 timestamp** over `manifest.json`'s hash from whichever of **FreeTSA, DigiCert, Sectigo** are individually enabled (`TSA_PROVIDERS` in [support/legalCapture/tsaClient.js](support/legalCapture/tsaClient.js), all queried over HTTPS) concurrently, so the capture isn't sealed by one third party's availability or trustworthiness. Any succeeding is enough; more succeeding is simply stronger. The DER request is hand-encoded (no ASN.1 library); each response is independently **verified** — not just parsed — by checking its `messageImprint` hash matches what was actually sent and (when present) that its nonce echoes ours, before being accepted as a successful timestamp. Each verified response also has its embedded `genTime` diffed against this machine's local clock at request time (`clockSkewSeconds`, in `timestamps.json` and `report.txt`) — cheap cross-corroboration that preempts a "the local clock was manipulated" dispute, since independent authorities' skew readings can be compared against each other. We deliberately do not attempt to validate the TSA's CMS signature itself (that would need a full X.509 chain validator, making the report only as trustworthy as this codebase's own from-scratch one) — the raw signed token is saved untouched per authority (`capture-freetsa.tsr`, `capture-digicert.tsr`, `capture-sectigo.tsr`) for independent verification: `openssl ts -reply -in capture-freetsa.tsr -text`.
10. Downloads one zip (`legal-capture-<timestamp>.zip`, `saveAs: true`) containing whichever of `capture.wacz`, `screenshot.png`, `page.html`, `page.mhtml` were produced, `manifest.json` (frozen, hash-sealed core), `timestamps.json` (the TSA results/errors, written after — it points at manifest.json's hash rather than being inside it, since nothing can attest to its own future), whichever `capture-<authority>.tsr` files succeeded, `SHA256SUMS.txt` (sha256 of every file physically in the zip — its own toggle, a convenience check that nothing was swapped post-assembly, not itself sealed unlike manifest.json), and `report.txt` (plain-language "what this proves / doesn't prove" writeup, including a **Capture Options** section mirroring `captureOptions` exactly, the operator/case-reference/geolocation/account-email certification block, tool + machine + page-environment provenance, redirect chain, TSA verification + clock-skew results, and network/WebSocket/Service-Worker coverage stats).

**Guards against disputing "the HTML was unaltered":**
- **Remove Elements**: [contentScripts/domKiller.js](contentScripts/domKiller.js) broadcasts `domKillerUsed` the first time an element is actually removed on a tab; [support/tabState.js](support/tabState.js) records that per-tab in `chrome.storage.session` (cleared on the tab's next navigation via `chrome.tabs.onUpdated`). The popup surfaces this as an informational warning banner in the Legal Capture section — informational only, since step 3's forced reload already restores the original HTML regardless (and always runs, even with every other toggle off).
- **Native DevTools open on the tab**: `chrome.debugger.attach` fails if a real DevTools window already holds the tab's debugger slot. [support/debugerAttachment.js](support/debugerAttachment.js)'s `attachDebugger` normally auto-recovers from an "already attached" error (a leaked *own* prior session), but if the retry fails too, it now throws a distinguishable `DevToolsAttachedError` instead of a generic Chrome error string, which the popup turns into "DevTools is open on this tab. Close it and try again." There's no reliable way to detect a DevTools-made DOM edit *after the fact* — a live MutationObserver can't distinguish a human editing via Elements-panel from the page's own routine JS-driven DOM churn — so the forced reload is the actual safeguard, not detection.

**Threat model — read before "hardening" this further.** Legal Capture runs on a machine the operator controls, so it *cannot* be made tamper-proof against a dishonest operator, and the code must not imply otherwise. An operator can point DNS at a local server, install their own CA root, and capture a page they wrote — every hash correct, every TSA timestamp genuine. A timestamp proves *these bytes existed at time T*, never *this is what the server sent*. The design goal is therefore **detectability by a third party, not prevention**: push every claim toward something a verifier can check against the outside world (server IP vs. passive DNS, leaf cert fingerprint vs. public CT logs, install type, WACZ replay in ReplayWeb.page). `report.txt`'s **LIMITS — PLEASE READ** section states this explicitly, including the fact that install type / IP / CT status are self-reported by the same extension and are meaningful only *because they are externally checkable*. Do not add language asserting the package is tamper-proof; a tool that marks its boundary precisely is worth more in front of a tribunal than one that overstates its reach. The obvious next step — submitting the URL to a public archive for independent corroboration — is deliberately **not** implemented: it would send the captured URL to a third party, contradicting [PRIVACY.md](PRIVACY.md)'s promise that only a hash ever leaves the machine. If ever added it must be default-off with an explicit warning.

**What this does and doesn't prove** (also spelled out in the generated `report.txt`): with everything left on, the WACZ is a byte-exact recording of the real HTTP exchange — including its full redirect chain and any WebSocket traffic — sealed via `manifest.json`'s hash with up to three independent third-party timestamps, plus independent `page.html`/`page.mhtml` snapshots and tool/machine/page provenance metadata. It doesn't re-verify the TLS certificate chain or a TSA's signature itself, can't capture Service-Worker-served content when that capture is disabled or attach wasn't possible, doesn't capture non-WebSocket real-time channels (e.g. WebRTC), and is supporting technical evidence, not a legal determination. The operator name/case-reference/geolocation/account-email fields are human-supplied or machine-reported-but-unverified labels, not a cryptographic identity claim. Any artifact whose toggle was off simply isn't part of the package — `manifest.json`'s `captureOptions` records exactly which.

---

## Arcade

A five-game mini-arcade hidden behind the header brand mark. Entirely
popup-local — no service worker, no new permissions, no `manifest.json`
change — and purely additive: the logo previously did nothing on click.
One game (Typing Trainer) fetches text over the network; see its section
below and [PRIVACY.md](PRIVACY.md).

`.arcade-view` is pinned to `--popup-view-h`, the same as Settings and
Help, so opening the arcade never changes the popup's width or height. The
**screen is the one item allowed to shrink** (`flex: 0 1 auto` +
`aspect-ratio: 1/1`; everything else is `flex: 0 0 auto`), so a short main
view scales the cabinet down instead of pushing the bottom of the
playfield below the fold — which is where every game draws its prompts.
The canvas therefore carries **no inline CSS size**; it fills the screen
box at `width/height: 100%` while its backing store stays
`STAGE_W × STAGE_H × DPR`. That shrink is a **safety net, not the plan** —
every row around the screen is deliberately tight (5 px gaps, 3–4 px row
padding, the game-controls slot sharing the reset row) so the arcade's
chrome costs ~130 px and the screen keeps its full 332 px on any realistic
main view. If you add a row here, take the height from somewhere else. Any game reading pointer coordinates must go
through **`ctx.pointer(el, event)`**, which converts client coordinates
back to logical stage units — a raw `clientX - rect.left` misses by the
scale factor the moment the screen is not exactly 330 px (this is why
Breakout's paddle and Target Practice's clicks route through it).

**Entry point.** `#header-icon` (the animated `[data-brand-mark]` in the
header) is now a real control: `role="button"`, `tabindex="0"`, an
`aria-label`/`title` fed from i18n, Enter/Space activation, and
`aria-expanded` tracking the view. It was `aria-hidden` decoration before
becoming interactive. Clicking it toggles `#view-arcade`, following the
same view-switching pattern as `#view-settings` / `#view-legal-settings` /
`#view-help` (`hidden` + an `is-arcade` class on `.popup`, added to
`VIEW_CLASSES` so `syncPopupContentHeight()` measures correctly).
**The header itself is left completely alone** — there was once a hero
animation that scaled the mark up and slid it to the popup's centre while
fading the title out, plus an `.arcade-hero-space` runway in the view; all
of that has been removed. Opening the arcade must not move a single element
of the top bar, so `#header-icon` carries no arcade-specific transform and
no `transform-origin`. Opening the arcade closes the other subpages, and
each of their toggles closes the arcade (`window.__Arcade.close()`).

**Files.** [arcade/arcade.js](arcade/arcade.js) is the hub — view
switching, the game picker, the score readout, storage, pause/resume
plumbing, a shared rAF loop helper, a DPR-scaled canvas factory, and a
`palette()` that reads the CSS custom properties off the live stylesheet
so the games repaint correctly in both themes rather than hardcoding dark
colours. It also owns the shared **attract screen** (see below). One file
per game: [arcade/snake.js](arcade/snake.js), [arcade/2048.js](arcade/2048.js),
[arcade/breakout.js](arcade/breakout.js),
[arcade/targetPractice.js](arcade/targetPractice.js),
[arcade/typing.js](arcade/typing.js). All six are classic
scripts loaded from `popup.html` after `popup.js`; the hub must come first
(it exposes `window.__Arcade.register`) and wires itself up on
`DOMContentLoaded`, i.e. after every game has registered. All five render
into one shared 330×330 canvas stage — square, because the popup is 360 px
wide and the arcade view keeps the standard 14 px side padding.

**Per-game interface.** `register({ id, nameKey, realtime, saveVersion,
create })`, where `create(ctx)` returns:

| Method | Contract |
|---|---|
| `init(container, savedState)` | Build the canvas; restore `savedState` or start fresh. |
| `getState()` | Resumable snapshot, or **`null`** when the run isn't worth keeping (game over, not started). Drives every persistence path — returning `null` is how a game discards its own finished run. |
| `pause()` → state | Freeze; returns the same snapshot. |
| `resume()` | Unfreeze. |
| `destroy()` | Tear down the canvas and every input listener. |
| `onScore(cb)` | Hub subscribes; `cb(score)` on every change. |
| `showIntro?()` | Optional; re-renders the game's attract screen. Called after a runtime language switch — the copy came from the game, so only the game can rebuild it. |
| `isOver?()` / `handleKey?(e)` / `handleKeyUp?(e)` | Optional. |

`ctx` carries `t`, `STAGE_W`/`STAGE_H`, `canvas()`, `pointer()`, `loop()`,
`palette()`,
`save()` (throttled, ~500 ms), `saveNow()` (immediate),
`setOverlay()`/`setIntro()`/`clearOverlay()`, `setControls()`, and
`setDetail()`.

**Attract screen.** Four of the five games open on one, via
`ctx.setIntro({ title, lines: [...], start })`. It's the same
`#arcade-overlay` element in a second mode (`.is-intro`): a title, a
hairline rule, the rules as staggered lines, and a deliberately loud
`start` prompt (boxed, tinted, glowing, on a slow pulse) — the one thing on
the screen that has to be unmissable. The entrance animations are one-shot
CSS keyframes, so `setIntro()` forces a reflow between dropping and
re-adding `.is-intro` or a second call would swap the copy without
replaying them. **Typing Trainer deliberately does not use it** — see its
section below.

**Game controls.** `ctx.setControls([Element])` parks a game's own live DOM
controls in the `#arcade-game-controls` slot, which sits **below the screen,
right-aligned, sharing the row with the two reset buttons** (Typing
Trainer's language `<select>`). It shares that row rather than taking one of
its own on purpose: the view is pinned to the popup's height, so a row spent
on chrome is height the playfield loses. The elements are **moved**, never
cloned — the game keeps the reference and reads it back. The slot never
overlays the playfield, collapses to nothing when empty
(`:empty { display: none }`), and is cleared by the hub on teardown so one
game's controls never outlive it.

**Score detail.** `ctx.setDetail(text)` hangs an optional second figure off
the score readout, and the hub banks whatever was last reported alongside a
new highscore (`gs.highDetail`). Only Typing Trainer uses it — WPM as the
score, accuracy as the detail, so a record reads `71 · 96%`.

**Input.** The hub owns the single `keydown`/`keyup` listener and forwards
to the active game, so keys can never fire while another view is active
and nothing survives a teardown. It `preventDefault()`s arrows/space (they
would otherwise scroll the view, or walk the picker's radio group
mid-game) and yields Space/Enter/Tab back to a focused control. Pointer
input belongs to each game's own canvas listeners, dropped in `destroy()`.

**Storage** — one `arcade` object in `chrome.storage.local`:

```
{ lastGame, games: { <id>: { highscore, highDetail, saved } } }
```

- **Highscores are unconditional.** Written the moment they're beaten, not
  at game over — a popup close fires no reliable unload event, so nothing
  may be deferred to one.
- **Runs are always kept.** There is no "Keep game on close" toggle; it was
  removed. A game discards its own run by returning `null` from
  `getState()`, which is the only gate.
- **`saved`** carries the game's own `v` (`saveVersion`); a mismatch is
  discarded in favour of a fresh game. A restore that throws anyway is
  caught and retried fresh — stale state costs the run, never the session.
- Real-time games persist throttled (~500 ms) plus immediately on every
  score/life/level change; 2048 persists on every move (it's turn-based, so
  the snapshot is exact).
- A game registered `ephemeral: true` (Typing Trainer) is never restored
  and never persisted — `startGame` forces `saved` to `null` for it.

**Activation always shows the description.** Whichever game you switch to
opens on its attract screen: a fresh game because its own `init()` builds
one, a restored one because `showResumePrompt()` calls its `showIntro()`.
A restored run additionally opens **frozen and blocking** — `setIntro()`
swaps its `start` line for the continue prompt while `awaitingResume` is
set, so one panel carries both "here's the game" and "press any key to
continue" rather than a bare pause overlay hiding what you're resuming.
`awaitingResume` is therefore armed **before** `init()`, so a game that
builds its attract screen in there renders the paused variant directly.
The bare `arcadePaused` two-liner survives only as the fallback for a game
with no `showIntro()`. `showResumePrompt()` calls the game's own `pause()`
first: a game's `init()` starts its loop unconditionally, so a restored run
used to keep simulating behind a screen that said Paused — Breakout's ball
visibly kept travelling. `pause()` is idempotent, so the `autoPause()` path
(`visibilitychange` / `window.blur`, which already pauses) is unaffected.

**Games.** Snake, 2048, Breakout, Target Practice, Typing Trainer.

- **Snake** plays on a **torus**: the grid wraps, so leaving one edge
  re-enters from the opposite one (`(x + dir.x + COLS) % COLS`, with the
  `+ COLS` because JS's `%` keeps the dividend's sign). Only self-collision
  ends a run. A dashed frame is drawn around the playfield as the on-screen
  cue that the edges are doorways rather than walls.
- **Typing Trainer** ([arcade/typing.js](arcade/typing.js)) is the one game
  that touches the network. It drills against a **random Wikipedia article
  summary** in a language picked from a `<select>` parked in the topbar's
  control slot (`ctx.setControls`) — `https://<lang>.wikipedia.org/api/rest_v1/page/random/summary`,
  which 303-redirects to the chosen article and is CORS-open. No manifest
  change was needed (the extension already holds `<all_urls>`
  `host_permissions` for Extract Image), and the request carries nothing
  identifying: it names no article — the endpoint picks one. `normalize()`
  strips pronunciation parentheses, footnote brackets and typographic
  punctuation that has no key on most layouts; `toDrill()` cuts to whole
  sentences in a 110–240 character band. Failures fall back to one built-in
  sentence per language — a degradation, not the source. The next drill is
  prefetched during play so a restart is instant, and a `token` counter
  orphans in-flight fetches across a teardown or language change. Score is
  net WPM (correct characters / 5 over `elapsed`, which only accrues in the
  `typing` phase and so is pause-safe); accuracy is correct keystrokes over
  total keystrokes and rides along as the hub's score detail. A mistyped
  character is flagged and typing continues past it (Backspace walks back
  and clears the flag — the speed metric recovers, the accuracy metric does
  not). The `<select>` is blurred on change: a focused control eats letter
  and arrow keys itself, and the hub yields Space/Enter/Tab to one.
  The chosen language persists under its own `arcadeTypingLang` key, not in
  the shared `arcade` object.

  **It never pauses and never resumes.** Registered `ephemeral: true`, and
  its `getState()` returns `null` unconditionally, so leaving the game (or
  the arcade, or the popup) ends the drill and re-entering starts a new
  one. `pause()`/`resume()` are no-ops: the clock only accrues in the
  `typing` phase and rAF stops delivering frames to a hidden popup anyway,
  so there is nothing a pause would protect — and a pause screen over a
  typing drill would cover the paragraph, which is the whole problem the
  canvas-drawn UI below exists to avoid.

  **It is the one game that never uses the shared overlay** — not for its
  attract screen, not for its result. Everything is drawn on its own
  canvas, because a panel covering the screen also covers the paragraph
  you are being asked to type, which made the start prompt and the text
  mutually exclusive. Instead: the drill text is drawn as soon as it
  arrives, and a **footer strip** below it carries the rules and the same
  loud boxed/pulsing `start` prompt (`drawPrompt`) while armed, then the
  WPM/accuracy result and the "press any key for a new paragraph" prompt
  once finished — with the typed paragraph and its red mistake flags still
  on screen behind it. Both are anchored upward from `FOOTER_BOTTOM` so a
  long localized string grows away from the text rather than into it. The
  `showIntro()` hook is therefore not implemented (the hub only calls it
  while its own intro overlay is showing, and the canvas re-reads every
  string through `ctx.t` each frame, so a language switch relocalizes for
  free). While the drill is being fetched, `drawLoading()` animates
  skeleton lines with a sweeping highlight **in the place the paragraph
  will occupy** — it replaced a "Fetching a paragraph…" caption, so
  `arcadeTypingLoading` no longer exists in `_locales`. Do not reintroduce
  a full-screen overlay here.

**Reset controls**, per game — both icon + label buttons, so their text
lives in a `<span>` and is written through `btnLabel()` (writing the
button's own `textContent` would take the `<svg>` with it). "Reset game"
discards the saved run and starts fresh; "Reset highscore" takes a second
click within 3 s (the button becomes "Sure?") — never a native `confirm()`,
which an action popup can't survive — and then **also resets the current
run**, restarting the game so the description goes back up: a half-played
board sitting next to a zeroed best is a readout nobody can interpret.

**Styling** lives at the end of both [popup.css](popup.css) and
[popup-light.css](popup-light.css) (the two stylesheets are full
duplicates gated by `prefers-color-scheme`, so the arcade block is written
twice with adapted palettes, including `--arcade-screen` / `--arcade-grid`
which the games read at draw time). The cabinet reuses the existing
`.radio-group` chips for the picker and `.btn-helper` for the resets; the
screen adds its own finer scanline wash, inner vignette and slow flicker
over the shared CRT language. No sound.

---

## Architecture notes

- **Service worker:** [backgroundScript.js](backgroundScript.js). Owns a specific set of message actions (`getPageHeight`, `getViewportSize`, `capturePage`, `captureElement`, `domKiller`, `stopDomKiller`, `imageExtractor`, `imageExtractorDownload`, `imageExtractorCropUrl`, `getTabCaptureFlags`, `startLegalCapture`) and always responds with `{ok: true, ...}` or `{ok: false, error}`. Other listeners own their own actions to avoid channel conflicts: the element-click handler in [screenshots/elementSelect/elementClickListener.js](screenshots/elementSelect/elementClickListener.js) claims `elementClicked`; [support/tabState.js](support/tabState.js) claims the `domKillerUsed` broadcast; [support/legalCapture/geoPermissionRelay.js](support/legalCapture/geoPermissionRelay.js) claims `openGeolocationPermissionWindow` and `legalGeolocationPermissionResult`. `domKillerEnded` (broadcast by [contentScripts/domKiller.js](contentScripts/domKiller.js) when a Remove Elements session ends) is only listened for by [popup.js](popup.js) — the service worker doesn't claim it.
- **Geolocation permission relay:** [support/legalCapture/geoPermissionRelay.js](support/legalCapture/geoPermissionRelay.js) + [support/legalCapture/geoPermission.html](support/legalCapture/geoPermission.html)/`.js`. Exists solely because an undecided geolocation permission prompt closes the toolbar action popup (focus steals to the native prompt, Chrome dismisses `action` popups on blur). `geoPermissionRelay.js` opens `geoPermission.html` as a real `chrome.windows.create` window (not an action popup, so it isn't subject to that auto-close), which calls `navigator.geolocation.getCurrentPosition` itself and reports the grant/deny back via a message the relay persists into `legalCaptureOptions.geolocation`, then closes its own window. `popup.js` only takes this path when `navigator.permissions.query({name:"geolocation"})` reports an undecided state; an already-resolved (`granted`/`denied`) state is read in the popup directly since no prompt — and therefore no close-on-blur risk — is involved. **Known benign console warning:** when `geoPermission.html` calls `navigator.geolocation.getCurrentPosition`, Chromium logs "Is the 'geolocation' permission appropriate? See https://developer.chrome.com/extensions/manifest.html#permissions." to that page's console (visible via the extension's "Errors" button in `chrome://extensions`). This is a built-in Chromium advisory triggered by any extension page calling the Geolocation Web API — it fires regardless of what's declared in `manifest.json` and is unrelated to the actual permission grant flow (which works correctly). It can only be silenced by adding `"geolocation"` to `manifest.json`'s standing `permissions` array, which would grant geolocation access unconditionally at install instead of the current opt-in-per-toggle design — a deliberate tradeoff not worth making. Leave the warning as-is.
- **Debugger lifecycle:** [support/debugerAttachment.js](support/debugerAttachment.js). Idempotent attach/detach tracked in a `Set`. Auto-recovers from "already attached" via detach+retry, but only when that retry succeeds — if it fails too (a real external client, i.e. native DevTools, genuinely holds the slot), it throws a distinguishable `DevToolsAttachedError` rather than retrying forever or surfacing a generic Chrome error. Hooks `chrome.debugger.onDetach` to clear stale state.
- **Mutation settle:** [support/mutationObserver.js](support/mutationObserver.js) + [contentScripts/mutationWatcher.js](contentScripts/mutationWatcher.js). Watcher disconnects any prior watcher via `window.__MutationCleanup` so re-injection doesn't leak observers. The waiter is tab-filtered and has an 8 s timeout fallback — never hangs the worker forever. Timing is **behaviour-tiered, never host-tiered**: the watcher starts fast (500 ms debounce, 2.5 s ceiling, 300 ms early-quiet exit) and escalates once to a slow tier (1200 ms debounce, 5 s ceiling) after it observes ≥150 mutation records, i.e. once the page has proven it re-renders in chunks. It used to hardcode a `SLOW_HOSTS` list of named third-party sites; that list was removed because naming those services anywhere in the package/listing triggered a Chrome Web Store *Yellow Argon* keyword-abuse violation. **Do not reintroduce hostname lists of named services** — measure the page instead.
- **Shared capture flow:** [screenshots/captureSession.js](screenshots/captureSession.js) exposes `withEmulatedCapture(tabId, deviceMetrics, body)` which handles attach → hide scrollbars → inject watcher → emulate → settle → run body → restore → detach. Used by both page and element capture. The `finally` guarantees teardown even on error. `hideScrollbars`, `restoreScrollbars`, and `postEmulationBreather` are also exported individually — Legal Capture composes them directly in a different order (see above) rather than calling `withEmulatedCapture` as a black box, since it needs the debugger attached and network recording active *before* its forced reload, not after.
- **Element highlighter cleanup:** [contentScripts/elementHighlighter.js](contentScripts/elementHighlighter.js) is an IIFE that exposes `window.__HighlighterDestroy` so re-injection cleans up the previous instance instead of double-binding handlers.
- **Image extractor cleanup:** [contentScripts/imageExtractor.js](contentScripts/imageExtractor.js) follows the same pattern via `window.__ImageExtractorDestroy`.
- **SVG rasterization:** [support/svgRaster.js](support/svgRaster.js) (service-worker side) + [offscreen/svgRaster.html](offscreen/svgRaster.html)/`.js` (the actual drawing). A service worker cannot rasterize SVG at all — `createImageBitmap()` rejects `image/svg+xml` blobs outside a document and there is no `<img>` element — so this creates an offscreen document on demand (`offscreen` permission; reason `DOM_PARSER`), hands it the SVG source, and gets base64 PNG back. The offscreen document is closed once the last in-flight rasterization finishes, since an open one keeps the service worker alive. Sizing is decided in the offscreen page: vector has no true pixel count, so it rewrites the markup's `width`/`height` (adding a `viewBox` if absent) to scale the long edge toward 2048 px — never below intrinsic, never above 8192 — *before* loading it, so Chrome rasterizes the vector at output size instead of bitmap-scaling a small raster up. The markup is loaded via a blob URL (same-origin to the offscreen page, so the canvas stays untainted and `toDataURL` is allowed). Externally-referenced assets inside the SVG (webfonts, `xlink:href` images) won't resolve from that blob URL; self-contained SVGs — the overwhelming majority — are unaffected.
- **Shared binary helpers:** [support/binary.js](support/binary.js) — chunked base64 encode/decode (`bytesToBase64`/`base64ToBytes`, avoiding the call-stack overflow a naive `String.fromCharCode(...bytes)` hits on large arrays), `crc32`, `sha256Hex`/`sha256Bytes`, `concatBytes`. Used by the screenshot/crop pipeline and by Legal Capture's WARC/ZIP writers — previously this chunked-base64 logic was copy-pasted independently in four places; it's consolidated here now.
- **Shared page measurement:** [support/pageMeasure.js](support/pageMeasure.js) — `measurePageHeight`/`measureViewportSize`, used both by the popup's `getPageHeight`/`getViewportSize` actions (driving the User/Full Page presets) and by Legal Capture's post-reload re-measurement step.
- **Per-tab capture flags:** [support/tabState.js](support/tabState.js) — tracks whether Remove Elements has been used on a tab since its last navigation, in `chrome.storage.session` (not an in-memory `Map`, since the service worker can be killed and restarted between the Remove Elements click and a later Legal Capture click — an in-memory flag would silently reset to "safe").

---

## Constraints to keep in mind

- **MV3 forbids remote code execution.** Any "external script" feature has to mean *bundled-in-extension* JS files selected at runtime — not code fetched from a URL and `eval`ed.
- **`chrome.debugger` attach shows the yellow banner** on the target tab while a capture is in flight. Keep capture sessions short and always detach.
- **`Page.captureScreenshot` has a max dimension of 16384 px** per side. The element-capture viewport expansion clamps to this.
- **No bundler/npm exists in this repo.** Every JS file is loaded as-authored (`import`/`export` ES modules, `chrome.scripting.executeScript({files:[...]})`). A third-party library can only be added by manually vendoring a single dependency-free file into the tree — nothing here can `npm install` anything. Legal Capture's WARC writer, ZIP writer, and RFC 3161 DER encoder are hand-written for exactly this reason, not out of NIH preference.
- **Legal Capture is the only *capture* feature that makes outbound requests to servers the developer doesn't operate** — RFC 3161 timestamp requests to whichever of three public authorities are enabled (FreeTSA, DigiCert, Sectigo — see `TSA_PROVIDERS`), each sending only a SHA-256 hash (never the captured URL, page content, or any other identifying data). See [PRIVACY.md](PRIVACY.md) for the user-facing disclosure. Every other capture mode remains fully local. Outside capture, the Arcade's Typing Trainer fetches a random Wikipedia summary while that game is open (see Arcade above) — the only other outbound request in the extension.
- **Legal Capture's Machine Info and Account Email toggles use `optional_permissions`, not standing `permissions`.** `system.cpu`/`system.memory`/`system.display` (Machine Info) and `identity` (Account Email) are declared in `manifest.json`'s `optional_permissions` array and requested via `chrome.permissions.request()` only at the moment the operator flips the corresponding toggle on in Legal Capture Settings (popup.js) — never granted upfront just because the feature exists. If the operator denies the browser's prompt, the toggle reverts to off and nothing is requested. **The Operator Geolocation toggle is different: `"geolocation"` cannot be listed in `optional_permissions` at all** — Chrome rejects it at install with a console warning and silently drops it (confirmed by testing: `chrome://extensions` reports "Permission 'geolocation' cannot be listed as optional"). It's one of a small set of API permissions, alongside e.g. `debugger`/`devtools`, that Chrome only allows as a standing permission. Since a standing permission would defeat "off by default," this toggle isn't backed by any manifest permission at all — it relies on the ordinary per-origin Geolocation API prompt Chrome shows the first time `navigator.geolocation.getCurrentPosition` is called from an extension page, exactly like a regular website.

---

## Planned (not implemented)

These were in the original spec but do not exist in the codebase. Listed here so future work has a clear target.

### Personal & sensitive data remover
Hides the logged-in user's avatar and name in comment sections. Per-site selectors; bundled, not remote. Not wired into any capture flow yet.

**Note:** any per-site selector work here must not name third-party services anywhere user- or store-visible (descriptions, UI strings, listing copy). Naming them got the listing flagged with a Chrome Web Store *Yellow Argon* (keyword-abuse) violation once already — see the mutation-settle note below.

