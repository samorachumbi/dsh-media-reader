# Evidence pack v1 — measure before you generate

**Status:** built and measured on this machine · **Date:** 2026-10-31 · **Generation calls:** none

This is stage 1 of `PRODUCTION-PIPELINE.md`. It reads a media file and writes a directory of
measurements — tempo, key, cadence, energy, timbre, regions, shots, frames, lyrics confidence, loudness,
hashes — where **every field carries its own evidence tag**, so nothing downstream can mistake a guess
for a measurement.

```
node bin/media-evidence.mjs "source.mp4" --mode replica --profile local
```

It needs no DSH server, no network and no API key, which is exactly what makes it testable before any
restart.

**In a chat session** it is also a tool — `media_evidence` — so the same measurement can be requested
without a terminal:

```
media_evidence(path="…/video.mp4", mode="replica", shots=20, lyrics=true)
```

The tool returns the claims grouped by evidence strength (MEASURED / INFERRED / NOT CLAIMED) and the paths
to the full pack. It is deliberately slow (about 1–4 min for a full-length music video) and is not
concurrency-safe: one measurement at a time on this machine.

## Why it exists

The Rick Ross test file proved the gap concretely: the plugin's `media_audio` capped transcription at
300 s of a 368.08 s file, Whisper was transcribing a *sung* vocal as if it were speech, and the video
half produced a contact sheet with no tempo, no key and no per-shot record. A generator fed that would
invent the missing half.

So this stage measures what can be measured locally, and **says so** where it cannot:

| The question | v1 answer |
|---|---|
| How fast is it? | measured, with candidates and an octave rival named |
| What key? | measured, with the correlation margin |
| What is the rhythm feel? | inter-onset intervals, accent per beat position, alternation, grid deviation |
| Where does the structure change? | measured novelty boundaries — never labelled "verse" |
| What instruments? | **not measured** — no separator, no classifier ran |
| What is on screen? | shot boundaries, start/mid/end frames, luma and palette; **not** camera, action, transition or text |
| What are the lyrics? | the transcript, plus Whisper's own confidence deciding speech-like vs sung-or-uncertain |

## What v2 adds (2026-10-31)

v1 measured the mix and the shots. v2 adds the four things a generator actually needs, and keeps the same
tagging rule:

| Stage | What it produces | Evidence tag |
|---|---|---|
| **Full shot inventory** | every detected boundary in `shots.json`, plus pilot clips chosen to satisfy the generation endpoints (3–8 s continuous) | MEASURED |
| **Chord candidates** | major/minor triads from the measured chroma, majority-filtered, with a confidence margin | **INFERRED** |
| **Stems** | Kie Suno `split_stem` separation, downloaded, then **each stem decoded and measured locally** | MEASURED (files + their own numbers) |
| **Semantic pass** | Kie Gemini 3 Pro conditioned on the measured facts: genre, vibe, instrument hypotheses, vocal delivery, structural roles, camera/action/transition/on-screen text for sampled shots | **INFERRED** |

Paid stages run **only** in the `assisted` or `cloud` profile:

```bash
node bin/media-evidence.mjs "source.mp4" --profile assisted --budget-credits 100
```

Every paid call is appended to `replication/<job>/kie-jobs.jsonl` with task id, model, media sent,
latency, credits before/after and the local files. The credential is `KIE_AI_API_KEY` from
`~/projects/Website_Builder/.env`; it is never printed (only a shape mask) and never written to the ledger.

New skipped-stage honesty: `local` now says **why** stems and the semantic pass did not run, instead of
leaving a reader to assume the model found nothing.

### Measured on the real source (assisted profile)

`RICK ROSS - HIGH DEFINITION (OFFICIAL VIDEO).mp4`, 368.078 s, one paid run:

| Result | Value | Tag |
|---|---|---|
| Shot inventory | **196 boundaries**, median 0.959 s, longest 85.5 s — 9 are long enough for a 3–8 s generation clip | MEASURED |
| Pilot clips | `#1 0–8 s`, `#6 37.913–45.913 s`, `#196 282.574–290.574 s` | MEASURED |
| Chords | 9 segments, all confidence ≥ 0.46, A minor dominant (agrees with the measured key) | INFERRED |
| Instruments | Synthesizer 0.90, Drum Machine 0.95, 808 Bass 0.95 | INFERRED |
| Vocal | "steady, deliberate, heavily punctuated", low register, gruff delivery | INFERRED |
| Structural roles | intro 0–48 s · verse 48–88 s · hook 88–252 s · bridge 252–280 s · outro 280–368 s | INFERRED |
| Per-shot descriptions | 6 sampled shots described (action, camera, on-screen text) — correctly mapped to **detected** shots 1, 8, 14, 21, 28, 35 | INFERRED |
| Stems | **refused by the provider** — see below | UNVERIFIED |

Cost of that run: **2.56 credits**, wall time 8 min 40 s (local measurement 4 min, paid stages ~4 min 40 s).
Credits are read before and after every call and written into `kie-jobs.jsonl`.

#### Report defects found by reading the rendered document (2026-10-31, fixed)

The operator read `REPLICATION.md` against `replication.json` and found three places where the document
disagreed with its own data:

1. **The shot table hardcoded `_UNVERIFIED_`** in the camera/action/transition column, so a pack whose JSON
   held real descriptions still rendered "unverified". The report now prints each graded value with its own
   tag, and a closing line says how many sampled shots carry an interpretation.
2. **The OCR note lied in one case**: it said "no semantic pass read this frame" even when the pass had been
   shown the frame and simply returned no text. Three situations are now distinguished — read-and-found-
   nothing, not-among-the-sent-frames, and no-pass-ran.
3. **A model answer containing a newline broke the table** (on-screen text came back as two lines). Table
   cells are folded to one line.

Also corrected from the same review: pilot clips were chosen as the **three longest shots**, which on a
music video means the title card, the spoken intro and the end card. They are now chosen from the measured
**highest-energy region**, spread across it, and a single-shot video is told to use its keyframe with
image-to-video instead of a clip.

#### Measured on a second source (copyright-free, 776.5 s)

`Copyright Free Epic Music - Journey To The Stars (Savfk)`, 1280×720 @ 30 fps, one paid run, **2.76 credits**:

| Result | Value | Tag |
|---|---|---|
| Key / tempo | E major (correlation 0.638) / 100.3 BPM | MEASURED / INFERRED |
| Regions | 17 novelty regions | MEASURED |
| Chords | 22 segments; **14 of 22 fit E major's diatonic set** (0.636), with the major/minor-third caveat stated | INFERRED |
| Semantic | "cinematic orchestral", epic/majestic, Strings 0.95 · Brass 0.90 · Orchestral Percussion 0.95 · Piano 0.90 · Choir 0.90; wordless SATB choir, legato, heavy hall reverb | INFERRED |
| Video | **one continuous static shot** — piloted as a keyframe for image-to-video, not as a clip | MEASURED |
| On-screen text | "Journey To The Stars / SAVFK" read from the keyframe | INFERRED |
| Lyrics | no speech detected (instrumental) | UNVERIFIED |

#### Two presentation fixes from the second review round (2026-10-31)

1. **Single-shot videos no longer print a pilot window.** The note said "use the keyframe" while the table
   still offered a 0–8 s clip, i.e. advice and data disagreed. A single continuous shot now produces
   `mode: "keyframe"` with the frame timestamp and path, and the report prints one line instead of a table.
2. **Old packs can be re-rendered without re-measuring.** `--rerender <pack.json>` rebuilds
   `REPLICATION.md` from the pack's own JSON: no network, no credits. This is what lets a rendering
   improvement reach artifacts produced earlier — it re-presents, it does not re-grade, and it says so.

```bash
node bin/media-evidence.mjs --rerender replication/<job>/replication.json
```

#### The stem blocker, measured

Kie's Suno stem separation **refuses commercially released audio**:

```
GENERATE_AUDIO_FAILED: This audio matches an existing recording in our catalog.
```

That was verified for **both** `split_stem` and `separate_vocal`, and the failed task was **not charged**.
It also fires on a *copyright-free* track (the Savfk piece above was refused too), so the trigger is
"recognisable in their catalogue", not "copyrighted". **Kie stem separation is therefore not a usable route
for arbitrary music uploads**, and the pack reports stems as UNVERIFIED with the provider's own message.

Remaining options, in order of preference: separate the **generated** cover (not in their catalogue), a
vetted local separator (Demucs is still unmeasured on this machine), or a crude local mid/side split that
would be labelled as such.

#### One more provider limit, measured

The semantic pass uploads audio and asks the model to fetch it. An **18.6 MB** upload produced
`400 Failed to get the file information` — which reads like a credential or format failure and is really a
size problem. The pass now encodes a **64 kbps mono** copy (≤8 MB; a 776 s track lands at ~6 MB) and states
in the pack which audio the model actually heard.

## The three tags

- **MEASURED** — a number computed from the samples or the pixels.
- **INFERRED** — the measurement exists but is not decisive (narrow key margin, rival tempo octave).
- **UNVERIFIED** — the pack does not know, and states the reason and the route that could answer it.

The graders that assign these are pure functions in `lib/evidence/pack.js` with tests in
`tests/evidence.test.mjs`, so a threshold can be argued with rather than discovered by reading a
template string.

## What runs

| Stage | Implementation | Network |
|---|---|---|
| Source facts | `ffprobe`, `sha256sum`, one ffmpeg pass running `ebur128` + `silencedetect` | none |
| Audio measurement | `python/dsp_worker.py` (numpy only) | none |
| Shot sheet | `ffmpeg scdet` + frame extraction + 16×16 pixel statistics | none |
| Chord candidates | `lib/evidence/chords.js` (triad templates over the measured chroma) | none |
| Lyrics | local `faster-whisper` via `python/stt_worker.py` | model download only if uncached |
| Stems | Kie `ai-music-api/separate-vocals`, `split_stem` (≤20 MB upload) | **paid** |
| Semantic pass | Kie `gemini-3-pro` chat completions with audio + keyframes | **paid** |
| Pack + render | `lib/evidence/*` | none |
| Generation | **not in this stage** | — |

### The DSP worker is numpy-only on purpose

librosa would pull numba and llvmlite (~200 MB) onto a machine with ~2 GB of usable RAM. The worker
implements the textbook versions instead, and — more importantly — it is **verified against synthetic
signals whose answer is known before the measurement**:

```
$ .venv-stt/bin/python python/dsp_worker.py --self-test
PASS  moving average matches convolution — interior max |delta| = 8.882e-16
PASS  120 BPM click track — reported 120.11 BPM
PASS  120 BPM onset count — reported 19 onsets
PASS  96 BPM with off-beat eighths — reported 95.77 BPM
PASS  alternating accents are measured — alternation ratio 0.856
PASS  steady 440 Hz tone has no rhythm — 1 onsets, tempo None
PASS  C-E-G triad reads as C major — reported C major (r 0.8324, margin 0.0492)
PASS  silence claims nothing — silent=True tempo=None
PASS  truncation is reported — analysed 3.0s of 6.0s
=> 9 passed 0 failed
```

`tests/dsp.test.mjs` runs that self-test through `npm test`, so a Python change cannot land without it.

**Four defects this ground-truth discipline caught that reading the code did not:**

1. Log-compressed spectral flux reported **63 onsets for a steady 440 Hz sine** — window-phase leakage, not
   rhythm. Total-energy rise reports 1, and click tracks keep all their onsets.
2. A cumulative-sum moving average was **off by one frame** and dropped its last column, which moved the
   strongest flux from the attack to an edge artefact: 57 fake onsets.
3. Integer autocorrelation lags **quantised the period**, so a perfect 120 BPM metronome reported
   **60.1 BPM** (the half-tempo family happened to land on whole frames). Fixed by fractional-lag
   interpolation and by refining the period against the same objective that selected it.
4. Accents sampled from a **single frame** per beat gave a flat vector on real hip-hop; percussive *share*
   instead of percussive *energy* saturated at 1.0. Peak energy inside the beat window fixes both, and the
   alternation test proves it: 0.856 on an alternating grid vs 0.030 on a flat metronome.

## Artifacts

```
replication/<job>/
  source.json           # ffprobe + sha256 + loudness + silence windows
  audio-features.json   # the full DSP result, including the 2 Hz series
  frames/               # start / mid / end PNG per shot
  lyrics/               # transcript.txt / .json / .srt + lyrics.json with confidence
  reference/
    audio-mono-22050.wav  # the DSP input (reproducible)
    source-audio.flac     # lossless copy for the generator stage
  notes/skipped.json    # every stage that did not run, and why
  replication.json      # the tagged pack
  plan.json            # preserve / change / evaluation, derived mechanically
  REPLICATION.md       # the human-readable pack
```

`plan.json` deliberately has an **empty `change` list**: v1 does not invent a transformation. The operator
states what must change (for example "characters become anime-styled") and it is recorded there before any
generation call.

The `series` block (2 Hz energy, harmonic ratio, onset strength and 12-value chroma) exists so a generated
take can later be compared against this source numerically rather than by opinion.

## Measured on this machine

The real acceptance run, `RICK ROSS - HIGH DEFINITION (OFFICIAL VIDEO).mp4`, 27,226,722 bytes,
368.078 s, 1280×720 @ 23.976 fps, AAC 44.1 kHz stereo:

| Quantity | Value |
|---|---|
| wall time | 4 min 16 s (source 48.3 s, audio 22.8 s, shots 123.1 s, lyrics 61.6 s) |
| peak RSS (whole tree) | ~536 MB |
| DSP time | 6.5 s for 368 s of audio, 523 MB inside the worker |
| audio measured | 368.036 s — the whole track, `truncated: false` |
| shots | 196 detected, 30 sampled (3 frames each) |
| artifacts on disk | 100 MB (74 MB lossless reference audio, 26 MB frames) |

That is the point of the stage: 368 s measured instead of 300 s truncated.

The confidence path is two-sided, not just a warning label: the same code reports the rap vocal as
`sung-or-uncertain` at mean log-probability −0.52 (**INFERRED**) and the JFK speech fixture as
`speech-like` (**MEASURED**), so the tag discriminates rather than defaulting to caution.

## Limits

- **Tempo, key and rhythm cannot be measured with certainty** from audio alone. The pack reports
  confidence, rival candidates and the octave alternative instead of a single confident number, and grades
  weak readings INFERRED or UNVERIFIED.
- **Loudness onsets** are rises in total spectral energy: a quiet hi-hat over a constant bed may not
  register. The beat grid and onset rate are reported alongside so the under-count is visible.
- **Accents** are measured in the percussive band; a dense mix can flatten the pattern, which is why the
  spread is reported rather than a "backbeat" claim.
- **No OCR**: tesseract is not installed, so on-screen text is UNVERIFIED with that reason.
- **No stems, no MIDI**: Demucs and Basic Pitch are not installed. Instruments stay UNVERIFIED until a
  separator runs, or a native audio model interprets the mix in the `assisted` profile.
- **No semantic pass**: `local` makes no model call by definition.
- Nothing here is a legal opinion; the operator confirmed rights to the source for testing.

## Testing it

```bash
npm test                                                       # 52 unit tests incl. the DSP self-test
.venv-stt/bin/python python/dsp_worker.py --self-test           # DSP ground truth alone
node bin/media-evidence.mjs fixtures/error-demo.mp4 --out /tmp/ev --no-lyrics   # 9 s end-to-end
node bin/media-evidence.mjs "like.mp4" --mode transform --profile local        # mode changes the plan
```

## Next step

The Kie adapter (stage 2 of `PRODUCTION-PIPELINE.md`): resolve `KIE_AI_API_KEY` from
`~/projects/Website_Builder/.env` (the variable is **not** `KIE_API_KEY`), upload the reference audio or
frames, create/poll tasks, and write `kie-jobs.jsonl` with cost and output archived locally. No batch
run until one music pilot and one video pilot are reviewed against this pack.
