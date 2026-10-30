#!/usr/bin/env bash
# Probe A — measure the local Whisper models on THIS machine.
#
# It records wall time and peak RSS for base and small on the same real clip.
# Do not assume `small` fits: the T4 profile has ~2.4 GB available with Chrome.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${DSH_MEDIA_STT_PYTHON:-$ROOT/.venv-stt/bin/python}"
AUDIO="${1:-$ROOT/fixtures/speech16k.wav}"
MODELS="${2:-base small}"

[ -x "$PY" ] || { echo "missing interpreter: $PY" >&2; exit 1; }
[ -f "$AUDIO" ] || { echo "missing audio fixture: $AUDIO" >&2; exit 1; }
command -v /usr/bin/time >/dev/null || { echo "/usr/bin/time not found" >&2; exit 1; }

mkdir -p "$ROOT/models"
for model in $MODELS; do
  echo "=== model=$model threads=4 ==="
  /usr/bin/time -f "elapsed_s=%e maxrss_kb=%M" \
    "$PY" "$ROOT/python/stt_worker.py" \
      --audio "$AUDIO" \
      --model "$model" \
      --compute-type int8 \
      --threads 4 \
      --language en \
      --beam-size 1 \
      --cache-dir "$ROOT/models" \
    > "$ROOT/probe/out-$model.json" 2> "$ROOT/probe/err-$model.txt"
  status=$?
  tail -1 "$ROOT/probe/err-$model.txt"
  if [ "$status" -eq 0 ]; then
    "$PY" - "$ROOT/probe/out-$model.json" <<'PY'
import json,sys
text=open(sys.argv[1], encoding="utf-8").read()
lines=[line for line in text.splitlines() if "MEDIA_READER_RESULT " in line]
if not lines:
    raise SystemExit("no MEDIA_READER_RESULT line in worker output")
d=json.loads(lines[-1].split("MEDIA_READER_RESULT ",1)[1])
print("segments=%d text_len=%d language=%s" % (len(d.get("segments",[])), len(d.get("text","")), d.get("language")))
print("text:", d.get("text","")[:400])
PY
  else
    echo "model=$model FAILED (exit $status)" >&2
    tail -5 "$ROOT/probe/err-$model.txt" >&2
  fi
done
