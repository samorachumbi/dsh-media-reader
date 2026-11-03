#!/usr/bin/env python3
"""Generalise development-machine paths in a staged bundle, and record what was rewritten."""
import sys
from pathlib import Path

stage = Path(sys.argv[1])
REPLACEMENTS = [
    ('/home/samora/projects/deepseek-test/second-brain', '$VAULT'),
    ('/home/samora/projects/Video_Image_Voice', '$WORKSPACE'),
    ('/home/samora/Music', '$REVIEW_DIR'),
    ('/home/samora', '$HOME'),
    # tilde-relative forms of the same private locations
    ('~/projects/deepseek-test/second-brain', '$VAULT'),
    ('~/projects/Video_Image_Voice', '$WORKSPACE'),
    ('~/Music', '$REVIEW_DIR'),
]
touched = []
for path in sorted(list(stage.rglob('*.md')) + list(stage.rglob('*.mjs')) + list(stage.rglob('*.js')) + list(stage.rglob('*.py'))):
    text = path.read_text(encoding='utf-8', errors='ignore')
    original = text
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    if text != original:
        path.write_text(text, encoding='utf-8')
        touched.append(path.relative_to(stage).as_posix())

note = stage / 'docs' / 'PATH-PLACEHOLDERS.md'
note.parent.mkdir(parents=True, exist_ok=True)
note.write_text(
    "# Path placeholders in this bundle\n\n"
    "Absolute paths from the development machine were replaced so this bundle works anywhere:\n\n"
    "| Placeholder | Meaning |\n|---|---|\n"
    "| `$HOME` | the installing user's home directory |\n"
    "| `$VAULT` | the operator's private notes vault; referenced as background reading only, the bundle does not need it |\n"
    "| `$WORKSPACE` | wherever this bundle was extracted |\n"
    "| `$REVIEW_DIR` | the operator's review folder for generated media; any folder works |\n\n"
    "Rewritten files: " + (", ".join(touched) if touched else "none") + "\n"
)
print(f"  generalised paths in {len(touched)} files")
