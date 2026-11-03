#!/usr/bin/env bash
# Link the bundled skills into $DSH_HOME/skills so they are loadable and slash-invocable.
# DSH reads $DSH_HOME/skills (NOT ~/.claude/skills) and hot-reloads changes.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME_DIR/skills"

[ -d "$HERE/skills" ] || { echo "FATAL: skills/ missing from this bundle" >&2; exit 1; }
mkdir -p "$TARGET"
echo "linking bundled skills into $TARGET"
for dir in "$HERE"/skills/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || { echo "  skip $name (no SKILL.md)"; continue; }
  if [ -e "$TARGET/$name" ] && [ ! -L "$TARGET/$name" ]; then
    echo "  skip $name (a real directory is already installed there — not overwriting)"
    continue
  fi
  ln -sfn "$dir" "$TARGET/$name"
  echo "  linked $name"
done
echo "done. DSH hot-reloads this directory; no restart needed for skills."
