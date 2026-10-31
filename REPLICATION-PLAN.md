# Replication plan — from evidence pack to replica / transform

**Date:** 2026-10-31 · **Status:** phase 1 (evidence pack v2) **built and run**; phases 2–5 planned ·
**Generation provider:** **Kie only**
**Test source:** `RICK ROSS - HIGH DEFINITION (OFFICIAL VIDEO).mp4` (operator confirmed usage rights)

## 1. Why the current state cannot produce a replica yet

This is a sequencing problem, not a single missing feature.

| Missing piece | Why it blocks a replica |
|---|---|
| **No Kie adapter exists** | Nothing can upload, create a task, poll it, record cost, or archive the result. The pack makes no generation call by design. |
| **Only 20–30 of 196 shots are sampled** | A shot-by-shot rebuild needs the full shot inventory and reference frames for the shots actually being regenerated. |
| **Camera, action, transition and on-screen text are UNVERIFIED** | Those are exactly the instructions a video generator needs. Local measurement cannot supply them. |
| **No stems and no MIDI** | Instruments cannot be named, and the musical parts cannot be programmed from a whole-mix measurement. |
| **No chord progression or vocal-flow map** | Chroma gives key evidence, not a chord sequence. Whole-mix onsets cannot separate the rapper's flow from the drums. |
| **Lyrics are approximate** | The rap transcript is `sung-or-uncertain`; it cannot be treated as the lyric sheet. |
| **Generation models approximate** | Even with perfect evidence, Wan/Kling/Suno produce a *new* performance. No exact-reproduction claim is allowed. |

So the way forward is: **complete the evidence for the shots and parts being generated, build the smallest
possible Kie adapter, run one pilot per medium, and only then consider full-length assembly.**

## 2. Provider facts that shape the implementation

Checked against the current Kie docs on 2026-10-31.

### Semantic analysis (assisted/cloud)

[Kie Gemini 3 Pro (OpenAI-compatible)](https://docs.kie.ai/market/gemini/gemini-3-pro) accepts **text,
image, video, audio and PDF** through chat completions. All media use one structure:

```json
{ "type": "image_url", "image_url": { "url": "https://…" } }
```

That supplies the semantic pass **without a second vendor**: instruments, genre/vibe, vocal delivery, chord
hypotheses, shot action/camera/transition, and on-screen text. These are **INFERRED**, never MEASURED.

### Stems

[Kie Suno Vocal & Instrument Stem Separation](https://docs.kie.ai/suno-api/separate-vocals) supports:

- `separate_vocal` — vocals + accompaniment;
- `split_stem` — up to 12 stems (vocals, backing vocals, drums, bass, guitar, keyboard, strings, brass,
  woodwinds, percussion, synthesizer, FX/other);
- `split_stem_advanced` — one named stem plus its remainder.

Input may be `audio_url` (docs say **20 MB max**) or a previously generated `task_id` + `audio_id`.
The source **MP3 (8.8 MB)** fits; the 60 MB FLAC does not. Keep the FLAC locally, upload the MP3, and record
that the uploaded analysis source is lossy. Failed tasks are not charged; repeated calls are charged again.

### Music generation

[Kie Suno Upload And Cover Audio](https://docs.kie.ai/suno-api/upload-and-cover-audio) transforms style
**while retaining the core melody**.

- Source: `upload_url` (≤ **8 minutes**) or a previous `task_id` + `audio_id`.
- Required: `instrumental`, `model`, and a source.
- Controls: `style_weight`, `weirdness_constraint`, `audio_weight` (0–1), `variety` (0–4), `style`,
  `negative_tags`, `vocal_gender`, `duration` (10–360 s on V6 family), optional `lyrics`/`prompt`.
- Do not pass `image_urls`; cover does not accept them.

The source is **368 s**, longer than the 360 s explicit duration target. **Do not start with a full-song
job.** Pilot on a 60–90 s excerpt first; decide full-length handling only after the pilot.

### Video transformation

[Kie Wan 2.2 Animate Replace](https://docs.kie.ai/market/wan/2-2-animate-replace):

- required `input.video_url` + `input.image_url`;
- video and image each **≤ 10 MB**;
- output 480p / 580p / 720p.

Use for the **anime character replacement** pilot. The 27 MB source must be cut and compressed into a short
clip first.

[Kie Kling 3.0 Omni Transformation](https://docs.kie.ai/cn/market/kling/v3-omni-transformation):

- exactly one source video in `video_urls`, MP4/MOV, **≤ 200 MB**;
- duration **3–15.5 s**;
- frame rate **24–60 fps**;
- width/height 700–4553 px, total pixels ≤ 8,294,400, aspect ratio 0.4–2;
- prompt ≤ 3072 chars; resolution 720p / 1080p / 4K.

The source is **23.976 fps**, below Kling's 24 fps minimum, so the pilot clip must be conformed to 24 fps.
The 1280×720 dimensions fit.

### Replica-shot candidates

[Kie Kling 4.0 Reference To Video](https://docs.kie.ai/market/kling/v4-reference-to-video): output 3–30 s,
reference clips 2–30 s (up to 5), prompt references such as `@video_1` and `@image_1`.

[Kie Seedance 2](https://docs.kie.ai/market/bytedance/seedance-2): output 4–15 s, each reference video
2–15 s and ≤ 50 MB (maximum 3, total reference duration ≤ 15 s), optional reference images/audio.

Model choice stays a **pilot decision**, not a commitment.

## 3. Execution phases

### Phase 0 — close the MP3 drop question without guessing

**Finding:** `lib/client.js` already accepts `.mp3` by extension and any `audio/*` MIME type, and the MP3
the operator dropped produced a real transcript. No code defect was ever demonstrated, so nothing was changed
blindly — that remains the position.

**Do not change working code blindly.** If the failure is seen again, capture the exact status/error text
and the bundle URL (`/plugins/dsh-media-reader/client.js`) before editing. Add a small client regression
test that feeds synthetic `DataTransfer` drops for MP3, MP4 and PNG through the same handlers, and keep the
visible `Analyzing …` status until the draft is updated. A 368 s MP3 takes about a minute to transcribe, so
the wait is not itself a failure.

**Acceptance:** MP3 and MP4 both pass the synthetic drop test; if a live failure exists, its exact error is
recorded before any fix.

### Phase 1 — evidence pack v2 (complete the evidence needed for generation) — **BUILT 2026-10-31**

1. **Full shot inventory.** Write every detected boundary to `shots.json` (index, start, end, duration, cut
   score), not only the sampled shots. Keep frame extraction budgeted, but allow `--all-shot-frames` for a
   deliberate full extraction. Select pilot shots from this inventory, preferring continuous segments of
   **3–8 seconds**.
2. **Assisted semantic pass.** Add a Kie Gemini 3 Pro adapter call conditioned on the measured fields:
   - audio: genre/vibe/instrument hypotheses, vocal delivery, section roles, chord hypotheses;
   - video/keyframes: action, camera, lighting design, transition, on-screen text.
   Store model, latency, prompt and raw response. Tag everything **INFERRED**.
3. **Stems.** ~~Run Suno `split_stem` on the MP3~~ — **blocked for released audio**: Kie refuses it with
   "This audio matches an existing recording in our catalog" (verified for both separation types; the failed
   task is not charged). Options, in order of preference:
   1. separate the **generated** track (the cover is not in the catalogue) and measure that;
   2. a vetted local separator (Demucs) — still unmeasured on this 7.6 GB machine;
   3. a crude local mid/side split, labelled as such, for chord/lyric work only.

   The gate also refused a **copyright-free** track, so treat this as a property of the provider rather
   than of the material: do not spend another attempt on source stems through Kie.
   Basic Pitch remains optional and must be vetted/measured before adoption.
4. **Chord and vocal detail.** Derive per-window chord candidates from the measured chroma series and
   compare them with the semantic hypotheses. On the vocal stem, add pitch/onset measurements only where
   the implementation can be checked against synthetic ground truth. Otherwise leave UNVERIFIED.
5. **Update the plan** with the pilot shot list, intended change, and evaluation targets.

**Acceptance:** full shot inventory exists; assisted fields are filled and tagged INFERRED; stems are
archived locally with their own measurements; no field silently becomes MEASURED because a model said it.

### Phase 2 — Kie adapter skeleton

Implement the smallest useful adapter, using the existing Website Builder Kie client as reference code
(not a package install):

- credential resolution: `KIE_AI_API_KEY` from environment, `--env-file`, then
  `~/projects/Website_Builder/.env`; never print the secret;
- base64 file upload returning a provider URL;
- `POST /api/v1/jobs/createTask`, `GET /api/v1/jobs/recordInfo?taskId=…` polling with a hard timeout;
- optional callback only if a public callback URL actually exists (local chat testing should poll);
- `kie-jobs.jsonl`: task ID, model, inputs, status transitions, credits/cost if returned, output URLs,
  local artifact paths, and errors;
- download and archive every output immediately — provider URLs expire;
- credit check before the first paid call, and a fixed per-pilot budget.

**Acceptance:** missing key and insufficient credits fail loudly; every submitted task is in the ledger;
no provider URL is the only copy of an artifact.

### Phase 3 — one music pilot

Use a **60–90 second excerpt** from the main body (not the full 368 s track), uploaded as MP3.

- `replica`: conservative style, low weirdness, high source/audio preservation; keep the measured BPM/key
  and section structure as the contract.
- `transform`: one deliberate style change, still retaining the core melody.

Then run the evidence pack on the generated audio and compare tempo, key, energy, section boundaries,
duration and vocal/lyric reliability. Archive the output and record credits.

**Acceptance:** one output archived and evaluated; melody/structure drift is reported, not hidden; the
operator approves before any full-length work.

### Phase 4 — two video pilots

Pick **one continuous 3–8 s segment** from the full shot inventory. Conform it to 24 fps and compress it to
the endpoint's size limit.

1. **Replica:** Kling Reference To Video or Seedance 2 with the original clip/frames and a prompt to retain
   the same action, composition and storyline.
2. **Transform:** Wan Animate Replace with an anime character reference, or Kling Omni Transformation with
   "convert to anime while preserving character actions, shot composition and storyline".

Evaluate per-shot action/composition/timing against the source, and record where identity, lip-sync or
motion drifted. Do not ask the video model to typeset critical text; keep title cards in the assembly layer.

**Acceptance:** both outputs archived, with side-by-side review and an explicit go/no-go decision. No batch
run before this.

### Phase 5 — full-length assembly, only after both pilots pass

- Generate shots in small batches with a fixed budget and a per-shot fallback to original footage.
- Assemble with ffmpeg at the measured boundaries; keep the original or accepted generated soundtrack
  separate.
- Write `REVIEW.md` with measured drift, remaining differences, cost, and the exact fallback decisions.
- Re-run the evidence pack on the assembled master and compare against the source.

## 4. Acceptance gates for the whole effort

1. No exact-reproduction claim anywhere; the result is a reconstruction or transformation.
2. Every generated task has a ledger row, cost record and local archive.
3. Assisted semantic fields are INFERRED; only DSP/pixel/file facts are MEASURED.
4. One music pilot and both video pilots are reviewed before any batch.
5. No critical text is left to a video model; it is composited deterministically.
6. Rights and performer-identity permission are recorded on each job.
7. `local` never implies offline generation; it means local analysis only.
8. A failed pilot stops the pipeline rather than silently producing a full-length approximated "replica".

## 5. Immediate order of work

1. **Evidence pack v2** — full shot inventory + assisted semantic pass + stems.
2. **Kie adapter** — credential check, upload, task lifecycle, ledger, archive.
3. **Music pilot** on a short excerpt, evaluated against the pack.
4. **Replica and anime-transform video pilots**, evaluated separately.
5. Only then: full-length assembly.

## 6. What is done, as of this revision

| Phase | State |
|---|---|
| 0 — MP3 drop question | closed: no defect demonstrated; client accepts `.mp3` and `audio/*` |
| 1 — evidence pack v2 | **built and run** (`ba5857f`, tag `evidence-pack-v2`, 78 tests) |
| 2 — Kie adapter | not started (this is the next build step) |
| 3–5 — pilots and assembly | not started; blocked on phase 2 |

Two results from the phase-1 runs changed the plan: Kie refuses stem separation for **catalogued** audio
(verified, uncharged), and the semantic pass costs ~2.5 credits per run, which makes pilots affordable.
Pilot clips are now chosen from the measured high-energy region rather than from the longest shots.
