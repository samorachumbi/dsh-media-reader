#!/usr/bin/env bash
# Deploy the storefront to Cloudflare Pages — a WHITELIST, not the whole directory.
#
# Why a staging copy instead of `wrangler pages deploy store/`:
#   store/ also holds README.md (the operator runbook) and evidence/ (~3.9 MB of test PNGs).
#   Cloudflare Pages uploads every non-dot file in the directory it is given, so deploying
#   store/ directly would publish the runbook at /README.md and ship 4 MB of screenshots.
#   Staging keeps store/ as the single source of truth while publishing only the sales surface.
#
#   ./tools/deploy-store.sh --dry-run     # show exactly what would be uploaded, upload nothing
#   ./tools/deploy-store.sh               # stage and deploy to the production branch
#
# Requires: wrangler authenticated (`npx wrangler whoami`), project "itikia-store" existing.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/store"
PROJECT="${PROJECT:-itikia-store}"
BRANCH="${BRANCH:-main}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# The public site: the selling page, its policy pages, its assets, and the agent-readable summary.
WHITELIST=(index.html terms.html privacy.html refund.html llms.txt assets)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

missing=0
for item in "${WHITELIST[@]}"; do
  if [ ! -e "$SRC/$item" ]; then echo "MISSING: store/$item" >&2; missing=1; fi
done
[ "$missing" -eq 0 ] || { echo "refusing to deploy an incomplete site" >&2; exit 1; }

for item in "${WHITELIST[@]}"; do
  cp -a "$SRC/$item" "$STAGE/"
done

echo "staged for upload:"
( cd "$STAGE" && find . -type f | sort | sed 's/^\.\//  /' )
echo "  $(find "$STAGE" -type f | wc -l) files, $(du -sh "$STAGE" | cut -f1)"

# The page must still pass its own guards before anything is published.
( cd "$REPO" && node --test tests/storefront-rails.test.mjs >/dev/null 2>&1 ) \
  || { echo "refusing to deploy: storefront guards are failing (node --test tests/storefront-rails.test.mjs)" >&2; exit 1; }
echo "storefront guards: pass"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run — nothing was uploaded."
  exit 0
fi

cd "$STAGE"
npx --yes wrangler pages deploy . \
  --project-name "$PROJECT" \
  --branch "$BRANCH" \
  --commit-hash "$(git -C "$REPO" rev-parse HEAD)" \
  --commit-message "$(git -C "$REPO" log -1 --pretty=%s)"
