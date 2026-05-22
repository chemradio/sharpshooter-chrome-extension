# Privacy Policy — Sharpshooter

_Last updated: 2026-05-22_

Sharpshooter is a Chrome extension for capturing high-resolution screenshots of
web pages and page elements.

## Summary

**Sharpshooter does not collect, transmit, or sell any personal data.** All
processing happens locally in your browser. No analytics, no tracking, no
remote servers, and **no network requests of any kind**.

## What the extension stores

Sharpshooter uses Chrome's local storage (`chrome.storage.local`) on your own
device for:

- **Extension preferences** — your capture settings (output format, scale,
  filename prefix, theme, language, and similar options).

This data never leaves your device. It is not synced to the developer or any
third party.

## Network access

Sharpshooter makes **no network requests**. It does not download or upload
anything, and it requests no host permissions for any website.

## Screenshots

Screenshots you capture are saved directly to your computer's Downloads folder
via Chrome's downloads API. They are never uploaded anywhere.

## Permissions

| Permission | Why it is needed |
|---|---|
| `debugger` | Captures screenshots through the Chrome DevTools Protocol (`Page.captureScreenshot`) with device-metric emulation — the core capture mechanism. |
| `downloads` | Saves the captured screenshot files to your Downloads folder. |
| `scripting` | Injects the highlighter and page-measurement scripts into the page being captured. |
| `storage` | Stores your capture preferences locally. |
| `activeTab` | Lets the extension act on the tab you invoke it on — granted only when you open the popup or click a capture button. |

Sharpshooter requests no host permissions and does not access any website
beyond the tab you explicitly invoke it on.

## Contact

Questions about this policy: chemradio@gmail.com
