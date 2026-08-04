# Privacy Policy — Sharpshooter

_Last updated: 2026-07-29_

Sharpshooter is a Chrome extension for capturing high-resolution screenshots of
web pages and page elements, and for extracting source images from a page.

## Summary

**Sharpshooter does not collect, transmit, or sell any personal data.** All
processing happens locally in your browser. There is no analytics, no
tracking, and no remote server operated by the developer. Outbound network
requests are limited to the ones described below — fetching an image URL you
chose to extract, (only if you turn on the optional Legal Capture feature) a
hash sent to a public timestamping authority, and (only while you play the
built-in Typing Trainer mini-game) a request to Wikipedia for a random article
summary to type. None goes to the developer, and none includes your browsing
content.

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

It also makes one other kind of outbound request, but **only if you actually
use the Legal Capture feature** (its section is shown in the popup by
default and can be hidden via the "Enable Legal Capture" toggle in Settings —
but merely having it visible sends nothing; nothing leaves your machine
unless you run a capture with it) **and** leave its timestamping option on
(on by default, individually switchable — see below): every time
you use Legal Capture, the extension sends a SHA-256 hash of the capture
package to whichever of three independent, free, public timestamping
authorities you have enabled — [FreeTSA](https://freetsa.org),
[DigiCert](https://www.digicert.com), and [Sectigo](https://sectigo.com) —
to get back signed proof of when that hash existed (RFC 3161 timestamps).
Each request contains **only the hash** — a short string of characters that
does not reveal the URL you captured, the page's content, or anything else
about your browsing. None of these authorities are operated by the
developer; they're widely-used, publicly-documented services that
Sharpshooter's code talks to directly, the same way your browser talks to
any website. Everything else Legal Capture collects — the operator name /
case reference fields, and the optional machine info, browser/page
environment, geolocation, and Chrome-account-email data described below —
stays local: it's written only into the report and manifest inside the zip
on your device, never sent to any of the three authorities or anywhere else.

Finally, the extension includes a small **Arcade** of mini-games (opened by
clicking the logo in the popup header) — a hidden extra, unrelated to
capture. One of them, the **Typing Trainer**, needs something to type. Rather
than ship a fixed set of paragraphs, it asks Wikipedia for a random article
summary in whichever language you pick from its dropdown, using Wikipedia's
public REST API (`https://<language>.wikipedia.org/api/rest_v1/page/random/summary`).
The request happens **only while that specific game is open**, contains no
data about you — it names no article, no page you've visited, and carries no
identifier; Wikipedia chooses the article — and nothing is uploaded. If the
request fails (offline, blocked), the game falls back to a short built-in
sentence. Your chosen drill language is stored locally, like any other
preference. No other mini-game makes any network request at all.

Screenshot capture itself (Page Capture, Capture Element, Remove Elements) is
entirely local: nothing about the page you capture is ever sent anywhere.
Legal Capture additionally downloads a byte-exact recording of the page's
network traffic (headers and bodies, including anything sent in requests
your browser made while loading the page) into the zip it saves to your
Downloads folder — that file stays on your device like any other capture;
only the hash described above leaves your browser, and only to whichever
timestamping authorities you've left enabled.

### Legal Capture Settings — every data source is individually switchable

Every artifact and data source Legal Capture can include in its evidence
package is its own on/off toggle, in a **Legal Capture Settings** subpage
(gear icon next to the Legal Capture section). Most default **on** — network
recording, screenshot, DOM/full-page snapshots, timestamps, and basic
browser/page environment info (screen size, locale, timezone) — since none
of them need any permission beyond what the extension already has, and none
of them leave your device except the timestamp hash described above.

Three toggles are **off by default** because turning them on adds a new
category of personal data to the package, and each is gated by its own
browser permission prompt:

- **Machine info** (CPU model, installed RAM, connected displays) — requests
  the `system.cpu` / `system.memory` / `system.display` extension
  permissions.
- **Operator geolocation** — uses the browser's Geolocation API (GPS/Wi-Fi/IP,
  whichever the OS provides) and triggers Chrome's normal, per-site
  location-access prompt the first time it runs, exactly like a website
  asking for your location. This one isn't backed by an extension permission
  — Chrome doesn't allow "geolocation" to be requested as an optional
  extension permission at all, so the ordinary browser location prompt is
  the only gate.
- **Operator's Chrome account email** — requests the `identity` extension
  permission to read the email of whichever Google account is currently
  signed into your Chrome profile, if any.

Machine info and account email are requested only at the moment you switch
the corresponding toggle on (via `chrome.permissions.request()`), never
granted upfront — if you decline the browser's prompt, the toggle reverts to
off. Geolocation works the same way in effect (turning the toggle on
immediately triggers the location prompt, and a decline reverts the toggle),
just via the browser's own per-site permission system rather than an
extension permission grant. All three stay entirely local like everything
else Legal Capture collects: they are written into the zip on your device
and are never transmitted anywhere, including to the timestamping
authorities above (which only ever receive the manifest's hash, regardless
of which of these toggles are on).

## Extract Design

The **Extract Design** helper reads an element's styling — colours,
typography, spacing, corner radii, shadows, layout, CSS custom properties,
and its hover/focus/active states — and turns it into a spec card, a Markdown
sheet, and a JSON file saved to your Downloads folder.

**This feature makes no network requests at all**, and needs no permission
the extension does not already hold. Everything is read from the page already
open in your browser, using the same `debugger` and `scripting` permissions
the normal screenshot modes use, and every file it produces is assembled
locally and handed to Chrome's downloads API. Nothing about the element, the
page, or the styles read from it is transmitted anywhere.

Reading interaction states works by asking the browser to temporarily apply
`:hover`, `:focus` and `:active` to the element you selected, then reading
back what changed. This affects only the rendering of that one element for a
fraction of a second and is cleared before the capture ends.

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

### Optional permissions

These are declared as `optional_permissions`, not standing permissions — Chrome does not grant them at install. Each is requested only at the moment you switch on its corresponding Legal Capture Settings toggle, and only used for that toggle's data.

| Optional permission | Requested when you enable | Why it is needed |
|---|---|---|
| `system.cpu`, `system.memory`, `system.display` | Machine Info | Reads your computer's CPU model/core count, installed RAM, and connected display layout — included in the local capture package as chain-of-custody hardware info. |
| `identity` | Operator's Chrome Account Email | Reads the email of whichever Google account is currently signed into your Chrome profile, if any — included in the local capture package. |

Operator Geolocation is *not* in this table — Chrome does not allow `"geolocation"` to be requested as an optional extension permission at all (it can only be a standing, install-time permission). Instead, that toggle relies on the browser's ordinary per-site Geolocation prompt, the same one any website would trigger, shown the first time the toggle is turned on.

## Contact

Questions about this policy: chemradio@gmail.com
