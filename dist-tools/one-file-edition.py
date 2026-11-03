#!/usr/bin/env python3
"""Emit a single plain-text edition of the bundle, for an LLM or reader that cannot unpack a tarball."""
import sys
from pathlib import Path

stage, out = Path(sys.argv[1]), Path(sys.argv[2])
order = ["README.md", "MANIFEST.json", "install.sh", "install-skills.sh", "uninstall.sh", "smoke.sh"]
parts = [
    f"# {stage.name} — single-file edition\n",
    "Everything below is the text of this bundle, in reading order. Binary payloads (lib/, python/,\n",
    "fixtures/) are described in MANIFEST.json and are not inlined.\n",
]


def add(path: Path, title: str) -> None:
    parts.append(f"\n\n---\n\n## {title}\n\n```\n{path.read_text(encoding='utf-8', errors='ignore')}\n```\n")


for name in order:
    candidate = stage / name
    if candidate.exists():
        add(candidate, name)

for path in sorted(stage.rglob("*.md")):
    if path.name in order or path.parent == stage:
        continue
    add(path, path.relative_to(stage).as_posix())

out.write_text("".join(parts), encoding="utf-8")
print(f"  single-file edition: {out} ({out.stat().st_size} bytes)")
