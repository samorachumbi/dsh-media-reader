#!/usr/bin/env bash
# Build the distributable bundle: plugin + skills + docs + fixtures + installers + manifest.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Private locations (the notes vault) are NOT part of this public repository, and neither is the file
# that names them: a file holding private paths inside the checkout is a leak waiting for one wrong
# `git add`. Declare them OUTSIDE the repo, in $BUNDLE_PATHS, else
#   ${XDG_CONFIG_HOME:-$HOME/.config}/dsh-media-reader/bundle-paths
#     VAULT_DIR=$HOME/somewhere/private-vault
# Without it the plugin still bundles; the four skills are simply left out with a loud warning.
PATHS_FILE="${BUNDLE_PATHS:-${XDG_CONFIG_HOME:-$HOME/.config}/dsh-media-reader/bundle-paths}"
if [ ! -f "$PATHS_FILE" ] && [ -f "$REPO/.bundle-paths" ]; then
  PATHS_FILE="$REPO/.bundle-paths"
  echo "  NOTE: private paths read from $REPO/.bundle-paths, which is inside the checkout — move it to" >&2
  echo "        ${XDG_CONFIG_HOME:-$HOME/.config}/dsh-media-reader/bundle-paths" >&2
fi
[ -f "$PATHS_FILE" ] && . "$PATHS_FILE"
# scrub-paths.py reads these from its ENVIRONMENT, so they must be exported — sourcing .bundle-paths
# alone only sets shell variables and the placeholders silently disappear. WORKSPACE_DIR defaults to
# this checkout, which the build already knows, so it can never be forgotten.
export VAULT_DIR="${VAULT_DIR:-}"
export WORKSPACE_DIR="${WORKSPACE_DIR:-$REPO}"
export REVIEW_DIR="${REVIEW_DIR:-}"
VAULT="$VAULT_DIR"
NAME="${NAME:-dsh-media-reader}"
VERSION="$(python3 -c "import json;print(json.load(open('$REPO/package.json'))['version'])")"
STAGE="$REPO/dist-tools/bundle/$NAME-$VERSION"
OUT="$REPO/dist"

rm -rf "$STAGE"; mkdir -p "$STAGE"/{plugin,plugin/fixtures,skills,docs,fixtures}

# --- plugin payload -------------------------------------------------------
for part in lib python package.json cordis.patch.yml README.md probe LICENSE; do
  cp -r "$REPO/$part" "$STAGE/plugin"/
done
# the licence travels with the payload too, so a consumer who vendors `plugin/` alone still has the terms
cp "$REPO/LICENSE" "$STAGE/LICENSE"
# the smoke harness must ship with the plugin it tests
rm -rf "$STAGE/plugin/lib/__pycache__" 2>/dev/null || true

# --- skills (canonical files from the vault) ------------------------------
copy_skill() {
  local name="$1" file="$2"
  mkdir -p "$STAGE/skills/$name"
  if [ -z "$VAULT" ]; then
    echo "  SKIP skill: $name — VAULT_DIR is not set (see .bundle-paths); the plugin payload is unaffected" >&2
    return 0
  fi
  if [ -f "$VAULT/skills/$file" ]; then
    cp "$VAULT/skills/$file" "$STAGE/skills/$name/SKILL.md"
    echo "  skill: $name"
  else
    echo "  WARN: missing $VAULT/skills/$file" >&2
  fi
}
copy_skill product-motion-studio        product-motion-studio-SKILL.md
copy_skill dsh-plugin-install-safety    dsh-plugin-install-safety-SKILL.md
copy_skill dsh-skill-install            dsh-skill-install-SKILL.md
copy_skill dsh-test-boot                dsh-test-boot-SKILL.md
copy_skill media-reading-discipline      media-reading-discipline-SKILL.md

# --- docs ----------------------------------------------------------------
for doc in RESEARCH.md PRODUCTION-PIPELINE.md REPLICATION-RESEARCH.md EVIDENCE-PACK.md \
           ACCEPTANCE.md CONTRACT.md AUDIT.md PLAN.md README.md \
           directing-workflow.md dance-direction.md; do
  [ -f "$REPO/$doc" ] && cp "$REPO/$doc" "$STAGE/docs/"
done
if [ -n "$VAULT" ]; then
  cp "$VAULT/concepts/generated-film-pipeline.md" "$STAGE/docs/" 2>/dev/null || true
  cp "$VAULT/concepts/plugin-distribution-bundle.md" "$STAGE/docs/" 2>/dev/null || true
  cp "$VAULT/concepts/image-read-failure-handoff.md" "$STAGE/docs/" 2>/dev/null || true
fi

python3 "$REPO/dist-tools/scrub-paths.py" "$STAGE"
python3 "$REPO/dist-tools/sanitise-skills.py" "$STAGE"

# --- artifact hygiene gate -------------------------------------------------
# The path scrubber rewrites TEXT. A .pyc embeds the absolute source path as bytes, so a stale
# bytecode cache ships a private path into an artifact no scrubber can fix — and stale bytecode can
# even shadow a source change. Remove it, then prove the artifact is clean instead of assuming it.
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -name '*.pyc' -delete 2>/dev/null || true
if [ -n "${HOME:-}" ] && grep -rlF -e "$HOME" "$STAGE" >/dev/null 2>&1; then
  echo "FATAL: the artifact still contains this machine's home path — do not ship it:" >&2
  grep -rlF -e "$HOME" "$STAGE" >&2
  exit 1
fi
if grep -rlE -e 'github_pat_[A-Za-z0-9]{20,}' -e 'ghp_[A-Za-z0-9]{20,}' "$STAGE" >/dev/null 2>&1; then
  echo "FATAL: the artifact contains a credential — do not ship it:" >&2
  grep -rlE -e 'github_pat_' -e 'ghp_' "$STAGE" >&2
  exit 1
fi
echo "  hygiene: no home path, no credential, no bytecode cache"

# --- fixtures the smoke test needs ---------------------------------------
for f in hello.png jfk.wav silence.wav error-demo.mp4; do
  if [ -f "$REPO/fixtures/$f" ]; then
    cp "$REPO/fixtures/$f" "$STAGE/fixtures/"
    mkdir -p "$STAGE/plugin/fixtures"
    cp "$REPO/fixtures/$f" "$STAGE/plugin/fixtures/"
  fi
done

# --- installers ----------------------------------------------------------
cp "$REPO/install.sh" "$REPO/install-skills.sh" "$REPO/uninstall.sh" "$REPO/smoke.sh" "$STAGE"/
chmod +x "$STAGE"/*.sh

# --- install-first README ------------------------------------------------
cp "$REPO/dist-tools/bundle/README-BUNDLE.md" "$STAGE/README.md"

python3 "$REPO/dist-tools/write-manifest.py" "$STAGE"

mkdir -p "$OUT"
( cd "$REPO/dist-tools/bundle" && tar -czf "$OUT/$NAME-$VERSION.tar.gz" "$NAME-$VERSION" )
( cd "$OUT" && sha256sum "$NAME-$VERSION.tar.gz" > "$NAME-$VERSION.tar.gz.sha256" )
python3 "$REPO/dist-tools/one-file-edition.py" "$STAGE" "$OUT/$NAME-$VERSION.txt"

echo "built: $OUT/$NAME-$VERSION.tar.gz"
cat "$OUT/$NAME-$VERSION.tar.gz.sha256"
du -h "$OUT/$NAME-$VERSION.tar.gz" | awk '{print "size: "$1}'
