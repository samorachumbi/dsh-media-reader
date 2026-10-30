# Replication-grade media analysis — research and pathway

**Date:** 2026-10-30 · **Status:** research only, no implementation · **Trigger:** the Rick Ross MP4
**Goal:** turn an MP3/MP4 into enough *evidence and reference assets* that a generation model can make a
close reproduction — or a deliberately better version — instead of a vague text summary.

## 1. What the current output proves — and what it does not

The current digest gave: 368.08 s duration, 4 scene shots, a contact-sheet description, and some speech.
It did **not** provide:

- tempo, key, onset/cadence pattern, harmonic content, section boundaries, dynamics or timbre;
- instrument stems or note events/MIDI;
- complete lyrics (the 300 s cap truncated the last ~68 s), and Whisper `base` misheard sung words;
- per-shot camera, lighting, subject/action, transition and typography detail sufficient to reconstruct a
  music video.

A contact sheet cannot establish cadence or instruments, and a speech transcriber cannot establish notes.
Asking a text-only LLM to infer them would fabricate exactly the confidence the user needs to avoid.

**Therefore the goal is not “a better paragraph.” It is a replication evidence pack.**

## 2. The central design rule

> **Measure what can be measured locally. Use a native audio/video model for interpretation. Feed the
> original media and derived references to the generator. Never present inference as a measurement.**

Three kinds of fact must stay separate in every artifact:

- `MEASURED`: ffprobe, DSP, stems, MIDI, timestamps, file hashes.
- `INFERRED`: genre, vibe, instrument hypotheses, shot function, artistic interpretation.
- `UNVERIFIED`: anything the model could not establish, including exact lyrics when confidence is low.

## 3. Evidence reviewed

| Capability | Evidence | What it means for us |
|---|---|---|
| Native audio understanding | [Gemini audio understanding](https://ai.google.dev/gemini-api/docs/audio) — describes/summarizes/answers questions about audio, transcription/translation, speaker diarization, **emotion in speech and music**, timestamped segments | Useful semantic layer for vibe and musical interpretation. Not a substitute for measured BPM/key/MIDI. |
| Native long-video understanding | [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) — video content and timestamps; File API recommended for large/long files (2 GB free / 20 GB paid; inline <100 MB) | A 6-minute MP4 can be analyzed as a video rather than 4 detached frames. Requires a Gemini key and permission to upload. |
| Music source separation | [Demucs README](https://github.com/facebookresearch/demucs) — v4 separates **drums, bass, vocals and other**; six-source guitar/piano is experimental (piano has bleeding/artifacts) | Stems make instrumentation and lyric transcription much more reliable. Repo is unmaintained; vet before install. CPU cost is unmeasured here. |
| Note transcription | [Basic Pitch README](https://github.com/spotify/basic-pitch) — lightweight polyphonic AMT, instrument-agnostic, outputs MIDI/pitch bends/note events; **best on one instrument at a time** | Best local route to actual notes/MIDI, preferably on separated stems. It is not a full faithful score of a dense mix. |
| Alternative transcription | [MT3 README](https://github.com/magenta/mt3) — multi-instrument transcription using T5X | Stronger research option, but a poor first choice for this CPU/RAM/framework budget. |
| Audio-native music analysis | [Qwen3-Omni README](https://github.com/QwenLM/Qwen3-Omni) — audio/video model with a **Music Analysis** cookbook for style, genre and rhythm; example model `Qwen3-Omni-30B-A3B-Instruct` | Good alternative semantic layer through an API. Far too large to run locally on this machine. |
| Music generation with source audio | [Stable Audio audio-to-audio guide](https://kb.stability.ai/knowledge-base/tips-for-using-the-audio-to-audio-api) — transforms an input file with a text prompt; `strength` trades preservation vs transformation; use descriptive sonic prompts | Directly supports “same but better”: give the original/stems plus measured style, then iterate strength. |
| Music style reference | [Udio Styles](https://www.udio.com/blog/introducing-styles) — one/two audio references, style strength, ~32 s context window; uploaded audio requires rights | Reference audio preserves more of the original feel than text alone. Short reference clips must be selected deliberately. |
| Video reference generation | [Seedance 2](https://docs.kie.ai/market/bytedance/seedance-2), [Kling motion control](https://docs.kie.ai/market/kling/motion-control), [Veo 3.1](https://docs.kie.ai/veo3-api/generate-veo-3-video) — reference images/video/audio, image-to-video and motion-control variants | Supply keyframes/reference clips rather than asking for a 6-minute video from prose. Capabilities vary; pilot, do not assume fidelity. |

**Not chosen:** running a local 30B audio/video model (RAM), treating Whisper as music analysis, or generating
one long video from a single prompt.

## 4. Recommended analysis pipeline

### A. Audio — objective first

1. **Decode and inspect** with ffprobe/ffmpeg: duration, channels, sample rate, loudness (ebur128),
   silence/energy envelope. Keep the whole file; no 300 s truncation for replication work.
2. **DSP features** (librosa or Essentia, after vetting):
   - BPM and beat timestamps; onset envelope and tempo distribution (**cadence**);
   - chroma → key/mode estimate with a confidence score;
   - harmonic/percussive separation (HPSS), spectral centroid/rolloff/flux and MFCC summaries (**timbre**);
   - RMS/dynamic envelope and novelty-based section boundaries (**energy arc**). These are measured
     sections, not automatically “verse/chorus”; an audio model may label function with lower confidence.
3. **Stems with Demucs** (`vocals`, `drums`, `bass`, `other`). Run BPM/key/timbre per stem where useful;
   analyze drums for rhythm and other/bass for harmony. Do not claim guitar/piano as clean stems — the
   official docs warn about those sources.
4. **Notes with Basic Pitch** on stems (especially `other`/`bass`), producing `notes.csv` and `music.mid`.
   Keep note confidences and a sonified preview so the result can be checked by ear. Treat dense-mix MIDI
   as a guide, not a guaranteed score.
5. **Lyrics separately from music.** Use the vocal stem and a stronger route (Whisper `small`, or a native
   audio model) with timestamped confidence. Mark sung/unclear words; do not call the current `base`
   output exact. Full duration, never silently capped.
6. **Semantic interpretation (optional cloud):** Gemini or Qwen-Omni receives the audio/stems and the
   measured feature table. Ask for genre, instrumentation hypotheses, vocal delivery, mood and section
   roles **conditioned on measurements**, with an explicit instruction not to contradict them.

### B. Video — a shot replication sheet, not just a contact sheet

1. Keep scene detection, but sample **start/mid/end frames per shot** and retain OCR/text regions.
   For a 6-minute music video this is a bounded set of evidence frames, not 4 shots with no descriptions.
2. For each shot record: timestamp range, subject/person, action, setting, camera angle and movement,
   lighting, palette/grade, on-screen text, transition in/out, and representative frame paths.
3. Track global visual grammar: performance vs narrative vs title cards, recurring motifs, typography,
   aspect ratio, grain, pacing and color treatment. Use a native video model (Gemini) or the vision route
   in batches for interpretation; keep every claim tied to timestamps.
4. Generate short reference clips for the generator, plus keyframes and contact sheets. Do not expect a
   single long generation to preserve all of it.

### C. Generation — reference-conditioned, shot-by-shot

**Music:** original/stems + `replication.json` + a 20–32 s reference clip. Stable Audio audio-to-audio or
Udio Styles can use the actual audio as structural/style reference. Start with conservative strength;
iterate using measured BPM/key/energy plus listening. Do not ask for “exactly this song” from prose.

**Video:** produce short shots (typically 2–8 s) from reference frames/motion references, then assemble
with ffmpeg/Remotion. Put exact typography/title cards in the deterministic edit layer, not the video
model. Keep the original or newly generated soundtrack separate so visuals remain revisable. Exact
performer identity and lip-sync are not guaranteed; use original footage/motion transfer where permitted
or accept an approximation.

## 5. The artifact a generator should receive

```
replication/
  source.json                 # file, hash, duration, codecs, provenance
  audio-features.json         # BPM, beats, key+confidence, chroma, MFCC/timbre, energy, sections
  stems/{vocals,drums,bass,other}.wav
  notes/{music.mid,notes.csv,sonified.wav}
  lyrics/{lyrics.json,lyrics.srt}       # timestamps + confidence
  frames/shot-XX-{start,mid,end}.png
  contact-sheet.png
  reference/                  # selected clips/stills for the generator
  replication.json            # machine-readable complete evidence pack
  REPLICATION.md              # shot/section-by-section reconstruction brief
```

`replication.json` must include confidence and provenance per field. `REPLICATION.md` should read like a
shot list and a music arrangement sheet: **what happens when, how it looks/sounds, what to preserve, what
to improve, and what was not established.**

## 6. Feasibility on this machine (T4)

- **Cheap and suitable:** ffprobe/ffmpeg, DSP features, frame extraction, HPSS, Basic Pitch (lightweight).
- **Expensive but plausible:** Demucs on a 6-minute song. CPU time/RAM must be measured before it becomes
  a default. If it misses the budget, use HPSS + cloud audio analysis instead.
- **Not suitable:** local Qwen3-Omni/30B, MT3/T5X as a first implementation, or many simultaneous jobs.
- **Cloud is for semantics, not for proving numbers:** Gemini/Qwen interpretation is useful but must not
  override local measurements.

Required probes before implementation: Basic Pitch runtime/accuracy on a stem, Demucs runtime/RSS on a
short clip, and one Gemini/Qwen audio+video analysis call if a key is available.

## 7. Fidelity and rights limits

- A generator is probabilistic. “Exactly reproduce” cannot be promised from any summary or prompt; the
  achievable target is **bounded, measurable fidelity** using references and an evaluation loop.
- Do not clone a performer’s voice/identity without permission. Source audio/video needs rights for upload
  and derivative generation; Udio explicitly requires rights for uploaded audio. Record that permission.
- Keep generation candidates labelled as generated, not as the original recording.

## 8. Recommended implementation order

1. **Replication evidence pack v1:** full-duration decode + DSP features + shot replication sheet +
   `replication.json`/`REPLICATION.md`. No Demucs yet.
2. **Stems + MIDI + better lyrics:** vet/install Demucs and Basic Pitch, measure them on one real song,
   compare against v1 and only keep if the accuracy gain justifies the runtime.
3. **Native audio/video semantic pass (optional):** Gemini preferred if a key exists; Qwen-Omni via API as
   alternative. Merge interpretation with measured fields without overwriting them.
4. **Generator adapter + evaluation loop:** one music adapter (Stable Audio or Udio) and one video adapter
   (Seedance/Kling/Veo). Generate one representative music variation and one representative shot, compare
   against source, and only then automate batches.

## 9. Decisions needed before coding

1. Which generator(s) do you actually use: Suno, Udio, Stable Audio, Runway/Kling/Veo, or Kie?
2. Do you have a **Gemini** key, Qwen/DashScope key, Stability key, or Kie key for native audio/video
   analysis? (DeepSeek itself cannot consume audio/video natively.)
3. May the Rick Ross file and derived stems/frames be uploaded to those providers, and do you have rights
   to reproduce/derive from it?
4. Is the target **closest possible reproduction** or a **better version**? Those require different
   evaluation criteria and different strength settings.
5. What time/cost budget is acceptable for a 6-minute song: local-only and slower, or cloud-assisted?

Until those are answered, the safe default is **local evidence pack first, no generation calls**.
