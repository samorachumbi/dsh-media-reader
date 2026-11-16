#!/usr/bin/env bash
# Deploy the licence-issuing Worker, stamping it with the artifact this machine actually built.
#
# WHY THIS SCRIPT EXISTS
# The Worker's whole job is to put an sha256 into a legal document. A hash typed by hand into a
# config drifts the first time the bundle is rebuilt, and the failure is silent: buyers receive a
# licence naming a file that no longer matches what they downloaded. So the hash is never typed —
# it is read from `dist/`, cross-checked against its own `.sha256` sidecar, and refused if they
# disagree. Same rule as `tools/issue-licence.py`, for the same reason.
#
#   bash tools/deploy-licence-worker.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
WORKER="$ROOT/worker/licence"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ── the artifact identity, verified rather than assumed ────────────────────────────────────────
TARBALL="$(ls -1 "$DIST"/dsh-media-reader-*.tar.gz 2>/dev/null | sort | tail -1 || true)"
if [ -z "$TARBALL" ]; then
  echo "REFUSING: no built artifact in $DIST — run dist-tools/build-bundle.sh first." >&2
  exit 1
fi

VERSION="$(basename "$TARBALL" | sed -e 's/^dsh-media-reader-//' -e 's/\.tar\.gz$//')"
SHA="$(sha256sum "$TARBALL" | cut -d' ' -f1)"

SIDECAR="$TARBALL.sha256"
if [ -f "$SIDECAR" ]; then
  RECORDED="$(cut -d' ' -f1 "$SIDECAR" | tr -d '\n')"
  if [ "$RECORDED" != "$SHA" ]; then
    echo "REFUSING: $SIDECAR does not match the tarball's bytes." >&2
    echo "  sidecar: ${RECORDED:0:16}…" >&2
    echo "  actual : ${SHA:0:16}…" >&2
    echo "A licence naming an unverified hash is worse than no licence. Rebuild first." >&2
    exit 1
  fi
else
  echo "REFUSING: $SIDECAR is missing, so the published hash cannot be corroborated." >&2
  exit 1
fi

ARTIFACT_URL="https://raw.githubusercontent.com/samorachumbi/dsh-media-reader/main/dist/$(basename "$TARBALL")"

echo "artifact : $(basename "$TARBALL")"
echo "version  : $VERSION"
echo "sha256   : $SHA"
echo "url      : $ARTIFACT_URL"
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "--dry-run: would deploy $WORKER with these values stamped in. Nothing sent."
  exit 0
fi

# ── the secret must exist before the webhook can be served ────────────────────────────────────
# `wrangler secret list` prints names only, never values.
if ! npx --yes wrangler@4.163.0 secret list --config "$WORKER/wrangler.jsonc" 2>/dev/null \
     | grep -q 'PADDLE_WEBHOOK_SECRET'; then
  echo "REFUSING: PADDLE_WEBHOOK_SECRET is not set on this Worker." >&2
  echo "Every request would be rejected, and a webhook that refuses everything looks identical to" >&2
  echo "one that receives nothing. Set it from the Paddle notification-setting's secret_key:" >&2
  echo "  npx wrangler secret put PADDLE_WEBHOOK_SECRET --config worker/licence/wrangler.jsonc" >&2
  exit 1
fi

cd "$WORKER"
npx --yes wrangler@4.163.0 deploy \
  --var "ARTIFACT_VERSION:$VERSION" \
  --var "ARTIFACT_SHA256:$SHA" \
  --var "ARTIFACT_URL:$ARTIFACT_URL" 2>&1 | tail -20
