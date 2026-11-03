#!/usr/bin/env bash
# Build the distributable bundle: plugin + skills + docs + fixtures + installers + manifest.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="${VAULT:-$HOME/projects/deepseek-test/second-brain}"
NAME="${NAME:-dsh-media-reader}"
VERSION="$(python3 -c "import json;print(json.load(open('$REPO/package.json'))['version'])")"
STAGE="$REPO/dist-tools/bundle/$NAME-$VERSION"
OUT="$REPO/dist"

rm -rf "$STAGE"; mkdir -p "$STAGE"/{plugin,plugin/fixtures,skills,docs,fixtures}

# --- plugin payload -------------------------------------------------------
for part in lib python package.json cordis.patch.yml README.md probe; do
  cp -r "$REPO/$part" "$STAGE/plugin"/
done
# the smoke harness must ship with the plugin it tests
rm -rf "$STAGE/plugin/lib/__pycache__" 2>/dev/null || true

# --- skills (canonical files from the vault) ------------------------------
copy_skill() {
  local name="$1" file="$2"
  mkdir -p "$STAGE/skills/$name"
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

# --- docs ----------------------------------------------------------------
for doc in RESEARCH.md PRODUCTION-PIPELINE.md REPLICATION-RESEARCH.md EVIDENCE-PACK.md \
           ACCEPTANCE.md CONTRACT.md AUDIT.md PLAN.md README.md \
           directing-workflow.md dance-direction.md; do
  [ -f "$REPO/$doc" ] && cp "$REPO/$doc" "$STAGE/docs/"
done
cp "$VAULT/concepts/generated-film-pipeline.md" "$STAGE/docs/" 2>/dev/null || true
cp "$VAULT/concepts/plugin-distribution-bundle.md" "$STAGE/docs/" 2>/dev/null || true
cp "$VAULT/concepts/image-read-failure-handoff.md" "$STAGE/docs/" 2>/dev/null || true

python3 "$REPO/dist-tools/scrub-paths.py" "$STAGE"

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
