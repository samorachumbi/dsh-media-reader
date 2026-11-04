#!/usr/bin/env bash
# Is the published product linked to the storefront that sells it?
#
# The rule (operator, 2026-11-04, MANDATORY): once the storefront is hosted and operational, the GitHub
# repository MUST link to it, so a client who finds the repo can find the way to buy. Nobody will remember
# this at the moment it becomes true — deployment day is exactly when attention is on the deploy — so it is a
# check, not a note.
#
#   store/DEPLOYED-URL   one line: the live storefront URL. Its presence is what declares "hosted".
#
# Exit codes:
#   0  the storefront is not live yet, OR it is live and the repo links to it
#   1  the storefront is live and the repository does NOT link to it  -> the obligation is unmet
#   2  bad state (an unreadable URL line, or the repo README is missing)
#
# The pre-compact audit calls this, so forgetting to run it is not possible at wrap-up.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL_FILE="$REPO/store/DEPLOYED-URL"
README="$REPO/README.md"

if [ ! -f "$URL_FILE" ]; then
  echo "storefront-not-live: no $URL_FILE, so nothing is hosted yet — link obligation not yet triggered"
  exit 0
fi

URL="$(head -1 "$URL_FILE" | tr -d '[:space:]')"
case "$URL" in
  https://*) : ;;
  *) echo "bad-url: $URL_FILE does not start with https:// — it reads '$URL'" >&2; exit 2 ;;
esac

[ -f "$README" ] || { echo "no-readme: $REPO/README.md is missing" >&2; exit 2; }

# every place a client might look before buying
MISSING=""
for target in "$README" "$REPO/store/README.md" "$REPO/package.json"; do
  [ -f "$target" ] || continue
  grep -qF "$URL" "$target" || MISSING="$MISSING ${target#$REPO/}"
done

if [ -n "$MISSING" ]; then
  echo "unlinked: the storefront is live at $URL but these files do not mention it:$MISSING" >&2
  echo "          add the link to README.md (a client reads that first), then re-run." >&2
  exit 1
fi

echo "linked: $URL appears in README.md, store/README.md and package.json"
exit 0
