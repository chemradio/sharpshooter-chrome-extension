#!/usr/bin/env python3
"""Bundle Sharpshooter into a Chrome Web Store upload ZIP.

Run from anywhere:
    python internal-guides/build_extension.py

Produces:
    internal-guides/build/sharpshooter-<version>.zip

The archive contains only the files the extension loads at runtime, with
manifest.json at the archive root (no wrapper folder). Anything matched by the
EXCLUDE_* rules below is left out.

This uses a denylist (exclude) rather than an allowlist, so new runtime files
added to the project are packed automatically. If you add a new dev-only file
or folder, add it to the EXCLUDE_* sets.
"""
import json
import sys
import zipfile
from pathlib import Path

# internal-guides/ lives inside the project; the project root is its parent.
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
OUT_DIR = SCRIPT_DIR / "build"

# Directories never packed (matched at any depth in the path).
EXCLUDE_DIRS = {
    ".git",            # version control
    ".claude",         # Claude Code settings
    "internal-guides", # these docs + this script + build output
    "static",          # dev-only icon/brand-mark generation assets
    "__pycache__",     # Python cache
}

# Exact root-level files never packed (dev docs, not part of the extension).
EXCLUDE_FILES = {
    ".gitignore",
    "CLAUDE.md",
    "README.md",
    "PRIVACY.md",      # hosted publicly, not shipped inside the extension
}

# File-name patterns never packed, anywhere.
EXCLUDE_SUFFIXES = (".pyc", ".zip")
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db"}


def should_include(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    parts = rel.parts
    if any(p in EXCLUDE_DIRS for p in parts):
        return False
    if len(parts) == 1 and rel.name in EXCLUDE_FILES:
        return False
    if rel.name in EXCLUDE_NAMES:
        return False
    if path.suffix in EXCLUDE_SUFFIXES:
        return False
    return True


def main() -> int:
    manifest_path = ROOT / "manifest.json"
    if not manifest_path.exists():
        print(f"ERROR: manifest.json not found at {manifest_path}", file=sys.stderr)
        return 1

    version = json.loads(manifest_path.read_text(encoding="utf-8"))["version"]
    OUT_DIR.mkdir(exist_ok=True)
    zip_path = OUT_DIR / f"sharpshooter-{version}.zip"
    if zip_path.exists():
        zip_path.unlink()

    files = sorted(p for p in ROOT.rglob("*") if p.is_file() and should_include(p))
    if not files:
        print("ERROR: nothing to pack — check the exclude rules.", file=sys.stderr)
        return 1

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(f, f.relative_to(ROOT).as_posix())

    # Sanity check: manifest must sit at the archive root.
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    if "manifest.json" not in names:
        print("ERROR: manifest.json missing from archive root!", file=sys.stderr)
        return 1

    print(f"Packed {len(names)} files -> {zip_path}")
    print(f"Size: {zip_path.stat().st_size / 1024:.1f} KB\n")
    print("Included:")
    for n in names:
        print(f"  {n}")
    print("\nUpload this ZIP at https://chrome.google.com/webstore/devconsole")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
