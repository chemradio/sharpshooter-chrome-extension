# Privacy Policy — Sharpshooter

_Last updated: 2026-07-29_

Sharpshooter is a Chrome extension for capturing high-resolution screenshots of
web pages and page elements, and for extracting source images from a page.

## Summary

**Sharpshooter does not collect, transmit, or sell any personal data.** All
processing happens locally in your browser. There is no analytics, no
tracking, and no remote server operated by the developer. Outbound network
requests are limited to the ones described below — fetching an image URL you
chose to extract, and (only if you turn on the optional Legal Capture feature)
a hash sent to a public timestamping authority. Neither goes to the developer,
and neither includes your browsing content.

## What the extension stores

Sharpshooter uses Chrome's local storage (`chrome.storage.local`) on your own
device for:

- **Extension preferences** — your capture settings (output format, scale,
  filename prefix, theme, language, and similar options).
- **A temporary, per-tab flag** (`chrome.storage.session`, cleared automatically
  on that tab's next page load) noting whether you used Remove Elements on that
  tab — used only to show an informational note in Legal Capture.

This data never leaves your device. It is not synced to the developer or any
third party.

## Network access

Sharpshooter's own code does not call any developer- or third-party-owned
server, and ships no analytics or tracking.

It does make one kind of outbound network request: when you use the
**Extract Image** helper, the background service worker fetches the specific
image URL found in the page you're viewing (and optionally probes a
CDN-suffix-stripped variant of that URL with a `HEAD` request first) so it can
re-encode the image to PNG before saving it to your Downloads folder or
sending it to the crop editor. This request goes straight from your browser to
the site hosting that image — the same request your browser would make
loading the image normally. No data is sent to the developer.

This requires the `host_permissions: ["<all_urls>"]` grant in the manifest,
since the image being extracted can be hosted on any domain (see
[Permissions](#permissions) below).

It also makes one other kind of outbound request, but **only if you turn on
the optional Legal Capture feature** (off by default; enabled via the
"Enable Legal Capture" toggle in Settings): every time you use Legal Capture,
the extension sends a SHA-256 hash of the capture package to
[FreeTSA](https://freetsa.org), a free, independent, public timestamping
authority, to get back a signed proof of when that hash existed (an RFC 3161
timestamp). This request contains **only the hash** — a short string of
characters that does not reveal the URL you captured, the page's content, or
anything else about your browsing. FreeTSA is not operated by the developer;
it's a widely-used, publicly-documented service that Sharpshooter's code
talks to directly, the same way your browser talks to any website.

Screenshot capture itself (Page Capture, Capture Element, Remove Elements) is
entirely local: nothing about the page you capture is ever sent anywhere.
Legal Capture additionally downloads a byte-exact recording of the page's
network traffic (headers and bodies, including anything sent in requests
your browser made while loading the page) into the zip it saves to your
Downloads folder — that file stays on your device like any other capture;
only the hash described above leaves your browser, and only to FreeTSA.

## Screenshots

Screenshots you capture are saved directly to your computer's Downloads folder
via Chrome's downloads API. They are never uploaded anywhere.

## Permissions

| Permission | Why it is needed |
|---|---|
| `debugger` | Captures screenshots through the Chrome DevTools Protocol (`Page.captureScreenshot`) with device-metric emulation — the core capture mechanism. Also used by the optional Legal Capture feature to record the page's network traffic via CDP's `Network` domain. |
| `downloads` | Saves captured screenshots and extracted images to your Downloads folder. |
| `scripting` | Injects the highlighter, page-measurement, and element/image-selection scripts into the page being captured. |
| `storage` | Stores your capture preferences locally. |
| `activeTab` | Lets the extension act on the tab you invoke it on — granted only when you open the popup or click a button. |
| `host_permissions: <all_urls>` | Required so the background service worker can fetch an extracted image's URL (which may be on any domain, e.g. a CDN different from the page's own domain) and re-encode it to PNG. Not used to inject scripts on a schedule or in the background — script injection is still user-gesture-driven via `activeTab`/`scripting`. |

## Contact

Questions about this policy: chemradio@gmail.com
