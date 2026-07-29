# Sharpshooter — IT Security Review Package

_Prepared: 2026-07-10, updated 2026-07-29 for the Legal Capture feature_

This document is a technical overview of the Sharpshooter Chrome extension for
IT Security review, covering what it does, what permissions it requests and
why, what data it touches, and where the source lives.

## What it is

Sharpshooter is a Chrome MV3 extension for taking high-resolution screenshots
of web pages and individual page elements, and for extracting source images
from a page. It's used for MotionGFX asset creation, archiving, and general
screenshot work. It has no server component, no accounts, and no
build/deploy pipeline of its own — it is a single unpacked/packed extension
loaded directly by Chrome.

Full functional documentation: [README.md](../README.md) (user-facing) and
[CLAUDE.md](../CLAUDE.md) (architecture reference, most detailed).

## How capture works

All screenshot capture uses the Chrome DevTools Protocol via `chrome.debugger`:
the extension attaches to the active tab, emulates device metrics
(`Emulation.setDeviceMetricsOverride`), waits for the page to visually settle,
takes the shot with `Page.captureScreenshot`, then detaches. Element captures
crop the resulting image client-side with `OffscreenCanvas`; nothing is sent
off-device. `chrome.debugger` attachment shows Chrome's yellow "being
debugged" banner on the tab for the (short) duration of a capture.

### Legal Capture (new, opt-in feature)

An additional capture mode, off by default (user must enable it in Settings),
for producing a forensic evidence package rather than a plain screenshot.
Reviewers should be aware this mode does two things no other feature does:

- **Records the tab's full network traffic** via CDP's `Network`/`Security`
  domains (request/response headers and bodies, TLS certificate details) for
  the duration of one capture session, and writes it into a WARC/WACZ archive
  that's saved to the user's Downloads folder alongside the screenshot. This
  can include anything sent in that traffic — cookies, auth headers, etc., to
  the same extent Chrome's own DevTools Network panel would show them. This
  data goes to the user's local Downloads folder only; the extension does not
  transmit it anywhere.
- **Makes one outbound network request to a third party**: a SHA-256 hash of
  the capture archive (not the archive itself, not the URL, not page content)
  is sent to [FreeTSA](https://freetsa.org), a public RFC 3161 timestamping
  authority, to obtain an independent, verifiable proof-of-time for that hash.
  This is the only network request in the entire extension that isn't either
  (a) fetching a resource the user's own browser session already has access
  to, or (b) entirely local. It is not developer-operated and receives no
  identifying information — see [PRIVACY.md](../PRIVACY.md) for the exact
  disclosure given to end users.

Forced before recording: a cache-bypassed reload of the tab, so the captured
network traffic reflects a clean page load rather than one a user may have
already modified via the extension's own "Remove Elements" tool or via native
DevTools. See [CLAUDE.md](../CLAUDE.md#legal-capture) for the full technical
writeup.

## Permissions requested

From [manifest.json](../manifest.json):

```json
"permissions": ["debugger", "downloads", "activeTab", "scripting", "storage"],
"host_permissions": ["<all_urls>"]
```

| Permission | Why it's needed |
|---|---|
| `debugger` | Core capture mechanism — attaches to the active tab to drive `Page.captureScreenshot` with device-metric emulation. Idempotent attach/detach with auto-recovery; sessions are short-lived and always detached in a `finally` block. |
| `downloads` | Saves captured screenshots and extracted images to the user's Downloads folder via `chrome.downloads.download`. |
| `scripting` | Injects content scripts (element highlighter, page-height/viewport measurement, DOM element remover, image extractor, per-site cleanup modules) into the page the user is actively capturing. Always triggered by a user action (clicking a popup button), never scheduled or automatic. |
| `storage` | `chrome.storage.local` only — stores user preferences (output format, scale, filename prefix, theme/language, resolution presets, and locally-collected DOM-removal selectors from the optional "Remove Elements" tool). Local to the device; no sync storage is used. |
| `activeTab` | Grants access to the tab the user is currently interacting with, scoped to the click/keypress that invoked the extension. |
| `host_permissions: <all_urls>` | The one broad grant. Required by the **Extract Image** helper: when a user selects an image on a page, the background service worker fetches that image's URL (which can be hosted on any domain — e.g. a CDN different from the page's own origin) to re-encode it to PNG before saving/cropping. `activeTab` alone does not cover a background-initiated cross-origin `fetch()`, hence the host-wide permission. This is the only source of outbound network requests in the extension. |

See [PRIVACY.md](../PRIVACY.md) for the user-facing privacy policy covering
the same ground.

## Network behavior

- **No developer-owned backend, no telemetry, analytics, or crash reporting.**
  The extension does not talk to any server operated by the developer.
- **Extract Image**: the background service worker does a `fetch()` (and
  optionally a `HEAD` probe against a CDN-suffix-stripped URL variant, for
  size-suffix stripping like `_800x600.jpg` → `.jpg`) directly against the
  image URL the user selected on the page they're viewing. This is the same
  request the browser already made to render that image — the extension does
  not proxy, log, or forward it anywhere else.
- **Legal Capture** (opt-in, off by default): the only feature that talks to a
  server the developer doesn't operate. It POSTs a SHA-256 hash (never the
  captured content, URL, or archive itself) to the public FreeTSA RFC 3161
  timestamping authority (`https://freetsa.org/tsr`) to obtain an independent
  timestamp. See the Legal Capture subsection above for full detail.

## Data handling

- All screenshots, extracted images, and Legal Capture packages are written
  straight to the user's local Downloads folder via `chrome.downloads.download`.
  Nothing is uploaded — except the single hash described above, sent only when
  the user explicitly runs a Legal Capture.
- All preferences live in `chrome.storage.local` on the user's own device —
  never synced or transmitted. Legal Capture additionally keeps one small,
  per-tab, session-scoped flag (`chrome.storage.session`, auto-cleared on that
  tab's next navigation) noting whether Remove Elements was used on it.
- The extension processes no PII beyond what's visually present on the page
  the user chooses to screenshot; it does not read cookies, page content for
  analysis, form data, or credentials for its own purposes, and has no code
  path that transmits page content anywhere. The one exception a reviewer
  should know: Legal Capture's network recording captures whatever the page's
  own network traffic contains (which may include cookies/auth headers, the
  same as DevTools' Network panel would show) into the downloaded archive —
  that archive is written to the user's local Downloads folder only and is
  never transmitted by the extension.

## Content Security Policy

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self';"
}
```

No remote or inline script execution is allowed in the extension's own pages
(popup, crop editor). MV3 in general prohibits remotely-fetched-and-`eval`ed
code; this extension additionally has no such code path — everything runs
from files bundled in the extension package.

## Code structure (for reviewer navigation)

- `manifest.json` — permissions, entry points.
- `backgroundScript.js` — MV3 service worker; message-routing hub for all
  actions listed above.
- `popup.html` / `popup.js` — the toolbar UI.
- `screenshots/` — capture pipeline (viewport emulation, element capture,
  site-aware element capture, site-specific modules under
  `screenshots/elementSelect/` and `contentScripts/sites/`).
- `contentScripts/` — scripts injected into the page being captured
  (highlighter, DOM remover, image extractor, mutation watcher).
- `support/` — shared utilities (debugger attach/detach lifecycle, mutation
  settling, zoom reset, binary/hash helpers, page measurement, per-tab flags).
- `support/legalCapture/` — the Legal Capture pipeline: CDP network recorder,
  WARC writer, ZIP/WACZ writer, RFC 3161 timestamp client, orchestrator.
- `cropEditor.js` / `cropEditor.html` — optional post-capture crop UI.
- `_locales/` — English and Russian UI strings.

## Known limitations / things a reviewer should know

- `<all_urls>` is a broad host permission. It is used exclusively for
  fetching a user-selected image URL in the Extract Image flow; it is not
  used to run scripts automatically or in the background on pages the user
  hasn't interacted with.
- `chrome.debugger` is an inherently high-privilege API (it's the same
  protocol devtools uses). Usage here is scoped to short capture sessions on
  the active tab only, always explicitly triggered by the user, and always
  detached afterward (including on error, via `finally`).
- Legal Capture is opt-in (off by default) and is the one feature that both
  captures raw network traffic (into a local file the user controls) and
  makes a request to a non-developer-operated third party (a hash only, to
  FreeTSA, for an independent timestamp). Both behaviors are disclosed to the
  user in the popup, [README.md](../README.md), and [PRIVACY.md](../PRIVACY.md).

## Distribution

Publishing target: Chrome Web Store (preferred, per IT Security's guidance).
Source will be shared via GitHub link (added separately by the developer).

## Contact

chemradio@gmail.com
