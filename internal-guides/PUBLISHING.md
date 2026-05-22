# Publishing Sharpshooter to the Chrome Web Store

Internal checklist. Not part of the extension.

Related files in this folder:
- **STORE_LISTING.md** — copy/paste text for the dashboard (description, permission justifications).
- **FROZEN-CLEANUP.md** — record of the disabled Cleanup/Filters feature.
- **build_extension.py** — builds the upload ZIP (see step 3).

The privacy policy (**PRIVACY.md**) stays at the project root because it must be
hosted at a public URL.

---

## Step 0 — One-time setup

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in with the owning Google account.
3. Pay the one-time **$5 USD** registration fee.
4. Verify the account contact email.

## Step 1 — Host the privacy policy

The dashboard requires a public privacy-policy URL.

1. Publish `PRIVACY.md` (project root) somewhere public — GitHub repo/Pages, a
   gist, or any web page.
2. Copy that URL; you paste it in step 5.

## Step 2 — Prepare listing assets

- **Icon** — `icon128.png` (already in the project, 128×128).
- **Screenshots** — at least 1, sized **1280×800** or **640×400**, PNG/JPEG.
  Show the popup and a capture result.
- **Optional** — small promo tile 440×280.

## Step 3 — Build the upload ZIP

Run the bundler:

```
python internal-guides/build_extension.py
```

It reads the version from `manifest.json` and writes
`internal-guides/build/sharpshooter-<version>.zip` with `manifest.json` at the
archive root. It packs only runtime files (see the lists below).

## Step 4 — Create the item

1. Dashboard → **Add new item** → upload the ZIP.
2. Fill the **Store listing** tab using `STORE_LISTING.md`:
   - Title, summary, description.
   - Category — Productivity (or Developer Tools).
   - Language, icon, screenshots.

## Step 5 — Privacy tab

1. Set **Single purpose** (from `STORE_LISTING.md`).
2. Paste each **permission justification** from `STORE_LISTING.md` —
   `debugger`, `downloads`, `scripting`, `storage`, `activeTab`.
   Host permissions: none. Remote code: none.
3. Paste the **privacy policy URL** from step 1.
4. Tick the data-usage certifications: does not collect personal data, does not
   sell/transfer data, no unrelated use, no creditworthiness use.

## Step 6 — Distribution & submit

1. Choose **visibility** — Public, Unlisted (link-only), or Private (Workspace).
   For internal CTA use, Unlisted or Private is the usual choice.
2. Pricing: Free. Set regions.
3. Click **Submit for review**.

Note: Sharpshooter uses the `debugger` permission, which triggers stricter,
slower manual review — expect a longer turnaround and possibly follow-up
questions.

## Step 7 — Updates

Bump `version` in `manifest.json` (e.g. `1.0.0` → `1.0.1`), rebuild with the
script, and upload the new ZIP to the same item. Each upload must have a higher
version number.

---

## What goes in the ZIP

The build script packs these automatically. Listed here for review.

**Root files**
- `manifest.json`
- `popup.html`, `popup.js`, `popup.css`, `popup-light.css`
- `cropEditor.html`, `cropEditor.js`, `cropEditor.css`
- `backgroundScript.js`
- `brandMark.js`
- `i18n.js`, `localize.js`
- `icon16.png`, `icon48.png`, `icon128.png`

**Folders (all contents)**
- `_locales/` — `en/`, `ru/`
- `contentScripts/` — including `sites/`
- `screenshots/` — including `capture/`, `elementSelect/`, `emulation/`
- `support/`
- `adRemover/` — frozen feature, but `backgroundScript.js` still imports it; the
  service worker fails to load if it is missing.
- `filters/` — `bundledFilters.json` (frozen feature; kept for the same reason).

## What must NOT go in the ZIP

The build script excludes these automatically:

- `.git/`, `.claude/`, `.gitignore`
- `CLAUDE.md`, `README.md`
- `PRIVACY.md` — hosted publicly instead (step 1)
- `internal-guides/` — this folder (docs, this script, `build/` output)
- `static/` — dev-only icon / brand-mark generation assets, not loaded at runtime
- `__pycache__/`, `*.pyc`, `*.zip`, `.DS_Store`, `Thumbs.db`
