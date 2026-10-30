# Audit — findings, corrections, and the better path

**Date:** 2026-10-30 · **Mode:** investigation / design audit · **Decision:** **Option A accepted — three build-days**
**Status:** audit and revised pathway only; **no plugin code written**

## Object pinned

- Previous deliverables: git `a438faba50c75f463362f0408a35647a587019c4` (`RESEARCH.md`, `CONTRACT.md`, `PLAN.md`).
- Harness: DSH `0.1.1-rc.2`, `@deepseek-ai/dsh-tools` `0.1.1-rc.2`; paths below are relative to
  `/home/samora/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`.
- Prior art: npm registry metadata and `dsh-video-lens-0.3.2.tgz`, fetched 2026-10-30.
- STT: `faster-whisper` PyPI metadata and official README, fetched 2026-10-30.
- Empirical media probes: local `ffmpeg`/`ffprobe` 6.1.1, synthetic files in `/tmp/media-probe`, 2026-10-30.

## Questions this audit answered

1. Are the five headline findings true?
2. Can the proposed `read_image` fallback actually return a successful description?
3. Is a nested model call the best description mechanism, or is there a better route?
4. Is the tool surface and file handling minimal and safe?
5. Does the three-day plan measure the things most likely to fail?

## Verdict on the previous findings

| Previous claim | Audit verdict |
|---|---|
| DSH has no audio modality | **Confirmed.** `MODEL_MODALITIES = ["text","image"]`, `dsh-llm-deepseek/lib/index.js:1612`. |
| Text-only routes receive `[image omitted …]` | **Confirmed.** `dsh-llm/lib/index.js:592-594`, projection at `:1585`. |
| Four image gates key off `inputModalities` | **Confirmed.** Minor doc bug: the heading said “three” while the table listed four. |
| `llm/stream` cannot rewrite a request | **Confirmed.** `next` closes over the original options, `dsh-llm/lib/index.js:1640`. |
| A plugin can make an auxiliary model call | **Confirmed as precedent**, `dsh-session-title-llm/lib/index.js:195-228`; **inside a tool remains unprobed**. |
| No second API key is needed | **Qualified.** True only while a vision route is configured in DSH and the nested call works. Image bytes still go to that vision provider; that is data egress, not a free/local operation. |
| `tools/post-execute` can power the automatic fallback | **Corrected — not as a successful result.** See F1. |
| Video should always be described by an auxiliary vision call | **Improved.** On a vision route the current model should receive the frames directly; no auxiliary call. See F2. |
| Local `small` Whisper is the right default | **Unconfirmed.** Measure `base` **and** `small`; choose from measured speed/RAM/accuracy. See F4. |

## Findings

### F1 — Blocker in the old plan: post-execute cannot turn a failed `read_image` into a success

Evidence:

- Replacing `value` on a failed result is explicitly forbidden:
  `tools/post-execute cannot replace the value of a failed result` (`dsh-tools/lib/index.js:3380-3382`).
- Replacing `content` spreads the original result, preserving `isError: true` and `error`
  (`dsh-tools/lib/index.js:3390-3394`). The model would receive **an error whose text is a description**, not a successful read.
- Moving one seam earlier does not solve it: a synthetic successful result from `tools/execute` is normalized through the **owning tool's** output schema and renderer (`dsh-tools/lib/index.js:3436-3451`). For `read_image`, that means producing its declared `{path, image}` value, not arbitrary text.
- Shadowing `read_image` with our own registration is not a clean alternative: duplicate names fail within a layer (`dsh-tools/lib/index.js:2524`, registration at `:2762-2770`), and cross-layer shadowing would be load-order-dependent and hostile to future harness changes.

**Better path:** keep `read_image` native on vision routes. On text-only routes, use `tools/pre-execute` to **deny with a corrective redirect**:

> `This model cannot consume image blocks. Call media_image with the same file_path; it returns a text description with provenance.`

A deny is materialized as `Error: <reason>` (`dsh-tools/lib/index.js:3109-3125`), so the model can act on it. This is honest, cheap, uses a documented decision type, and does not hide the original failure class. The actual description happens in `media_image`, not inside an interceptor.

### F2 — Major improvement: make **all visual presentation** route-aware, not just `media_image`

The old plan still paid for auxiliary vision descriptions during ordinary video digests. Better:

- **Vision route:** extraction returns the contact sheet (and selected frames on demand) as real image blocks plus transcript/timeline text. The **current** model interprets the pixels on its next turn. Zero auxiliary model calls, and better reasoning because the user's actual model sees the evidence.
- **Text-only route:** the same artifacts go to the configured vision route through `ctx.llm.stream`; the tool returns text only, with provenance.
- **Audio:** identical on every route — timestamped text, no model call in the plugin.

This yields one simple rule:

> **Ingest once. Present according to the route. Never describe pixels the current model can already see.**

### F3 — Major safety improvement: resolve every input through `ctx.fs`, not raw paths

Use the same pattern as `read_image`: `ctx.fs.resolve` → `stat` → `readBytes` for images
(`dsh-tool-fs/lib/index.js:273-285`, `:1037-1045`). For `ffmpeg`, obtain the canonical OS path through
`ctx.fs.processPath(target)` (`dsh-fs/lib/types/index.d.ts:88-97`; local implementation
`dsh-fs-local/lib/index.js:713-715`).

Benefits: relative paths resolve against the session workspace; missing/non-regular files fail through the normal FS taxonomy; and subprocess arguments are absolute canonical paths, so a model-supplied basename beginning with `-` cannot become an ffmpeg option. Raw `node:fs` reads of arbitrary model-supplied paths are rejected as a design choice.

### F4 — The STT choice is still unmeasured; the official benchmark says not to assume

The official `faster-whisper` README reports, for **13 minutes** of audio with the **small** model on an **i7-12700K, 8 threads**: int8 beam 5 took **1m42s** and used **1477 MB RAM**. That is a different, much faster CPU than this i5-8265U with single-channel RAM, and it is not a prediction for this machine.

On this machine only **~2.4 GB** was available with Chrome running. Therefore:

- Probe **both `base` and `small`**, int8, on the same real 60-second speech clip.
- Record wall time, RTF, peak RSS, and a hand-checked word-accuracy sample.
- Choose the default from those measurements; do not pre-commit to `small`.
- Keep one media job at a time and make the duration cap part of the result, not a silent truncation.

Source: [faster-whisper README — Small model on CPU](https://github.com/SYSTRAN/faster-whisper#small-model-on-cpu), fetched 2026-10-30.

### F5 — The ffmpeg approach is viable, including the empty-scene edge case

Empirical, local:

- `scdet=threshold=10,metadata=print` detected the two deliberate cuts in a 6-second three-shot video at **2s** and **4s**, scores **27.693** and **20.611**.
- On a static synthetic video, scene-based extraction produced **zero frames**. The uniform-sampling fallback is therefore mandatory, not optional.
- A tiled contact sheet was produced successfully (**960×180**, **62 KB**), within the image budgets.
- Audio extraction to **16 kHz mono PCM WAV** and a silent-audio fixture both succeeded.

This supports building our own thin ingestion layer rather than adopting an unvetted plugin for it.

### F6 — “No second key” must not become “no privacy cost”

When a text-only route needs a description, image/frame bytes are sent to the configured vision provider. That is the intended fallback, but it must be explicit in the README and controlled by config (`visionFallback: 'configured-route' | 'off'`). With `off`, the tool must say that a text-only route cannot read the image without a vision fallback; it must not quietly send anything.

Local STT remains the privacy-preserving default for audio. Cloud ASR is a separate decision and is not silently enabled by slow local measurements.

### F7 — The third build-day needs a date

The previous planner schedule gives media 2026-10-30/31 and trading 2026-11-01/02. Option A adds a third media day but does not itself resolve that collision. This audit does **not** move trading. Choose the third media day explicitly before scheduling implementation tasks.

## Alternatives considered and rejected

| Alternative | Why not the default |
|---|---|
| `post-execute` description replacement | Leaves `isError: true`; cannot replace a failed value (F1). |
| `tools/execute` synthetic success | Normalized through the owning tool's schema/renderer (F1). |
| Shadow `read_image` | Duplicate/load-order fragile; changes a first-party contract. |
| Reroute whole requests with `agent/request` | Payload has no messages; user attachments are refused earlier; switching models mid-session is intrusive. |
| Direct OpenAI-compatible HTTP as the primary describer | Duplicates credentials/retry/attachment handling. Keep only as the documented fallback if the nested-call probe fails. |
| Cloud audio/video-native model | Could cover non-speech audio, but adds keys, cost and media egress; optional later, not v1. |
| Local vision model | Not viable on this T4 machine's available RAM. |
| Adopt `dsh-video-lens` | Useful reference, but different credential/model design, text-only output, and still unvetted. Build the thin layer; do not install it. |

## Revised architecture

```
model-supplied path
        │
        ▼
ctx.fs.resolve → stat → processPath/readBytes
        │
        ▼
media_probe ──► kind, duration, tracks, dimensions
        │
        ├─ image ───────────────────────────────┐
        ├─ audio ─► ffmpeg ─► local Whisper ────┤
        └─ video ─► scdet/uniform frames + audio┤
                                                ▼
                                   durable artifacts + bounded text
                                                │
                              current route declares image?
                              ┌─────────────────┴─────────────────┐
                             YES                                NO
                              │                                 │
                  attach contact sheet/frames          configured vision route
                  + transcript/timeline text           via ctx.llm.stream
                  (no auxiliary model call)            → text-only result
                              └─────────────────┬─────────────────┘
                                                ▼
                         provenance: source, processor, timing, skipped content
```

## Decision

Proceed with **Option A**, using the revised `PLAN.md` (v2). The architecture is sound; the old automatic-fallback mechanism was not. The revised path is simpler, more honest, and cheaper on vision routes.

## Not verified

- No nested `ctx.llm.stream()` call has been executed from inside a tool.
- No Whisper model has been downloaded or benchmarked on this machine; no transcription accuracy is claimed.
- No real DSH tool call, model-route switch, plugin boot, or acceptance-matrix row has run.
- Prior-art packages were metadata/source scanned only; `/repo-vetting` was not completed and nothing was installed.
- No real user video/audio sample was processed; ffmpeg probes used synthetic files.
- The third build-day's date and the four product-scope defaults still need operator confirmation.

**Trail:** revised `PLAN.md` v2, corrected `CONTRACT.md`, and this audit are committed in the project repo; vault project card and journal updated.
