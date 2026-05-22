<p align="center">
  <img src="static/icon-animated.svg" alt="Sharpshooter logo" width="160" height="160">
</p>

# Sharpshooter

Chrome MV3 extension for high-resolution, clean screenshots of web pages and
individual elements. Built for MotionGFX, archiving, and general asset creation.
All capture uses the Chrome DevTools Protocol (`chrome.debugger`) for device
emulation + `Page.captureScreenshot`.

> The popup has a built-in **?** help panel — this README is the high-level
> overview; the help panel covers day-to-day usage.

## Installation

1. Clone or download this repo.
2. Go to `chrome://extensions/`.
3. Enable **Developer Mode** (top-right toggle).
4. Click **Load unpacked** and select the extension folder.

## Capture modes

All captures start from the toolbar popup.

- **Capture this post / story** — appears at the top of the popup only when the
  active tab is a single post or story on a supported social site. One click
  cleans up the page and captures just that post/story element.
- **Auto Capture** — one-click full-page capture at the selected scale.
- **Page Capture** — captures the page at a chosen resolution preset and scale.
- **Capture Element** — interactively pick any DOM element: hover to highlight
  (cyan glow), scroll wheel to walk the DOM tree (up = parent, down = child),
  click to capture.

Each capture button is split: the main button captures and saves directly,
the narrow **with crop** segment routes the shot through the crop editor
first. When **Always open the crop editor** is enabled in Settings, every
capture goes to the editor and the separate segments are hidden.

Captures download as `page-…` / `element-…` named with the domain and a
timestamp (and an optional filename prefix set in Settings). Output format is
PNG by default, or JPEG — both configurable in Settings.

## Resolution presets (Page Capture)

| Preset    | Width            | Height                          |
| --------- | ---------------- | ------------------------------- |
| User      | tab viewport     | tab viewport                    |
| Full Page | tab viewport     | measured live page height       |
| Vertical  | tab viewport     | width × 3.5                     |
| FullHD    | 1920             | 1080                            |
| 4K        | 3840             | 2160                            |
| Custom    | user-editable    | user-editable                   |

**Quality multiplier** — 1× / 2× / 3× / 4× (`deviceScaleFactor`); default 2×.
Max output is 16384 px per side (CDP limit).

## Supported social sites

| Site            | Post | Story | Notes                          |
| --------------- | :--: | :---: | ------------------------------ |
| Facebook        |  ✓   |   ✓   | also detects group posts       |
| Instagram       |  ✓   |   ✓   |                                |
| X / Twitter     |  ✓   |       |                                |
| Telegram (t.me) |  ✓   |       |                                |
| VK              |  ✓   |       |                                |

The "Capture this post/story" prompt only shows when the URL looks like a
single post/story page. Feed and profile pages fall through to Auto / Page
Capture.

## Helpers

- **Remove Elements** — interactive click-to-remove tool. Hover + scroll wheel
  to target, click to delete an element; **Ctrl/Cmd+Z** undoes the last
  removal.

## Settings

The header **gear** icon opens the Settings panel:

- **Output** — PNG or JPEG; JPEG quality slider; re-encode PNG as opaque
  (flattens onto white and strips alpha / colour-profile chunks, fixing Adobe
  ScriptUI / Direct2D panels that reject the screenshots — on by default,
  hidden in JPEG mode).
- **Downloads** — skip the "Save as" dialog; filename prefix prepended to
  every saved file.
- **Capture** — always open the crop editor; full-page height limit
  (capped at Chrome's 16384 px maximum).
- **Appearance** — theme override (Auto / Light / Dark) and language override
  (Auto / English / Русский) for the popup.

> The **Cleanup / Filters** feature (EasyList ad removal, the bundled + user
> filter lists, the Expert-mode filter manager) is frozen and disabled. The
> code is left intact but unwired — see [FROZEN-CLEANUP.md](internal-guides/FROZEN-CLEANUP.md)
> to re-enable it.

## How it works

1. Attach `chrome.debugger` to the active tab.
2. Emulate device metrics (`Emulation.setDeviceMetricsOverride`).
3. Wait for the page to settle (MutationObserver-based).
4. Capture with `Page.captureScreenshot`.
5. Detach and download the image (PNG/JPEG per Settings). Element captures are
   cropped from the viewport shot in JS (`OffscreenCanvas`) for accuracy.

See [CLAUDE.md](CLAUDE.md) for the full architecture reference.
