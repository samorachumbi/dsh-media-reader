#!/usr/bin/env python3
"""Make the shipped skills safe for a customer, and fail the build if they are not.

The skills in `second-brain/skills/` are written for this machine: they name `~/dsh-planner`, instance
numbers, `scripts/deploy.sh`, and vault notes that are not in the bundle. A customer's agent that follows
those references chases files it does not have — the exact failure recorded in census E17, where a skill
documented a path that did not resolve from where the skill was installed.

This script edits the STAGED COPY only. The canonical skill stays intact for our own use.
"""
import re
import sys
from pathlib import Path

stage = Path(sys.argv[1])
if not stage.is_dir():
    raise SystemExit(f"not a directory: {stage}")

# Anything that cannot resolve on a machine that is not ours.
FORBIDDEN = [
    (r"~/dsh-planner", "a home only this machine has"),
    (r"scripts/deploy\.sh", "a script that is not in the bundle"),
    (r"/home/samora", "an absolute path from the author's machine"),
    (r"\[\[[^\]]+\]\]", "an Obsidian wiki-link the reader cannot open"),
    (r"\brepo-vetting\b", "a skill we did not ship"),
    (r"\blearnings/", "a vault path"),
    (r"\bconcepts/", "a vault path"),
    (r"this machine", "text that describes the author's setup, not the reader's"),
]

DROPPED_SECTIONS = re.compile(r"\b(this machine|on this box|author's machine)\b", re.I)

changed, problems = [], []

for path in sorted(stage.glob("skills/*/SKILL.md")):
    text = path.read_text(encoding="utf-8")
    before = text

    # 1. drop whole sections that are about our setup, not the reader's
    lines = text.splitlines()
    kept, skip_level = [], None
    for line in lines:
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading and DROPPED_SECTIONS.search(heading.group(2)):
            skip_level = len(heading.group(1))
            continue
        if skip_level is not None:
            if heading and len(heading.group(1)) <= skip_level:
                skip_level = None
            else:
                continue
        kept.append(line)
    text = "\n".join(kept)

    # 2. a wiki-link becomes plain text: a customer has no Obsidian vault to open it in
    text = re.sub(r"\[\[([^\]]+)\]\]", lambda m: f"`{m.group(1)}`", text)

    # 3. drop the lines that point at things we did not ship
    text = "\n".join(
        line for line in text.splitlines()
        if not re.search(r"\b(repo-vetting|learnings/|concepts/|scripts/deploy\.sh|~/dsh-planner)\b", line)
    )

    text = re.sub(r"\n{3,}", "\n\n", text).rstrip() + "\n"

    if text != before:
        path.write_text(text, encoding="utf-8")
        changed.append(path.relative_to(stage).as_posix())

    for pattern, why in FORBIDDEN:
        for match in re.finditer(pattern, text):
            line = text[:match.start()].count("\n") + 1
            problems.append(f"{path.relative_to(stage).as_posix()}:{line} {why}: {match.group(0)[:60]}")

if changed:
    print(f"  skills made customer-safe: {len(changed)} file(s) edited")
for problem in problems:
    print(f"  LEAK: {problem}", file=sys.stderr)
if problems:
    raise SystemExit("FATAL: a shipped skill still refers to something the buyer does not have")
print("  skills: no machine-specific references, no vault links, no unshipped skills")
