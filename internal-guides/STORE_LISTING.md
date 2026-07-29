# Chrome Web Store listing — Sharpshooter

Copy/paste content for the Developer Dashboard. Not part of the extension —
exclude from the upload ZIP.

---

## Single purpose

Sharpshooter captures high-resolution screenshots of web pages and individual
page elements.

## Detailed description (store listing)

Sharpshooter takes sharp, high-resolution screenshots of web pages — the whole
page, a chosen resolution, or a single element you click on.

- **Page Capture** — capture at a resolution preset (viewport, full page,
  FullHD, 4K) or a custom size, at up to 4× pixel density.
- **Capture Element** — hover any element, scroll to change depth, click to
  capture just that part of the page.
- **Post / story capture** — on Facebook, Instagram, Telegram, X, VK and
  Threads, detects a post or story and captures it without surrounding clutter.
- **Extract Image** — hover any element to scan its subtree for raster images
  and download the highest-resolution source as PNG, optionally through the crop
  editor.
- **Crop editor** — optionally route any capture through a built-in crop editor.
- **Remove Elements** — manually click to remove distracting elements from the
  page before capturing.
- **Legal Capture** (opt-in, off by default) — for investigative/legal use
  cases where a plain screenshot isn't strong enough evidence: records the
  full network exchange for the page into a hash-sealed archive, gets an
  independent timestamp for it from a public authority, and downloads all of
  it alongside the screenshot.

All processing happens locally in your browser. No data is collected. The
only outbound requests are fetching an image URL you explicitly chose to
extract, and — only if you turn on the optional Legal Capture feature — a
hash sent to a public timestamping authority (never your browsing content).

## Permission justifications

Paste each into the matching field on the dashboard's Privacy tab.

**debugger**
Sharpshooter captures screenshots through the Chrome DevTools Protocol
(Page.captureScreenshot). The debugger permission is required to attach to the
tab, emulate device metrics for the requested resolution and scale factor, and
take the screenshot. This is the core capture mechanism and the extension
cannot function without it. The debugger is attached only during a capture and
detached immediately after. The optional Legal Capture feature also uses it to
record the tab's network traffic for the duration of one capture.

**downloads**
Used to save the captured screenshot image file to the user's Downloads folder.

**scripting**
Used to inject the extension's own bundled scripts (element highlighter,
page-height measurement, DOM element remover, image extractor) into the tab
being captured.

**storage**
Used to store the user's capture preferences locally on the user's device.

**activeTab**
Screenshot capture acts on the tab the user explicitly invokes the extension
on. activeTab grants access to that single tab only when the user opens the
popup or clicks a capture button.

**Host permissions**
`<all_urls>`. Required by the Extract Image helper: the background service
worker fetches a user-selected image's URL, which can be hosted on any
domain (e.g. a CDN different from the page's own origin) — activeTab alone
does not cover that background-initiated cross-origin fetch. Not used to run
scripts automatically or in the background; every script injection is still
triggered by an explicit user action.

**Remote code use**
The extension does not execute remote code — no code is fetched from a URL
and `eval`ed; every script is bundled in the package. It does make network
requests: Extract Image fetches a user-selected image URL directly, and the
optional, off-by-default Legal Capture feature sends a SHA-256 hash (never
page content or the captured URL) to the public FreeTSA RFC 3161 timestamping
authority to obtain an independent timestamp for the capture. Neither goes to
a developer-operated server.

## Data usage disclosures (Privacy tab — check these)

- Does NOT collect or use personal/sensitive user data.
- Does NOT sell or transfer user data to third parties.
- Does NOT use data for purposes unrelated to the single purpose.
- Does NOT use data to determine creditworthiness or for lending.

Privacy policy URL: <host PRIVACY.md and paste the public URL here>

## Category

Productivity (or Developer Tools)
