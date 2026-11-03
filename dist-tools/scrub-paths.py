#!/usr/bin/env python3
"""Generalise development-machine paths in a staged bundle, and record what was rewritten.

The private locations are **not hardcoded**: this repository is public, so baking the
author's vault, workspace and review folders into it would both leak those paths and
make the scrubber useless to anyone else. They are read from the environment instead:

    VAULT_DIR      the operator's private notes vault (background reading only)
    WORKSPACE_DIR  the checkout this bundle was built from
    REVIEW_DIR     wherever the operator reviews generated media

`HOME` is always known, so `$HOME` is generalised even when nothing is exported. When a
variable is unset its placeholder simply does not appear — that is correct, not a failure:
a machine with no vault has no vault paths to remove.

Usage:  scrub-paths.py <stage-dir>
"""
import os
import sys
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit("usage: scrub-paths.py <stage-dir>")
stage = Path(sys.argv[1])

home = os.environ.get('HOME') or str(Path.home())

# placeholder -> private directory, only for the ones this machine actually declares
private = {
    '$VAULT': os.environ.get('VAULT_DIR', ''),
    '$WORKSPACE': os.environ.get('WORKSPACE_DIR', ''),
    '$REVIEW_DIR': os.environ.get('REVIEW_DIR', ''),
}

REPLACEMENTS = []
for placeholder, value in sorted(private.items(), key=lambda kv: -len(kv[1] or '')):
    value = (value or '').rstrip('/')
    if not value or not value.startswith('/'):
        continue
    REPLACEMENTS.append((value, placeholder))
    # the tilde-relative spelling of the same location, when it lives under $HOME
    if value.startswith(home.rstrip('/') + '/'):
        REPLACEMENTS.append(('~' + value[len(home.rstrip('/')):], placeholder))
# $HOME last, so the deeper locations above are already handled by their own placeholders
REPLACEMENTS.append((home.rstrip('/'), '$HOME'))

touched = []
for path in sorted(list(stage.rglob('*.md')) + list(stage.rglob('*.mjs')) + list(stage.rglob('*.js')) + list(stage.rglob('*.py'))):
    text = path.read_text(encoding='utf-8', errors='ignore')
    original = text
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    if text != original:
        path.write_text(text, encoding='utf-8')
        touched.append(path.relative_to(stage).as_posix())

declared = [p for p in ('$VAULT', '$WORKSPACE', '$REVIEW_DIR') if any(new == p for _, new in REPLACEMENTS)]
note = stage / 'docs' / 'PATH-PLACEHOLDERS.md'
note.parent.mkdir(parents=True, exist_ok=True)
note.write_text(
    "# Path placeholders in this bundle\n\n"
    "Absolute paths from the machine that built this bundle were replaced so it works anywhere:\n\n"
    "| Placeholder | Meaning |\n|---|---|\n"
    "| `$HOME` | the installing user's home directory |\n"
    "| `$VAULT` | the builder's private notes vault; background reading only, the bundle does not need it |\n"
    "| `$WORKSPACE` | wherever this bundle was extracted |\n"
    "| `$REVIEW_DIR` | the builder's review folder for generated media; any folder works |\n\n"
    "Placeholders that appear in this build: " + (", ".join(['$HOME'] + declared)) + "\n\n"
    "Rewritten files: " + (", ".join(touched) if touched else "none") + "\n"
)
print(f"  generalised paths in {len(touched)} files (placeholders: {', '.join(['$HOME'] + declared)})")
