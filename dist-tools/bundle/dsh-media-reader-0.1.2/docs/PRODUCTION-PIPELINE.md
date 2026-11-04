# Production pipeline — replica and transformation, with local / assisted / cloud profiles

**Date:** 2026-10-30 · **Status:** design confirmed by operator choices · **Generation adapter:** **Kie only**
**Test source:** Rick Ross MP4 (operator confirms usage rights)

## 1. Operator decisions now fixed

- Use **Kie for every generation call** (music and video).
- Support **replica** and **better/transformative version** of the same source.
- A transformation may change characters (e.g. anime) while preserving shot composition and storyline.
- Execution must be selectable by machine capability: **local**, **assisted**, or **cloud**.
- The Rick Ross file may be used for testing.

One caveat that matters for planning: **Kie generation is remote even in `local` profile.** `local` means
*analysis and feature extraction happen on the laptop*; it does not mean generation runs offline.

## 2. The two production modes

### `replica` — preserve structure and melody

Goal: closest defensible reproduction, not a claim of exact identity.

- Keep shot order, shot timing, composition, storyline, melody and arrangement as reference anchors.
- Use original frames/reference clips and source audio as the main conditioning; analysis tells the adapter
  what to preserve, not what to invent.
- Music: Kie **Upload And Cover Audio**, conservative style change / high preservation, melody retained.
- Video: per-shot reference-to-video or image-to-video with original frames; only regenerate where needed.
- Evaluate against the source: BPM/key/energy/shot timing and a human side-by-side review.

### `transform` — same composition/storyline, new treatment

Examples: anime characters, a new visual style, a different arrangement, or a better version.

- The **shot list, timing, action and storyline are the contract**. Style and character are variables.
- **Characters:** pilot Kie **Wan - Animate Replace** for replacement with an anime reference image; if the
  result drifts, fall back to per-shot replacement and deterministic assembly.
- **Whole-video style:** pilot **Kling 3.0 Omni Transformation** with the source `video_urls` and a prompt
  such as “convert to anime while preserving character actions, shot composition and storyline”.
- **Music:** Kie Suno cover, which explicitly transforms style **while retaining the core melody**. Keep
  measured BPM/key/energy as constraints; style weight and creative deviation are mode controls.
- Evaluate: did composition/action/storyline survive? If not, shorten the shots and replace per shot.

Useful Kie references:
[Upload And Cover Audio](https://docs.kie.ai/suno-api/upload-and-cover-audio),
[Wan - Animate Replace](https://docs.kie.ai/market/wan/2-2-animate-replace),
[Kling 3.0 Omni Transformation](https://docs.kie.ai/cn/market/kling/v3-omni-transformation),
[Kling 4.0 Reference To Video](https://docs.kie.ai/market/kling/v4-reference-to-video),
[Seedance 2](https://docs.kie.ai/market/bytedance/seedance-2).

## 3. Execution profiles

| Profile | Analysis | Heavy options | When to use |
|---|---|---|---|
| **`local`** | ffprobe/ffmpeg, DSP, frames, local Whisper, Basic Pitch on stems | Demucs **off by default on T4**, on for a stronger laptop | Best privacy; slow on this laptop; generation still via Kie |
| **`assisted`** (default) | Local measurements + Kie native audio/video interpretation + DeepSeek vision for frames | Demucs optional; use if measured to fit | Balanced accuracy/cost; recommended default |
| **`cloud`** | Kie native audio/video analysis and interpretation; local work limited to upload/probe | Demucs off | Weak laptop or large files; highest upload/cost exposure |

Profile must be explicit per job, not an implicit downgrade. The result names the profile, provider, model,
analysis time, generation time, and what was skipped.

### Backends by stage

| Stage | `local` | `assisted` | `cloud` |
|---|---|---|---|
| Objective DSP | local | local | local (cheap) or skipped with reason |
| Stems/MIDI | Basic Pitch; Demucs if viable | Basic Pitch; Demucs if measured | optional/native alternative if documented |
| Lyrics | local Whisper on vocal stem | vocal stem + stronger local/native route | native audio model |
| Semantic music analysis | none (report as unmeasured) | Kie native audio model | Kie native audio model |
| Semantic video analysis | DeepSeek vision on sampled frames | Kie native video model | Kie native video model |
| Generation | **Kie** | **Kie** | **Kie** |

A profile change must never silently replace a measured fact with a model guess.

## 4. Pipeline stages

### Stage 1 — evidence pack (works in every profile)

**IMPLEMENTED 2026-10-31** — `node bin/media-evidence.mjs <file>`; contract and measured results in
`EVIDENCE-PACK.md`. Writes `replication/<job>/` with `source.json`, `audio-features.json`, `frames/`,
`lyrics/`, `reference/`, `notes/skipped.json`, `replication.json`, `plan.json`, `REPLICATION.md`. Every
field carries MEASURED / INFERRED / UNVERIFIED. No model call and no generation call. Measured on the test
source: 368.078 s file fully analysed (`truncated: false`) in 4 min 34 s, ~536 MB peak RSS.

Still open inside stage 1: stems and MIDI (Demucs / Basic Pitch are not installed — recorded as skipped,
not faked), and OCR (tesseract absent).

- Full-duration decode, probe, loudness, silence and file hash.
- Local DSP: BPM/beats/onsets, key+confidence, chroma, HPSS, MFCC/timbre, energy and section boundaries.
- Shot replication sheet with start/mid/end frames, OCR, camera/action/lighting/palette/transition fields.
- Lyrics with timestamps and confidence; never call sung Whisper text exact by default.
- `replication.json` and `REPLICATION.md`, with `MEASURED`/`INFERRED`/`UNVERIFIED` on each field.
- Reference assets: source audio, stems if enabled, MIDI, selected keyframes and short reference clips.

### Stage 2 — semantic pass (profile-dependent)

- `local`: mark genre/vibe/instrument interpretation as unmeasured unless the source itself documents it.
- `assisted`/`cloud`: ask the native audio/video model for genre, vibe, instrument hypotheses, vocal
  delivery, section roles and shot function **conditioned on measured fields**. Record model and latency.

### Stage 3 — mode plan

`replica` and `transform` produce different job plans from the same evidence pack:

- `preserve`: shot order/timing/composition/storyline/melody;
- `change`: character style, visual treatment, arrangement, or specific improvement;
- `constraints`: measured BPM/key/energy, exact overlay text, reference assets, negative instructions;
- `evaluation`: the measurements that must not regress.

### Stage 4 — Kie generation (one pilot, not a batch)

**Music pilot:** Upload And Cover Audio with the source `upload_url` (≤8 minutes per Kie docs), measured
style prompt, and mode-appropriate style weight / creative deviation. Compare melody and structure.

**Video pilot:** one representative shot or short segment, not a 6-minute one-shot.

- `replica`: Kling 4.0 Reference To Video / Seedance 2 with original reference frames/clips.
- `transform`: Wan Animate Replace for anime character replacement, or Kling 3.0 Omni Transformation for
  whole-video style conversion. Keep action/composition/storyline in the prompt and constraints.

Record task ID, model, inputs, callback state, output URLs, cost/credits and artifact paths. Archive output
locally; provider URLs expire.

### Stage 5 — deterministic assembly and evaluation

- Assemble short generated shots with ffmpeg/Remotion; exact title cards and typography stay in this layer.
- Keep original or generated soundtrack separate; do not ask a video model to typeset critical text.
- `replica`: compare against source measurements and shot timing; flag drift rather than claim identity.
- `transform`: check composition/action/storyline survival and anime/style consistency per shot.
- Only after the pilot is accepted does a batch run proceed, with a fixed budget and per-shot fallbacks.

## 5. Artifact contract

```
replication/<job>/
  source.json
  audio-features.json
  stems/                 # optional by profile/probe
  notes/
  lyrics/
  frames/
  reference/
  replication.json
  REPLICATION.md
  plan.json              # mode, profile, preserve/change/constraints/evaluation
  kie-jobs.jsonl         # every submitted task, input, callback, cost, output
  output/                # generated shots/audio + assembled master
  REVIEW.md              # side-by-side findings and remaining drift
```

Every artifact records profile, mode, provider/model, rights confirmation, and provenance.

## 6. Implementation order

1. **Evidence pack v1** — local measurements + shot sheet + artifact contract. No generation call.
2. **Kie adapter skeleton** — credential check, upload helper, task create/poll/callback, ledger, download
   and archive. The credential **exists**: the variable is `KIE_AI_API_KEY` (not `KIE_API_KEY`) and it is
   held in `~/projects/Website_Builder/.env`, the key used for the Itikia build. It is not exported into a
   shell environment, so the adapter must resolve it from that file (or `--env-file`) and fail loudly only
   when both are absent.
3. **Music pilot** — one cover, compare melody/structure against source.
4. **Video pilot** — one replica shot and one anime-transformation shot, evaluate separately.
5. **Profiles** — wire `local`/`assisted`/`cloud` through config, then measure Demucs on this machine to
   decide whether it belongs in `assisted` by default or only on a stronger laptop.

## 7. Acceptance gates

- No field claims cadence/instruments/camera facts without evidence.
- Full-duration analysis; no silent cap.
- Replica and transformation have different job plans and different checks.
- One pilot per medium is reviewed before any batch; composition/storyline survival is measured, not assumed.
- Local outputs archived; provider task IDs/costs recorded; no provider URL is the only copy.
- `local` never implies offline generation; `assisted`/`cloud` never silently means “send everything”.
- Rights and performer-identity permission are recorded on the job.

## 8. Remaining unknowns

- Exact Kie model choice after the pilot; model names are candidates, not commitments.
- Demucs runtime/RSS on this T4 machine (decides whether it belongs in assisted by default).
- Which native Kie audio/video analysis endpoint to use for semantic interpretation.
- Cost per representative cover and per representative shot; measured before batches.
- Fidelity ceiling for exact performer identity and lip-sync; accept approximation where it fails.
