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
- **Auto Capture** — one-click full-page capture: removes ads, runs per-host
  cleanup, then captures the full page at the selected scale.
- **Page Capture** — captures the page at a chosen resolution preset and scale.
- **Capture Element** — interactively pick any DOM element: hover to highlight
  (cyan glow), scroll wheel to walk the DOM tree (up = parent, down = child),
  click to capture.

PNGs download as `page-…` / `element-…` named with the domain and a timestamp.

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

- **Cleanup** — runs the cleanup pipeline (ad removal + per-host framing
  cleanup) on the current page without capturing.
- **Remove Elements** — interactive click-to-remove tool. Hover + scroll wheel
  to target, click to delete an element; **Ctrl/Cmd+Z** undoes the last
  removal. Each removal is also saved as a reusable selector for that host.

## Expert mode

Toggle **Expert** in the header to manage filters:

- Add / remove user filter selectors, per-host or global.
- Export collected filters as JSON, clear domain or global filters.
- Disable the bundled filter list; optionally re-encode captures as opaque PNG.

## Cleanup & ad removal

Cleanup merges three filter tiers — upstream **EasyList**, a **bundled**
curated list shipped with the extension, and **user** selectors collected via
Remove Elements — and applies them as CSS-selector node removal, plus a small
hand-curated per-host pass for screenshot framing.

MV3-safe: only filter *lists* (CSS selectors / URL patterns) are fetched at
runtime — never remote JavaScript.

## How it works

1. Attach `chrome.debugger` to the active tab.
2. Emulate device metrics (`Emulation.setDeviceMetricsOverride`).
3. Wait for the page to settle (MutationObserver-based).
4. Capture with `Page.captureScreenshot`.
5. Detach and download the PNG. Element captures are cropped from the
   viewport shot in JS (`OffscreenCanvas`) for accuracy.

See [CLAUDE.md](CLAUDE.md) for the full architecture reference.
