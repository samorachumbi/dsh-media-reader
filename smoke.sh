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
DSH_TEST_URL="${DSH_TEST_URL:-http://127.0.0.1:3096}" node "$HERE/plugin/probe/smoke.mjs"
