# Coding plan — `dsh-media-reader` (Video / Image / Voice)

**Date:** 2026-10-30 · **Status:** plan only — **no implementation started** · **Research:** `RESEARCH.md`
**Box:** 2 build-days already scheduled (2026-10-30/31, 5 h/day) · **Honest estimate:** ~15 h ≈ **3 build-days**

> Read `RESEARCH.md` §2 first. The plan leans on four verified facts: DSH has no audio modality; a
> text-only model receives `[image omitted …]` instead of pixels; `llm/stream` cannot rewrite a request,
> so automatic fallback must ride `tools/post-execute`; and a plugin can make its own model call through
> `ctx.llm.stream()`.

---

## 0. Preconditions (do not skip; each is a gate, not a warm-up)

### 0.1 Version control before any code

```bash
cd ~/projects/Video_Image_Voice
git init && git add RESEARCH.md PLAN.md && git commit -m "research + plan baseline (no code)"
git tag -a baseline-research -m "research/plan baseline before implementation"
git switch -c feat/media-reader
```

**Rollback path:** `git switch main` (or `master`) → tree returns to the baseline tag; the plugin is
only mounted by one `cordis.patch.yml` row and one directory, both removed in §5.4.

### 0.2 Pin the contract (documentation task, 20 min)

Write `CONTRACT.md` recording, for DSH **0.1.1-rc.2**:

- `MODEL_MODALITIES = ["text","image"]` — no audio, ever (`dsh-llm-deepseek/lib/index.js:1612`)
- text-only placeholder text (`dsh-llm/lib/index.js:592`)
- `read_image` rejection text (`dsh-tool-fs/lib/index.js:941`)
- attachment admission refusal (`dsh-host-apiproxy/lib/index.js:2755`)
- image budgets: 1 MB / 640 000 px request, 20 MB / 64 Mpx / 8192 px store
- the four seams we use, with their type signatures
- **the limits:** no audio modality, no request-rewrite seam, user attachments on a text-only route are
  refused before we can help

Re-verify by re-reading those lines. If upstream moves, the diff is the deliverable.

### 0.3 Probe A — speech-to-text speed on THIS machine (blocking, ~45 min wall clock)

```bash
python3 -m venv ~/projects/Video_Image_Voice/.venv-stt
.venv-stt/bin/pip install -q faster-whisper==1.2.1
# 60 s clip of real speech, 16 kHz mono
.venv-stt/bin/python probe/rtf.py clip60.wav --model small --compute-type int8 --threads 4
```

Record: wall time, real-time factor (RTF), peak RSS.

| Measured RTF (`small` int8, 4 threads) | Decision |
|---|---|
| ≤ 1.5× | local STT is the default. Continue. |
| 1.5×–3× | local `small` only up to a duration cap (default 5 min); `base` for longer. Document it. |
| > 3× | **stop and ask the operator** — cloud ASR (audio leaves the machine) or scope-cut audio. Never silently degrade. |

Write the measured numbers into `CONTRACT.md`. **A guess is not acceptable here** — this is the T4
machine's binding constraint.

### 0.4 Probe B — nested model call from inside a tool (blocking, ~30 min)

Throwaway plugin, one tool `probe_nested`: builds `GenerateOptions` for
`deepseek-official / deepseek-v4-flash-vision-exp` with one image block, calls
`ctx.llm.stream(options)` inside `execute`, returns the text.

- **Pass** → D3 is implementable as designed.
- **Fail / deadlock / race** → fall back to a config-driven OpenAI-compatible endpoint (the prior art's
  approach), and document that the plugin needs its own vision key.

### 0.5 Probe C — the negative route is real (10 min)

Switch the session to `deepseek-official / deepseek-v4-flash` (text-only, same key, no new credential)
and invoke the built-in `read_image` on any PNG. **Expected and required:** the exact refusal from
`dsh-tool-fs/lib/index.js:941`. Capture the message — it is the before-picture that Phase 2 changes.

**Phase 0 exit gate:** CONTRACT.md written; RTF measured and recorded; nested-call verdict known;
negative route reproduced. If Probe A fails and the operator has not answered `RESEARCH.md` §7.1,
**stop here** and report.

---

## 1. Skeleton, route resolver, `media_probe` (~2 h)

### Files

```
~/projects/Video_Image_Voice/
├── package.json                # name dsh-media-reader, private, type module, exports . → lib/index.js
├── cordis.patch.yml            # - insert: [{ id: media-reader, name: 'dsh-media-reader', config: {...} }]
├── lib/
│   ├── index.js                # plugin apply(): register 4 tools + the post-execute listener
│   ├── route.js                # resolveRoute(exec) → { canSeeImages, provider, model }
│   ├── probe.js                # ffprobe wrapper (serialized, timeout, size caps)
│   ├── exec.js                 # spawn helper: argv arrays only, signal, timeout, arg-cap guard
│   ├── image.js                # decode/downscale/frame-budget helpers
│   ├── stt.js                  # local faster-whisper bridge (Phase 3)
│   ├── video.js                # scdet sampling + fusion (Phase 4)
│   └── describe.js             # vision-route description via ctx.llm.stream (Phase 2)
├── probe/                      # bench scripts (rtf.py), never shipped
├── artifacts/                  # default output root (git-ignored)
└── tests/                      # node:test — starts in Phase 1, not Phase 5
```

### `route.js` — copied logic, not invented

Mirror `assertImageCapableRoute` (`dsh-tool-fs/lib/index.js:925-943`):

```js
const routed = exec.agent?.session.requestHeader()?.config
const provider = routed?.provider ?? exec.agent?.options.provider
const model    = routed?.model    ?? exec.agent?.options.model
const info     = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
const canSeeImages = info.inputModalities?.includes('image') === true
```

### Tool 1 — `media_probe`

| | |
|---|---|
| Parameters | `path` (string, required) |
| Output | structured JSON: kind (image/video/audio), container, duration, dimensions, fps, codecs, audio-track count, subtitle count, byte size |
| Model calls | **zero** |
| Fails on | missing file, unreadable file, unsupported container, `-`-leading basename (option injection), ffprobe absent |

**Acceptance:** one PNG, one MP4, one MP3 return correct metadata; a text file with a `.png` name and a
missing path each return an explicit error. Nothing is inferred.

---

## 2. Image — `media_image` + the automatic `read_image` fallback (~2.5 h)

### Tool 2 — `media_image`

| Parameter | Meaning |
|---|---|
| `path` | image file (PNG/JPEG/WebP/GIF) |
| `question` | optional: what to look for — passed verbatim into the description prompt |

**Route-aware behaviour (D2):**

- `canSeeImages` → `ctx.attachments.saveImage(...)` → return `[{type:'text', text: envelope}, {type:'image', attachment}]`. Envelope names path, dimensions, and whether the harness downscaled.
- else → `describe.js`: one `ctx.llm.stream()` call to the configured vision route with the image block
  and a fixed instruction (*describe factually; quote on-screen text; state uncertainty; never guess*).
  Return text with provenance: `source`, `processor: deepseek-v4-flash-vision-exp`, `latency_ms`.
- no vision route / call fails → **throw** with what is missing. Never a mock, never a guess.

### Automatic fallback (D3)

`tools/post-execute` listener:

```
if (exec.name === 'read_image' && result is an error matching /does not declare image input/)
    → run the same describe path on exec.arguments.file_path
    → return { kind: 'accept', content: [{type:'text', text: description + provenance}] }
```

Guarded: only when `canSeeImages === false` (otherwise the native path already worked), bypassed by a
config flag `autoFallback: true`, and it must never mask a *different* error class.

**Acceptance matrix for this phase**

| # | Route | Input | Required result |
|---|---|---|---|
| I1 | vision | real PNG | image block returned **and** text envelope; no extra model call (prove by latency + log) |
| I2 | text-only (`deepseek-v4-flash`) | same PNG via `media_image` | text description naming visible content, with provenance |
| I3 | text-only | same PNG via **`read_image`** | the refusal is **replaced** by a description — this is the headline proof |
| I4 | either | missing file | explicit error, no description |
| I5 | either | `.png` that is really a JPEG | explicit mismatch error (attachment store's `IMAGE_TYPE_MISMATCH` path) |
| I6 | either | 6000×4000 photo | succeeds within budget; envelope states downscale |
| I7 | text-only, vision route broken | any PNG | explicit failure naming the route — **not** a fabricated description |

**Mutation test for I3:** disable the listener → the refusal must reappear. A guard that cannot fail is
not a guard.

---

## 3. Audio — `media_audio` (~3 h)

### Tool 3 — `media_audio`

| Parameter | Meaning |
|---|---|
| `path` | audio file, or a video whose audio track is wanted |
| `language` | `auto` (default) / `en` / `sw` |
| `model` | `small` (default from the machine profile) / `base` |
| `maxSeconds` | hard duration cap, default 300 on T4 |

**Pipeline:** `ffprobe` (has an audio track? what format?) → `ffmpeg` → 16 kHz mono WAV in a temp dir →
`faster-whisper` with `vad_filter=True` → artifacts `transcript.txt`, `transcript.json` (segments +
timestamps), `transcript.srt` → tool result carries the first N segments, the total duration, the word
count and the artifact paths.

**Guardrails:** one job at a time (`flock` in the artifact dir — 2.4 GB free RAM), hard timeout merged
with `exec.signal`, temp cleanup in `finally`, model cache in the project (not `~`), and a **named
dependency error** if the venv or model is absent.

**Acceptance matrix**

| # | Input | Required result |
|---|---|---|
| A1 | 30 s clear English speech | transcript; ≥ 90 % word agreement on a hand-checked sample; timestamps land on the right words |
| A2 | same, video file | audio track extracted; visuals untouched |
| A3 | 10 s **silence** | empty transcript **and** the sentence "no speech detected in 10.0 s" — not an empty string |
| A4 | music, no words | explicit "speech recognition found no words"; **states** that non-speech audio is out of scope |
| A5 | no audio track (muted video) | explicit "this file has no audio track" |
| A6 | venv / model absent | explicit dependency error naming the missing piece |
| A7 | 20 min file, cap 300 s | processes the first 300 s and **says** it truncated |

---

## 4. Video — `media_video` (~3.5 h)

### Tool 4 — `media_video`

| Parameter | Meaning |
|---|---|
| `path` | video file |
| `question` | optional focus |
| `maxFrames` | 1–6 on T4 (machine profile `video.max_shots`), default 4 |
| `mode` | `digest` (default) / `frames` / `transcript` |

**Pipeline:** `ffprobe` → `scdet` shot boundaries (`threshold` configurable, default 10) → one
representative frame per shot at the midpoint, **scaled to stay inside 640 000 px and 1 MB** → contact
sheet PNG (one grid image) → audio track → `media_audio` → **fuse**:

```
[00:03:12] shot-07.png (12.4 s)
           on screen: <from the vision route, or "(not described — call media_image on this frame)">
           said: "now set the duty rate to twenty five percent"
```

Artifacts: `digest.md`, `timeline.json`, `contact-sheet.png`, `frames/shot-NN.png`.

**Coarse-to-fine (D5):** default returns the digest + contact sheet + transcript text. Individual frames
are described only when `question` is given (then ≤ 3 frames) or when the model asks in a second call.
`mode=frames` returns the shot frames themselves as image blocks **only** on a vision route.

**Acceptance matrix**

| # | Input | Required result |
|---|---|---|
| V1 | 2–3 min screen recording with narration | digest with ≥ 3 timestamped shots and aligned speech; artifact paths returned |
| V2 | question whose answer is **visual** (e.g. "what does the error banner say?") | answered from a frame, frame cited by timestamp |
| V3 | question whose answer is **spoken** | answered from the transcript, timestamp cited |
| V4 | question needing **both** | on-screen + spoken evidence cited together |
| V5 | silent video | shots present; each `said:` line says no audio track / no speech |
| V6 | video with no detectable cuts | falls back to uniform sampling; **says so** |
| V7 | text-only route | digest text still complete; frames described only through the vision route |
| V8 | 20 min video, T4 | obeys the shot cap and the duration cap; states what was skipped |

---

## 5. Acceptance, packaging, rollback (~2 h)

### 5.1 The three-modality gate (the project's "done means")

Each row is a **real DSH tool call on a real file**, run twice: on `deepseek-v4-flash-vision-exp` and on
`deepseek-v4-flash` (text-only). All the per-phase matrices above, plus:

| Modality | Vision route | Text-only route |
|---|---|---|
| Image | pixels returned, no wasted call | description via vision route, provenance shown |
| Audio | transcript | transcript (identical — audio never reaches a model) |
| Video | digest + frames | digest + frame descriptions |

**Negative controls that must fail correctly:** missing file · corrupt file · wrong extension · absent
dependency · absent audio track · silent audio · vision route unreachable · unreadable permission.

### 5.2 Anti-fabrication check

Re-read every description produced during the matrix with the source file open. Any claim not visible in
the file is a defect of the same severity as a crash. The plugin must never be a route to a fabricated
visual approval (`image-read-failure-handoff` still governs).

### 5.3 Install (copy-restore — never `pnpm` inside the profile)

```bash
# 1. copy the plugin into the profile's node_modules
cp -r ~/projects/Video_Image_Voice ~/.dsh/profiles/web/node_modules/dsh-media-reader
# 2. one row in the profile patch
#    - insert: [{ id: media-reader, name: 'dsh-media-reader', config: { artifacts: '~/.../artifacts', maxFrames: 6, whisperModel: 'small' } }]
```

Then **test-boot before touching the real server** — `dsh-test-boot` skill: scratch web instance on a free
port, leave it running for the operator's own eye-check, verify the four tools appear and one call
succeeds. `dsh plugin add` is pnpm-inside-the-profile and re-prints pnpm's own help (re-confirmed today) —
do not use it.

### 5.4 Rollback (written before it is needed)

```bash
rm -rf ~/.dsh/profiles/web/node_modules/dsh-media-reader
# remove the media-reader row from ~/.dsh/profiles/web/cordis.patch.yml
# restart the web server; the profile returns to cost-bubble + planner + domain-watch + app-launcher
```

No host files touched; the STT venv and model cache live entirely inside the project directory;
`git switch master` returns the source tree to `baseline-research`.

### 5.5 Exit gate

`bash ~/projects/deepseek-test/second-brain/scripts/task-exit-gate.sh` and paste the VERDICT block, plus
an explicit list of what was **not** verified.

---

## 6. Estimates against the box

| Phase | Hours | Cumulative |
|---|---|---|
| 0 — git baseline, CONTRACT, probes A/B/C | 2.0 | 2.0 |
| 1 — skeleton, route resolver, `media_probe` | 2.0 | 4.0 |
| 2 — image + automatic fallback | 2.5 | 6.5 |
| 3 — audio (local STT) | 3.0 | 9.5 |
| 4 — video digest | 3.5 | 13.0 |
| 5 — matrix, packaging, exit gate | 2.0 | 15.0 |

**15 h against a 10 h box (2 × 5 h).** Three honest options for the operator:

- **A. Extend** to 3 build-days — everything above, all three modalities proven.
- **B. Cut video** — Phases 0–3 + 5 ≈ 11.5 h, still ~1 day over, but image + audio proven end to end.
- **C. Cut the automatic fallback** (Phase 2's listener) — saves ~45 min, loses the headline claim, not
  recommended.

Recommendation: **A**, because audio and video are the two modalities the priors have not solved
locally, and because `RESEARCH.md` §7.4 says the box was already flagged as a time-box, not a fit.

## 7. Explicitly NOT in scope

- Live microphone capture, streaming, real-time transcription (a different, client-facing product).
- Live web-page reading (`BRIEF.md` phase 1 — separate project).
- YouTube/URL media (`youtube-link-reader` owns that; a later handoff can call `media_audio`).
- Non-speech audio understanding (music, tone, sound events) — needs an audio-native model DSH cannot
  address at all.
- Any second vision/ASR provider key, unless Probe B fails.
- Publishing to npm, a UI bubble, or a settings page — v1 is tools-only, deliberately
  (`how-a-dsh-plugin-surfaces-to-the-user`: tools-only = no client bundle, no shell surface).

## 8. Stop points

1. **End of Phase 0** — if Probe A fails and the operator has not chosen, stop and report; do not build
   on an unmeasured machine.
2. **End of Phase 3** — show the image + audio matrix and the measured RTF; ask before spending the video
   phase on a box that is already over its hours.
3. **End of Phase 5** — if any modality fails, **report the failure and request an extension**; do not
   call the project complete (project card `done means` #6).
