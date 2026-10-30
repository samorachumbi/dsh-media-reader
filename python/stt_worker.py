#!/usr/bin/env python3
"""Local speech-to-text worker for dsh-media-reader.

One JSON document on stdout; diagnostics on stderr. The bridge must never treat
an empty or unparseable output as a successful empty transcript.
"""
import argparse
import json
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel

        os.makedirs(args.cache_dir, exist_ok=True)
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type=args.compute_type,
            cpu_threads=max(1, args.threads),
            download_root=args.cache_dir,
        )
        language = None if args.language == "auto" else args.language
        segments_iter, info = model.transcribe(
            args.audio,
            language=language,
            beam_size=max(1, args.beam_size),
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            word_timestamps=False,
            condition_on_previous_text=False,
        )
        segments = []
        for segment in segments_iter:
            text = (segment.text or "").strip()
            if not text:
                continue
            segments.append(
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": text,
                }
            )
        text = " ".join(segment["text"] for segment in segments).strip()
        payload = {
            "ok": True,
            "model": args.model,
            "computeType": args.compute_type,
            "language": getattr(info, "language", None),
            "languageProbability": getattr(info, "language_probability", None),
            "duration": getattr(info, "duration", None),
            "segments": segments,
            "text": text,
        }
        print("MEDIA_READER_RESULT " + json.dumps(payload, ensure_ascii=False))
        return 0
    except ModuleNotFoundError as error:
        print(json.dumps({
            "ok": False,
            "code": "STT_DEPENDENCY_MISSING",
            "error": f"missing Python module: {error.name}",
        }), file=sys.stderr)
        return 2
    except Exception as error:  # provider/runtime failure: report, never fake text
        print(json.dumps({
            "ok": False,
            "code": "STT_FAILED",
            "error": f"{type(error).__name__}: {error}",
        }), file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
