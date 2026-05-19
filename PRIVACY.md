# Privacy Policy — Sharpshooter

_Last updated: 2026-05-19_

Sharpshooter is a Chrome extension for capturing high-resolution screenshots of
web pages and page elements.

## Summary

**Sharpshooter does not collect, transmit, or sell any personal data.** All
processing happens locally in your browser. No analytics, no tracking, no
remote servers operated by the developer.

## What the extension stores

Sharpshooter uses Chrome's local storage (`chrome.storage.local`) on your own
device for:

- **Filter lists** — a cosmetic ad/clutter filter list (EasyList) downloaded
  from `easylist.to`, a small set of filters bundled with the extension, and
  any CSS selectors you choose to collect with the "Remove Elements" tool.
- **Extension preferences** — your last-used capture settings.

This data never leaves your device. It is not synced to the developer or any
third party.

## What the extension downloads

The extension periodically downloads a public **text filter list** (EasyList)
from `easylist.to`, with `raw.githubusercontent.com` and `cdn.jsdelivr.net` as
fallback mirrors. This is a plain-text list of CSS selectors. No personal data
is sent in these requests beyond the standard network request your browser
makes for any download.

## Screenshots

Screenshots you capture are saved directly to your computer's Downloads folder
via Chrome's downloads API. They are never uploaded anywhere.

## Permissions

| Permission | Why it is needed |
|---|---|
| `debugger` | Captures screenshots through the Chrome DevTools Protocol (`Page.captureScreenshot`) with device-metric emulation — the core capture mechanism. |
| `downloads` | Saves the captured screenshot files to your Downloads folder. |
| `scripting` | Injects the highlighter, cleanup, and measurement scripts into the page being captured. |
| `storage` | Stores filter lists and your preferences locally. |
| `activeTab` | Lets the extension act on the tab you invoke it on — granted only when you open the popup or click a capture button. |
| Host permissions (`easylist.to`, `raw.githubusercontent.com`, `cdn.jsdelivr.net`) | Used only to download the public EasyList cosmetic filter list. No other websites are accessed via host permissions. |

## Contact

Questions about this policy: chemradio@gmail.com
