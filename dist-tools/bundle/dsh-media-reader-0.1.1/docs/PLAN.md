# Coding pathway v2 — `dsh-media-reader` (Video / Image / Voice)

**Date:** 2026-10-30 · **Status:** plan only — **no implementation started**
**Decision:** **Option A — three build-days, ~15 hours** · **Audit:** `AUDIT.md`
**Third-day date:** TBD — 2026-11-01/02 is currently allocated to trading; do not collide with it silently.

> v2 changes two load-bearing decisions from v1: the automatic `read_image` fallback becomes a
> **pre-execute redirect** (post-execute cannot turn a failure into a success), and **video presentation
> becomes route-aware** just like images. Read `AUDIT.md` F1/F2 before implementing anything.

---

## 1. Product contract

Any model on this harness can ask about a local image, audio recording, or video and receive an answer
grounded in that file. On a vision-capable route the model receives real pixels; on a text-only route it
receives text produced by the configured vision route. Audio is always transcribed locally to text.
Every result carries source, processor, timing, and skipped content. Missing capabilities raise; nothing
is mocked.

### Defaults for the still-open scope questions

These are v1 defaults, not silent expansions:

- **Files only:** local image/audio/video paths; no URLs or YouTube.
- **Recordings only:** no microphone, streaming, or real-time transcription.
- **Private enabler:** tools-only plugin, no client UI, no npm publication.
- **Audio stays local:** cloud ASR requires a fresh operator decision if local STT fails its measurement.
- **Vision fallback:** uses the configured DeepSeek vision route; a config switch can disable that egress.

## 2. Architecture (the better path)

```
path → ctx.fs.resolve/stat → processPath/readBytes → probe
                                      │
              ┌───────────────────────┼────────────────────────┐
              ▼                       ▼                        ▼
            image                   audio                     video
              │                       │                        │
              │                ffmpeg → 16 kHz mono       scdet + uniform fallback
              │                       │                        ├─ frames + contact sheet
              │                  local Whisper                 └─ audio → local Whisper
              │                       │                        │
              └───────────────────────┴────────────────────────┘
                                      │
                    current route resolved with resolveModelInfo
                                      │
                    ┌─────────────────┴──────────────────┐
                 declares image                       text-only
                    │                                    │
          attach image blocks + text          configured vision route via
          (no auxiliary model call)           ctx.llm.stream → text only
                    └─────────────────┬──────────────────┘
                                      ▼
                    bounded result + artifact paths + provenance
```

Services used: `tools`, `llm`, `attachments`, `fs`, `subprocess`. No raw model-supplied filesystem reads,
no second credentials by default, no network outside the configured model route.

## 3. Repository and configuration

```
lib/
  index.js        # register four tools + one pre-execute redirect
  route.js        # current route + configured vision route
  fs.js           # resolve/stat/processPath/readBytes helpers
  exec.js         # subprocess argv, timeout, cancellation, cleanup
  probe.js        # ffprobe metadata
  describe.js     # auxiliary vision call via ctx.llm.stream + BlockAssembler
  image.js        # image admission and route-aware presentation
  stt.js          # local faster-whisper worker bridge
  video.js        # scene detection, uniform fallback, frames, contact sheet, fusion
  redirect.js     # read_image → media_image guidance on text-only routes
probe/            # measurement scripts and fixtures, not shipped
tests/            # node:test from the first implementation task
artifacts/        # generated transcripts/frames/digests, git-ignored
```

Config (all have safe defaults):

| Key | Default | Meaning |
|---|---|---|
| `artifactsDir` | project `artifacts/` | durable outputs |
| `visionProvider` / `visionModel` | `deepseek-official` / `deepseek-v4-flash-vision-exp` | auxiliary description route |
| `visionFallback` | `configured-route` | `off` disables image egress and fails explicitly on text-only routes |
| `autoRedirect` | `true` | redirect `read_image` on text-only routes |
| `whisperModel` | chosen by Probe A | `base` or `small`, never assumed |
| `whisperThreads` | `4` | measured against RAM/CPU pressure |
| `maxAudioSeconds` | `300` | truncation must be stated |
| `maxFrames` | `4` (hard cap `6` on T4) | visual budget |
| `maxVideoSeconds` | `600` | video processing cap |
| `ffmpegThreads` | `2` | leave CPU for the harness/browser |

---

## DAY 1 — measurements, walking skeleton, image path (~5 h)

### 1.1 Baseline and fixtures (0.75 h)

- Branch `feat/media-reader` from the audited commit.
- Record the audited contract corrections in `CONTRACT.md` (already done in v2 docs).
- Prepare fixtures: small PNG, mislabeled image, static video, three-shot video, narrated clip, silence,
  no-audio video. Synthetic ffmpeg fixtures are acceptable for pipeline tests; acceptance also needs one
  real speech sample and one real screen recording.

### 1.2 Blocking probes (1.25 h, run downloads/benchmarks in the background)

**Probe A — STT choice.** Install `faster-whisper==1.2.1` in the project venv. Run the same real 60-second
speech clip through **`base` and `small`**, int8, fixed thread count. Record wall time, RTF, peak RSS and a
hand-checked accuracy sample. Select the default from the table below, and write the actual numbers into
the project notes.

| Result | Decision |
|---|---|
| `small` fits RAM and RTF ≤ 1.5× | default `small` |
| `small` works but RTF 1.5–3× | default `small` only within a shorter duration cap; document |
| `small` too slow/heavy, `base` acceptable | default `base`; state the accuracy trade-off |
| neither acceptable | **stop**; local audio is not viable on this machine. Ask before any cloud ASR |

**Probe B — nested model call.** A scratch tool makes one `ctx.llm.stream()` call with a real image block
to the configured vision route from inside `execute`. Required: a valid text response, no deadlock, clean
cancellation. If it fails, **stop and re-plan the describer**; direct HTTP is a fallback with new config
and credential work, not a drop-in freebie.

**Probe C — before picture.** On `deepseek-v4-flash`, invoke built-in `read_image`; capture the exact
refusal. This is the negative control that Day 1's redirect changes.

### 1.3 Skeleton + `media_probe` (1.25 h)

Implement plugin registration, config, FS resolution, subprocess wrapper, structured errors, and
`media_probe(path)`. Unit tests begin here: missing file, directory instead of file, relative path,
unsupported input, ffprobe failure. No model calls.

### 1.4 `media_image` + redirect (1.75 h)

`media_image(path, question?)`:

1. Resolve through `ctx.fs`; validate regular file and supported media type.
2. Read bytes with the attachment byte cap; `saveImage` performs real format/dimension validation.
3. Current route declares image → return text envelope + image block. **No auxiliary call.**
4. Otherwise, if `visionFallback=configured-route` → describe through the vision route with a fixed
   anti-fabrication prompt; return text with provenance and latency.
5. Otherwise/failure → explicit error naming the missing capability.

Register the `tools/pre-execute` redirect for `read_image` on text-only routes:

> `This model cannot consume image blocks. Call media_image with the same file_path; it returns a text description with provenance.`

### Day 1 acceptance

| # | Route / input | Required result |
|---|---|---|
| I1 | vision route, real PNG | image block + envelope; logs show no auxiliary call |
| I2 | text-only, same PNG via `media_image` | factual description + processor/latency/source |
| I3 | text-only via `read_image` | error redirects to `media_image`; follow-up call succeeds |
| I4 | missing file | explicit FS error, no description |
| I5 | JPEG named `.png` | attachment mismatch error, no inference |
| I6 | oversized image | succeeds within documented limits or names the exact limit |
| I7 | `visionFallback=off`, text-only | explicit refusal; no network call |
| I8 | redirect disabled | original `read_image` refusal returns (mutation test) |

**Day 1 stop gate:** image path passes both routes; Probe A numbers recorded; Probe B verdict known.
Do not start audio on an unmeasured STT choice.

---

## DAY 2 — local audio and video ingestion (~5 h)

### 2.1 `media_audio` (2.5 h)

Parameters: `path`, `language=auto|en|sw`, `model=<measured default>`, `maxSeconds=300`.

Pipeline: FS/probe validation → reject absent audio track → extract at most `maxSeconds` to 16 kHz mono WAV
→ local faster-whisper with Silero VAD → write `transcript.txt`, `transcript.json`, `transcript.srt` →
return bounded segments plus artifact paths, duration, detected language, processor, RTF, and truncation.

Guardrails: one media job at a time; merged cancellation/timeout; temporary cleanup in `finally`; model
cache inside the project; explicit dependency errors; no audio bytes sent to a model.

| # | Input | Required result |
|---|---|---|
| A1 | clear speech | accurate transcript, timestamps checked against the clip |
| A2 | video with speech | audio track transcribed; no visual claims |
| A3 | silence | “no speech detected” with duration, not an empty success |
| A4 | music only | no words + non-speech limitation stated |
| A5 | no audio track | explicit “no audio track” |
| A6 | missing venv/model | dependency error naming the missing piece |
| A7 | input longer than cap | only capped portion processed; truncation stated |

### 2.2 Video ingestion (2.5 h)

Implement ffprobe metadata, `scdet` parsing, uniform midpoint fallback when no cuts are detected, one
representative frame per selected shot, frame scaling inside the 1 MiB / 640 000 px request budget,
contact-sheet generation, and reuse of `media_audio`. Write `frames/shot-NN.png`, `contact-sheet.png`,
`timeline.json`, and transcript artifacts.

Unit-test the `scdet` parser against captured output and prove the fallback with a static-video fixture.
Enforce frame, duration, subprocess and concurrency caps.

**Day 2 stop gate:** audio matrix passes; a three-shot sample yields timestamped frames + contact sheet +
transcript; a static sample yields uniformly sampled frames and says why. Presentation to the model is
Day 3, but the artifacts must already be real and inspectable.

---

## DAY 3 — route-aware video, full acceptance, packaging (~5 h)

### 3.1 `media_video` presentation (2 h)

Parameters: `path`, `question?`, `maxFrames=4`, `mode=digest|frames|transcript`.

- `transcript`: return the audio result only; no frame work.
- Vision route, `digest`/`frames`: attach the contact sheet (and selected frames for `frames`) as image
  blocks, plus timestamp/shot metadata and transcript text. The current model answers `question` from
  those pixels; **no auxiliary vision call**.
- Text-only route, `digest`: send the contact sheet to the configured vision route for one coarse visual
  digest; use at most three individual frames when `question` requires detail. Fuse visual text and
  transcript into `digest.md`; return bounded text with provenance.
- Text-only route, `frames`: reject clearly — raw frames cannot help this route; ask for `digest` instead.

`digest.md` rows carry timestamp, frame path, visual evidence (or “attached for the current model”), and
speech evidence. On-screen text is marked as untrusted data, never as instructions.

### 3.2 Full acceptance + anti-fabrication review (1.5 h)

Run every row on real files, on **both** `deepseek-v4-flash-vision-exp` and `deepseek-v4-flash`.

| Modality | Vision route | Text-only route |
|---|---|---|
| Image | pixels attached; no auxiliary call | description with provenance |
| Audio | local transcript | identical local transcript |
| Video | contact sheet/frames + transcript; no auxiliary call | visual digest + transcript; no image blocks |

Negative controls: missing/corrupt/mislabeled file, absent dependency, absent audio, silence, music,
static video, over-cap duration, `visionFallback=off`, unreachable vision route, redirect disabled.

Open each source beside the model's answer and check every material claim. A fabricated visual or spoken
claim is a release blocker. This review does not replace `image-read-failure-handoff` for any image the
agent itself could not read.

### 3.3 Package, document, test-boot, exit gate (1.5 h)

- README: four tools, config, privacy/egress, resource limits, known gaps, artifacts, rollback.
- Copy-restore into the profile's `node_modules`; add one `cordis.patch.yml` row. Never `dsh plugin add`.
- `dsh-test-boot`: scratch web instance on a free port, left running for the operator; confirm tool
  registration and at least one real call per modality before restarting the real server.
- Rollback: remove the copied directory and patch row, restart; source returns to the baseline tag. STT
  venv/model/artifacts remain inside the project and can be deleted independently.
- Run `/task-exit-gate`, paste VERDICT, and list every unverified item.

**Day 3 stop gate:** if any modality fails its real acceptance row, report the failure and request more
time. Do not call the project complete.

---

## 4. Time and contingency

| Day | Work | Hours |
|---|---|---|
| 1 | probes, skeleton/probe tool, image + redirect | 5 |
| 2 | local audio, video ingestion | 5 |
| 3 | route-aware video, acceptance, packaging | 5 |
| **Total** | | **15** |

- **Probe B failure:** stop and re-estimate the describer; do not silently absorb a new credential/HTTP
  subsystem into the same box.
- **Probe A failure:** stop for an audio-privacy decision; image and video-frames work may continue only
  if the operator explicitly re-scopes.
- **Video overrun:** preserve honest partial delivery (image + audio proven; video ingestion demonstrated)
  and ask for time. Never substitute a mocked digest.

## 5. Explicit non-goals for v1

Live microphone or streaming · URLs/YouTube · live web reading · non-speech audio understanding · local
VLM · cloud audio/video-native models · automatic whole-request model rerouting · shadowing built-in tools
· a client bubble/settings UI · npm publication.

## 6. What must be true at the end

1. Image, audio and video each pass a real DSH invocation on real files, on both route types.
2. Vision routes receive pixels without paying for redundant descriptions; text-only routes receive real
   derived text with provenance.
3. Every failure is explicit; negative controls and mutation tests fail correctly.
4. Local audio stays local; visual fallback egress is configurable and documented.
5. Install, rollback, privacy, limitations and measured STT numbers are documented; the exit gate runs.
