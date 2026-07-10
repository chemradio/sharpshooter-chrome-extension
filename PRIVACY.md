# Privacy Policy — Sharpshooter

_Last updated: 2026-07-10_

Sharpshooter is a Chrome extension for capturing high-resolution screenshots of
web pages and page elements, and for extracting source images from a page.

## Summary

**Sharpshooter does not collect, transmit, or sell any personal data.** All
processing happens locally in your browser. There is no analytics, no
tracking, and no remote server operated by the developer. The only outbound
network requests are the ones described below, made directly from your
browser to the image URL you choose to extract — never to the developer or
any third party.

## What the extension stores

Sharpshooter uses Chrome's local storage (`chrome.storage.local`) on your own
device for:

- **Extension preferences** — your capture settings (output format, scale,
  filename prefix, theme, language, and similar options).

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

No other feature makes network requests. In particular, screenshot capture is
entirely local: nothing about the page you capture is ever sent anywhere.

> The **Cleanup / Filters** feature (EasyList fetching, bundled + user
> filters, AdRemover) is present in the codebase but disabled and unwired — it
> does not run and makes no requests. See
> [internal-guides/FROZEN-CLEANUP.md](internal-guides/FROZEN-CLEANUP.md).

## Screenshots

Screenshots you capture are saved directly to your computer's Downloads folder
via Chrome's downloads API. They are never uploaded anywhere.

## Permissions

| Permission | Why it is needed |
|---|---|
| `debugger` | Captures screenshots through the Chrome DevTools Protocol (`Page.captureScreenshot`) with device-metric emulation — the core capture mechanism. |
| `downloads` | Saves captured screenshots and extracted images to your Downloads folder. |
| `scripting` | Injects the highlighter, page-measurement, and element/image-selection scripts into the page being captured. |
| `storage` | Stores your capture preferences locally. |
| `activeTab` | Lets the extension act on the tab you invoke it on — granted only when you open the popup or click a button. |
| `host_permissions: <all_urls>` | Required so the background service worker can fetch an extracted image's URL (which may be on any domain, e.g. a CDN different from the page's own domain) and re-encode it to PNG. Not used to inject scripts on a schedule or in the background — script injection is still user-gesture-driven via `activeTab`/`scripting`. |

## Contact

Questions about this policy: chemradio@gmail.com
