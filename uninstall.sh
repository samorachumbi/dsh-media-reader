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
    # The previous pattern required a `# dsh-media-reader` comment line immediately above the block,
    # so a row written by hand (or by an older installer) was never matched — while this script still
    # printed "patch row removed". That is a rollback claim the code did not keep, and it leaves a
    # harness loading a plugin whose files are gone. Match the block by the plugin name instead, and
    # say only what actually happened.
    REMOVED="$(python3 - "$PATCH" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
before = text
text = re.sub(r"(?m)^[ \t]*#[^\n]*dsh-media-reader[^\n]*\n", "", text)
text = re.sub(r"(?ms)^[ \t]*- insert:\n(?:(?!^[ \t]*- insert:)[\s\S])*?name: 'dsh-media-reader'\n", "", text)
if text != before:
    open(path, "w").write(text)
    print("yes")
else:
    print("no")
PY
)"
    if [ "$REMOVED" = "yes" ]; then
      echo "  patch row removed (backup kept beside it)"
    else
      echo "  WARN: could not remove a media-reader block from $PATCH" >&2
      echo "        The file is unchanged and still references the plugin — remove it by hand." >&2
      echo "        A backup of the file is beside it: $(ls -1t "$PATCH".bak.* 2>/dev/null | head -1)" >&2
      echo "restart the DSH server to drop the tools."
      exit 3
    fi
  fi
fi
echo "restart the DSH server to drop the tools."
