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
# robots.txt belongs here. Cloudflare already serves an edge file for this zone, and the only way to learn whether
# ours replaces it is to publish one. While it was missing from this list the gap was silent: the file existed in
# git, every test passed, and the deploy shipped 13 files without it — so the live robots.txt would still have been
# Cloudflare's, and L4 would have blamed the edge.
WHITELIST=(index.html pricing.html terms.html privacy.html refund.html 404.html llms.txt robots.txt assets)

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

# The page must still pass its own guards before anything is published — ALL of them, not one file.
# This used to run only storefront-rails.test.mjs, which covers rails, policy links and the 404; it does not know
# that the JSON-LD disagrees with #pay-config, or that llms.txt contradicts the refund page. Those guards existed
# and were green in the suite while a deploy could ship straight past them. The whole storefront subset runs in
# under two seconds, so there is no speed argument for the narrow gate.
( cd "$REPO" && node --test tests/storefront-*.test.mjs >/dev/null 2>&1 ) \
  || { echo "refusing to deploy: storefront guards are failing (node --test tests/storefront-*.test.mjs)" >&2; exit 1; }
echo "storefront guards: pass (all tests/storefront-*.test.mjs)"

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
