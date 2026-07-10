# Sharpshooter — IT Security Review Package

_Prepared: 2026-07-10_

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

- **No developer-owned or third-party backend.** The extension does not talk
  to any server operated by the developer. There is no telemetry, analytics,
  or crash reporting.
- **The only outbound requests**: when using Extract Image, the background
  service worker does a `fetch()` (and optionally a `HEAD` probe against a
  CDN-suffix-stripped URL variant, for size-suffix stripping like
  `_800x600.jpg` → `.jpg`) directly against the image URL the user selected on
  the page they're viewing. This is the same request the browser already made
  to render that image — the extension does not proxy, log, or forward it
  anywhere else.
- A separate feature (**Cleanup / AdRemover**, cosmetic-filter-based ad
  removal via EasyList) exists in the codebase but is **frozen/disabled** —
  its network fetches (`easylist.to`) do not run. See
  [FROZEN-CLEANUP.md](FROZEN-CLEANUP.md).

## Data handling

- All screenshots and extracted images are written straight to the user's
  local Downloads folder via `chrome.downloads.download`. Nothing is
  uploaded.
- All preferences live in `chrome.storage.local` on the user's own device —
  never synced or transmitted.
- The extension processes no PII beyond what's visually present on the page
  the user chooses to screenshot; it does not read cookies, page content for
  analysis, form data, or credentials, and has no code path that transmits
  page content anywhere.

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
  auto-capture, site-specific modules under `screenshots/elementSelect/` and
  `contentScripts/sites/`).
- `contentScripts/` — scripts injected into the page being captured
  (highlighter, DOM remover, image extractor, mutation watcher).
- `support/` — shared utilities (debugger attach/detach lifecycle, mutation
  settling, zoom reset).
- `adRemover/`, `filters/`, `contentScripts/adRemover.js`,
  `contentScripts/cleanup.js` — the frozen/disabled Cleanup feature (present,
  unwired — see FROZEN-CLEANUP.md).
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
- The Cleanup/AdRemover feature's code is present but dead — it is not wired
  into any UI control and does not execute. It's flagged here for
  completeness since static analysis of the repo will find it.

## Distribution

Publishing target: Chrome Web Store (preferred, per IT Security's guidance).
Source will be shared via GitHub link (added separately by the developer).

## Contact

chemradio@gmail.com
