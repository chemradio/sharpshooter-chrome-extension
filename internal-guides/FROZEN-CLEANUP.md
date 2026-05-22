# Frozen: Cleanup / Filters feature

The **Cleanup** feature — EasyList fetching, bundled filters, user filters,
AdRemover, the Expert-mode filter manager, and the Expert help page — has been
**obsoleted and disabled**. None of it runs anymore and the extension makes no
network requests.

All the code is **left intact** on disk. Nothing was deleted — only unwired.
This document lists every change so the feature can be turned back on.

## What still works

- Auto / Page / Element capture, the site-detection prompt, and **Remove
  Elements** are unaffected.
- The former "Expert mode" header toggle is now a **Settings** gear icon
  (`view-settings`), holding the "Re-encode PNG opaque" option (now **on by
  default**).

## Files left untouched (the frozen feature's code)

These still exist and are fully functional — they are just no longer called:

- `adRemover/` (filterSource, parseEasylist, filterStorage, refreshFilters)
- `contentScripts/adRemover.js`, `contentScripts/cleanup.js`
- `filters/bundledFilters.json`
- `backgroundScript.js` — `runCleanup`, `loadBundledFilters`, `exportUserFilters`,
  `listUserFilters`, `addUserFilter`, `removeUserFilter`, `clearDomainFilters`,
  `clearGlobalFilters` and their message actions are all still defined.
- `screenshots/autoCapture.js` — `runAdRemover` is still defined.

## How to turn it back on

Each step is marked in code with a `FROZEN` comment.

1. **`manifest.json`** — re-add the `host_permissions` block (it was removed
   entirely; it sat right after `permissions`):
   ```json
   "host_permissions": [
       "https://easylist.to/*",
       "https://raw.githubusercontent.com/*",
       "https://cdn.jsdelivr.net/*"
   ],
   ```

2. **`backgroundScript.js`** — uncomment the `onStartup` / `onInstalled` filter
   hydration listeners (search for `FROZEN: Cleanup / AdRemover feature`).

3. **`screenshots/autoCapture.js`** — uncomment the two
   `// FROZEN: await runAdRemover(tabId);` lines (in `runAutoCapture` and
   `captureSiteElement`).

4. **UI (`popup.html`, `popup.js`, `popup.css`, `_locales/*/messages.json`)** —
   the Cleanup button, the filter-manager panel, and the Expert help page were
   removed from the markup. To restore the full Expert UI, revert the popup
   changes from the commit that froze this feature (`git log` for "obsolete
   cleanup"). The background message actions they call are all still present, so
   only the front-end markup/handlers need restoring.

The i18n keys for the old UI (`cleanup`, `addFilter`, `exportFilters`,
`helpTiers`, etc.) were intentionally **kept** in `_locales/en` and `_locales/ru`,
so restoring the markup needs no new translations.
