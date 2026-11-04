#!/usr/bin/env bash
# dsh-media-reader installer — ANY DSH home, ANY profile, no package manager.
#
#   ./install.sh                      # auto-detect DSH_HOME (default ~/.dsh) and profile "web"
#   DSH_HOME=/opt/dsh ./install.sh    # explicit home
#   ./install.sh --profile scratch --home /path/to/home
#   ./install.sh --dry-run            # print every action, change nothing
#
# It is copy-restore on purpose: `dsh plugin add` forwards to pnpm inside the profile, which is the
# documented split-Symbol crash ("Cannot read properties of undefined (reading 'prepare')" on every
# tool call). This script never invokes pnpm, npm, yarn or dsh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="dsh-media-reader"
PROFILE="web"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) DSH_HOME_DIR="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

run() { if [ "$DRY_RUN" -eq 1 ]; then printf '  would: %s\n' "$*"; else "$@"; fi; }

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
DEST="$PROFILE_DIR/node_modules/$PKG_NAME"
PATCH="$PROFILE_DIR/cordis.patch.yml"
SRC="$HERE/plugin"

echo "dsh-media-reader installer"
echo "  home      $DSH_HOME_DIR"
echo "  profile   $PROFILE"
echo "  dest      $DEST"

[ -d "$HERE/plugin" ] || { echo "FATAL: plugin/ is missing from this bundle" >&2; exit 1; }
[ -d "$PROFILE_DIR" ] || { echo "FATAL: profile directory not found: $PROFILE_DIR (start DSH once with this home, or pass --profile)" >&2; exit 1; }
command -v node >/dev/null || { echo "FATAL: node is required on PATH" >&2; exit 1; }
command -v ffmpeg >/dev/null || echo "WARN: ffmpeg not found — media_probe/media_video/media_image need it"

# 1. copy (never a package manager)
run mkdir -p "$DEST"
for part in lib python package.json cordis.patch.yml README.md; do
  [ -e "$SRC/$part" ] || { echo "FATAL: plugin/$part missing" >&2; exit 1; }
  run cp -r "$SRC/$part" "$DEST"/
done

# 2. register the plugin row (idempotent)
if [ -f "$PATCH" ] && grep -q "$PKG_NAME" "$PATCH"; then
  echo "  patch row already present in $PATCH"
else
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would: append the media-reader row to $PATCH"
  else
    mkdir -p "$(dirname "$PATCH")"
    cat >> "$PATCH" <<'YAML'

# dsh-media-reader — images, audio, video and evidence packs on routes that cannot read media.
- insert:
    - id: media-reader
      name: 'dsh-media-reader'
YAML
    echo "  appended the media-reader row to $PATCH"
  fi
fi

# 3. duplicate guard — the crash vector this whole method exists to avoid
echo "  guard: materialised @deepseek-ai copies under profiles must be absent"
DUPES="$(find "$DSH_HOME_DIR/profiles" -type d -path '*/node_modules/@deepseek-ai/*' 2>/dev/null || true)"
if [ -n "$DUPES" ]; then
  printf 'FATAL: duplicate @deepseek-ai packages found — every tool call will crash until removed:\n%s\n' "$DUPES" >&2
  echo "  fix: rm -rf the paths above, then re-run this installer" >&2
  exit 1
fi

# 4. probe the plugin actually loads as a module.
#    On a real DSH home the host's own packages resolve through <home>/profiles/node_modules, so the
#    import works here. On a machine where DSH has not been started with this home yet, that tree does
#    not exist — that is a missing prerequisite, not a broken bundle, so warn instead of failing and say
#    what to do.
# 2 = not checked at all (dry run). Never claim a verification that did not run: the generated
# prompt gates on this sentence, so a dry run printing it would satisfy the file's only pass condition.
VERIFIED=2
if [ "$DRY_RUN" -eq 0 ]; then
  VERIFIED=1
  IMPORT_ERR="$(node --input-type=module -e "await import('$DEST/lib/index.js')" 2>&1 || true)"
  if [ -z "$IMPORT_ERR" ]; then
    echo "  plugin imports cleanly"
  elif printf '%s' "$IMPORT_ERR" | grep -q "Cannot find package '@deepseek-ai/"; then
    VERIFIED=0
    echo "  WARN: the plugin cannot be imported from here because the harness packages are not reachable"
    echo "        from $DSH_HOME_DIR/profiles/node_modules. That tree is created by DSH itself: start the"
    echo "        server once with this home, then re-run this check. The copy and the patch row are in place."
  else
    printf 'FATAL: plugin import failed:\n%s\n' "$IMPORT_ERR" >&2
    exit 1
  fi
fi

cat <<NEXT

$([ "$VERIFIED" -eq 2 ] && echo "dry run — nothing was changed, and nothing was verified." || { [ "$VERIFIED" -eq 1 ] && echo "installed, and the import check passed." || echo "COPIED, BUT NOT VERIFIED — the import check above failed. Do not treat this as working until it passes and the smoke test runs."; }) Next steps:
  1. skills:  ./install-skills.sh --home $DSH_HOME_DIR   (links the bundled skills into $DSH_HOME_DIR/skills)
  2. verify:  ./smoke.sh                   (needs a RUNNING scratch harness; see README.md)
  3. restart the DSH server so the tools register, then run: dsh web --port <port>
  4. rollback: ./uninstall.sh --home $DSH_HOME_DIR --profile $PROFILE
NEXT
