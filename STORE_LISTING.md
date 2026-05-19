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
- **Auto Capture** — one-click full-page capture with ad and clutter removal.
- **Post / story capture** — on Facebook, Instagram, Telegram, X and VK,
  detects a post or story and captures it without surrounding clutter.
- **Cleanup helpers** — remove ads and distracting elements before capturing.

All processing happens locally in your browser. No data is collected or sent
anywhere.

## Permission justifications

Paste each into the matching field on the dashboard's Privacy tab.

**debugger**
Sharpshooter captures screenshots through the Chrome DevTools Protocol
(Page.captureScreenshot). The debugger permission is required to attach to the
tab, emulate device metrics for the requested resolution and scale factor, and
take the screenshot. This is the core capture mechanism and the extension
cannot function without it. The debugger is attached only during a capture and
detached immediately after.

**downloads**
Used to save the captured screenshot image file to the user's Downloads folder.

**scripting**
Used to inject the extension's own bundled scripts (element highlighter, page
cleanup, and page-height measurement) into the tab being captured.

**storage**
Used to store cosmetic filter lists and the user's capture preferences locally
on the user's device.

**activeTab**
Screenshot capture acts on the tab the user explicitly invokes the extension
on. activeTab grants access to that single tab only when the user opens the
popup or clicks a capture button — the extension does not request standing
access to all websites.

**Host permissions (easylist.to, raw.githubusercontent.com, cdn.jsdelivr.net)**
The extension downloads a public plain-text cosmetic filter list (CSS
selectors) used to remove ads and clutter before a screenshot. These three
hosts are the source and mirrors for that list. Host access is limited to
exactly these domains; page capture itself relies on activeTab, not host
permissions.

**Remote code use**
The extension does not execute remote code. It downloads a public plain-text
cosmetic filter list (CSS selectors) from easylist.to and applies those
selectors locally. No JavaScript is fetched or evaluated from any remote source.

## Data usage disclosures (Privacy tab — check these)

- Does NOT collect or use personal/sensitive user data.
- Does NOT sell or transfer user data to third parties.
- Does NOT use data for purposes unrelated to the single purpose.
- Does NOT use data to determine creditworthiness or for lending.

Privacy policy URL: <host PRIVACY.md and paste the public URL here>

## Category

Productivity (or Developer Tools)
