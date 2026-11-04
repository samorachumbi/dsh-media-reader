#!/usr/bin/env bash
# Live capability check: drives real DSH sessions on a scratch instance and asserts the plugin works on
# BOTH a vision route and a text-only route. Never touches a production server.
#
#   DSH_TEST_URL=http://127.0.0.1:3096 ./smoke.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/plugin/probe/smoke.mjs" ] || { echo "FATAL: probe/smoke.mjs missing from the bundle" >&2; exit 1; }
command -v node >/dev/null || { echo "FATAL: node required" >&2; exit 1; }
DEFAULT_MODEL="${DSH_TEXT_MODEL:-deepseek-v4-flash}"
DEFAULT_VISION="${DSH_VISION_MODEL:-deepseek-v4-flash-vision-exp}"
echo "smoke: ${DSH_TEST_URL:-http://127.0.0.1:3096}"
echo "  text-only route:  $DEFAULT_MODEL"
echo "  vision route:     $DEFAULT_VISION"
URL="${DSH_TEST_URL:-http://127.0.0.1:3096}"
# a dead port produces 18 confusing failures; say it plainly instead
if ! node -e "fetch('$URL/api/version').then(r=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "FATAL: nothing is listening at $URL" >&2
  echo "       Boot a harness there first, e.g.  DSH_HOME=<scratch-home> dsh web --port <port>" >&2
  echo "       then:  DSH_TEST_URL=$URL ./smoke.sh" >&2
  exit 1
fi
DSH_TEST_URL="$URL" DSH_TEXT_MODEL="$DEFAULT_MODEL" DSH_VISION_MODEL="$DEFAULT_VISION" node "$HERE/plugin/probe/smoke.mjs"
