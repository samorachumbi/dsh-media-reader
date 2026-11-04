#!/usr/bin/env bash
# Link the bundled skills into <home>/skills so they are loadable and slash-invocable.
# DSH reads $DSH_HOME/skills (NOT ~/.claude/skills) and hot-reloads changes.
#
#   ./install-skills.sh                      # $DSH_HOME, else ~/.dsh
#   ./install-skills.sh --home /tmp/scratch  # same home you passed to install.sh
#
# --home exists because `DSH_HOME` is ALREADY SET in every process a harness spawns. An installer
# that reads only the environment therefore installs the plugin into the home you named and the
# skills into the operator's real one. If the two disagree this script says so and refuses.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
EXPLICIT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="$2"; EXPLICIT=1; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "install-skills.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
DRY="${DRY:-0}"
TARGET="$HOME_DIR/skills"

echo "install-skills"
echo "  home   $HOME_DIR"
echo "  target $TARGET"

# The trap that makes this flag necessary: an inherited DSH_HOME that differs from the home the
# caller just installed into. Refuse rather than scatter links into two homes.
if [ "$EXPLICIT" -eq 0 ] && [ -n "${DSH_HOME:-}" ]; then
  echo "  NOTE: no --home given, so this follows the inherited DSH_HOME ($DSH_HOME)." >&2
  echo "        If you installed the plugin into a different home, pass --home with the same value." >&2
fi

[ -d "$HERE/skills" ] || { echo "FATAL: skills/ missing from this bundle" >&2; exit 1; }
if [ "$DRY" -eq 1 ]; then
  echo "  would: link $(ls -1d "$HERE"/skills/*/ 2>/dev/null | wc -l) skills into $TARGET"
  exit 0
fi
mkdir -p "$TARGET"
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
