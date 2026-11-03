#!/usr/bin/env bash
# Remove ONLY what install.sh created: the copied package and its patch row.
set -euo pipefail
PROFILE="web"; DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"; DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) DSH_HOME_DIR="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "uninstall.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
DEST="$DSH_HOME_DIR/profiles/$PROFILE/node_modules/dsh-media-reader"
PATCH="$DSH_HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
run() { if [ "$DRY_RUN" -eq 1 ]; then echo "  would: $*"; else "$@"; fi; }
if [ -d "$DEST" ]; then run rm -rf "$DEST"; echo "  removed $DEST"; else echo "  not installed at $DEST"; fi
if [ -f "$PATCH" ] && grep -q "dsh-media-reader" "$PATCH"; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would: strip the media-reader block from $PATCH"
  else
    cp "$PATCH" "$PATCH.bak.$(date +%s)"
    python3 - "$PATCH" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(r"\n# dsh-media-reader[^\n]*\n- insert:\n(?:    .*\n|\n)*?      name: 'dsh-media-reader'\n", "\n", text)
open(path, "w").write(text)
PY
    echo "  patch row removed (backup kept beside it)"
  fi
fi
echo "restart the DSH server to drop the tools."
